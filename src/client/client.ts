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

import { RequestEngine, sanitizeServerText, type EngineOptions } from "./engine.js";
import { LadesaeulenApiError, LadesaeulenParseError, LadesaeulenValidationError } from "./errors.js";
import type { QueryParams } from "./query.js";
import type {
  ArcGisQueryResponse,
  CountByRow,
  Feature,
  FieldInfo,
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
      // response body and flow into an Error.message printed raw to stderr; strip
      // control characters so a hostile endpoint cannot inject terminal escapes.
      const e = typeof err === "object" ? (err as { code?: unknown; message?: unknown; details?: unknown }) : {};
      const parts: unknown[] =
        typeof err === "string" ? [err] : [e.message, ...(Array.isArray(e.details) ? e.details : [])];
      const detail = parts
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .map(sanitizeServerText)
        .join("; ");
      const target = this.engine.requestTarget(path, params);
      throw new LadesaeulenApiError({
        url: target.url,
        method: target.method,
        body: JSON.stringify(res),
        arcgisCode: typeof e.code === "number" ? e.code : undefined,
        detail: detail || undefined,
      });
    }
    return res;
  }

  /** Build the shared feature-query params (where / outFields / paging / near). */
  private buildParams(q: StationQuery, extra: QueryParams): QueryParams {
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

  /** A page of charging stations (ArcGIS `f=json`). */
  async stations(q: StationQuery = {}): Promise<StationPage> {
    const params = this.buildParams(
      { ...q, outFields: q.outFields ?? DEFAULT_FIELDS },
      { f: "json", returnGeometry: false },
    );
    const res = await this.get<ArcGisQueryResponse>(`${LAYER}/query`, params);
    return {
      features: featureList(res.features, `${LAYER}/query`),
      exceededTransferLimit: res.exceededTransferLimit === true,
    };
  }

  /** The number of stations matching the query (`returnCountOnly`). */
  async count(q: StationQuery = {}): Promise<number> {
    const params = this.buildParams(q, { f: "json", returnCountOnly: true });
    delete params["outFields"];
    const res = await this.get<ArcGisQueryResponse>(`${LAYER}/query`, params);
    // 0 is a plausible real answer, so a reply without a usable count must not
    // become one (a proxy's `{}`, a non-ArcGIS endpoint, a string count).
    const count: unknown = res.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw shapeError(`${LAYER}/query`, "a non-negative integer count");
    }
    return count;
  }

  /** The matching stations as a GeoJSON FeatureCollection (`f=geojson`). */
  async geojson(q: StationQuery = {}): Promise<unknown> {
    const params = this.buildParams({ ...q, outFields: q.outFields ?? DEFAULT_FIELDS }, { f: "geojson" });
    return this.get<{ error?: { code?: number; message?: string; details?: string[] } }>(
      `${LAYER}/query`,
      params,
    );
  }

  /**
   * Grouped station counts by one field (ArcGIS `outStatistics` group-by), e.g.
   * `countBy("state")` for stations per Bundesland. Sorted descending by count.
   * The field name is trimmed; a comma-separated list is a
   * `LadesaeulenValidationError`.
   */
  async countBy(field: string, where = "1=1"): Promise<CountByRow[]> {
    const name = groupField(field);
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
    return featureList(res.features, path).map((f, i) => {
      const count: unknown = f.attributes["count"];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw shapeError(path, `a non-negative integer count in every group, group ${i} has ${kindOf(count)}`);
      }
      return { value: (groupValue(f.attributes, name, path, i) as string | number | null) ?? null, count };
    });
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
