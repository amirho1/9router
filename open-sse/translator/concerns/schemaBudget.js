import { SCHEMA_LIMITS } from "../../config/schemaCompatibility.js";
import { SchemaError } from "../../utils/schemaErrors.js";

const encoder = new TextEncoder();

/**
 * Create independent phase counters shared by all schemas in one request.
 * @param {Object} [limits] - Internal test overrides, never request-controlled.
 * @returns {Object} Mutable request budget using centralized defaults.
 */
export function createSchemaBudget(limits = {}) {
  return {
    limits: { ...SCHEMA_LIMITS, ...limits },
    source: { nodes: 0, bytes: 0 },
    expanded: { nodes: 0, bytes: 0 },
    output: { nodes: 0, bytes: 0 },
  };
}

/**
 * Meter a single schema while also charging its shared request budget.
 * @param {Object} budget - Mutable counters returned by createSchemaBudget.
 * @param {"source"|"expanded"|"output"} phase - Independently limited phase.
 * @returns {Object} Charging methods; each throws SchemaError on excess.
 */
export function createSchemaMeter(budget, phase) {
  const { limits } = budget;
  const total = budget[phase];
  let nodes = 0;
  let bytes = 0;

  /**
   * Charge before allocating or traversing the next value.
   * @param {number} n - Nodes or intersection operations.
   * @param {number} b - Serialized bytes, including separators.
   * @returns {void} Updates both local and shared counters.
   * @throws {SchemaError} If a schema or request limit is exceeded.
   */
  function charge(n, b) {
    nodes += n;
    bytes += b;
    total.nodes += n;
    total.bytes += b;
    if (nodes > limits.maxNodes || bytes > limits.maxBytes ||
      total.nodes > limits.maxRequestNodes || total.bytes > limits.maxRequestBytes) {
      throw new SchemaError("schema_size");
    }
  }

  /**
   * Preflight raw length before allocating escaped UTF-8 string data.
   * @param {string} value - Read-only key or value.
   * @returns {number} JSON byte length, including quotes and escapes.
   * @throws {SchemaError} When the string alone exceeds a limit.
   */
  function stringBytes(value) {
    if (value.length > limits.maxBytes || value.length > limits.maxRequestBytes) throw new SchemaError("schema_size");
    return encoder.encode(JSON.stringify(value)).length;
  }

  return {
    /**
     * @param {number} depth - Container/reference depth to check.
     * @returns {void}
     * @throws {SchemaError} When nesting is excessive.
     */
    depth(depth) {
      if (depth > limits.maxDepth) throw new SchemaError("schema_depth");
    },
    /**
     * @param {*} value - Read-only value charged before copying.
     * @param {number} depth - Current JSON depth.
     * @returns {void}
     * @throws {SchemaError} When depth or size is excessive.
     */
    value(value, depth) {
      this.depth(depth);
      const size = value !== null && typeof value === "object" ? 2
        : typeof value === "string" ? stringBytes(value) : JSON.stringify(value)?.length || 0;
      charge(1, size + 1);
    },
    /**
     * @param {string} key - Property name charged as data, never interpreted.
     * @returns {void}
     * @throws {SchemaError} When the byte budget is exceeded.
     */
    key(key) { charge(0, stringBytes(key) + 1); },
    /**
     * Charge composition work even if its output is smaller than its inputs.
     * @returns {void}
     * @throws {SchemaError} When the node/work budget is exceeded.
     */
    work() { charge(1, 0); },
  };
}

/**
 * Inspect JSON incrementally without cloning it or allocating an entries array.
 * @param {*} value - Read-only source or completed output.
 * @param {Object} meter - Per-schema meter to mutate.
 * @param {number} [depth=0] - Current JSON depth.
 * @param {Set<Object>} [ancestors] - Active objects, for in-memory cycle detection.
 * @returns {void}
 * @throws {SchemaError} For cycles, excessive size, or excessive nesting.
 */
export function inspectSchemaJson(value, meter, depth = 0, ancestors = new Set()) {
  meter.value(value, depth);
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) throw new SchemaError("schema_cycle");
  ancestors.add(value);
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (!Array.isArray(value)) meter.key(key);
    inspectSchemaJson(value[key], meter, depth + 1, ancestors);
  }
  ancestors.delete(value);
}
