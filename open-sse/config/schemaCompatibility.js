/** Budgets apply independently to source, expanded work, and serialized output. */
export const SCHEMA_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 10000,
  maxBytes: 256 * 1024,
  maxRequestNodes: 50000,
  maxRequestBytes: 2 * 1024 * 1024,
});

/** Empty tool schemas retain synthetic arguments; response schemas never do. */
export const SCHEMA_PURPOSE = Object.freeze({ TOOL: "tool", RESPONSE: "response" });

/** JSON types shared by literal inference and provider lowering. */
export const SCHEMA_TYPE = Object.freeze({
  OBJECT: "object", ARRAY: "array", STRING: "string", NUMBER: "number",
  INTEGER: "integer", BOOLEAN: "boolean", NULL: "null",
});

/** Safe categories deliberately exclude caller values and account/quota wording. */
export const SCHEMA_ERROR_MESSAGES = Object.freeze({
  schema_size: "Schema exceeds the configured processing budget.",
  schema_depth: "Schema exceeds the configured nesting depth.",
  schema_reference: "Schema contains an unresolved or unsupported local reference.",
  schema_cycle: "Schema contains a cyclic reference.",
  schema_conflict: "Schema constraints have an empty or unrepresentable intersection.",
  schema_literal: "Schema literal restriction cannot be represented by this provider.",
  schema_shape: "Schema contains an invalid schema node.",
  schema_preparation_failed: "Unable to prepare the requested structured output schema.",
});
