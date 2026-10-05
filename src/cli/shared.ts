// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and JSON rendering.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { MAX_CHARGE_POINT_KW, MAX_RADIUS_KM, MIN_RADIUS_KM, type LadesaeulenClientOptions } from "../client/client.js";
import { baseUrlProblem, headerValueProblem } from "../client/validate.js";

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals, signs, padding and decimals.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * commander value-parser for `--base-url`: the library's `baseUrlProblem` (a
 * non-empty, well-formed `http:`/`https:` URL with no query, fragment or
 * surrounding whitespace), whose reason becomes the usage error (exit 2). The
 * engine runs the same rule when the client is built, and the transport re-checks
 * the scheme per hop as defence in depth.
 */
export function parseBaseUrl(value: string): string {
  const reason = baseUrlProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/**
 * commander value-parser for `--radius`: a plain decimal number of km (`2`, `0.5`)
 * from `MIN_RADIUS_KM` to `MAX_RADIUS_KM`. A strict regex rather than `Number()`,
 * which accepts hex (`0x10`), exponents (`1e308`) and padding.
 */
export function parseRadiusKm(value: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new InvalidArgumentError("Expected a radius in km as a plain decimal number (e.g. 2.5).");
  }
  const km = Number(value);
  if (km < MIN_RADIUS_KM || km > MAX_RADIUS_KM) {
    throw new InvalidArgumentError(`Radius must be between ${MIN_RADIUS_KM} and ${MAX_RADIUS_KM} km.`);
  }
  return km;
}

/**
 * commander value-parser for `--min-point-kw`: a plain decimal number of kW (`150`,
 * `3.7`) above 0 and at most `MAX_CHARGE_POINT_KW`, the library's `minChargePointKw` range.
 */
export function parsePointKw(value: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new InvalidArgumentError("Expected a power in kW as a plain decimal number (e.g. 150).");
  }
  const n = Number(value);
  if (n <= 0 || n > MAX_CHARGE_POINT_KW) {
    throw new InvalidArgumentError(`Power must be above 0 and at most ${MAX_CHARGE_POINT_KW} kW.`);
  }
  return n;
}

/** commander value-parser for `--near`: a `lat,lon` pair in WGS84 degrees. */
export function parseLatLon(value: string): { lat: number; lon: number } {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!m) throw new InvalidArgumentError("Expected 'lat,lon' (e.g. 52.52,13.405).");
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (lat < -90 || lat > 90) throw new InvalidArgumentError("Latitude must be between -90 and 90.");
  if (lon < -180 || lon > 180) throw new InvalidArgumentError("Longitude must be between -180 and 180.");
  return { lat, lon };
}

/**
 * commander value-parser for a value that ends up in an HTTP header (User-Agent):
 * the library's `headerValueProblem` (not blank, Latin-1 without control
 * characters; tab is fine), whose reason becomes the usage error. The engine runs
 * the same rule on `userAgent`.
 */
export function parseHeaderValue(value: string): string {
  const reason = headerValueProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * Make giving a single-value option twice a usage error, on `command` and every
 * subcommand. Commander keeps the last value silently: `--where "Ort='Berlin'" --where
 * "Typ='Schnellladeeinrichtung'"` counted the fast chargers of all Germany, with nothing
 * telling the user that a filter was dropped. Flags without a value are left alone. Call
 * it once on a freshly built program: the check counts per Option object.
 */
export function forbidRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if ((!option.required && !option.optional) || option.variadic) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) {
        throw new InvalidArgumentError(
          `${option.long ?? option.short} was given more than once; it takes one value` +
            (option.long === "--where" ? " (combine conditions with AND / OR in one --where)." : "."),
        );
      }
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toEngineOptions(global: GlobalOptions): LadesaeulenClientOptions {
  const options: LadesaeulenClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
