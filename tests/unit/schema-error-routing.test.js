import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/structured-assessment/structured-assessment.json";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), fetch: vi.fn(), pending: vi.fn(), detail: vi.fn(async () => {}),
  credentials: vi.fn(), cooldown: vi.fn(), quota: vi.fn(), combo: vi.fn(),
  warn: vi.fn(),
}));

// Exercise real routing/translation/execution, replacing only I/O and account storage.
vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute: mocks.execute }) }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: mocks.pending, appendRequestLog: vi.fn(async () => {}), saveRequestDetail: mocks.detail,
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials, markAccountUnavailable: mocks.cooldown,
  clearAccountError: vi.fn(), extractApiKey: vi.fn(), isValidApiKey: vi.fn(),
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: mocks.quota, clearAntigravityStrikes: vi.fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials, updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({
  getComboModels: mocks.combo,
  getModelInfo: async () => ({ provider: "antigravity", model: "gemini-3.8-flash-high" }),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn(), maskKey: vi.fn(),
  tagForSession: undefined, nextTag: undefined, line: undefined, errorLine: undefined,
}));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

import { handleChat } from "../../src/sse/handlers/chat.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { isLocalSchemaFailure, SchemaError, schemaErrorResult } from "../../open-sse/utils/schemaErrors.js";
import * as helpers from "../../open-sse/translator/formats/gemini.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const credentials = { accessToken: "synthetic-token", connectionId: "synthetic-account", projectId: "synthetic-project" };
const log = { debug: vi.fn(), info: vi.fn(), warn: mocks.warn };

/** @returns {Object} Fresh synthetic request; caller may mutate it. */
function requestBody() { return structuredClone(fixture.request); }

/**
 * Dispatch through the app's account/combo loops without real storage or network.
 * @param {Object} body - Synthetic request serialized without mutation.
 * @returns {Promise<Response>} Real gateway HTTP response.
 */
function dispatch(body) {
  return handleChat(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.combo.mockResolvedValue(null);
  mocks.credentials.mockResolvedValue({ ...credentials });
  mocks.cooldown.mockResolvedValue({ shouldFallback: true });
  const executor = new AntigravityExecutor();
  mocks.execute.mockImplementation(options => executor.execute(options));
});
afterEach(() => vi.restoreAllMocks());

describe("local schema errors across HTTP, account and combo routing", () => {
  it.each([false, true])("returns 400 with zero generation or retry (combo=%s)", async combo => {
    if (combo) mocks.combo.mockResolvedValue(["ag/gemini-3.8-flash-high", "ag/gemini-3.8-pro-high"]);
    const body = requestBody();
    body.response_format.json_schema.schema = { $ref: "#/$defs/missing" };
    const response = await dispatch(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: {
      type: "invalid_request_error", code: "schema_reference", param: "response_format.json_schema.schema",
    } });
    expect(mocks.credentials).toHaveBeenCalledTimes(1);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.pending).not.toHaveBeenCalled();
    expect(mocks.cooldown).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it("returns safe 500 for a preparation bug without fallback or leaked details", async () => {
    mocks.combo.mockResolvedValue(["ag/gemini-3.8-flash-high", "ag/gemini-3.8-pro-high"]);
    vi.spyOn(helpers, "cleanJSONSchemaForAntigravity").mockImplementationOnce(() => {
      throw new ReferenceError("private-resume private-token undefined value");
    });
    const response = await dispatch(requestBody());
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error).toMatchObject({ type: "server_error", code: "schema_preparation_failed" });
    expect(JSON.stringify([payload, mocks.warn.mock.calls])).not.toMatch(/private-resume|private-token|undefined value/);
    expect(mocks.credentials).toHaveBeenCalledTimes(1);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.pending).not.toHaveBeenCalled();
    expect(mocks.cooldown).not.toHaveBeenCalled();
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it.each(["schema_reference", "schema_preparation_failed"])("clears only a started pending counter on native executor failure: %s", async code => {
    const schema = code === "schema_reference" ? { $ref: "#/$defs/missing" } : { type: "object", default: 1n };
    const result = await handleChatCore({
      body: { request: { contents: [{ role: "user", parts: [{ text: "synthetic" }] }], generationConfig: { responseSchema: schema } } },
      modelInfo: { provider: "antigravity", model: "gemini-3.8-flash-high" },
      credentials: { ...credentials }, connectionId: credentials.connectionId, log,
      sourceFormatOverride: FORMATS.ANTIGRAVITY,
    });
    expect(result.status).toBe(code === "schema_reference" ? 400 : 500);
    expect(result.nonRetryable).toBe(true);
    expect((await result.response.json()).error.code).toBe(code);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.pending.mock.calls.map(call => call[3])).toEqual([true, false]);
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it("sends the complete fixture schema through the real executor with one mocked upstream call", async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ response: {
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(fixture.assessment) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
    } }), { headers: { "content-type": "application/json" } }));
    const body = requestBody();
    body.stream = false;
    const response = await dispatch(body);
    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const outbound = JSON.parse(mocks.fetch.mock.calls[0][1].body).request;
    const schema = outbound.generationConfig.responseSchema;
    expect(schema.required).toEqual(expect.arrayContaining(["criteria", "sections", "summary"]));
    expect(schema.properties.criteria.items.properties.rating).toMatchObject({ type: "integer", minimum: 0, maximum: 4, nullable: true });
    expect(schema.properties.sections.items.properties.findings.items.properties.absenceReason.nullable).toBe(true);
    expect(outbound.systemInstruction.parts.some(part => part.text === fixture.request.messages[0].content)).toBe(true);
    expect(JSON.stringify(schema)).not.toMatch(/"\$ref"|"\$defs"/);
    const returned = await response.json();
    expect(JSON.parse(returned.choices[0].message.content)).toEqual(fixture.assessment);
    expect(mocks.pending.mock.calls.map(call => call[3])).toEqual([true, false]);
  });

  it.each(["schema_literal", "schema_preparation_failed"])("propagates the internal combo marker: %s", async code => {
    const response = schemaErrorResult(new SchemaError(code, "response_format.json_schema.schema")).response;
    const single = vi.fn(async () => response);
    expect(await handleComboChat({ body: {}, models: ["ag/first", "ag/second"], handleSingleModel: single, log, autoSwitch: false })).toBe(response);
    expect(single).toHaveBeenCalledTimes(1);
    expect(isLocalSchemaFailure(response)).toBe(true);
    expect(isLocalSchemaFailure(new Response(JSON.stringify({ error: { code }, nonRetryable: true }), { status: 500 }))).toBe(false);
  });
});
