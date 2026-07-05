// Command group for the Ladesäulenregister CLI: the primary `stations` query
// (filter / page / spatial / count / geojson), a `count-by` grouped aggregation,
// and `fields` to list the queryable columns.

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import type { StationQuery } from "../../client/types.js";
import { LadesaeulenValidationError } from "../../client/errors.js";
import {
  action,
  parseBoundedInt,
  parseIntArg,
  parseLatLon,
  parseNonEmpty,
  parsePositiveFloat,
  renderJson,
} from "../shared.js";

/** Build a StationQuery from this command's parsed options. */
function buildStationQuery(opts: Record<string, unknown>): StationQuery {
  const q: StationQuery = {};
  if (typeof opts["where"] === "string") q.where = opts["where"];
  if (typeof opts["limit"] === "number") q.limit = opts["limit"];
  if (typeof opts["offset"] === "number") q.offset = opts["offset"];
  if (typeof opts["orderBy"] === "string") q.orderBy = opts["orderBy"];
  if (typeof opts["fields"] === "string") q.outFields = opts["fields"];

  const near = opts["near"] as { lat: number; lon: number } | undefined;
  const radius = opts["radius"] as number | undefined;
  if (near !== undefined || radius !== undefined) {
    if (near === undefined || radius === undefined) {
      throw new LadesaeulenValidationError("--near and --radius must be given together.");
    }
    q.near = { lat: near.lat, lon: near.lon, radiusKm: radius };
  }
  return q;
}

export function registerCommands(program: Command, deps: CliDeps): void {
  program
    .command("stations")
    .description("Search charging stations (Ladeeinrichtungen)")
    .option("--where <sql>", "SQL filter, e.g. \"Ort='Berlin' AND Typ='Schnellladeeinrichtung'\"", parseNonEmpty)
    .option(
      "--limit <n>",
      "max rows per request (1..10000; the server returns at most ~2000 — page with --offset)",
      parseBoundedInt(1, 10000),
      50,
    )
    .option("--offset <n>", "rows to skip (for paging)", parseIntArg)
    .option("--order-by <spec>", "sort, e.g. \"Ort ASC\" or \"max_electric_power_station DESC\"", parseNonEmpty)
    .option("--fields <list>", "comma-separated field list, or '*' for all (see `fields`)", parseNonEmpty)
    .option("--near <lat,lon>", "only stations near this WGS84 point (needs --radius)", parseLatLon)
    .option("--radius <km>", "search radius in km for --near", parsePositiveFloat)
    .option("--count", "print only the number of matching stations")
    .option("--geojson", "output a GeoJSON FeatureCollection instead of ArcGIS JSON")
    .action(
      action(deps, async ({ client, global, opts }) => {
        const q = buildStationQuery(opts);
        if (opts["count"] === true) {
          renderJson(deps, global, await client.count(q));
        } else if (opts["geojson"] === true) {
          renderJson(deps, global, await client.geojson(q));
        } else {
          const page = await client.stations(q);
          if (page.exceededTransferLimit) {
            deps.io.err(
              "Note: more stations match than were returned (the server caps a page at ~2000 rows). " +
                "Page with --offset, or narrow --where.",
            );
          }
          renderJson(deps, global, page);
        }
      }),
    );

  program
    .command("count-by")
    .description("Count stations grouped by a field, e.g. `count-by state` (per Bundesland)")
    .argument("<field>", "field to group by (e.g. state, Typ, Betreiber, Ort)", parseNonEmpty)
    .option("--where <sql>", "restrict to matching stations first", parseNonEmpty)
    .action(
      action(deps, async ({ client, global, opts }, [field]) => {
        const where = typeof opts["where"] === "string" ? opts["where"] : "1=1";
        renderJson(deps, global, await client.countBy(field!, where));
      }),
    );

  program
    .command("fields")
    .description("List the queryable field names (for --where / --fields / count-by)")
    .action(
      action(deps, async ({ client, global }) => {
        const fields = await client.fields();
        renderJson(
          deps,
          global,
          fields.map((f) => ({ name: f.name, type: f.type, alias: f.alias })),
        );
      }),
    );
}
