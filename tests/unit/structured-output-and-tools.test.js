import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import {
  openaiToAntigravityRequest,
  openaiToGeminiRequest,
} from "../../open-sse/translator/request/openai-to-gemini.js";
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../../open-sse/translator/request/openai-responses.js";
import * as geminiHelpers from "../../open-sse/translator/formats/gemini.js";
import { GEMINI_ROLE, OPENAI_BLOCK, ROLE } from "../../open-sse/translator/schema/index.js";

const JSON_INSTRUCTION = "You must respond with valid JSON. Respond ONLY with a JSON object, no other text.";
const credentials = { connectionId: "structured-output-test", projectId: "test-project" };
const messages = [{ role: ROLE.USER, content: "Return a title." }];

/**
 * Build a fresh schema with a keyword-like property name and unsupported constraints.
 * @returns {Object} Schema fixture for cleanup and input-mutation assertions.
 */
function makeSchema() {
  return {
    type: "object",
    properties: { title: { type: "string", minLength: 1 } },
    required: ["title"],
    additionalProperties: false,
  };
}

/**
 * Build a Chat Completions JSON schema format with all optional metadata populated.
 * @returns {Object} Fresh response_format fixture for translation and round-trip checks.
 */
function makeResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "title_output",
      schema: makeSchema(),
      strict: true,
      description: "A generated title",
    },
  };
}

/**
 * Build equivalent function declarations in either API's shape.
 * @param {boolean} [nested=false] - Use nested Chat Completions instead of flat Responses fields.
 * @returns {Object} Function tool with a fresh parameter schema.
 */
function makeTool(nested = false) {
  const fn = { name: "my_tool", parameters: makeSchema() };
  return nested
    ? { type: OPENAI_BLOCK.FUNCTION, function: fn }
    : { type: OPENAI_BLOCK.FUNCTION, ...fn };
}

/**
 * Run Codex request normalization with fixture credentials and caller overrides.
 * @param {Object} body - Fields to overlay on the minimal Responses request.
 * @param {string} [model="gpt-5.4-mini"] - Model whose tool transport should be exercised.
 * @returns {Object} Transformed upstream request; no network call is made.
 */
function transformCodex(body, model = "gpt-5.4-mini") {
  return new CodexExecutor().transformRequest(model, {
    model,
    input: "Return a title.",
    ...body,
  }, true, credentials);
}

// Failure-path spies must not leak into the next schema or provider case.
afterEach(() => vi.restoreAllMocks());

// Assert identical schema behavior for direct Gemini and Antigravity's inner request.
describe.each([
  ["Gemini", (body) => openaiToGeminiRequest("gemini-3.8-flash-high", body, false, credentials)],
  ["Antigravity", (body) => openaiToAntigravityRequest("gemini-3.8-flash-high", body, false, credentials).request],
])("%s structured outputs", (_label, translate) => {
  it.each([
    ["nested", true], ["nested", false], ["flat", true], ["flat", false],
  ])("maps a %s schema with existing system instruction=%s", (shape, hasSystem) => {
    const schema = makeSchema();
    const body = {
      messages: hasSystem ? [{ role: ROLE.SYSTEM, content: "Keep the title short." }, ...messages] : messages,
      temperature: 0.2,
      response_format: shape === "nested"
        ? { type: "json_schema", json_schema: { name: "title_output", schema } }
        : { type: "json_schema", schema },
    };
    const original = structuredClone(body);
    const result = translate(body);

    expect(result.generationConfig).toEqual({
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    });
    const instruction = `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;
    expect(result.systemInstruction).toEqual({
      role: GEMINI_ROLE.USER,
      parts: [...(hasSystem ? [{ text: "Keep the title short." }] : []), { text: instruction }],
    });
    expect(result.contents[0].parts).toEqual([{ text: "Return a title." }]);
    expect(body).toEqual(original);
  });

  it.each([true, false])("maps JSON object mode with existing system instruction=%s", (hasSystem) => {
    const result = translate({
      messages: hasSystem ? [{ role: ROLE.SYSTEM, content: "Keep the title short." }, ...messages] : messages,
      response_format: { type: "json_object" },
    });
    expect(result.generationConfig).toEqual({ responseMimeType: "application/json" });
    expect(result.systemInstruction).toEqual({
      role: GEMINI_ROLE.USER,
      parts: [...(hasSystem ? [{ text: "Keep the title short." }] : []), { text: JSON_INSTRUCTION }],
    });
  });

  it("preserves keyword-like property names while stripping nested schema annotations", () => {
    const result = translate({
      messages,
      response_format: { type: "json_schema", schema: {
        type: "object",
        title: "Output metadata",
        properties: {
          records: { type: "array", items: {
            type: "object",
            properties: {
              title: { type: "string", title: "Field metadata", minLength: 1 },
              "x-label": { type: "string", "x-extra": true },
            },
            required: ["title", "x-label"],
          } },
        },
      } },
    });
    const schema = result.generationConfig.responseSchema;
    expect(schema).not.toHaveProperty("title");
    expect(schema.properties.records.items).toEqual({
      type: "object",
      properties: { title: { type: "string" }, "x-label": { type: "string" } },
      required: ["title", "x-label"],
    });
  });

  it("resolves and inlines $defs and $ref in response schema", () => {
    const result = translate({
      messages,
      response_format: {
        type: "json_schema",
        schema: {
          $ref: "#/$defs/Root",
          $defs: {
            Root: {
              type: "object",
              properties: {
                rating: {
                  anyOf: [
                    { const: "low" },
                    { const: "medium" },
                    { const: "high" },
                    { type: "null" },
                  ],
                },
                evidence: {
                  type: "array",
                  items: { $ref: "#/$defs/EvidenceRef" },
                },
              },
              required: ["rating", "evidence"],
            },
            EvidenceRef: {
              type: "object",
              properties: {
                blockId: { type: "string" },
                quote: { type: "string" },
              },
              required: ["blockId", "quote"],
            },
          },
        },
      },
    });
    const schema = result.generationConfig.responseSchema;
    expect(schema).not.toHaveProperty("$defs");
    expect(schema).not.toHaveProperty("$ref");
    expect(schema.type).toBe("object");
    expect(schema.properties.evidence.items).toEqual({
      type: "object",
      properties: {
        blockId: { type: "string" },
        quote: { type: "string" },
      },
      required: ["blockId", "quote"],
    });
    expect(schema.properties.rating).toEqual({
      type: "string",
      enum: ["low", "medium", "high"],
      nullable: true,
    });
  });

  it("enables JSON mode without a schema", () => {
    const result = translate({ messages, response_format: { type: "json_schema" } });
    expect(result.generationConfig).toEqual({ responseMimeType: "application/json" });
    expect(result.systemInstruction).toBeUndefined();
  });

  it.each([undefined, null, { type: "text" }, { type: "unknown" }])("ignores unsupported or absent format %j", (response_format) => {
    const result = translate({ messages, response_format });
    expect(result.generationConfig).toEqual({});
    expect(result.systemInstruction).toBeUndefined();
  });

  it.each(["cleaning", "serialization"])("keeps JSON mode and existing instructions when schema %s fails", (stage) => {
    const schema = makeSchema();
    if (stage === "cleaning") {
      vi.spyOn(geminiHelpers, "cleanJSONSchemaForAntigravity").mockImplementationOnce(() => { throw new Error("clean failed"); });
    } else {
      // Cleaning removes this unsupported keyword, but serializing the original schema fails.
      schema.default = 1n;
    }
    const result = translate({
      messages: [{ role: ROLE.SYSTEM, content: "Keep the title short." }, ...messages],
      response_format: { type: "json_schema", json_schema: { schema } },
    });
    expect(result.generationConfig).toEqual({ responseMimeType: "application/json" });
    expect(result.systemInstruction.parts).toEqual([
      { text: "Keep the title short." }, { text: JSON_INSTRUCTION },
    ]);
  });
});

describe("Chat Completions to Responses structured outputs and tools", () => {
  /**
   * Translate Chat fields with a shared user message and fixture credentials.
   * @param {Object} fields - Request fields under test.
   * @returns {Object} Translated Responses request.
   */
  const translate = (fields) => openaiToOpenAIResponsesRequest("gpt-5.4-mini", { messages, ...fields }, false, credentials);

  it.each([
    { type: OPENAI_BLOCK.FUNCTION, function: { name: "my_tool" } },
    { type: OPENAI_BLOCK.FUNCTION, name: "my_tool" },
    { type: OPENAI_BLOCK.FUNCTION, name: "my_tool", function: { name: "other_tool" } },
  ])("normalizes function choice %j", (tool_choice) => {
    const result = translate({ tools: [makeTool(true)], tool_choice });
    expect(result.tool_choice).toEqual({ type: OPENAI_BLOCK.FUNCTION, name: "my_tool" });
    expect(result.tools[0].name).toBe("my_tool");
  });

  it.each(["auto", "none", "required"])("preserves string choice %s", (tool_choice) => {
    expect(translate({ tool_choice }).tool_choice).toBe(tool_choice);
  });

  it.each([
    { type: OPENAI_BLOCK.FUNCTION },
    { type: OPENAI_BLOCK.FUNCTION, function: {} },
    { type: "web_search" },
    { type: "custom", name: "apply_patch" },
  ])("passes through choice %j", (tool_choice) => {
    expect(translate({ tool_choice }).tool_choice).toEqual(tool_choice);
  });

  it.each(["nested", "flat"])("maps a %s JSON schema with all metadata", (shape) => {
    const response_format = makeResponseFormat();
    const result = translate({ response_format: shape === "nested"
      ? response_format : { type: "json_schema", ...response_format.json_schema } });
    expect(result.text).toEqual({ format: { type: "json_schema", ...response_format.json_schema } });
    expect(result).not.toHaveProperty("response_format");
  });

  it("maps JSON object mode", () => {
    expect(translate({ response_format: { type: "json_object" } }).text).toEqual({ format: { type: "json_object" } });
  });

  it.each([null, {}, { format: { type: "json_object" }, verbosity: "low" }])("gives explicit text precedence: %j", (text) => {
    expect(translate({ text, response_format: makeResponseFormat() }).text).toEqual(text);
  });

  it("preserves false strict without inventing optional metadata", () => {
    const schema = makeSchema();
    const result = translate({ response_format: { type: "json_schema", json_schema: { schema, strict: false } } });
    expect(JSON.parse(JSON.stringify(result.text))).toEqual({ format: { type: "json_schema", schema, strict: false } });
  });

  it("does not add text or tool_choice when absent or unsupported", () => {
    expect(translate({})).not.toHaveProperty("text");
    expect(translate({})).not.toHaveProperty("tool_choice");
    expect(translate({ response_format: { type: "unknown" } })).not.toHaveProperty("text");
  });

  it("retains native Responses passthrough", () => {
    const body = {
      input: "Return a title.",
      text: { format: { type: "json_object" } },
      tools: [makeTool()],
      tool_choice: { type: OPENAI_BLOCK.FUNCTION, name: "my_tool" },
    };
    const original = structuredClone(body);
    expect(openaiToOpenAIResponsesRequest("gpt-5.4-mini", body, false, credentials))
      .toEqual({ ...body, model: "gpt-5.4-mini", stream: true });
    expect(body).toEqual(original);
  });
});

describe("Responses to Chat Completions structured outputs", () => {
  it.each(["json_schema", "json_object"])("maps %s and round-trips its format", (type) => {
    const format = type === "json_schema" ? { type, ...makeResponseFormat().json_schema } : { type };
    const body = { input: "Return a title.", text: { format } };
    const original = structuredClone(body);
    const result = openaiResponsesToOpenAIRequest("model", body, false, credentials);
    expect(result.response_format).toEqual(type === "json_schema" ? { type, json_schema: format } : { type });
    expect(result).not.toHaveProperty("text");
    expect(result.messages).toEqual([{ role: ROLE.USER, content: [{ type: OPENAI_BLOCK.TEXT, text: "Return a title." }] }]);
    expect(body).toEqual(original);
    expect(openaiToOpenAIResponsesRequest("model", result, false, credentials).text).toEqual({ format });
  });

  it("removes unsupported text.format without inventing response_format", () => {
    const result = openaiResponsesToOpenAIRequest("model", { input: "hello", text: { format: { type: "text" } } }, false);
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("response_format");
  });

  it("preserves text without a format", () => {
    const text = { verbosity: "low" };
    expect(openaiResponsesToOpenAIRequest("model", { input: "hello", text }, false).text).toEqual(text);
  });
});

describe("Codex forced function choices", () => {
  it.each([true, false])("normalizes and trims valid choices with nested shape=%s", (nested) => {
    const tool_choice = nested
      ? { type: OPENAI_BLOCK.FUNCTION, function: { name: " my_tool " } }
      : { type: OPENAI_BLOCK.FUNCTION, name: " my_tool " };
    const result = transformCodex({ tools: [makeTool(nested)], tool_choice });
    expect(result.tool_choice).toEqual({ type: OPENAI_BLOCK.FUNCTION, name: "my_tool" });
    expect(result.tools[0].name).toBe(result.tool_choice.name);
  });

  it.each([
    { type: OPENAI_BLOCK.FUNCTION },
    { type: OPENAI_BLOCK.FUNCTION, name: "unknown_tool" },
    { type: OPENAI_BLOCK.FUNCTION, function: { name: "unknown_tool" } },
    { type: OPENAI_BLOCK.FUNCTION, name: " " },
    { type: OPENAI_BLOCK.FUNCTION, function: { name: " " } },
    { type: OPENAI_BLOCK.FUNCTION, name: 123 },
    { type: OPENAI_BLOCK.FUNCTION, function: { name: 123 } },
  ])("removes invalid choice %j", (tool_choice) => {
    expect(transformCodex({ tools: [makeTool()], tool_choice })).not.toHaveProperty("tool_choice");
  });

  it("removes a forced function choice when no declared tools survive", () => {
    const result = transformCodex({ tools: [{ type: OPENAI_BLOCK.FUNCTION, name: " " }],
      tool_choice: { type: OPENAI_BLOCK.FUNCTION, function: { name: "my_tool" } } });
    expect(result.tools).toEqual([]);
    expect(result).not.toHaveProperty("tool_choice");
  });

  it.each(["auto", "none", "required", { type: "web_search" }])("preserves non-function choice %j", (tool_choice) => {
    expect(transformCodex({ tools: [makeTool()], tool_choice }).tool_choice).toEqual(tool_choice);
  });

  it.each([
    ["gpt-5.4-mini", "json_schema"], ["gpt-5.4-mini", "json_object"],
    ["gpt-6-luna", "json_schema"], ["gpt-6-luna", "json_object"],
  ])("preserves Chat tool choices and %s %s formatting through the executor", (model, type) => {
    const response_format = type === "json_schema" ? makeResponseFormat() : { type };
    const translated = openaiToOpenAIResponsesRequest(model, {
      messages,
      tools: [makeTool(true)],
      tool_choice: { type: OPENAI_BLOCK.FUNCTION, function: { name: "my_tool" } },
      response_format,
    }, false, credentials);
    const result = transformCodex(translated, model);
    expect(result.tool_choice).toEqual({ type: OPENAI_BLOCK.FUNCTION, name: "my_tool" });
    expect(result.text).toEqual({ format: type === "json_schema" ? { type, ...response_format.json_schema } : { type } });
    // This model carries tools in an input item; other models retain top-level tools.
    const tools = model === "gpt-6-luna"
      ? result.input.find((item) => item.type === "additional_tools").tools
      : result.tools;
    expect(tools[0].name).toBe(result.tool_choice.name);
    expect(result).not.toHaveProperty("response_format");
  });
});
