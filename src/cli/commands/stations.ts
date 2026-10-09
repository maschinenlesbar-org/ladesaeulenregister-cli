// Command group for the Ladesäulenregister CLI: the primary `stations` query
// (filter / page / spatial / count / geojson), a `count-by` grouped aggregation,
// and `fields` to list the queryable columns.

import type { Command } from "commander";
import { logOf, type CliDeps } from "../io.js";
import type { StationQuery } from "../../client/types.js";
import { LadesaeulenValidationError } from "../../client/errors.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../../client/client.js";
import { EMPTY_FIELDS, emptyFieldsIn } from "../../client/columns.js";
import { countIgnoredOptions, type COUNT_IGNORED_KEYS } from "../../client/validate.js";
import {
  action,
  type ActionContext,
  parseBoundedInt,
  parseIntArg,
  parseLatLon,
  parseNonEmpty,
  parsePointKw,
  parseRadiusKm,
  renderJson,
} from "../shared.js";

/**
 * Roughly Germany's bounding box (generous margins). Used only to catch a likely
 * latitude/longitude swap in `--near` (both numbers are valid lat AND lon, so the
 * parser cannot tell them apart).
 */
function isOutsideGermany(lat: number, lon: number): boolean {
  return lat < 47 || lat > 56 || lon < 5 || lon > 16;
}

/**
 * The stderr note for a truncated page. When the page is as long as `--limit`, the
 * user's own limit cut it; only a shorter page means the server's ~2000-row cap did.
 */
function truncationNote(rows: number, limit: number, filtered = false): string {
  if (filtered) {
    return (
      `more stations may match than the ${rows} returned: --min-point-kw checked one page of ` +
      `candidates (--limit ${limit}, the server sends at most ~2000). Page with --offset, or raise --limit.`
    );
  }
  if (rows >= limit) {
    return `more stations match than the ${rows} returned (--limit ${limit}). Page with --offset, or raise --limit.`;
  }
  return (
    "more stations match than were returned (the server caps a page at ~2000 rows). " +
    "Page with --offset, or narrow --where."
  );
}

/**
 * The stderr note for columns the register never fills (`EMPTY_FIELDS`) named in a filter,
 * sort, field list or group: their filters match nothing and their groups are one null
 * group, with exit 0, so say so rather than let the 0 read like an answer.
 */
function emptyFieldsNote(deps: CliDeps, texts: Array<string | undefined>): void {
  const names = [...new Set(texts.flatMap((t) => (t === undefined ? [] : emptyFieldsIn(t))))];
  if (names.length === 0) return;
  logOf(deps).info(
    "api",
    `${names.join(", ")} ${names.length === 1 ? "is" : "are"} empty on every row of the register ` +
      "(checked 2026-10-06), so a filter on it matches nothing and a group on it is one null group.",
  );
}

/** The CLI flag for each `StationQuery` key `count()` refuses, for flag-style wording. */
const COUNT_KEY_FLAGS: Record<(typeof COUNT_IGNORED_KEYS)[number], string> = {
  limit: "--limit",
  offset: "--offset",
  orderBy: "--order-by",
  outFields: "--fields",
};

/**
 * Count the stations. The library refuses paging, sort and field options on a
 * count before any request; its error is reworded here with the flag names.
 */
async function countStations(client: ActionContext["client"], q: StationQuery): Promise<number> {
  try {
    return await client.count(q);
  } catch (err) {
    const keys = countIgnoredOptions(q);
    if (err instanceof LadesaeulenValidationError && keys.length > 0) {
      throw new LadesaeulenValidationError(
        `--count cannot be combined with ${keys.map((key) => COUNT_KEY_FLAGS[key]).join(", ")}: ` +
          "it counts every match, so paging, sorting and field options do not apply.",
      );
    }
    throw err;
  }
}

/** Build a StationQuery from this command's parsed options. */
function buildStationQuery(opts: Record<string, unknown>): StationQuery {
  const q: StationQuery = {};
  if (typeof opts["where"] === "string") q.where = opts["where"];
  if (typeof opts["limit"] === "number") q.limit = opts["limit"];
  if (typeof opts["offset"] === "number") q.offset = opts["offset"];
  if (typeof opts["orderBy"] === "string") q.orderBy = opts["orderBy"];
  if (typeof opts["fields"] === "string") q.outFields = opts["fields"];
  if (typeof opts["minPointKw"] === "number") q.minChargePointKw = opts["minPointKw"];

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
      `max rows per request (1..${MAX_LIMIT}, default ${DEFAULT_LIMIT}; the server returns at most ~2000 — page with --offset)`,
      parseBoundedInt(1, MAX_LIMIT),
    )
    .option("--offset <n>", "rows to skip (for paging)", parseIntArg)
    .option(
      "--order-by <spec>",
      "sort, e.g. \"Ort ASC\" or \"CAST(max_electric_power_station AS FLOAT) DESC\" (power is a text column)",
      parseNonEmpty,
    )
    .option("--fields <list>", "comma-separated field list, or '*' for all (see `fields`)", parseNonEmpty)
    .option("--near <lat,lon>", "only stations near this WGS84 point (needs --radius)", parseLatLon)
    .option("--radius <km>", "search radius in km for --near (0.001..1000)", parseRadiusKm)
    .option(
      "--min-point-kw <kW>",
      "only stations where one charge point can deliver at least this many kW (adds max_charge_point_kw, " +
        "read from the connector columns; max_electric_power_station is often the sum of all points)",
      parsePointKw,
    )
    .option("--count", "print only the number of matching stations")
    .option("--geojson", "output a GeoJSON FeatureCollection instead of ArcGIS JSON")
    .action(
      action(deps, async ({ client, global, opts }) => {
        if (opts["count"] === true && opts["geojson"] === true) {
          throw new LadesaeulenValidationError("--count and --geojson cannot be combined.");
        }
        const q = buildStationQuery(opts);
        emptyFieldsNote(deps, [q.where, q.orderBy, q.outFields]);
        if (q.near && isOutsideGermany(q.near.lat, q.near.lon)) {
          logOf(deps).info(
            "cli",
            `--near point (lat ${q.near.lat}, lon ${q.near.lon}) is outside Germany — ` +
              "did you swap latitude and longitude? --near expects lat,lon.",
          );
        }
        if (opts["count"] === true) {
          renderJson(deps, global, await countStations(client, q));
        } else if (opts["geojson"] === true) {
          const collection = await client.geojson(q);
          // ArcGIS puts the flag on the FeatureCollection's `properties`.
          if (collection.properties?.exceededTransferLimit === true) {
            logOf(deps).info("api", truncationNote(collection.features.length, q.limit ?? DEFAULT_LIMIT, q.minChargePointKw !== undefined));
          }
          renderJson(deps, global, collection);
        } else {
          const page = await client.stations(q);
          if (page.exceededTransferLimit) {
            logOf(deps).info("api", truncationNote(page.features.length, q.limit ?? DEFAULT_LIMIT, q.minChargePointKw !== undefined));
          }
          renderJson(deps, global, page);
        }
      }),
    );

  program
    .command("count-by")
    .description("Count stations grouped by a field, e.g. `count-by state` (per Bundesland)")
    .argument("<field>", "one field to group by (e.g. state, Typ, operator_companyName, Ort)", parseNonEmpty)
    .option("--where <sql>", "restrict to matching stations first", parseNonEmpty)
    .action(
      action(deps, async ({ client, global, opts }, [field]) => {
        const where = typeof opts["where"] === "string" ? opts["where"] : "1=1";
        emptyFieldsNote(deps, [field, where]);
        const page = await client.countByPage(field!, where);
        if (page.exceededTransferLimit) {
          logOf(deps).info(
            "api",
            `more groups exist than the ${page.groups.length} returned (the server caps a result at ~2000 ` +
              "groups). The largest groups are all there; narrow --where to see the rest.",
          );
        }
        renderJson(deps, global, page.groups);
      }),
    );

  program
    .command("info")
    .description("Show how current the register is: the layer's name and last edit dates (cite dataLastEditDate)")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.layerInfo());
      }),
    );

  program
    .command("fields")
    .description("List the queryable field names (for --where / --fields / count-by)")
    .action(
      action(deps, async ({ client, global }) => {
        const fields = await client.fields();
        const empty = fields.filter((f) => EMPTY_FIELDS.includes(f.name)).map((f) => f.name);
        if (empty.length > 0) {
          logOf(deps).info(
            "api",
            `${empty.length} of these columns are empty on every row of the register (checked 2026-10-06): ` +
              `${empty.join(", ")}.`,
          );
        }
        renderJson(
          deps,
          global,
          fields.map((f) => ({ name: f.name, type: f.type, alias: f.alias })),
        );
      }),
    );
}
