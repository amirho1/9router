import { SCHEMA_PURPOSE, SCHEMA_TYPE as TYPE } from "../../config/schemaCompatibility.js";
import { SchemaError } from "../../utils/schemaErrors.js";
import { createSchemaBudget, createSchemaMeter, inspectSchemaJson } from "./schemaBudget.js";

/** Composition fields are traversed as schema lists, never as data dictionaries. */
const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
/** Sibling descriptions may override annotations but never supported assertions. */
const annotations = new Set(["title", "description", "default", "examples", "$comment"]);
/** Known types also admit the uppercase names used in native Gemini requests. */
const typeNames = new Set(Object.values(TYPE));

/**
 * Set an own data key safely, including caller field names such as __proto__.
 * @param {Object} object - Owned destination, mutated in place.
 * @param {string} key - Data key, not a prototype setter.
 * @param {*} value - Owned value to store.
 * @returns {void}
 */
function put(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * @param {*} value - Read-only candidate.
 * @returns {boolean} Whether the value is a schema/property dictionary.
 */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {*} value - Read-only primitive literal.
 * @returns {string} Type-preserving identity key; never used as a wire value.
 * @throws {SchemaError} For complex or non-finite literal restrictions.
 */
function literalKey(value) {
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new SchemaError("schema_literal");
  if (typeof value === "number" && !Number.isFinite(value)) throw new SchemaError("schema_literal");
  return JSON.stringify(value);
}

/**
 * @param {string|number|boolean|null} value - Primitive to inspect without mutation.
 * @returns {string} JSON type, distinguishing integers from fractional numbers.
 */
function literalType(value) {
  if (value === null) return TYPE.NULL;
  if (typeof value === "number") return Number.isInteger(value) ? TYPE.INTEGER : TYPE.NUMBER;
  return typeof value;
}

/**
 * @param {string} value - Native or JSON Schema type.
 * @returns {string} Canonical JSON type name.
 * @throws {SchemaError} For unsupported or malformed types.
 */
function canonicalType(value) {
  if (typeof value !== "string" || !typeNames.has(value.toLowerCase())) throw new SchemaError("schema_shape");
  return value.toLowerCase();
}

/**
 * @param {Object} schema - Schema inspected without mutation.
 * @returns {Set<string>|null} Explicit allowed types, including native nullability.
 */
function typeSet(schema) {
  if (!schema.type) return null;
  const types = new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (schema.nullable) types.add(TYPE.NULL);
  return types;
}

/**
 * @param {Object} schema - Read-only supported constraints.
 * @param {string|number|boolean|null} value - Candidate literal.
 * @returns {boolean} Whether type and numeric bounds admit the literal.
 */
function acceptsLiteral(schema, value) {
  const types = typeSet(schema);
  const type = literalType(value);
  if (types && !types.has(type) && !(type === TYPE.INTEGER && types.has(TYPE.NUMBER))) return false;
  return typeof value !== "number" ||
    ((schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum));
}

/**
 * Intersect owned nodes without replacing either node's supported constraints.
 * @param {Object} left - Owned result mutated in place.
 * @param {Object} right - Owned sibling/branch constraints, never source input.
 * @param {Object} context - Meter, removal policy and composed-node tracking.
 * @param {number} [depth=0] - Current output depth.
 * @returns {Object} The combined left node.
 * @throws {SchemaError} For contradictory or unrepresentable intersections.
 */
function intersect(left, right, context, depth = 0) {
  context.meter.depth(depth);
  context.meter.work();
  if (!isObject(left) || !isObject(right)) throw new SchemaError("schema_conflict");
  context.composed.add(left);
  const a = typeSet(left);
  const b = typeSet(right);
  let types;
  if (a && b) {
    types = [...a].filter(t => b.has(t) || (t === TYPE.INTEGER && b.has(TYPE.NUMBER)));
    if (a.has(TYPE.NUMBER) && b.has(TYPE.INTEGER)) types.push(TYPE.INTEGER);
    if (!types.length) throw new SchemaError("schema_conflict");
  } else types = a ? [...a] : b ? [...b] : null;

  // Assertions are combined; only annotations may use sibling precedence.
  for (const [key, value] of Object.entries(right)) {
    context.meter.work();
    if (key === "type" || key === "nullable") continue;
    if (!Object.hasOwn(left, key)) { put(left, key, value); continue; }
    if (key === "properties") {
      for (const [name, property] of Object.entries(value)) {
        context.meter.work();
        put(left.properties, name, Object.hasOwn(left.properties, name)
          ? intersect(left.properties[name], property, context, depth + 2) : property);
      }
    } else if (key === "required") left.required = [...new Set([...left.required, ...value])];
    else if (key === "enum") {
      const allowed = new Set(value.map(literalKey));
      left.enum = left.enum.filter(v => allowed.has(literalKey(v)));
      if (!left.enum.length) throw new SchemaError("schema_conflict");
    } else if (key === "minimum") left.minimum = Math.max(left.minimum, value);
    else if (key === "maximum") left.maximum = Math.min(left.maximum, value);
    else if (key === "items") left.items = intersect(left.items, value, context, depth + 1);
    else if (annotations.has(key) || context.unsupported.has(key) || key.startsWith("x-")) put(left, key, value);
    else if (JSON.stringify(left[key]) !== JSON.stringify(value)) throw new SchemaError("schema_conflict");
  }
  if (types) {
    types = [...new Set(types)].filter(t => t !== TYPE.INTEGER || !types.includes(TYPE.NUMBER));
    if (!left.enum && types.filter(t => t !== TYPE.NULL).length > 1) throw new SchemaError("schema_conflict");
    left.type = types.length === 1 ? types[0] : types;
    delete left.nullable;
  } else if (right.nullable) left.nullable = true;
  if (left.minimum > left.maximum) throw new SchemaError("schema_conflict");
  if (left.type === TYPE.INTEGER && Math.ceil(left.minimum) > Math.floor(left.maximum)) throw new SchemaError("schema_conflict");
  if (left.enum) {
    left.enum = left.enum.filter(v => acceptsLiteral(left, v));
    if (!left.enum.length) throw new SchemaError("schema_conflict");
  }
  return left;
}

/**
 * Compile JSON Schema to the existing Gemini Schema transport without mutation.
 * Every source, expansion and output is bounded by centralized schema/request limits.
 * @param {Object} schema - Read-only source schema; local pointers resolve here.
 * @param {Object} [options] - Purpose and shared request counters.
 * @param {"tool"|"response"} [options.purpose="tool"] - Empty-schema policy.
 * @param {Object} [options.budget] - Budget mutated across all request schemas.
 * @param {string[]} [unsupportedKeywords] - Existing unrelated keyword removal policy.
 * @returns {Object} Owned provider schema.
 * @throws {SchemaError} For invalid, unsafe or unrepresentable schemas.
 */
export function prepareGeminiSchema(schema, { purpose = SCHEMA_PURPOSE.TOOL, budget = createSchemaBudget() } = {}, unsupportedKeywords = []) {
  inspectSchemaJson(schema, createSchemaMeter(budget, "source"));
  const meter = createSchemaMeter(budget, "expanded");
  const context = { meter, unsupported: new Set(unsupportedKeywords), composed: new WeakSet() };
  const active = new Set();
  const pointers = new Map();

  /**
   * Resolve a local JSON Pointer using only own properties; never fetch a URI.
   * @param {string} ref - Fragment pointer supporting URI and ~0/~1 escapes.
   * @returns {Object} Borrowed source node, never mutated.
   * @throws {SchemaError} For unsupported, missing or non-schema targets.
   */
  function resolve(ref) {
    if (typeof ref !== "string" || !ref.startsWith("#")) throw new SchemaError("schema_reference");
    if (pointers.has(ref)) return pointers.get(ref);
    let pointer;
    try { pointer = decodeURIComponent(ref.slice(1)); } catch { throw new SchemaError("schema_reference"); }
    if (pointer && !pointer.startsWith("/")) throw new SchemaError("schema_reference");
    let target = schema;
    for (const part of pointer ? pointer.slice(1).split("/") : []) {
      if (/~(?![01])/u.test(part)) throw new SchemaError("schema_reference");
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if ((!isObject(target) && !Array.isArray(target)) || !Object.hasOwn(target, key)) throw new SchemaError("schema_reference");
      target = target[key];
    }
    if (!isObject(target)) throw new SchemaError("schema_reference");
    pointers.set(ref, target);
    return target;
  }

  /**
   * Copy non-schema data without interpreting keyword-like keys.
   * @param {*} value - Read-only annotation or literal data, source-budgeted already.
   * @param {number} depth - Current JSON depth.
   * @returns {*} Bounded copy.
   * @throws {SchemaError} On excessive expansion or nesting.
   */
  function copy(value, depth) {
    meter.value(value, depth);
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(v => copy(v, depth + 1));
    const result = {};
    for (const [key, child] of Object.entries(value)) { meter.key(key); put(result, key, copy(child, depth + 1)); }
    return result;
  }

  /**
   * Normalize const/enums before intersection while keeping primitive values typed.
   * @param {Object} node - Owned node mutated in place.
   * @returns {void}
   * @throws {SchemaError} For malformed literals or empty accepted sets.
   */
  function literals(node) {
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length)) throw new SchemaError("schema_literal");
    if (Object.hasOwn(node, "const")) {
      if (node.enum && !node.enum.some(v => literalKey(v) === literalKey(node.const))) throw new SchemaError("schema_conflict");
      node.enum = [node.const];
      delete node.const;
    }
    if (node.enum) {
      // Native Gemini nullable enums include null outside their string enum list.
      // Restoring it internally makes a second cleanup pass semantically stable.
      if (node.nullable) node.enum.push(null);
      node.enum = [...new Map(node.enum.map(v => [literalKey(v), v])).values()].filter(v => acceptsLiteral(node, v));
      if (!node.enum.length) throw new SchemaError("schema_conflict");
    }
  }

  /**
   * Normalize literal unions exactly, preserving the legacy structural preference.
   * @param {Object} node - Owned schema and branches, mutated in place.
   * @param {"anyOf"|"oneOf"} keyword - Composition to remove.
   * @returns {Object} Normalized node.
   * @throws {SchemaError} For empty or unrepresentable literal combinations.
   */
  function union(node, keyword) {
    if (!node[keyword]) return node;
    const branches = node[keyword];
    delete node[keyword];
    if (!branches.length) throw new SchemaError("schema_conflict");
    const enumerations = branches.map(b => b.enum || (b.type === TYPE.NULL ? [null] : null));
    if (enumerations.every(Boolean)) {
      // Additional supported assertions cannot disappear when branches collapse.
      for (const branch of branches) {
        if (Object.keys(branch).some(key => !["type", "nullable", "enum", "minimum", "maximum"].includes(key) && !annotations.has(key))) {
          throw new SchemaError("schema_conflict");
        }
      }
      const values = new Map();
      const counts = new Map();
      for (const enumeration of enumerations) {
        for (const value of new Map(enumeration.map(v => [literalKey(v), v])).values()) {
          const key = literalKey(value);
          values.set(key, value);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      const enumeration = [...values].filter(([key]) => keyword !== "oneOf" || counts.get(key) === 1).map(([, v]) => v);
      if (!enumeration.length) throw new SchemaError("schema_conflict");
      return intersect(node, { enum: enumeration }, context);
    }
    // Structural unions keep their previous best-branch approximation; this fix
    // adds nullability but does not implement an unrestricted union compiler.
    const nonNull = branches.filter(b => b.type !== TYPE.NULL);
    if (!nonNull.length) throw new SchemaError("schema_literal");
    /**
     * @param {Object} branch - Read-only branch.
     * @returns {number} Existing object/array/primitive preference.
     */
    const score = branch => branch.type === TYPE.OBJECT || branch.properties ? 3
      : branch.type === TYPE.ARRAY || branch.items ? 2 : branch.type ? 1 : 0;
    const best = nonNull.reduce((a, b) => score(b) > score(a) ? b : a);
    if (nonNull.length !== branches.length) best.nullable = true;
    return intersect(node, best, context);
  }

  /**
   * Expand one schema node, charging every reference occurrence before copying.
   * @param {Object} node - Borrowed source schema, never mutated.
   * @param {number} depth - Expanded JSON depth.
   * @returns {Object} Owned, normalized schema.
   * @throws {SchemaError} On invalid nodes, cycles, references or budget excess.
   */
  function expand(node, depth) {
    meter.value(node, depth);
    if (!isObject(node)) throw new SchemaError("schema_shape");
    if (active.has(node)) throw new SchemaError("schema_cycle");
    meter.depth(active.size);
    active.add(node);
    let result = {};
    for (const [key, value] of Object.entries(node)) {
      // Resource scopes and dynamic references need a different resolver. Reject
      // them instead of resolving a relative pointer against the wrong resource.
      if (["$id", "$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"].includes(key)) throw new SchemaError("schema_reference");
      if (["$ref", "$defs", "definitions", "$schema"].includes(key)) continue;
      // Preserve the existing removal policy for unrelated constraints. Their
      // payloads were source-budgeted, but discarded schemas need no expansion.
      if ((context.unsupported.has(key) || key.startsWith("x-")) && !schemaLists.has(key) && key !== "const") continue;
      meter.key(key);
      if (key === "properties") {
        if (!isObject(value)) throw new SchemaError("schema_shape");
        meter.value(value, depth + 1);
        const properties = {};
        for (const [name, child] of Object.entries(value)) { meter.key(name); put(properties, name, expand(child, depth + 2)); }
        put(result, key, properties);
      } else if (schemaLists.has(key)) {
        if (!Array.isArray(value)) throw new SchemaError("schema_shape");
        meter.value(value, depth + 1);
        put(result, key, value.map(child => expand(child, depth + 2)));
      } else if (key === "items") put(result, key, expand(value, depth + 1));
      else put(result, key, copy(value, depth + 1));
    }
    if (result.type !== undefined) {
      if (Array.isArray(result.type) && !result.type.length) throw new SchemaError("schema_shape");
      result.type = Array.isArray(result.type) ? result.type.map(canonicalType) : canonicalType(result.type);
    }
    if (result.required !== undefined && (!Array.isArray(result.required) || result.required.some(v => typeof v !== "string"))) throw new SchemaError("schema_shape");
    if (result.nullable !== undefined && typeof result.nullable !== "boolean") throw new SchemaError("schema_shape");
    for (const bound of ["minimum", "maximum"]) {
      if (result[bound] !== undefined && (typeof result[bound] !== "number" || !Number.isFinite(result[bound]))) throw new SchemaError("schema_shape");
    }
    literals(result);
    if (result.allOf) {
      const branches = result.allOf;
      delete result.allOf;
      for (const branch of branches) result = intersect(result, branch, context, depth);
    }
    result = union(union(result, "anyOf"), "oneOf");
    if (Object.hasOwn(node, "$ref")) {
      // Cache lookup only: repeated targets still consume the expansion budget.
      result = intersect(expand(resolve(node.$ref), depth), result, context, depth);
    }
    active.delete(node);
    return result;
  }

  /**
   * Lower exact literals and nullability to the existing provider representation.
   * @param {Object} node - Owned expanded schema, mutated in place.
   * @param {number} depth - Current output depth.
   * @returns {Object} Provider schema with purpose-specific empty-object handling.
   * @throws {SchemaError} For unsupported literals or unrepresentable requirements.
   */
  function lower(node, depth) {
    meter.depth(depth);
    if (node.enum) {
      const values = node.enum.filter(v => acceptsLiteral(node, v));
      const nullable = values.includes(null);
      const nonNull = values.filter(v => v !== null);
      if (!nonNull.length) throw new SchemaError("schema_literal");
      const types = new Set(nonNull.map(literalType));
      if (types.size !== 1) throw new SchemaError("schema_literal");
      const type = [...types][0];
      // Consecutive safe integers have an exact Schema representation. Neither
      // sparse numeric sets nor fractional literals are widened into an interval.
      if (type === TYPE.INTEGER && nonNull.every(Number.isSafeInteger)) {
        const sorted = [...nonNull].sort((a, b) => a - b);
        if (!sorted.every((value, index) => value === sorted[0] + index)) throw new SchemaError("schema_literal");
        node.minimum = sorted[0];
        node.maximum = sorted.at(-1);
        delete node.enum;
      } else if (type === TYPE.BOOLEAN && nonNull.includes(true) && nonNull.includes(false)) delete node.enum;
      else if (type === TYPE.STRING) node.enum = nonNull;
      else throw new SchemaError("schema_literal");
      node.type = type;
      if (nullable) node.nullable = true;
      else delete node.nullable;
    }
    if (Array.isArray(node.type)) {
      if (node.type.includes(TYPE.NULL)) node.nullable = true;
      const nonNull = node.type.filter(t => t !== TYPE.NULL);
      if (!nonNull.length) throw new SchemaError("schema_literal");
      node.type = nonNull[0];
    }
    if (node.type === TYPE.NULL) throw new SchemaError("schema_literal");
    if (node.properties && !node.type) node.type = TYPE.OBJECT;
    if (node.prefixItems?.length && !node.items) {
      const variants = node.prefixItems.filter(s => s.type !== TYPE.NULL);
      if (variants.length) node.items = union({ anyOf: variants }, "anyOf");
    }
    if (node.type === TYPE.ARRAY && !node.items) node.items = { type: TYPE.STRING };
    for (const key of Object.keys(node)) if (context.unsupported.has(key) || key.startsWith("x-")) delete node[key];
    // A later allOf branch may supply a required property. Check only after all
    // branches have merged, rather than dropping requirements during traversal.
    if (context.composed.has(node) && node.required?.some(name => !node.properties || !Object.hasOwn(node.properties, name))) throw new SchemaError("schema_conflict");
    if (node.required && node.properties) {
      node.required = node.required.filter(name => Object.hasOwn(node.properties, name));
      if (!node.required.length) delete node.required;
    }
    // Property maps are data dictionaries. Only actual tool schema nodes can
    // acquire a placeholder; response objects must never gain invented fields.
    if (purpose === SCHEMA_PURPOSE.TOOL && (Object.keys(node).length === 0 ||
      (node.type === TYPE.OBJECT && (!node.properties || !Object.keys(node.properties).length)))) {
      node.type = TYPE.OBJECT;
      node.properties = { reason: { type: TYPE.STRING, description: "Brief explanation of why you are calling this tool" } };
      node.required = ["reason"];
    }
    for (const child of Object.values(node.properties || {})) lower(child, depth + 2);
    if (isObject(node.items)) lower(node.items, depth + 1);
    return node;
  }

  const result = lower(expand(schema, 0), 0);
  // Generated tool placeholders also consume the final serialized-output budget.
  inspectSchemaJson(result, createSchemaMeter(budget, "output"));
  return result;
}
