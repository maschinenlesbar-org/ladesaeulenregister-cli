// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { LadesaeulenValidationError, cutForMessage, quoteValue } from "./errors.js";
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

/** A value as it appears in a validation message: strings quoted visibly (`quoteValue`), the rest as is; cut (`cutForMessage`). */
function show(value: unknown): string {
  return typeof value === "string" ? quoteValue(value) : cutForMessage(String(value));
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter, or undefined when it can. Refused, before any
 * request, as the API would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks (`isBlank`): an empty filter reads as "no filter"
 *   upstream, which answers with the whole unfiltered list;
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/**
 * A text filter as the API matches it: without surrounding whitespace (a value pasted with a
 * trailing space matched nothing) and in composed Unicode, NFC (a decomposed "Müller", u plus
 * U+0308 as pasted from a macOS file name, matched nothing). Inner whitespace is kept.
 * Inside an ArcGIS SQL `where` NFC changes no syntax (keywords and operators are ASCII), and
 * the register's server matches a decomposed and a composed literal alike (2026-10-21).
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is an id, a code, an
 * enum value or a sort key: a value the API compares exactly. The rules apply to the value with
 * surrounding whitespace trimmed, as it is sent ({@link normalizeToken}): not blank (and not only
 * invisible characters or combining marks), no lone surrogate, and no control or format character
 * at all (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an invisible character in
 * an id or a code only ever makes it match nothing. The reason quotes the value visibly.
 * A sort key is checked against its documented syntax too ({@link orderByProblem}).
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list option (`--fields Ort,state`), as typed: each item is checked
 * (`listProblem`) and canonicalised (`normalizeToken`) on its own, so `"Ort, state"` sends `state`, and
 * `"Ort,,state"`, `"Ort,"` and `","` are refused rather than sent as an empty item (which an API may
 * read as "no filter").
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all (an empty list reads as "no filter"), or an item that `itemProblem` refuses (by
 * default {@link tokenProblem}: a blank item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem<string> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/** What an `orderBy` may hold: column names, `ASC`/`DESC`, `CAST(… AS FLOAT)`, commas and spaces. */
const ORDER_BY = /^[\p{L}\p{N}_ ,()]+$/u;

/**
 * Why `value` cannot be sent as an `orderBy` (`--order-by`, ArcGIS `orderByFields`), or undefined
 * when it can: the {@link tokenProblem} rules, then the documented syntax, one or more of `<column>
 * [ASC|DESC]` or `CAST(<column> AS FLOAT) [ASC|DESC]`, separated by commas: letters (umlauts and ß
 * included), digits, `_`, spaces, commas and parentheses only. A dot, a slash, a quote or a `%`
 * belongs to no sort the layer takes, and the server answered such a value with an error, or
 * sorted by nothing.
 */
export function orderByProblem(value: string): string | undefined {
  const problem = tokenProblem(value);
  if (problem !== undefined) return problem;
  if (!ORDER_BY.test(normalizeToken(value))) {
    return (
      `expected column names with ASC or DESC, e.g. "Ort ASC" or "CAST(max_electric_power_station AS FLOAT) DESC", ` +
      `got ${quoteValue(value)}.`
    );
  }
  return undefined;
}

/**
 * Why `value` cannot be sent as `outFields` (`--fields`), or undefined when it can: a
 * comma-separated list of column names (or `*`) whose every item passes {@link tokenProblem};
 * an empty item (`"Ort,,state"`, `"Ort,"`) is refused, never sent. The value goes out as
 * {@link normalizeOutFields} gives it.
 */
export function outFieldsProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  return listProblem(splitList(value));
}

/** `outFields` as it is sent: each item trimmed and NFC, joined with commas. Check it with {@link outFieldsProblem} first. */
export function normalizeOutFields(value: string): string {
  return splitList(value).map(normalizeToken).join(",");
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
 * A rule for a configured base URL: a non-blank, well-formed `http:`/`https:` URL
 * with no query, fragment or surrounding whitespace. Request paths are appended to
 * the raw string, so a `?` or `#` would swallow every path (`http://h/fs?x=1`
 * requests `/fs?x=1/0/query?...`, `http://h/fs#f` requests `/fs` with no
 * parameters), and surrounding whitespace, which `new URL()` trims silently, would
 * end up in every request URL (`/fs%20/0/query`). A `%` in the user name or password must
 * start a valid escape (`%25` for a literal one). The reasons never echo the value, so a
 * credential in it cannot leak into a message.
 */
export const baseUrlProblem: Problem<string> = (raw) => {
  if (typeof raw !== "string") return `Expected a string, got ${show(raw)}.`;
  const trimmed = raw.trim();
  if (trimmed === "") return "Expected a non-empty value.";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "Expected a valid URL (e.g. https://host/path).";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Only http: and https: base URLs are supported.";
  }
  if (/[?#]/.test(raw)) return "A base URL cannot have a query (?) or fragment (#).";
  if (raw !== trimmed) return "A base URL cannot have surrounding whitespace.";
  // Node decodes the userinfo into the Authorization header and throws "URI malformed" for a
  // "%" that isn't an escape — at request time, as a network error (exit 6). Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

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
