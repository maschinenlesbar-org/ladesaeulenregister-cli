// LadesaeulenClient — a typed client over the Ladesäulenregister of the
// Bundesnetzagentur, a public ArcGIS FeatureServer of German EV charging stations
// (over 100k Ladeeinrichtungen; layer 0). No auth.
//
// The ArcGIS server answers HTTP 200 even for logical errors, carrying them in an
// `error` object — the client checks for it and throws.
//
//   const c = new LadesaeulenClient();
//   await c.count({ where: "Ort='Berlin' AND Typ='Schnellladeeinrichtung'" }); // 660
//   await c.countBy("state");            // stations per Bundesland
//   await c.stations({ near: { lat: 52.52, lon: 13.405, radiusKm: 1 } });

import { RequestEngine, type EngineOptions } from "./engine.js";
import { LadesaeulenParseError, LadesaeulenValidationError } from "./errors.js";
import type { QueryParams } from "./query.js";
import { assertValid, countQueryProblem } from "./validate.js";
import type {
  ArcGisQueryResponse,
  CountByPage,
  CountByRow,
  Feature,
  FieldInfo,
  GeoJsonFeatureCollection,
  StationPage,
  StationQuery,
} from "./types.js";

/** The layer holding the charging stations (Ladeeinrichtungen). */
const LAYER = "/0";

/**
 * Default `outFields` — a curated, broadly-useful subset. The layer has ~60 columns
 * including a large `F_response_body` JSON blob per row; `--fields '*'` returns
 * everything.
 */
export const DEFAULT_FIELDS = [
  "ID",
  "Betreiber",
  "operator_companyName",
  "Straße",
  "Hausnummer",
  "Postleitzahl",
  "Ort",
  "district_independent_city",
  "state",
  "Typ",
  "Status",
  "max_electric_power_station",
  "Anzahl_Ladepunkte",
  "coordinates_latitude",
  "coordinates_longitude",
  "go_live_date",
  "Bezahlsystem",
].join(",");

/**
 * Check and trim a `countBy` field name. ArcGIS groups by a comma-separated list
 * too, but each group then carries several values and `CountByRow` has room for
 * one, so a list is refused rather than returning `value: null` for every group.
 */
function groupField(field: string): string {
  const name = typeof field === "string" ? field.trim() : "";
  if (name === "") {
    throw new LadesaeulenValidationError(`Invalid field: expected a field name, got ${JSON.stringify(field)}.`);
  }
  if (name.includes(",")) {
    throw new LadesaeulenValidationError(
      `Invalid field: expected one field name, got a list: ${JSON.stringify(name)}. ` +
        "Group by one field and restrict the others with a where filter.",
    );
  }
  return name;
}

/**
 * The group-by value of one `countBy` row: the attribute named like the field, or
 * — should a server echo the field in its own spelling — the one attribute that
 * matches it case-insensitively. A row without it is a malformed reply, not a
 * `null` group (the register has real `null` groups, e.g. `Betreiber`).
 */
function groupValue(attributes: Record<string, unknown>, field: string, path: string, i: number): unknown {
  if (Object.prototype.hasOwnProperty.call(attributes, field)) return attributes[field];
  const lower = field.toLowerCase();
  const keys = Object.keys(attributes).filter((k) => k.toLowerCase() === lower);
  if (keys.length === 1) return attributes[keys[0]!];
  throw new LadesaeulenParseError(
    `Unexpected response shape from ${path}: expected the group-by field ${JSON.stringify(field)} in every group, group ${i} has none.`,
  );
}

/** The error for a reply whose top-level shape is not what the client relies on. */
function shapeError(path: string, expected: string): LadesaeulenParseError {
  return new LadesaeulenParseError(`Unexpected response shape from ${path}: expected ${expected}.`);
}

/** A short description of a JSON value for a shape error ("null", "a string", …). */
function kindOf(value: unknown): string {
  if (value === undefined) return "none";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The `features` of a query reply, checked: an array whose every element is a
 * JSON object with an `attributes` object. Anything else is a malformed reply —
 * library users are typed against `Feature[]` and the CLI reads `attributes`.
 */
function featureList(features: unknown, path: string): Feature[] {
  if (!Array.isArray(features)) throw shapeError(path, "a features array");
  features.forEach((f: unknown, i) => {
    if (!isObject(f)) {
      throw shapeError(path, `every feature to be a JSON object with an attributes object, feature ${i} is ${kindOf(f)}`);
    }
    if (!isObject(f["attributes"])) {
      throw shapeError(path, `every feature to be a JSON object with an attributes object, feature ${i} has none`);
    }
  });
  return features as Feature[];
}

/**
 * Smallest `--near` radius in km: 1 m. The radius goes to ArcGIS in whole metres,
 * so anything below half a metre would be sent as `distance=0` and match nothing.
 */
export const MIN_RADIUS_KM = 0.001;

/**
 * Largest `--near` radius in km. 1,000 km from any point in Germany covers nearly
 * all of it; far larger values fail upstream ("exceeds the full globe") or are sent
 * as `distance=Infinity`.
 */
export const MAX_RADIUS_KM = 1000;

/** Largest page `stations`/`geojson` ask for (ArcGIS `resultRecordCount`); the server sends at most ~2000. */
export const MAX_LIMIT = 10_000;

/**
 * Page size `stations`/`geojson` ask for when the query sets no `limit`. Without
 * one, the server would send its own cap of about 2000 rows. `count` sends none.
 */
export const DEFAULT_LIMIT = 50;

/** A value as it appears in a validation message: strings quoted, the rest as is. */
function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function invalid(name: string, expected: string, value: unknown): LadesaeulenValidationError {
  return new LadesaeulenValidationError(`Invalid ${name}: expected ${expected}, got ${show(value)}.`);
}

/** A present text parameter must be a non-blank string (ArcGIS reads `where=` as an error, not "all"). */
function checkText(name: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim() === "") throw invalid(name, "a non-empty string", value);
}

function checkInt(name: string, value: unknown, min: number, max: number): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(name, `an integer from ${min} to ${max}`, value);
  }
}

function checkNumber(name: string, value: unknown, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw invalid(name, `a number from ${min} to ${max}`, value);
  }
}

/** The keys a `StationQuery` takes; any other key is refused (`checkKeys`). */
export const STATION_QUERY_KEYS = ["where", "outFields", "limit", "offset", "orderBy", "near"] as const;

/** The keys of `StationQuery.near`. */
const NEAR_KEYS = ["lat", "lon", "radiusKm"] as const;

/**
 * Refuse an own key of `value` that is not in `known` — a misspelling (`wher`), another
 * case (`Where`), `__proto__` from JSON. The client only reads the keys it knows, so such a
 * key used to be dropped silently and the call answered for every station.
 */
function checkKeys(name: string, value: object, known: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue;
    const near = known.find((k) => k.toLowerCase() === key.toLowerCase());
    const hint = near !== undefined ? ` Did you mean "${near}"?` : ` Known keys: ${known.join(", ")}.`;
    throw new LadesaeulenValidationError(`Invalid ${name}: unknown key ${JSON.stringify(key)}.${hint}`);
  }
}

/**
 * A query argument: `undefined` and `null` mean "no options" (`{}`); anything else must
 * be a plain object with only `STATION_QUERY_KEYS`, else a `LadesaeulenValidationError`
 * rather than a raw TypeError or a silently ignored filter.
 */
function queryArg(q: unknown): StationQuery {
  if (q === undefined || q === null) return {};
  if (typeof q !== "object" || Array.isArray(q)) throw invalid("query", "an object", Array.isArray(q) ? "an array" : q);
  checkKeys("query", q, STATION_QUERY_KEYS);
  const near = (q as { near?: unknown }).near;
  if (near !== null && typeof near === "object" && !Array.isArray(near)) checkKeys("near", near, NEAR_KEYS);
  return q as StationQuery;
}

/**
 * Validate a station query before any request, so a library caller gets a typed
 * `LadesaeulenValidationError` instead of a remote ArcGIS 400 (or a silently
 * odd request such as `distance=Infinity` or `resultRecordCount=-3`).
 */
function checkQuery(q: StationQuery): void {
  checkText("where", q.where);
  checkText("outFields", q.outFields);
  checkText("orderBy", q.orderBy);
  checkInt("limit", q.limit, 1, MAX_LIMIT);
  checkInt("offset", q.offset, 0, Number.MAX_SAFE_INTEGER);
  if (q.near !== undefined) {
    if (q.near === null || typeof q.near !== "object") throw invalid("near", "{ lat, lon, radiusKm }", q.near);
    checkNumber("near.lat", q.near.lat, -90, 90);
    checkNumber("near.lon", q.near.lon, -180, 180);
    checkNumber("near.radiusKm", q.near.radiusKm, MIN_RADIUS_KM, MAX_RADIUS_KM);
  }
}

/** Options for the client (engine options only — the API needs no auth). */
export type LadesaeulenClientOptions = EngineOptions;

export class LadesaeulenClient {
  private readonly engine: RequestEngine;

  constructor(options: LadesaeulenClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /** Request a query path, then throw if the ArcGIS `error` envelope is present. */
  private async get<T extends { error?: { code?: number; message?: string; details?: string[] } }>(
    path: string,
    params: QueryParams,
  ): Promise<T> {
    const res = await this.engine.getJson<T>(path, params);
    // Every query/metadata endpoint answers with a JSON envelope object. A null
    // (empty/204 body) or non-object reply means the endpoint did not return the
    // expected shape; surface it as a typed parse error rather than letting a
    // downstream `res.features`/`res.count` dereference throw a raw TypeError that
    // is reported as an "Unexpected error".
    if (res === null || typeof res !== "object" || Array.isArray(res)) {
      const got = res === null ? "an empty body" : Array.isArray(res) ? "an array" : typeof res;
      throw shapeError(path, `a JSON object, got ${got}`);
    }
    // Any present, truthy `error` is a failure — ArcGIS writes it as an object,
    // but a gateway or an older server may send a bare string ("Token Required")
    // or `true`, which must not pass as an empty, successful result.
    const err: unknown = res.error;
    if (err) {
      // The ArcGIS `error` message/details come from the (attacker-controllable)
      // response body and flow into an Error.message printed raw to stderr; the
      // engine strips control characters (so a hostile endpoint cannot inject
      // terminal escapes) and the base URL's credentials, and redacts the URL.
      throw this.engine.envelopeError(path, params, res, err);
    }
    return res;
  }

  /** Build the shared feature-query params (where / outFields / paging / near). */
  private buildParams(q: StationQuery, extra: QueryParams): QueryParams {
    checkQuery(q);
    const p: QueryParams = { where: q.where ?? "1=1", ...extra };
    if (q.outFields !== undefined) p.outFields = q.outFields;
    if (q.limit !== undefined) p.resultRecordCount = q.limit;
    if (q.offset !== undefined) p.resultOffset = q.offset;
    if (q.orderBy !== undefined) p.orderByFields = q.orderBy;
    if (q.near) {
      p.geometry = `${q.near.lon},${q.near.lat}`;
      p.geometryType = "esriGeometryPoint";
      p.inSR = 4326;
      p.distance = Math.round(q.near.radiusKm * 1000);
      p.units = "esriSRUnit_Meter";
      p.spatialRel = "esriSpatialRelIntersects";
    }
    return p;
  }

  /** A page of charging stations (ArcGIS `f=json`); `limit` defaults to `DEFAULT_LIMIT`. */
  async stations(q: StationQuery = {}): Promise<StationPage> {
    q = queryArg(q);
    const params = this.buildParams(
      { ...q, outFields: q.outFields ?? DEFAULT_FIELDS, limit: q.limit ?? DEFAULT_LIMIT },
      { f: "json", returnGeometry: false },
    );
    const res = await this.get<ArcGisQueryResponse>(`${LAYER}/query`, params);
    return {
      features: featureList(res.features, `${LAYER}/query`),
      exceededTransferLimit: res.exceededTransferLimit === true,
    };
  }

  /**
   * The number of stations matching the query (`returnCountOnly`): every match of
   * `where` and `near`. A `limit`, `offset`, `orderBy` or `outFields` is a
   * `LadesaeulenValidationError` (`countQueryProblem`), since ArcGIS ignores them
   * on a count and would return the full total, not a per-page count.
   */
  async count(q: StationQuery = {}): Promise<number> {
    q = queryArg(q);
    assertValid("count query", q, countQueryProblem);
    const params = this.buildParams(q, { f: "json", returnCountOnly: true });
    const res = await this.get<ArcGisQueryResponse>(`${LAYER}/query`, params);
    // 0 is a plausible real answer, so a reply without a usable count must not
    // become one (a proxy's `{}`, a non-ArcGIS endpoint, a string count).
    const count: unknown = res.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw shapeError(`${LAYER}/query`, "a non-negative integer count");
    }
    return count;
  }

  /**
   * The matching stations as a GeoJSON FeatureCollection (`f=geojson`); `limit` defaults
   * to `DEFAULT_LIMIT`. The reply must be a FeatureCollection whose `features` is an
   * array of JSON objects; anything else (a gateway's `{}`, `features: null`, a string)
   * is a `LadesaeulenParseError`, never an empty map.
   */
  async geojson(q: StationQuery = {}): Promise<GeoJsonFeatureCollection> {
    q = queryArg(q);
    const params = this.buildParams(
      { ...q, outFields: q.outFields ?? DEFAULT_FIELDS, limit: q.limit ?? DEFAULT_LIMIT },
      { f: "geojson" },
    );
    const path = `${LAYER}/query`;
    const res = (await this.get<{ error?: { code?: number; message?: string; details?: string[] } }>(
      path,
      params,
    )) as Record<string, unknown>;
    const type = res["type"];
    if (type !== "FeatureCollection") {
      const got = typeof type === "string" ? JSON.stringify(type) : kindOf(type);
      throw shapeError(path, `a GeoJSON FeatureCollection, got type ${got}`);
    }
    const features: unknown = res["features"];
    if (!Array.isArray(features)) throw shapeError(path, `a FeatureCollection with a features array, got ${kindOf(features)}`);
    features.forEach((f: unknown, i) => {
      if (!isObject(f)) throw shapeError(path, `every feature to be a JSON object, feature ${i} is ${kindOf(f)}`);
    });
    return res as unknown as GeoJsonFeatureCollection;
  }

  /**
   * Grouped station counts by one field (ArcGIS `outStatistics` group-by), e.g.
   * `countBy("state")` for stations per Bundesland. Sorted descending by count.
   * The field name is trimmed; a comma-separated list is a
   * `LadesaeulenValidationError`.
   */
  async countBy(field: string, where = "1=1"): Promise<CountByRow[]> {
    return (await this.countByPage(field, where)).groups;
  }

  /**
   * Like `countBy`, plus the server's `exceededTransferLimit`: `true` when the
   * list was cut at the server's ~2000-group cap (the largest groups are still
   * all there, since the server sorts by count first).
   */
  async countByPage(field: string, where = "1=1"): Promise<CountByPage> {
    const name = groupField(field);
    checkText("where", where);
    const params: QueryParams = {
      where,
      f: "json",
      groupByFieldsForStatistics: name,
      outStatistics: JSON.stringify([
        { statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "count" },
      ]),
      orderByFields: "count DESC",
    };
    const res = await this.get<ArcGisQueryResponse>(`${LAYER}/query`, params);
    const path = `${LAYER}/query`;
    const groups = featureList(res.features, path).map((f, i) => {
      const count: unknown = f.attributes["count"];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw shapeError(path, `a non-negative integer count in every group, group ${i} has ${kindOf(count)}`);
      }
      return { value: (groupValue(f.attributes, name, path, i) as string | number | null) ?? null, count };
    });
    return { groups, exceededTransferLimit: res.exceededTransferLimit === true };
  }

  /** The layer's field metadata (names/types/aliases) — for building queries. */
  async fields(): Promise<FieldInfo[]> {
    const res = await this.get<{ fields?: FieldInfo[]; error?: { code?: number; message?: string } }>(
      LAYER,
      { f: "json" },
    );
    const fields: unknown = res.fields;
    if (!Array.isArray(fields)) throw shapeError(LAYER, "a fields array");
    fields.forEach((f: unknown, i) => {
      if (!isObject(f) || typeof f["name"] !== "string") {
        const what = isObject(f) ? "has no string name" : `is ${kindOf(f)}`;
        throw shapeError(LAYER, `every field to be a JSON object with a string name, field ${i} ${what}`);
      }
    });
    return fields as FieldInfo[];
  }
}
