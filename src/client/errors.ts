// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A URL without userinfo is returned unchanged; one that does not parse has its
 * userinfo cut out by text (credentialsIn / redactCredentials).
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A value that doesn't parse (a port typo, an unencoded "#" in the password) can still
    // carry credentials: cut them out by text.
    return redactCredentials(url, credentialsIn(url));
  }
  // `user:pw@host` without a scheme parses as a URL with the scheme "user:": no userinfo.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that don't
 * parse as a URL too, and on values with a prefix (`--base-url=https://u:p@h`): the userinfo
 * is everything between `://` and the last `@` before the host. A value without a scheme
 * counts when it reads `user:password@host`. Used to redact those exact strings from text
 * that echoes the value (usage errors, help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  if (typeof value !== "string") return [];
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--base-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them) that is
 * followed by `@` replaced by `***`. Matching the exact strings, not a pattern, covers
 * passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/** Base class for every error originating from this client. */
export class LadesaeulenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API signalled a failure. The ArcGIS FeatureServer is unusual: it answers
 * HTTP 200 even for logical errors, carrying the message in an `error` object
 * (`{code, message, details}`) — e.g. a bad `where` clause or "Token Required".
 * This error models both worlds:
 *  - `status` is set for a genuine transport/HTTP failure (non-2xx);
 *  - `arcgisCode` is set for a logical ArcGIS error (from `error.code`).
 * `detail` holds the human-readable message in either case.
 */
export class LadesaeulenApiError extends LadesaeulenError {
  readonly status: number | undefined;
  readonly arcgisCode: number | undefined;
  readonly detail: string | undefined;
  /** The request URL, userinfo redacted (`https://***@host/…`). */
  readonly url: string;
  readonly method: string;
  /** The response body as text (the base URL's credentials scrubbed by the engine). */
  readonly body: string;
  /** How many times the engine retried the request before giving up (0 when it did not). */
  readonly retries: number;
  /**
   * The wait the server asked for in `Retry-After` (milliseconds) when it was longer than
   * the engine waits (`MAX_RETRY_AFTER_MS`), so the request was not retried; else undefined.
   */
  readonly retryAfterMs: number | undefined;

  constructor(args: {
    url: string;
    method: string;
    body: string;
    status?: number;
    arcgisCode?: number;
    detail?: string;
    retries?: number;
    retryAfterMs?: number;
    maxRetryAfterMs?: number;
  }) {
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.retryAfterMs !== undefined) {
      // Say why the retries the caller asked for never ran: the server asked for a wait
      // longer than the engine sleeps, and retrying earlier would land inside that window.
      const wait = Math.ceil(args.retryAfterMs / 1000);
      const cap = args.maxRetryAfterMs === undefined ? "" : `, longer than the ${args.maxRetryAfterMs / 1000} s the client waits`;
      parts.push(`the server asked to retry after ${wait} s${cap}; not retried — try again after that`);
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    const retries = args.retries ?? 0;
    // Say that the status persisted through retries, so a user knows whether raising
    // --max-retries could help.
    const retryPart = retries > 0 ? ` (after ${retries} ${retries === 1 ? "retry" : "retries"})` : "";
    const head =
      args.status !== undefined
        ? `HTTP ${args.status}`
        : `ArcGIS error${args.arcgisCode !== undefined ? ` ${args.arcgisCode}` : ""}`;
    // The URL is shown without userinfo: a credential in the base URL must not leak.
    const url = redactUrl(args.url);
    super(`${head} for ${args.method} ${url}${detailPart}${retryPart}`);
    this.status = args.status;
    this.arcgisCode = args.arcgisCode;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.retries = retries;
    this.retryAfterMs = args.retryAfterMs;
  }

  /** True for HTTP statuses the API treats as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }

  /** True for a transport-level HTTP 404. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class LadesaeulenNetworkError extends LadesaeulenError {}

/**
 * A client-side validation error — a bad CLI option or library argument (a blank
 * `where`, an out-of-range `near`/`limit`/`offset`, a `countBy` field list, a
 * malformed `baseUrl`, an out-of-range engine option). No request is made.
 */
export class LadesaeulenValidationError extends LadesaeulenError {}

/** The response body could not be parsed as the expected JSON shape. */
export class LadesaeulenParseError extends LadesaeulenError {}
