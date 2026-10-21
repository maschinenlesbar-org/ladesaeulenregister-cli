// The request engine: turns logical (path, query) calls into HTTP requests via a
// Transport, applies retry/backoff for transient statuses (429, 503) and reset
// connections, and decodes JSON responses. The Ladesäulenregister is a public ArcGIS
// FeatureServer — an unauthenticated API whose parameters travel in the query string,
// or, for a query too long for a URL, in a form-encoded POST body (ArcGIS `/query`
// accepts both).

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { assertValid, baseUrlProblem, headerNameProblem, headerValueProblem, intRangeProblem } from "./validate.js";
import { TextDecoder } from "node:util";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  LadesaeulenApiError,
  LadesaeulenError,
  LadesaeulenNetworkError,
  LadesaeulenParseError,
  LadesaeulenValidationError,
  credentialsIn,
  cutForMessage,
  cutText,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";

export const DEFAULT_BASE_URL =
  "https://services-eu1.arcgis.com/TJm8oSvOdJUQvQT5/arcgis/rest/services/Ladesaeulen/FeatureServer";
const DEFAULT_USER_AGENT = "ladesaeulenregister-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to the public Ladesäulen ArcGIS FeatureServer.
   * Checked by `validateBaseUrl`: no surrounding whitespace, http(s) only, no query
   * or fragment.
   */
  baseUrl?: string | undefined;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport | undefined;
  /**
   * Value of the User-Agent header: not blank, Latin-1 without control characters
   * (tab is fine), else a LadesaeulenValidationError.
   */
  userAgent?: string | undefined;
  /** Extra headers sent on every request; names must be tokens, values follow the `userAgent` rule. */
  defaultHeaders?: Record<string, string> | undefined;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps: an integer 0..`MAX_TIMEOUT_MS` (2^31 - 1 ms); 0 disables.
   * Defaults to 30000.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient (429/503) responses, an integer
   * 0..`MAX_RETRIES` (10); defaults to 2. Each waits `retryDelayMs * attempt`, or the
   * response's `Retry-After` when that is longer (up to `MAX_RETRY_AFTER_MS`; a longer
   * one is not retried, and the LadesaeulenApiError says so). A GET whose connection
   * was reset (ECONNRESET, `socket hang up`, undici's UND_ERR_SOCKET, a body cut off
   * mid-way) is retried the same way, with the linear backoff; a refused connection, a
   * DNS failure or a timeout is not.
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (grows linearly), an integer
   * 0..`MAX_RETRY_AFTER_MS` (30 000). Defaults to 200. It is also the floor under a
   * `Retry-After`: the header can lengthen a wait, never shorten it.
   */
  retryDelayMs?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative integer. Defaults to 100 MiB;
   * set to 0 for no limit.
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried 429/503
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /**
   * Member names whose number values may exceed 2^53 (a Solr `_version_`, a 64-bit id). The value
   * of a declared member is delivered as its exact literal, as written, as a JSON string (`"5"`),
   * so its type never depends on its size. A declared member whose value is not a number (a
   * string, `null`, an object) is left as it is. Every undeclared number keeps the rule: exact,
   * or a LadesaeulenParseError. Matched by name anywhere in a JSON answer, an escaped
   * name (`"\u005fversion_"`) included. Defaults to none (the register has no such member);
   * anything but a set or list of non-empty strings makes the constructor throw a
   * LadesaeulenValidationError. The set is copied.
   */
  bigIntegerKeys?: ReadonlySet<string> | undefined;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Most retries `maxRetries` may ask for (each may wait up to `MAX_RETRY_AFTER_MS`). */
export const MAX_RETRIES = 10;

/**
 * A numeric engine option: `fallback` when undefined, else an integer in 0..max,
 * or a LadesaeulenValidationError (`Invalid <name>: expected an integer …`).
 */
function intOption(name: string, value: number | undefined, max: number, fallback: number): number {
  return value === undefined ? fallback : assertValid(name, value, intRangeProblem(0, max));
}

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` and a
 * response cut off mid-body are ECONNRESET) and undici's (`fetch failed` with cause
 * UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/**
 * True when `err` or an error in its `cause` chain has a transient connection code —
 * whichever transport raised it (the default one wraps Node's error as `cause`, fetch's
 * TypeError carries undici's). A refused connection (ECONNREFUSED), a DNS failure or a
 * timeout has none of these codes and is not retried.
 */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * Longest URL the engine sends as a GET. A longer request (a `where` with a long
 * `IN (…)` list) goes out as a form-encoded POST to the same path instead: the
 * ArcGIS Online front end answers a GET URL of about 2.9 KB with a misleading
 * HTTP 404 and one above about 20 KB with 414, while `/query` takes the same
 * parameters as a POST body (live-checked 2026-09-26). 2,000 characters stays
 * well below the point where the GET starts to fail.
 */
export const MAX_GET_URL_LENGTH = 2000;

/** How the engine sends one logical request: method, URL and (for a POST) the form body. */
export interface RequestTarget {
  method: "GET" | "POST";
  url: string;
  /** The form-encoded parameters of a POST (`application/x-www-form-urlencoded`). */
  body?: string;
}

/**
 * Strip control characters out of a string that originates in an
 * attacker-controlled response — the ArcGIS `error` detail and the non-JSON body
 * snippet — before it flows into a `LadesaeulenApiError.message` that run.ts
 * prints raw to stderr. `JSON.parse` decodes an escaped ESC (a backslash-u-001b
 * sequence) in an error body into a real ESC byte, so without this a hostile or
 * MITM'd endpoint could inject
 * ANSI/OSC terminal escape sequences (screen clears, title changes, output
 * spoofing) when the message reaches the user's terminal. The CLI's JSON output is
 * escaped separately (escapeControlChars in cli/output.ts), since `JSON.stringify`
 * alone leaves DEL, the C1 range and the bidi controls raw. Removes all C0 controls (except
 * tab/newline), DEL, and the C1 range; implemented via char codes so this source
 * file never contains a raw control byte.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n === 0x09 || n === 0x0a) {
      out += ch;
      continue;
    }
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * True for a bidi formatting character (U+061C, U+200E, U+200F, U+202A–U+202E,
 * U+2066–U+2069): it reorders the text that follows it on a terminal, so printed JSON
 * escapes it (the CLI's `escapeControlChars`) and a log record too.
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * The human-readable text of an ArcGIS `error` value, for an error message: a bare
 * string as is, or an `{code, message, details}` object's `message` and `details`
 * joined with "; ". Empty parts and repeats are dropped (the live server sends
 * `"message": ""` with the reason only in `details`, and sometimes the same text in
 * both). Every part is stripped of control characters (`sanitizeServerText`).
 * Returns `undefined` when nothing readable is left.
 */
export function describeArcGisError(error: unknown): string | undefined {
  let parts: unknown[] = [];
  if (typeof error === "string") parts = [error];
  else if (error !== null && typeof error === "object") {
    const e = error as { message?: unknown; details?: unknown };
    parts = [e.message, ...(Array.isArray(e.details) ? e.details : [])];
  }
  const seen = new Set<string>();
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const text = sanitizeServerText(part).trim();
    if (text !== "") seen.add(text);
  }
  return seen.size > 0 ? cutForMessage([...seen].join("; ")) : undefined;
}

/**
 * Check a configured base URL (`baseUrlProblem`) and return it with trailing
 * slashes stripped, or throw a LadesaeulenValidationError (`Invalid baseUrl:
 * <reason>`): blank, surrounding whitespace, unparsable, a scheme other than
 * http(s), a query or a fragment. Runs on the raw value, before the slash strip,
 * so `"https://h/fs/ "` cannot slip past it. The default transport still gates the
 * scheme per hop (a LadesaeulenNetworkError there), but the engine may be handed a
 * custom transport that does no such check, so a `file:`/`ftp:` base URL fails
 * here, before any request.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

/** True for a loopback host name: `localhost`, `127.0.0.0/8`, `::1` (as `URL.hostname` gives them). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * What travels unencrypted when requests go to `baseUrl`, as one sentence — or
 * `undefined` when nothing does: an `https:` URL, a URL that does
 * not parse (the base-URL check reports that), or a loopback host (`localhost`,
 * `127.0.0.0/8`, `::1`). The sentence names the host (`url.host`, host and port) and what
 * is sent with each request: the base URL's own credentials (userinfo) and any other
 * secret passed as a noun phrase in `secrets` (e.g. `"the API key"`). It never contains
 * a password or key. The CLI logs it as a `WARN` record of `ladesaeulen.http` on stderr
 * (once per run, before the first request).
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const sent = [...secrets];
  if (url.username !== "" || url.password !== "") sent.push("the base URL's credentials");
  if (sent.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  // "the base URL's credentials" and any pair are plural; a single secret phrase is not.
  const verb = sent.length === 1 && secrets.length === 1 ? "is" : "are";
  return `${sent.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

/**
 * Check a value bound for an HTTP header (`headerValueProblem`) and return it, or
 * throw a LadesaeulenValidationError (`Invalid <name>: <reason>`). The engine runs
 * it on `userAgent` and every `defaultHeaders` value before any request.
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/** Check every `defaultHeaders` name (a token) and value; returns a copy. */
function checkedHeaders(headers: Record<string, string>): Record<string, string> {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new LadesaeulenValidationError(
      `Invalid defaultHeaders: expected an object of header names and values, got ${headers === null ? "null" : Array.isArray(headers) ? "an array" : typeof headers}.`,
    );
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    assertValid("defaultHeaders name", name, headerNameProblem);
    out[name] = assertHeaderValue(`defaultHeaders["${name}"]`, value);
  }
  return out;
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which passes as an object but has no
 * plain properties: the engine then saw no Retry-After and no Content-Type. Such an
 * object (anything with `get` and `forEach`, a `Map` too) is copied into a record; a
 * plain record gets its names lower-cased, as the engine reads them.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  // Records built from an answer have no prototype: a header named `__proto__` is an own
  // entry like any other, never the record's prototype (whose entries would read as headers).
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = Object.create(null) as Record<string, string>;
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  // Node's transport lower-cases header names; a custom one may not ("Content-Type").
  const record = Object.create(null) as Record<string, string | string[] | undefined>;
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** No declared big-integer members (`EngineOptions.bigIntegerKeys` left out). */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Read the `bigIntegerKeys` option: `undefined` gives none; a set or list of non-empty strings is
 * copied; anything else throws a LadesaeulenValidationError.
 */
export function bigIntegerKeysOption(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_KEYS;
  const iterable = typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
  const names = iterable ? [...(value as Iterable<unknown>)] : [];
  if (!iterable || names.some((key) => typeof key !== "string" || key === "")) {
    throw new LadesaeulenValidationError("Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  return new Set(names as string[]);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident. Messages use redactUrl.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /**
   * The forms a server echoes that userinfo back in (the Basic value, the decoded
   * `user:password`, the password alone), longest first, so a password never leaves half
   * of the `user:password` around it.
   */
  readonly #echoed: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  /** `EngineOptions.bigIntegerKeys`, copied. */
  readonly bigIntegerKeys: ReadonlySet<string>;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined rather
    // than failing with a raw TypeError on the first property read.
    options = options ?? {};
    if (typeof options !== "object") {
      throw new LadesaeulenValidationError(`Invalid options: expected an object, got ${typeof options}.`);
    }
    // Checked raw, before the trailing-slash strip (see validateBaseUrl).
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.#echoed = credentialsIn(this.#baseUrl)
      .flatMap(echoedCredentialForms)
      .sort((a, b) => b.length - a.length);
    if (options.transport !== undefined && typeof options.transport !== "function") {
      throw new LadesaeulenValidationError(`Invalid transport: expected a function, got ${typeof options.transport}.`);
    }
    this.transport = options.transport ?? nodeHttpTransport;
    // Header values are checked up front: a blank one would be sent as is, and a
    // CR/LF or a character above U+00FF would reach a custom transport raw or make
    // Node's HTTP layer throw an untyped ERR_INVALID_CHAR.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    this.defaultHeaders = checkedHeaders(options.defaultHeaders ?? {});
    // Range-check the numeric options: a negative, NaN or fractional value would
    // otherwise silently disable the timeout or the size cap, and an unbounded
    // maxRetries would keep retrying.
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, MAX_TIMEOUT_MS, 30_000);
    this.maxRetries = intOption("maxRetries", options.maxRetries, MAX_RETRIES, 2);
    // Bounded like a Retry-After wait: a larger value overflowed Node's timer and fired
    // after 1 ms, a burst rather than a backoff.
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, MAX_RETRY_AFTER_MS, 200);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    if (options.sleep !== undefined && typeof options.sleep !== "function") {
      throw new LadesaeulenValidationError(`Invalid sleep: expected a function, got ${typeof options.sleep}.`);
    }
    this.sleep = options.sleep ?? realSleep;
    if (options.onRetry !== undefined && typeof options.onRetry !== "function") {
      throw new LadesaeulenValidationError(`Invalid onRetry: expected a function, got ${options.onRetry === null ? "null" : typeof options.onRetry}.`);
    }
    this.onRetry = options.onRetry;
    this.bigIntegerKeys = bigIntegerKeysOption(options.bigIntegerKeys);
  }

  /** Tell `onRetry` about a retry, then wait. A throwing callback never breaks the request. */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: redactUrl(url),
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactSecrets(redactCredentials(text, this.#credentials), this.#echoed);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * The error for an ArcGIS "HTTP 200 + `error`" envelope (a bad `where`, "Token
   * Required"): a LadesaeulenApiError with `arcgisCode` set, naming the request the
   * engine sent for `path` + `query` (URL redacted), with the server text stripped of
   * control characters and of the base URL's credentials.
   */
  envelopeError(path: string, query: QueryParams, envelope: unknown, error: unknown): LadesaeulenApiError {
    const e = error !== null && typeof error === "object" ? (error as { code?: unknown }) : {};
    const detail = describeArcGisError(error);
    const target = this.requestTarget(path, query);
    return new LadesaeulenApiError({
      url: target.url,
      method: target.method,
      body: this.scrub(JSON.stringify(envelope)),
      arcgisCode: typeof e.code === "number" ? e.code : undefined,
      ...(detail === undefined ? {} : { detail: this.scrub(detail) }),
    });
  }

  /**
   * Decide how a request goes out: a GET with the parameters in the query string,
   * or — when that URL would be longer than `MAX_GET_URL_LENGTH` — a POST to the
   * bare path with the same parameters as a form-encoded body.
   */
  requestTarget(path: string, query?: QueryParams): RequestTarget {
    const url = this.buildUrl(path, query);
    const qs = query ? buildQueryString(query) : "";
    if (qs === "" || url.length <= MAX_GET_URL_LENGTH) return { method: "GET", url };
    return { method: "POST", url: this.buildUrl(path), body: qs };
  }

  /**
   * The request as an answer error names it: `<METHOD> <url>` of the request the engine sends
   * for `path` + `query` (a GET, or the form POST of a long query, whose URL is the bare path),
   * userinfo redacted and cut at MAX_MESSAGE_VALUE_LENGTH characters. Every error about an
   * answer (bad JSON, an unknown charset, an inexact number, the wrong shape) starts with it,
   * as a network error does, so a caller making several requests can tell which one it was.
   */
  describeRequest(path: string, query?: QueryParams): string {
    const target = this.requestTarget(path, query);
    return `${target.method} ${cutForMessage(redactUrl(target.url))}`;
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new LadesaeulenNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, Math.min(this.timeoutMs, MAX_TIMEOUT_MS));
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A transport failure as the library's error, naming the request (`<METHOD> <url>
   * failed: <reason>`, URL redacted). The default transport rejects with
   * LadesaeulenNetworkError only, which gets that prefix; an injected one may throw
   * anything — a plain Error, fetch's TypeError, a string, null. That becomes a
   * LadesaeulenNetworkError naming the request (URL redacted), with the original as
   * `cause`, so a caller (and the CLI, exit 6) can rely on every failure being a
   * LadesaeulenError. Any other LadesaeulenError passes through.
   */
  private toNetworkError(method: string, url: string, cause: unknown): LadesaeulenError {
    if (cause instanceof LadesaeulenError && !(cause instanceof LadesaeulenNetworkError)) return cause;
    if (cause instanceof LadesaeulenNetworkError) {
      // The default transport's own errors (a timeout, the size cap, a refused connection, a
      // DNS failure) and the engine's deadline carry no URL: name the request, as for a reset,
      // with the original as the cause. A message that names it already is only scrubbed
      // (a custom transport may have built one from a server's text).
      const message = this.scrub(cause.message);
      const prefix = `${method} ${redactUrl(url)} failed: `;
      if (message.startsWith(prefix)) {
        const inner = this.scrubCause(cause.cause);
        if (message === cause.message && inner === cause.cause) return cause;
        return new LadesaeulenNetworkError(message, inner === undefined ? undefined : { cause: inner });
      }
      return new LadesaeulenNetworkError(`${prefix}${sanitizeServerText(message)}`, { cause: this.scrubCause(cause) });
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new LadesaeulenNetworkError(`${method} ${redactUrl(url)} failed: ${sanitizeServerText(this.scrub(reason))}`, {
      cause: this.scrubCause(cause),
    });
  }

  /**
   * Perform a request (GET, or a form POST for a long query — see `requestTarget`)
   * with Accept negotiation and transient-error retries. Redirects are NOT
   * followed — the canonical host answers directly, so a 3xx surfaces as an error.
   * Every transport is held to the same contract: the `timeoutMs` deadline and the
   * `maxResponseBytes` cap apply whatever it does, headers may be a record in any
   * case, a `Headers` object or a `Map`, the body any ArrayBuffer view, and anything
   * else it throws or returns is a LadesaeulenNetworkError. 429/503 statuses are
   * retried, and so is a GET whose connection was reset (see `hasTransientCode`); a
   * form POST is not re-sent after a reset, and no other network error is retried.
   */
  async request(path: string, query?: QueryParams, accept = "application/json"): Promise<RawResponse> {
    const { method, url, body } = this.requestTarget(path, query);
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      Accept: accept,
      "User-Agent": this.userAgent,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }

    // Only an idempotent request is sent again after a reset: request() is public, and a
    // POST re-sent after a reset may be applied twice. (The long-query form POST is a read,
    // but keep the rule simple: GET and HEAD only.)
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          ...(body !== undefined ? { body } : {}),
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is the network-level twin of a 503:
        // retry the GET with the same linear backoff, whichever transport reported it.
        // Timeouts are not retried — a slow upstream should not be asked again at once,
        // and timeoutMs bounds each attempt.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.backOff(attempt, this.retryDelayMs * attempt, url);
          continue;
        }
        const err = this.toNetworkError(method, url, cause);
        // Say that the reset persisted through the retries, as an API error does.
        if (attempt > 0 && err instanceof LadesaeulenNetworkError) {
          throw new LadesaeulenNetworkError(`${err.message} (after ${attempt} ${attempt === 1 ? "retry" : "retries"})`, {
            cause: err.cause,
          });
        }
        throw err;
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the LadesaeulenError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new LadesaeulenNetworkError(
          `${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const data = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a
      // custom one may have read everything.
      if (this.maxResponseBytes > 0 && data.byteLength > this.maxResponseBytes) {
        throw new LadesaeulenNetworkError(`${method} ${redactUrl(url)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }

      const retryable = status === 429 || status === 503;
      // A Retry-After beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at
      // once and names the wait the server asked for.
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      const tooLong = retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS;
      if (retryable && !tooLong && attempt < this.maxRetries) {
        attempt += 1;
        // Back off linearly from retryDelayMs. A Retry-After can ask for longer, never for
        // less: `Retry-After: 0` or a date in the past turned the retries into a zero-delay
        // burst against a server that had just asked for less load.
        const backoff = this.retryDelayMs * attempt;
        await this.backOff(attempt, retryAfter === undefined ? backoff : Math.max(retryAfter, backoff), url, status);
        continue;
      }

      const contentType = String(responseHeaders["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, data, {
          retries: attempt,
          ...(tooLong ? { retryAfterMs: retryAfter } : {}),
        });
      }

      return { data, contentType, status };
    }
  }

  /**
   * Request a path with query params and parse the JSON reply into `T`. A number in it that
   * JSON.parse can't carry exactly (`firstInexactNumber`) is a LadesaeulenParseError; the number
   * of a member named in `bigIntegerKeys` is delivered as its exact literal, a string.
   */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request(path, query);
    const request = this.describeRequest(path, query);
    const text = decodeBody(res.data, res.contentType, request);
    if (res.status === 204 || text.trim().length === 0) {
      return null as T;
    }
    // Declared big integers are quoted first, so JSON.parse delivers them exactly.
    const { json, inexact } = scanNumbers(text, this.bigIntegerKeys);
    let parsed: T;
    try {
      parsed = JSON.parse(json) as T;
    } catch (cause) {
      // An HTML maintenance or proxy page is the usual non-JSON answer: name its type,
      // so it reads as an upstream problem rather than a client bug.
      const type = res.contentType.split(";")[0]?.trim() ?? "";
      const hint = type !== "" && !/json/i.test(type) ? ` (expected JSON, got Content-Type "${cutForMessage(sanitizeServerText(type))}")` : "";
      throw new LadesaeulenParseError(`${request}: the answer is not valid JSON${hint}.`, { cause });
    }
    // JSON.parse rounds and overflows numbers silently: refuse the answer rather than hand
    // on a changed value.
    if (inexact !== undefined) {
      throw new LadesaeulenParseError(`${request}: the number ${cutForMessage(inexact)} cannot be represented exactly.`);
    }
    return parsed;
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    retry: { retries: number; retryAfterMs?: number },
  ): LadesaeulenApiError {
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as {
        error?: unknown;
        message?: unknown;
        detail?: unknown;
      };
      const arcgis = parsed?.error ? describeArcGisError(parsed.error) : undefined;
      if (arcgis !== undefined) detail = arcgis;
      else if (typeof parsed?.message === "string") detail = parsed.message;
      else if (typeof parsed?.detail === "string") detail = parsed.detail;
    } catch {
      // Not JSON (e.g. an HTML error page). Surface a short, whitespace-collapsed
      // snippet of a textual body; skip HTML pages (start with "<").
      const snippet = text.trim().replace(/\s+/g, " ");
      if (snippet.length > 0 && !snippet.startsWith("<")) {
        detail = snippet.length > 200 ? `${cutText(snippet, 200)}…` : snippet;
      }
    }
    // `detail` came from the attacker-controlled response body; strip control
    // characters so a hostile endpoint cannot drive terminal escape sequences
    // into stderr via the error message.
    // ... and cut it, so a hostile or buggy body cannot flood stderr with one huge line
    // (LadesaeulenApiError.body keeps the full text).
    if (detail !== undefined) detail = cutForMessage(sanitizeServerText(detail));
    return new LadesaeulenApiError({
      status,
      url,
      method,
      body: text,
      detail,
      retries: retry.retries,
      ...(retry.retryAfterMs === undefined ? {} : { retryAfterMs: retry.retryAfterMs, maxRetryAfterMs: MAX_RETRY_AFTER_MS }),
    });
  }
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). TextDecoder drops a leading byte order mark, which Buffer#toString keeps and
 * JSON.parse then rejects, so a BOM added by a proxy or a backend change cannot turn a
 * valid answer into a parse error, and a Latin-1 body keeps its umlauts ("München").
 * An unknown charset label is a LadesaeulenParseError naming `request` (`<METHOD> <url>`,
 * as `RequestEngine.describeRequest` gives it).
 */
export function decodeBody(body: Buffer, contentType: string, request: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new LadesaeulenParseError(`${request}: unsupported response charset "${cutForMessage(sanitizeServerText(charset))}".`);
  }
  return decoder.decode(body);
}

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The smallest positive normal double, 2^-1022. Below it a double has fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off in its leading digits: past 2^53, where every double is an integer, at 0,
 * which a literal too small for a double becomes, and below the smallest normal double, where a
 * subnormal has fewer significant digits (`3e-324` becomes `5e-324`). There the CLI prints
 * `String(value)`, the shortest decimal that reads back as the same double: `12345678901234567890`
 * prints as `12345678901234567000`, a changed value, while `1E23`, `1.7976931348623157E308` or
 * `5e-324` (a double a server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  const size = Math.abs(value);
  if (value !== 0 && size <= Number.MAX_SAFE_INTEGER && size >= MIN_NORMAL) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  const all = (whole + fraction).replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  return { negative: sign === "-", digits, exponent: Number(exp) - fraction.length + (all.length - digits.length) };
}

/** A JSON number token as the grammar allows it, matched at a given position (sticky). */
const STRICT_JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** What {@link scanNumbers} found in a JSON text. */
interface NumberScan {
  /** The text with each declared member's number value quoted; the input itself when there was none. */
  json: string;
  /** The first undeclared number literal JSON.parse cannot carry exactly, or undefined. */
  inexact: string | undefined;
}

/** Whether the member name `json` holds between `start` and `end` (its quotes) is one of `keys`, compared in place. */
function isDeclared(json: string, start: number, end: number, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (end - start - 1 === key.length && json.startsWith(key, start + 1)) return true;
  }
  return false;
}

/** The index of the first character at or after `i` that is not JSON whitespace. */
function skipSpace(json: string, i: number): number {
  for (; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
  }
  return i;
}

/**
 * One linear pass over `json` (the text of an answer) that skips strings and looks at every
 * number literal:
 * - the value of a member named in `bigIntegerKeys` is quoted, as written (`"_version_":
 *   1858054135406919680` becomes `"_version_":"1858054135406919680"`), so JSON.parse delivers
 *   it exactly as a string, whatever its size. Only a literal the JSON grammar allows is quoted,
 *   so a malformed one (`01`) still fails JSON.parse;
 * - any other number is checked as {@link firstInexactNumber} says, and the first one JSON.parse
 *   cannot carry exactly is reported in `inexact`.
 * Nothing is allocated per value: a member name is compared in place (only a name written with
 * an escape is decoded), and the text is copied only when a declared member is found. No
 * reviver, which would recurse per nesting level and overflow on deep data.
 */
export function scanNumbers(json: string, bigIntegerKeys: ReadonlySet<string> = NO_KEYS): NumberScan {
  const keys = bigIntegerKeys.size === 0 ? undefined : [...bigIntegerKeys];
  let inexact: string | undefined;
  let out: string | undefined;
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      const start = i;
      let escaped = false;
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) {
          escaped = true;
          i++;
        } else if (d === 0x22) break;
      }
      if (keys === undefined) continue;
      // A member name is a string followed by a colon; is it a declared one with a number value?
      const colon = skipSpace(json, i + 1);
      if (json.charCodeAt(colon) !== 0x3a) continue;
      if (!(escaped ? bigIntegerKeys.has(decodedName(json.slice(start, i + 1))) : isDeclared(json, start, i, keys))) continue;
      const at = skipSpace(json, colon + 1);
      STRICT_JSON_NUMBER.lastIndex = at;
      const literal = STRICT_JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      out = (out ?? "") + json.slice(copied, at) + '"' + literal + '"';
      copied = at + literal.length;
      i = copied - 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (inexact === undefined && (!Number.isFinite(value) || !exactAtTheEdges(literal, value))) {
        inexact = literal;
        if (keys === undefined) break;
      }
      i += literal.length - 1;
    }
  }
  return { json: out === undefined ? json : out + json.slice(copied), inexact };
}

/** A member name written with an escape, decoded; a name JSON.parse can't read matches nothing. */
function decodedName(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return "";
  }
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly, or
 * undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one past
 * 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0`, `9007199254740992.5`), a non-zero one too small for a double
 * (`1e-400` became 0), and a subnormal one that does not print as written (`3e-324` became
 * `5e-324`). Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual
 * precision, as JSON means it. {@link scanNumbers} without declared members.
 */
export function firstInexactNumber(json: string): string | undefined {
  return scanNumbers(json).inexact;
}
