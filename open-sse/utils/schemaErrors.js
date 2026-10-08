import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { SCHEMA_ERROR_MESSAGES } from "../config/schemaCompatibility.js";
import { buildErrorBody, createErrorResult } from "./error.js";

// This marker stays in process; it is never exposed in headers or response JSON.
const localSchemaFailure = Symbol.for("9router.localSchemaFailure");

/** A safe local failure, independent of provider/account health. */
export class SchemaError extends Error {
  /**
   * @param {keyof typeof SCHEMA_ERROR_MESSAGES} code - Fixed failure category.
   * @param {string} [location="schema"] - Internally supplied request-field path.
   */
  constructor(code, location = "schema") {
    super(SCHEMA_ERROR_MESSAGES[code] || SCHEMA_ERROR_MESSAGES.schema_shape);
    this.name = "SchemaError";
    this.code = code;
    this.location = location;
    this.status = code === "schema_preparation_failed" ? HTTP_STATUS.SERVER_ERROR : HTTP_STATUS.BAD_REQUEST;
  }
}

/**
 * Classify preparation bugs without copying their message, stack, or caller data.
 * @param {*} error - Original failure; existing SchemaErrors receive the location.
 * @param {string} location - Internal request-field path.
 * @returns {SchemaError} Safe HTTP 400 validation error or HTTP 500 preparation bug.
 */
export function asSchemaError(error, location) {
  const safe = error instanceof SchemaError ? error : new SchemaError("schema_preparation_failed");
  safe.location = location;
  return safe;
}

/**
 * Build an OpenAI error and mark it for account and combo short-circuiting.
 * @param {SchemaError} error - Local failure; never mutated.
 * @returns {Object} Non-retryable gateway result with a privately marked Response.
 */
export function schemaErrorResult(error) {
  const result = createErrorResult(error.status, error.message);
  const body = buildErrorBody(error.status, error.message);
  Object.assign(body.error, { code: error.code, param: error.location });
  result.response = new Response(JSON.stringify(body), {
    status: error.status, headers: result.response.headers,
  });
  Object.defineProperty(result.response, localSchemaFailure, { value: true });
  result.nonRetryable = true;
  return result;
}

/**
 * Recognize locally marked responses without trusting an upstream error string.
 * @param {Response} response - Response inspected without mutation.
 * @returns {boolean} Whether account/model fallback must stop.
 */
export function isLocalSchemaFailure(response) {
  return response?.[localSchemaFailure] === true;
}
