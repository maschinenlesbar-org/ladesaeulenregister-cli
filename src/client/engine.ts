// The request engine: turns logical (path, query) calls into HTTP requests via a
// Transport, applies retry/backoff for transient statuses (429, 503), and decodes
// JSON responses. The Ladesäulenregister is a public ArcGIS FeatureServer — an
// unauthenticated API whose parameters travel in the query string, or, for a query
// too long for a URL, in a form-encoded POST body (ArcGIS `/query` accepts both).

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { LadesaeulenApiError, LadesaeulenNetworkError, LadesaeulenParseError } from "./errors.js";

export const DEFAULT_BASE_URL =
  "https://services-eu1.arcgis.com/TJm8oSvOdJUQvQT5/arcgis/rest/services/Ladesaeulen/FeatureServer";
const DEFAULT_USER_AGENT = "ladesaeulenregister-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to the public Ladesäulen ArcGIS FeatureServer. */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; capped at `MAX_TIMEOUT_MS`, 2^31 - 1 ms).
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses. Each waits the
   * response's `Retry-After` (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried), or else `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly); used without a Retry-After. */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

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
  return seen.size > 0 ? [...seen].join("; ") : undefined;
}

/**
 * Reject a base URL whose scheme is not http(s), or that has a query or fragment.
 * The default transport already gates the scheme per hop, but the engine is
 * exported as a library and may be handed a custom transport that does no such
 * check, so gate the configured base URL here too (a `file:`/`ftp:` base URL fails
 * fast with a typed error). Request paths are appended to the base URL as a string,
 * so a `?` or `#` in it would swallow every path: `http://h/fs?x=1` requests
 * `/fs?x=1/0/query?...` and `http://h/fs#f` requests `/fs` with no parameters.
 */
function assertHttpScheme(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LadesaeulenNetworkError(`Invalid base URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LadesaeulenNetworkError(
      `Unsupported protocol "${url.protocol}" in base URL: ${baseUrl}`,
    );
  }
  if (/[?#]/.test(baseUrl)) {
    throw new LadesaeulenNetworkError(`Base URL must not contain a query or fragment: ${baseUrl}`);
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    assertHttpScheme(this.baseUrl);
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
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
   * Perform a request (GET, or a form POST for a long query — see `requestTarget`)
   * with Accept negotiation and transient-error retries. Redirects are NOT
   * followed — the canonical host answers directly, so a 3xx surfaces as an error.
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

    let attempt = 0;
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Request a path with query params and parse the JSON reply into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request(path, query);
    const text = res.data.toString("utf8");
    if (res.status === 204 || text.trim().length === 0) {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new LadesaeulenParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(method: string, url: string, status: number, body: Buffer): LadesaeulenApiError {
    const text = body.toString("utf8");
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
        detail = snippet.length > 200 ? `${snippet.slice(0, 200)}…` : snippet;
      }
    }
    // `detail` came from the attacker-controlled response body; strip control
    // characters so a hostile endpoint cannot drive terminal escape sequences
    // into stderr via the error message.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    return new LadesaeulenApiError({ status, url, method, body: text, detail });
  }
}
