// Public entry point for the API client library.

export {
  LadesaeulenClient,
  DEFAULT_FIELDS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MIN_RADIUS_KM,
  MAX_RADIUS_KM,
  STATION_QUERY_KEYS,
} from "./client.js";
export type { LadesaeulenClientOptions } from "./client.js";
export {
  RequestEngine,
  assertHeaderValue,
  DEFAULT_BASE_URL,
  MAX_GET_URL_LENGTH,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  decodeBody,
  describeArcGisError,
  validateBaseUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse, RequestTarget } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export {
  assertValid,
  baseUrlProblem,
  COUNT_IGNORED_KEYS,
  countIgnoredOptions,
  countQueryProblem,
  headerNameProblem,
  headerValueProblem,
  intRangeProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  LadesaeulenError,
  LadesaeulenApiError,
  LadesaeulenNetworkError,
  LadesaeulenValidationError,
  LadesaeulenParseError,
  credentialsIn,
  cutForMessage,
  MAX_MESSAGE_VALUE_LENGTH,
  redactCredentials,
  redactUrl,
} from "./errors.js";

export * from "./types.js";
