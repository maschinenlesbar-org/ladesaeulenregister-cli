// Public entry point for the API client library.

export { LadesaeulenClient, DEFAULT_FIELDS, MIN_RADIUS_KM, MAX_RADIUS_KM } from "./client.js";
export type { LadesaeulenClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_GET_URL_LENGTH,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  describeArcGisError,
} from "./engine.js";
export type { EngineOptions, RawResponse, RequestTarget } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  LadesaeulenError,
  LadesaeulenApiError,
  LadesaeulenNetworkError,
  LadesaeulenValidationError,
  LadesaeulenParseError,
} from "./errors.js";

export * from "./types.js";
