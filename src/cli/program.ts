// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { LadesaeulenClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { parseIntArg, parseBoundedInt, parseHeaderValue, parseBaseUrl } from "./shared.js";
import { registerCommands } from "./commands/stations.js";

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

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("ladesaeulen")
    .description(
      "CLI for the Ladesäulenregister — the Bundesnetzagentur's register of public EV " +
        "charging stations in Germany (~111k Ladeeinrichtungen). No API key needed. " +
        "`stations` searches with an SQL --where, paging, spatial --near/--radius, --count " +
        "or --geojson; `count-by` aggregates (e.g. per Bundesland); `fields` lists the " +
        "queryable columns.",
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
      "time limit per request in ms, whole response included (0 = no timeout)",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option("--max-retries <n>", "retries for transient 429/503 responses (0..10)", parseBoundedInt(0, 10))
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerCommands(program, deps);

  return program;
}
