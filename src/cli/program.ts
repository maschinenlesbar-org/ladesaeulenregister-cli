// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { LadesaeulenClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { MAX_RETRIES } from "../client/engine.js";
import { forbidRepeatedOptions, parseIntArg, parseBoundedInt, parseHeaderValue, parseBaseUrl } from "./shared.js";
import { registerCommands } from "./commands/stations.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new LadesaeulenClient(options),
};

/** commander value-parser for `--log-format`. */
function parseLogFormat(value: string): string {
  const problem = logFormatProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("ladesaeulen")
    .description(
      "CLI for the Ladesäulenregister — the Bundesnetzagentur's register of public EV " +
        "charging stations in Germany (over 100k Ladeeinrichtungen). No API key needed. " +
        "`stations` searches with an SQL --where, paging, spatial --near/--radius, --count " +
        "or --geojson; `count-by` aggregates (e.g. per Bundesland); `fields` lists the " +
        "queryable columns; `info` shows when the data was last edited.",
    )
    .version(VERSION)
    .option(
      "--base-url <url>",
      "API base URL (the ArcGIS FeatureServer)",
      parseBaseUrl,
      "https://services-eu1.arcgis.com/TJm8oSvOdJUQvQT5/arcgis/rest/services/Ladesaeulen/FeatureServer",
    )
    .option(
      "--timeout <ms>",
      "time limit per request in ms, whole response included (default 30000; 0 = no timeout)",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option(
      "--max-retries <n>",
      `retries for transient 429/503 responses and reset connections (0..${MAX_RETRIES}, default 2; each backs off 200 ms, 400 ms, … or waits the server's longer Retry-After, up to 30 s)`,
      parseBoundedInt(0, MAX_RETRIES),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option(
      "--log-format <format>",
      `how errors, warnings and notes are written to stderr: text (log4j style: time, level, [topic], message) or jsonl (one JSON object per line: ts, level, topic, msg); default ${DEFAULT_LOG_FORMAT}`,
      parseLogFormat,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerCommands(program, deps);
  forbidRepeatedOptions(program);

  return program;
}
