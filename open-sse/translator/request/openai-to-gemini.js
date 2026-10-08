import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { DEFAULT_THINKING_AG_SIGNATURE, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE } from "../../config/defaultThinkingSignature.js";
import { openaiToClaudeRequestForAntigravity } from "./openai-to-claude.js";
import { getGeminiThoughtSignatureSync } from "../../services/thoughtSignatureStore.js";
/** @returns {string} Fresh envelope identifier; no caller data is mutated. */
function generateUUID() {
  return crypto.randomUUID();
}

import {
  DEFAULT_SAFETY_SETTINGS,
  convertOpenAIContentToParts,
  extractTextContent,
  tryParseJSON,
  generateRequestId,
  generateSessionId,
  generateProjectId,
  cleanJSONSchemaForAntigravity,
  createSchemaBudget,
  normalizeGeminiContents
} from "../formats/gemini.js";
import { SCHEMA_PURPOSE } from "../../config/schemaCompatibility.js";
import { SchemaError, asSchemaError } from "../../utils/schemaErrors.js";
import { deriveSessionId, toNumericSessionId } from "../../utils/sessionManager.js";
import { ROLE, GEMINI_ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";

/**
 * Normalize a function name to Gemini's identifier alphabet and 64-character limit.
 * @param {string} name - Caller name, never mutated.
 * @returns {string} Provider-compatible name with a valid first character.
 */
function sanitizeGeminiFunctionName(name) {
  if (!name) return "_unknown";
  // Replace any char not in [a-zA-Z0-9_.:\-] with '_'
  let sanitized = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  // First char must be letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  // Truncate to 64 chars
  return sanitized.substring(0, 64);
}

/**
 * Rewrites duplicate tool_call_ids so every emitted functionCall id is unique.
 *
 * Gemini validates functionCall id uniqueness across the WHOLE history and
 * answers 400 INVALID_ARGUMENT otherwise, but an OpenAI tool_call_id is only
 * unique within its own assistant turn — a long agent session can replay the
 * same id in a later turn (#4532).
 *
 * Uniqueness is per OCCURRENCE, not per id: two different calls that share an id
 * must end up with different emitted ids, so the mapping is consumed in
 * document order rather than memoized by id. Each call site calls next() once
 * per emitted functionCall, and keeps the returned value so the matching
 * functionResponse reuses it.
 *
 * Ids that were already unique are passed through untouched, so a valid
 * conversation is byte-identical to before.
 */
function createToolCallIdUniquifier() {
  const used = new Set();
  return {
    next(id) {
      if (!id) return id;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
      let n = 2;
      let candidate = `${id}-${n}`;
      // An id may already end in "-2"; keep counting rather than collide again.
      while (used.has(candidate)) candidate = `${id}-${n++}`;
      used.add(candidate);
      return candidate;
    },
  };
}

/**
 * Translate Chat requests while preserving caller schemas and system instructions.
 * Schema budgets cover response and tool schemas together (SCHEMA_LIMITS).
 * @param {string} model - Target model identifier.
 * @param {Object} body - Read-only Chat request.
 * @param {boolean} stream - Requested transport mode.
 * @param {string} [signature] - Default thought signature for tool history.
 * @param {string|null} [sessionId=null] - Session used for cached signatures.
 * @returns {Object} Newly constructed Gemini request with bounded, owned schemas.
 * @throws {SchemaError} Invalid schemas (400) or unexpected preparation failures (500).
 */
function openaiToGeminiBase(model, body, stream, signature = DEFAULT_THINKING_AG_SIGNATURE, sessionId = null) {
  // Response and tool schemas share request-wide processing limits.
  const schemaBudget = createSchemaBudget();
  const result = {
    model: model,
    contents: [],
    generationConfig: {},
    safetySettings: DEFAULT_SAFETY_SETTINGS
  };

  // Generation config
  if (body.temperature !== undefined) {
    result.generationConfig.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    result.generationConfig.topP = body.top_p;
  }
  if (body.top_k !== undefined) {
    result.generationConfig.topK = body.top_k;
  }
  if (body.max_tokens !== undefined) {
    result.generationConfig.maxOutputTokens = body.max_tokens;
  }

  // Build tool_call_id -> name map
  const tcID2Name = {};
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === ROLE.ASSISTANT && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === OPENAI_BLOCK.FUNCTION && tc.id && tc.function?.name) {
            tcID2Name[tc.id] = tc.function.name;
          }
        }
      }
    }
  }

  // Build tool responses cache.
  //
  // Queued per id rather than a single value: an OpenAI tool_call_id is only
  // unique within its own assistant turn, so a long agent session can reuse one
  // id for two different tool results. A plain id->content map keeps only the
  // LAST one, and the earlier turn would then be answered with the later
  // turn's output. Each functionCall consumes the oldest unconsumed result for
  // its id instead. #4273
  const toolResponses = {};
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === ROLE.TOOL && msg.tool_call_id) {
        (toolResponses[msg.tool_call_id] ||= []).push(msg.content);
      }
    }
  }
  const toolResponseCursor = {};

  // Gemini validates that functionCall ids are unique across the WHOLE history,
  // and rejects the entire request with 400 INVALID_ARGUMENT when one repeats.
  // tool_call_id is only unique within a single assistant turn, so a long agent
  // session can legitimately emit call_51859 at turn 14 and again at turn 22.
  //
  // Each functionCall takes the next free id here and passes it down to its
  // matching functionResponse, so the pair always agrees. #4532
  const toolCallIdUniquifier = createToolCallIdUniquifier();

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const role = msg.role;
      const content = msg.content;

      if (role === ROLE.SYSTEM && body.messages.length > 1) {
        result.systemInstruction = {
          role: GEMINI_ROLE.USER,
          parts: [{ text: typeof content === "string" ? content : extractTextContent(content) }]
        };
      } else if (role === ROLE.USER || (role === ROLE.SYSTEM && body.messages.length === 1)) {
        const parts = convertOpenAIContentToParts(content);
        if (parts.length > 0) {
          result.contents.push({ role: GEMINI_ROLE.USER, parts });
        }
      } else if (role === ROLE.ASSISTANT) {
        const parts = [];

        // Thinking/reasoning → thought part with signature
        if (msg.reasoning_content) {
          parts.push({
            thought: true,
            text: msg.reasoning_content
          });
          parts.push({
            thoughtSignature: signature,
            text: ""
          });
        }

        if (content) {
          const text = typeof content === "string" ? content : extractTextContent(content);
          if (text) {
            parts.push({ text });
          }
        }

        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          const toolCallIds = [];
          let firstFunctionCallSeen = false;
          for (const tc of msg.tool_calls) {
            if (tc.type !== OPENAI_BLOCK.FUNCTION) continue;

            const args = tryParseJSON(tc.function?.arguments || "{}");
            const cachedSig = tc.id ? getGeminiThoughtSignatureSync(tc.id, sessionId, model) : null;
            // First call gets cached signature or fallback; sibling calls remain unsigned if no cached sig
            const callSig = cachedSig || (!firstFunctionCallSeen ? signature : undefined);
            firstFunctionCallSeen = true;

            // Emitted id is uniquified; the thought-signature lookup above stays
            // on the ORIGINAL id so a cached signature is still found. #4532
            const emitId = toolCallIdUniquifier.next(tc.id);

            const part = {
              functionCall: {
                id: emitId,
                name: sanitizeGeminiFunctionName(tc.function.name),
                args: args
              }
            };
            if (callSig) {
              part.thoughtSignature = callSig;
            }
            parts.push(part);
            // The NAME travels with the pair for the same reason the id does:
            // tcID2Name is a conversation-wide id->name map, so a later call
            // reusing the id would otherwise rename this turn's response.
            // #4273
            toolCallIds.push({ origId: tc.id, emitId, name: tc.function?.name });
          }

          if (parts.length > 0) {
            result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
          }

          // Check if there are actual tool responses in the next messages
          const isIntermediate = i < body.messages.length - 1;
          const hasActualResponses = toolCallIds.some(
            ({ origId }) => (toolResponseCursor[origId] || 0) < (toolResponses[origId]?.length ?? 0)
          );

          if (hasActualResponses || isIntermediate) {
            const toolParts = [];
            for (const { origId, emitId, name: callName } of toolCallIds) {
              // Content resolves on the ORIGINAL id, consuming the oldest
              // unconsumed result; only the emitted id is uniquified. #4273 #4532
              const queue = toolResponses[origId];
              const cursor = toolResponseCursor[origId] || 0;
              let resp;
              if (queue && cursor < queue.length) {
                resp = queue[cursor];
                toolResponseCursor[origId] = cursor + 1;
              } else {
                resp = "";
              }

              // Name comes from THIS call, not from the conversation-wide id->name map,
              // which a later duplicate of the same id would have overwritten.
              let name = callName || tcID2Name[origId];
              if (!name) {
                const idParts = String(origId).split("-");
                if (idParts.length > 2) {
                  name = idParts.slice(0, -2).join("-");
                } else {
                  name = origId;
                }
              }

              let parsedResp = tryParseJSON(resp);
              if (parsedResp === null) {
                parsedResp = { result: resp };
              } else if (typeof parsedResp !== "object") {
                parsedResp = { result: parsedResp };
              }

              toolParts.push({
                functionResponse: {
                  // Matches the functionCall id emitted above, so a response
                  // never points at an id the call does not carry. #4532
                  id: emitId,
                  name: sanitizeGeminiFunctionName(name),
                  response: { result: parsedResp }
                }
              });
            }
            if (toolParts.length > 0) {
              result.contents.push({ role: GEMINI_ROLE.USER, parts: toolParts });
            }
          }
        } else if (parts.length > 0) {
          result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
        }
      }
    }
  }

  // Apply structured outputs after messages so existing system instructions survive.
  const responseFormat = body.response_format;
  if (responseFormat?.type === "json_schema" || responseFormat?.type === "json_object") {
    result.generationConfig.responseMimeType = "application/json";
    const jsonInstruction = "You must respond with valid JSON. Respond ONLY with a JSON object, no other text.";
    let instructionText;
    if (responseFormat.type === "json_schema") {
      const nested = responseFormat.json_schema?.schema !== undefined;
      const rawSchema = nested ? responseFormat.json_schema.schema : responseFormat.schema;
      const location = nested ? "response_format.json_schema.schema" : "response_format.schema";
      try {
        if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) throw new SchemaError("schema_shape");
        // Response purpose preserves empty objects; the original schema remains
        // in prompt guidance, alongside the caller's existing system instructions.
        const responseSchema = cleanJSONSchemaForAntigravity(rawSchema, {
          purpose: SCHEMA_PURPOSE.RESPONSE, budget: schemaBudget, location,
        });
        const schemaJson = JSON.stringify(rawSchema, null, 2);
        instructionText = `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;
        result.generationConfig.responseSchema = responseSchema;
      } catch (error) {
        // Explicit schemas fail closed, including unexpected preparation bugs.
        // Never silently substitute generic JSON or expose the original exception.
        throw asSchemaError(error, location);
      }
    } else {
      instructionText = jsonInstruction;
    }
    if (instructionText) {
      if (result.systemInstruction) {
        result.systemInstruction.parts.push({ text: instructionText });
      } else {
        result.systemInstruction = { role: GEMINI_ROLE.USER, parts: [{ text: instructionText }] };
      }
    }
  }

  
  // Convert tools
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const functionDeclarations = [];
    for (const t of body.tools) {
      // Check if already in Anthropic/Claude format (no type field, direct name/description/input_schema)
      if (t.name && t.input_schema) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(t.input_schema || { type: "object", properties: {} }, { budget: schemaBudget });
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(t.name),
          description: t.description || "",
          parameters: cleanedSchema
        });
      }
      // OpenAI format
      else if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
        const fn = t.function;
        const cleanedSchema = cleanJSONSchemaForAntigravity(fn.parameters || { type: "object", properties: {} }, { budget: schemaBudget });
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(fn.name),
          description: fn.description || "",
          parameters: cleanedSchema
        });
      }
    }

    if (functionDeclarations.length > 0) {
      result.tools = [{ functionDeclarations }];
    }
  }

  result.contents = normalizeGeminiContents(result.contents);
  return result;
}

// OpenAI -> Gemini (standard API)
export function openaiToGeminiRequest(model, body, stream, credentials = null) {
  return openaiToGeminiBase(model, body, stream, DEFAULT_THINKING_AG_SIGNATURE, credentials?._clientSessionId);
}

// OpenAI -> Gemini CLI (Cloud Code Assist)
export function openaiToGeminiCLIRequest(model, body, stream, credentials = null) {
  const gemini = openaiToGeminiBase(model, body, stream, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE, credentials?._clientSessionId);
  // Thinking is normalized centrally by applyThinking (thinkingUnified.js) after translation.

  // The base translator already cleaned and budgeted every schema.
  return gemini;
}

// Wrap Gemini CLI format in Cloud Code wrapper
function wrapInCloudCodeEnvelope(model, geminiCLI, credentials = null, isAntigravity = false) {
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: isAntigravity ? "antigravity" : "gemini-cli",
    requestId: isAntigravity ? `agent-${generateUUID()}` : generateRequestId(),
    request: {
      sessionId: toNumericSessionId(credentials?._clientSessionId) || (isAntigravity ? deriveSessionId(credentials?.email || credentials?.connectionId) : generateSessionId()),
      contents: geminiCLI.contents,
      systemInstruction: geminiCLI.systemInstruction,
      generationConfig: geminiCLI.generationConfig,
      tools: geminiCLI.tools,
    }
  };

  // Antigravity specific fields.
  // NOTE: the official Antigravity client omits `requestType` entirely on the
  // agent (chat) path. Sending `requestType: "agent"` triggers a detail-free
  // 429 RESOURCE_EXHAUSTED even with quota available.
  if (!isAntigravity) {
    // Keep safetySettings for Gemini CLI
    envelope.request.safetySettings = geminiCLI.safetySettings;
  }

  if (geminiCLI.tools?.length > 0) {
    envelope.request.toolConfig = {
      functionCallingConfig: { mode: "VALIDATED" }
    };
  }

  return envelope;
}

/**
 * Build Antigravity's Claude envelope, budgeting all tool schemas together.
 * @param {string} model - Target Claude model.
 * @param {Object} claudeRequest - Read-only translated request.
 * @param {Object|null} [credentials=null] - Read-only project/session metadata.
 * @param {string} [signature] - Default thought signature.
 * @returns {Object} New envelope with owned tool schemas and preserved instructions.
 * @throws {SchemaError} If a tool schema is invalid or cannot be prepared safely.
 */
function wrapInCloudCodeEnvelopeForClaude(model, claudeRequest, credentials = null, signature = DEFAULT_THINKING_AG_SIGNATURE) {
  const schemaBudget = createSchemaBudget();
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: "antigravity",
    requestId: `agent-${generateUUID()}`,
    // NOTE: official Antigravity client omits `requestType` on the agent (chat)
    // path — see the note in wrapInCloudCodeEnvelope() above.
    request: {
      sessionId: toNumericSessionId(credentials?._clientSessionId) || deriveSessionId(credentials?.email || credentials?.connectionId),
      contents: [],
      generationConfig: {
        temperature: claudeRequest.temperature || 1,
        maxOutputTokens: claudeRequest.max_tokens || 4096
      }
    }
  };

  // Build tool_use id -> name map so functionResponse can use the correct name
  const toolUseIdToName = {};
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TOOL_USE && block.id && block.name) {
            toolUseIdToName[block.id] = block.name;
          }
        }
      }
    }
  }

  // Convert Claude messages to Gemini contents
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      const parts = [];

      if (Array.isArray(msg.content)) {
        let firstToolUseSeen = false;
        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TEXT) {
            parts.push({ text: block.text });
          } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
            const cachedSig = block.id ? getGeminiThoughtSignatureSync(block.id, credentials?._clientSessionId, model) : null;
            const callSig = cachedSig || (!firstToolUseSeen ? signature : undefined);
            firstToolUseSeen = true;

            const part = {
              functionCall: {
                id: block.id,
                name: sanitizeGeminiFunctionName(block.name),
                args: block.input || {}
              }
            };
            if (callSig) {
              part.thoughtSignature = callSig;
            }
            parts.push(part);
          } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
            let content = block.content;
            if (Array.isArray(content)) {
              content = content.map(c => c.type === CLAUDE_BLOCK.TEXT ? c.text : JSON.stringify(c)).join("\n");
            }
            // Resolve the original tool name from the id — Gemini requires it to match the functionCall name
            const resolvedName = toolUseIdToName[block.tool_use_id]
              ? sanitizeGeminiFunctionName(toolUseIdToName[block.tool_use_id])
              : "tool";
            parts.push({
              functionResponse: {
                id: block.tool_use_id,
                name: resolvedName,
                response: { result: tryParseJSON(content) || content }
              }
            });
          }
        }
      } else if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      }

      if (parts.length > 0) {
        envelope.request.contents.push({
          role: msg.role === ROLE.ASSISTANT ? GEMINI_ROLE.MODEL : GEMINI_ROLE.USER,
          parts
        });
      }
    }
  }

  // Convert Claude tools to Gemini functionDeclarations
  if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
    const functionDeclarations = [];
    for (const tool of claudeRequest.tools) {
      if (tool.name && tool.input_schema) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(tool.input_schema, { budget: schemaBudget });
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(tool.name),
          description: tool.description || "",
          parameters: cleanedSchema
        });
      }
    }
    if (functionDeclarations.length > 0) {
      envelope.request.tools = [{ functionDeclarations }];
      envelope.request.toolConfig = {
        functionCallingConfig: { mode: "VALIDATED" }
      };
    }
  }

  const systemParts = [];
  // Merge user system prompt from claudeRequest
  if (claudeRequest.system) {
    if (Array.isArray(claudeRequest.system)) {
      for (const block of claudeRequest.system) {
        if (block.text) systemParts.push({ text: block.text });
      }
    } else if (typeof claudeRequest.system === "string") {
      systemParts.push({ text: claudeRequest.system });
    }
  }

  if (systemParts.length > 0) {
    envelope.request.systemInstruction = { role: GEMINI_ROLE.USER, parts: systemParts };
  }

  envelope.request.contents = normalizeGeminiContents(envelope.request.contents);
  return envelope;
}

// Detect if model should use Claude backend in Antigravity
// Claude models have specific ID patterns — more reliable than caps at routing level
function isClaudeModel(model) {
  return model.toLowerCase().includes("claude");
}

// OpenAI -> Antigravity (Sandbox Cloud Code with wrapper)
export function openaiToAntigravityRequest(model, body, stream, credentials = null) {
  if (isClaudeModel(model)) {
    const claudeRequest = openaiToClaudeRequestForAntigravity(model, body, stream);
    return wrapInCloudCodeEnvelopeForClaude(model, claudeRequest, credentials);
  }

  const geminiCLI = openaiToGeminiCLIRequest(model, body, stream);
  return wrapInCloudCodeEnvelope(model, geminiCLI, credentials, true);
}

// Register
register(FORMATS.OPENAI, FORMATS.GEMINI, openaiToGeminiRequest, null);
register(FORMATS.OPENAI, FORMATS.GEMINI_CLI, (model, body, stream, credentials) => wrapInCloudCodeEnvelope(model, openaiToGeminiCLIRequest(model, body, stream), credentials), null);
register(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, openaiToAntigravityRequest, null);
