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
  redactCredentials,
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
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header: not blank, Latin-1 without control characters
   * (tab is fine), else a LadesaeulenValidationError.
   */
  userAgent?: string;
  /** Extra headers sent on every request; names must be tokens, values follow the `userAgent` rule. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps: an integer 0..`MAX_TIMEOUT_MS` (2^31 - 1 ms); 0 disables.
   * Defaults to 30000.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, an integer
   * 0..`MAX_RETRIES` (10); defaults to 2. Each waits `retryDelayMs * attempt`, or the
   * response's `Retry-After` when that is longer (up to `MAX_RETRY_AFTER_MS`; a longer
   * one is not retried, and the LadesaeulenApiError says so). A GET whose connection
   * was reset (ECONNRESET, `socket hang up`, undici's UND_ERR_SOCKET, a body cut off
   * mid-way) is retried the same way, with the linear backoff; a refused connection, a
   * DNS failure or a timeout is not.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly), an integer
   * 0..`MAX_RETRY_AFTER_MS` (30 000). Defaults to 200. It is also the floor under a
   * `Retry-After`: the header can lengthen a wait, never shorten it.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative integer. Defaults to 100 MiB;
   * set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
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
 * escaped separately (escapeControlChars in cli/shared.ts), since `JSON.stringify`
 * alone leaves DEL and the C1 range raw. Removes all C0 controls (except
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
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  // Node's transport lower-cases header names; a custom one may not ("Content-Type").
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
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
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

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
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
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
   * A transport failure as the library's error. The default transport rejects with
   * LadesaeulenNetworkError only, which passes through; an injected one may throw
   * anything — a plain Error, fetch's TypeError, a string, null. That becomes a
   * LadesaeulenNetworkError naming the request (URL redacted), with the original as
   * `cause`, so a caller (and the CLI, exit 6) can rely on every failure being a
   * LadesaeulenError. Any other LadesaeulenError passes through.
   */
  private toNetworkError(method: string, url: string, cause: unknown): LadesaeulenError {
    if (cause instanceof LadesaeulenError && !(cause instanceof LadesaeulenNetworkError)) return cause;
    if (cause instanceof LadesaeulenNetworkError) {
      // The default transport's own errors carry no URL; scrub one that does anyway.
      const scrubbed = this.scrubCause(cause);
      if (scrubbed === cause) return cause;
      return new LadesaeulenNetworkError(this.scrub(cause.message), { cause: this.scrubCause(cause.cause) });
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
          await this.sleep(this.retryDelayMs * attempt);
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
        throw new LadesaeulenNetworkError(sizeLimitMessage(this.maxResponseBytes));
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
        await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
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

  /** Request a path with query params and parse the JSON reply into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request(path, query);
    const text = decodeBody(res.data, res.contentType, path);
    if (res.status === 204 || text.trim().length === 0) {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new LadesaeulenParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
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
 * An unknown charset label is a LadesaeulenParseError.
 */
export function decodeBody(body: Buffer, contentType: string, path: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new LadesaeulenParseError(`Unsupported response charset "${sanitizeServerText(charset)}" from ${path}.`);
  }
  return decoder.decode(body);
}
