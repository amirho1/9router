import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanJSONSchemaForAntigravity as clean, createSchemaBudget } from "../../open-sse/translator/formats/gemini.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { SchemaError } from "../../open-sse/utils/schemaErrors.js";
import { SCHEMA_LIMITS } from "../../open-sse/config/schemaCompatibility.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/structured-assessment/structured-assessment.json", import.meta.url), "utf8"));

/**
 * @param {Object} schema - Source schema to reject without mutation.
 * @param {string} code - Expected safe failure category.
 * @returns {void}
 */
function rejects(schema, code) {
  expect(() => clean(schema)).toThrowError(SchemaError);
  expect(() => clean(schema)).toThrowError(expect.objectContaining({ code, status: 400 }));
}

/**
 * Build a small reference DAG that expands exponentially if not budgeted.
 * @param {number} levels - Number of repeated left/right references.
 * @returns {Object} Read-only source fixture.
 */
function amplification(levels) {
  const $defs = { leaf: { type: "string" } };
  for (let i = 0; i < levels; i++) {
    const $ref = `#/$defs/${i ? `r${i - 1}` : "leaf"}`;
    $defs[`r${i}`] = { type: "object", properties: { left: { $ref }, right: { $ref } } };
  }
  return { $ref: `#/$defs/r${levels - 1}`, $defs };
}

describe("structured assessment schema compatibility", () => {
  it("preserves the real LangChain schema through translation and executor cleanup", () => {
    const body = structuredClone(fixture.request);
    const before = structuredClone(body);
    const credentials = { connectionId: "synthetic", projectId: "test" };
    const translated = openaiToAntigravityRequest("gemini-3.8-flash-high", body, true, credentials);
    const result = new AntigravityExecutor().transformRequest("gemini-3.8-flash-high", translated, true, credentials);
    const schema = result.request.generationConfig.responseSchema;
    expect(Object.keys(schema.properties)).toEqual(["criteria", "sections", "summary", "limitations"]);
    expect(schema.required).toEqual(["criteria", "sections", "summary", "limitations"]);
    expect(schema.properties.criteria.items.properties.rating).toEqual({
      type: "integer", minimum: 0, maximum: 4, nullable: true,
      description: expect.any(String),
    });
    const findings = schema.properties.sections.items.properties.findings.items;
    expect(findings.properties.absenceReason).toEqual({ type: "string", nullable: true });
    expect(findings.properties.suggestedImprovement).toEqual({ type: "string", nullable: true });
    expect(findings.properties.evidence.items.required).toEqual(["blockId", "pageNumber", "quote"]);
    expect(findings.required).toContain("absenceReason");
    expect(JSON.stringify(schema)).not.toMatch(/"\$(?:ref|defs)"|"reason"/);
    expect(result.request.systemInstruction.parts[0].text).toBe(body.messages[0].content);
    expect(result.request.systemInstruction.parts[1].text).toContain(JSON.stringify(body.response_format.json_schema.schema, null, 2));
    expect(body).toEqual(before);
    expect(clean(schema, { purpose: "response" })).toEqual(schema);
  });
});

describe("bounded reference expansion", () => {
  it("rejects amplification deterministically while counting repeated references", () => {
    const schema = amplification(16);
    expect(JSON.stringify(schema).length).toBeLessThan(2200);
    const budget = createSchemaBudget();
    expect(() => clean(schema, { budget })).toThrowError(expect.objectContaining({ code: "schema_size" }));
    expect(budget.expanded.nodes).toBeLessThanOrEqual(SCHEMA_LIMITS.maxNodes + 1);
    expect(budget.expanded.bytes).toBeLessThan(SCHEMA_LIMITS.maxBytes + 100);
  });

  it("rejects deep source objects and chains of references", () => {
    let schema = { type: "string" };
    for (let i = 0; i < 70; i++) schema = { type: "array", items: schema };
    rejects(schema, "schema_depth");
    const $defs = { leaf: { type: "string" } };
    for (let i = 0; i < 70; i++) $defs[`r${i}`] = { $ref: `#/$defs/${i ? `r${i - 1}` : "leaf"}` };
    rejects({ $ref: "#/$defs/r69", $defs }, "schema_depth");
  });

  it.each([
    [{ $ref: "#" }, "schema_cycle"],
    [{ $ref: "#/$defs/a", $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } } }, "schema_cycle"],
    [{ $ref: "#/missing" }, "schema_reference"],
    [{ $ref: "https://example.com/schema" }, "schema_reference"],
    [{ $ref: "#anchor" }, "schema_reference"],
    [{ $ref: "#/constructor" }, "schema_reference"],
    [{ $ref: "#/$defs/a~2b", $defs: {} }, "schema_reference"],
    [{ $dynamicRef: "#node" }, "schema_reference"],
    [{ $ref: "#/$defs/scoped", $defs: { scoped: { $id: "other-resource", $ref: "#/properties/value" } }, properties: { value: { type: "string" } } }, "schema_reference"],
  ])("rejects unsafe references %j", (schema, code) => rejects(schema, code));

  it("resolves escaped pointer keys and allows reuse without source mutation", () => {
    expect(clean({ $ref: "#/$defs/a~1b~0c%20d", $defs: { "a/b~c d": { type: "string" } } })).toEqual({ type: "string" });
    expect(clean({ $ref: "#%2F$defs%2Fname", $defs: { name: { type: "string" } } })).toEqual({ type: "string" });
    const schema = amplification(3);
    const before = structuredClone(schema);
    expect(clean(schema).properties.left.properties.right.properties.left).toEqual({ type: "string" });
    expect(schema).toEqual(before);
  });

  it("budgets annotations and aggregate request size", () => {
    rejects({ type: "string", description: "x".repeat(SCHEMA_LIMITS.maxBytes) }, "schema_size");
    const budget = createSchemaBudget({ maxRequestNodes: 7 });
    for (let i = 0; i < 3; i++) clean({ type: "string" }, { budget });
    expect(() => clean({ type: "string" }, { budget })).toThrowError(expect.objectContaining({ code: "schema_size" }));
    const byteBudget = createSchemaBudget({ maxRequestBytes: 100 });
    clean({ type: "string", description: "a".repeat(20) }, { budget: byteBudget });
    expect(() => clean({ type: "string", description: "b".repeat(20) }, { budget: byteBudget })).toThrowError(SchemaError);
    const tools = Array.from({ length: 20 }, (_, i) => ({ type: "function", function: {
      name: `tool_${i}`, parameters: { type: "object", description: "a".repeat(110000), properties: { value: { type: "string" } } },
    } }));
    expect(() => openaiToAntigravityRequest("gemini-3.8-flash-high", { messages: [], tools }, false)).toThrowError(SchemaError);
  });
});

describe("typed literals and schema purpose", () => {
  it("keeps all consecutive integer values and nullability, including duplicates", () => {
    const schema = { anyOf: [0, 1, 2, 2, 3, 4, null].map(value => ({ const: value })) };
    expect(clean(schema)).toEqual({ type: "integer", minimum: 0, maximum: 4, nullable: true });
    expect(clean({ const: 3 })).toEqual({ type: "integer", minimum: 3, maximum: 3 });
  });

  it("deduplicates strings and preserves literal oneOf exclusivity", () => {
    const nullable = clean({ anyOf: [{ const: "a" }, { enum: ["a", "b"] }, { const: null }] });
    expect(nullable).toEqual({ type: "string", enum: ["a", "b"], nullable: true });
    expect(clean(nullable)).toEqual(nullable);
    expect(clean({ oneOf: [{ enum: ["a", "b", "a"] }, { enum: ["b", "c"] }] })).toEqual({ type: "string", enum: ["a", "c"] });
    rejects({ oneOf: [{ const: "a" }, { const: "a" }] }, "schema_conflict");
    expect(clean({ oneOf: [{ enum: [0, 1, null] }, { enum: [1, 2, null] }, { const: 2 }] })).toEqual({ type: "integer", minimum: 0, maximum: 0 });
  });

  it("preserves complete booleans and nullable strings without inventing types", () => {
    expect(clean({ anyOf: [{ const: true }, { const: false }, { type: "null" }] })).toEqual({ type: "boolean", nullable: true });
    expect(clean({ anyOf: [{ type: "string" }, { type: "null" }] })).toEqual({ type: "string", nullable: true });
    rejects({ type: "string", nullable: "true" }, "schema_shape");
  });

  it.each([
    { enum: [0, 2, 4] }, { enum: [0.5, 1.5] }, { const: false }, { enum: ["one", 1] },
    { const: null }, { type: ["null"] }, { enum: "a", const: "a" },
    { enum: [Number.MAX_SAFE_INTEGER + 1] },
  ])("rejects unsupported literal restrictions %j", schema => rejects(schema, "schema_literal"));

  it("keeps response objects empty while retaining tool placeholders", () => {
    const schema = { type: "object", properties: { empty: { type: "object", properties: {}, additionalProperties: false } } };
    expect(clean(schema, { purpose: "response" })).toEqual({ type: "object", properties: { empty: { type: "object", properties: {} } } });
    expect(clean({ type: "object", properties: {} }, { purpose: "response" })).toEqual({ type: "object", properties: {} });
    expect(clean({}, { purpose: "response" })).toEqual({});
    expect(clean({}).required).toEqual(["reason"]);
  });

  it("treats property names as data and retains unrelated legacy cleanup", () => {
    const names = ["title", "type", "$ref", "$defs", "definitions", "const", "enum", "x-field", "__proto__"];
    const properties = Object.fromEntries(names.map(name => [name, { type: "STRING", title: "annotation", minLength: 1 }]));
    const schema = { type: "OBJECT", properties, required: names, additionalProperties: { $ref: "#/unused" } };
    const result = clean(schema, { purpose: "response" });
    expect(result.properties).toEqual(Object.fromEntries(names.map(name => [name, { type: "string" }])));
    expect(result.required).toEqual(names);
    expect(Object.hasOwn(result.properties, "__proto__")).toBe(true);
    expect({}.polluted).toBeUndefined();
  });
});

describe("reference sibling and allOf intersection", () => {
  it.each([false, true])("keeps base and extra properties inside allOf=%s", allOf => {
    const child = { $ref: "#/$defs/Base", properties: { extra: { type: "string" } }, required: ["extra"], description: "sibling" };
    const schema = { properties: { child: allOf ? { allOf: [child] } : child }, $defs: {
      Base: { type: "object", properties: { base: { type: "string" } }, required: ["base"], description: "base" },
    } };
    expect(clean(schema).properties.child).toEqual({ type: "object", properties: {
      base: { type: "string" }, extra: { type: "string" },
    }, required: ["base", "extra"], description: "sibling" });
  });

  it("intersects overlapping types, bounds, enums and item schemas", () => {
    const schema = { $ref: "#/$defs/Base", properties: {
      n: { type: "integer", minimum: 2 }, s: { enum: ["b", "c"] },
      a: { items: { type: "integer", minimum: 3 } },
    }, $defs: { Base: { properties: {
      n: { type: "number", maximum: 5 }, s: { type: "string", enum: ["a", "b"] },
      a: { type: "array", items: { type: "number", maximum: 4 } },
    } } } };
    expect(clean(schema).properties).toEqual({ n: { type: "integer", minimum: 2, maximum: 5 },
      s: { type: "string", enum: ["b"] }, a: { type: "array", items: { type: "integer", minimum: 3, maximum: 4 } } });
    expect(clean({ allOf: [{ type: "object", required: ["x"] }, { properties: { x: { type: "string" } } }] }).required).toEqual(["x"]);
  });

  it.each([
    [{ type: "string" }, { type: "number" }], [{ enum: ["a"] }, { enum: ["b"] }],
    [{ minimum: 5 }, { maximum: 2 }], [{ minimum: 0.1, maximum: 0.9 }, { type: "integer" }],
    [{ pattern: "^a" }, { pattern: "^b" }], [{ type: "object", properties: {} }, { required: ["missing"] }],
  ])("rejects contradictions rather than discarding constraints", (base, sibling) => {
    rejects({ $ref: "#/$defs/Base", ...sibling, $defs: { Base: base } }, "schema_conflict");
  });
});
