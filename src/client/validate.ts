// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { LadesaeulenValidationError } from "./errors.js";
import type { StationQuery } from "./types.js";

/** A rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Throw a {@link LadesaeulenValidationError} with the message `Invalid <name>: <reason>`
 * when `problem(value)` finds a reason; otherwise return `value` unchanged. Call it
 * before any request, so a rejected input sends nothing. Async methods call it
 * inside their body, so the rejection arrives as a rejected promise rather than a
 * synchronous throw; constructors throw.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new LadesaeulenValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** A value as it appears in a validation message: strings quoted, the rest as is. */
function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * A rule for an integer option: a safe integer from `min` to `max`. Anything else
 * (a negative, NaN, Infinity, a fraction, a non-number) gets the reason
 * `expected an integer from <min> to <max>, got <value>.`
 */
export function intRangeProblem(min: number, max: number): Problem<number> {
  return (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
      ? undefined
      : `expected an integer from ${min} to ${max}, got ${show(value)}.`;
}

/**
 * A rule for a value that goes into an HTTP header (User-Agent, `defaultHeaders`):
 * not blank, no control characters (a CR/LF or other C0 byte, DEL; tab is fine)
 * and no code units above U+00FF. That is what Node's HTTP layer accepts; anything
 * else it refuses with an opaque `ERR_INVALID_CHAR`, and a CR/LF handed to a custom
 * transport could inject a header. Checked by char code so the source stays free
 * of control bytes.
 */
export const headerValueProblem: Problem<string> = (value) => {
  if (typeof value !== "string") return `Expected a string, got ${show(value)}.`;
  if (value.trim() === "") return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/** A rule for an HTTP header name: an RFC 9110 token (`X-Trace-Id`). */
export const headerNameProblem: Problem<string> = (name) =>
  typeof name === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
    ? undefined
    : `Expected an HTTP header name (a token), got ${show(name)}.`;

/**
 * The `StationQuery` keys that shape a page of rows (paging, sort, field
 * selection). ArcGIS ignores them next to `returnCountOnly`, so `count()` refuses
 * them rather than return the full total to a caller who expects a per-page count.
 */
export const COUNT_IGNORED_KEYS = ["limit", "offset", "orderBy", "outFields"] as const;

/** The keys of `q` that `count()` refuses (set and not `undefined`), in `COUNT_IGNORED_KEYS` order. */
export function countIgnoredOptions(q: StationQuery): (typeof COUNT_IGNORED_KEYS)[number][] {
  return COUNT_IGNORED_KEYS.filter((key) => q[key] !== undefined);
}

/** Why `q` cannot be counted: it sets a paging, sort or field option. */
export const countQueryProblem: Problem<StationQuery> = (q) => {
  const keys = countIgnoredOptions(q);
  if (keys.length === 0) return undefined;
  return (
    `${keys.join(", ")} cannot be combined with count(): it counts every match, ` +
    "so paging, sorting and field options do not apply."
  );
};
