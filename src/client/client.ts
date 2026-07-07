// LadesaeulenClient — a typed client over the Ladesäulenregister of the
// Bundesnetzagentur, a public ArcGIS FeatureServer of German EV charging stations
// (~111k Ladeeinrichtungen; layer 0). No auth.
//
// The ArcGIS server answers HTTP 200 even for logical errors, carrying them in an
// `error` object — the client checks for it and throws.
//
//   const c = new LadesaeulenClient();
//   await c.count({ where: "Ort='Berlin' AND Typ='Schnellladeeinrichtung'" }); // 660
//   await c.countBy("state");            // stations per Bundesland
//   await c.stations({ near: { lat: 52.52, lon: 13.405, radiusKm: 1 } });

import { RequestEngine, sanitizeServerText, type EngineOptions } from "./engine.js";
import { LadesaeulenApiError } from "./errors.js";
import type { QueryParams } from "./query.js";
import type {
  ArcGisQueryResponse,
  CountByRow,
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

/** Options for the client (engine options only — the API needs no auth). */
export type LadesaeulenClientOptions = EngineOptions;

export class LadesaeulenClient {
  private readonly engine: RequestEngine;

  constructor(options: LadesaeulenClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /** GET a query path, then throw if the ArcGIS `error` envelope is present. */
  private async get<T extends { error?: { code?: number; message?: string; details?: string[] } }>(
    path: string,
    params: QueryParams,
  ): Promise<T> {
    const res = await this.engine.getJson<T>(path, params);
    const err = res?.error;
    if (err && typeof err === "object") {
      // The ArcGIS `error` message/details come from the (attacker-controllable)
      // response body and flow into an Error.message printed raw to stderr; strip
      // control characters so a hostile endpoint cannot inject terminal escapes.
      const detail = [err.message, ...(Array.isArray(err.details) ? err.details : [])]
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .map(sanitizeServerText)
        .join("; ");
      throw new LadesaeulenApiError({
        url: this.engine.buildUrl(path, params),
        method: "GET",
        body: JSON.stringify(res),
        arcgisCode: typeof err.code === "number" ? err.code : undefined,
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
    return { features: res.features ?? [], exceededTransferLimit: res.exceededTransferLimit ?? false };
  }

  /** The number of stations matching the query (`returnCountOnly`). */
  async count(q: StationQuery = {}): Promise<number> {
    const params = this.buildParams(q, { f: "json", returnCountOnly: true });
    delete params["outFields"];
    const res = await this.get<ArcGisQueryResponse>(`${LAYER}/query`, params);
    return res.count ?? 0;
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
   * Grouped station counts by a field (ArcGIS `outStatistics` group-by), e.g.
   * `countBy("state")` for stations per Bundesland. Sorted descending by count.
   */
  async countBy(field: string, where = "1=1"): Promise<CountByRow[]> {
    const params: QueryParams = {
      where,
      f: "json",
      groupByFieldsForStatistics: field,
      outStatistics: JSON.stringify([
        { statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "count" },
      ]),
      orderByFields: "count DESC",
    };
    const res = await this.get<ArcGisQueryResponse>(`${LAYER}/query`, params);
    return (res.features ?? []).map((f) => ({
      value: (f.attributes[field] as string | number | null) ?? null,
      count: Number(f.attributes["count"] ?? 0),
    }));
  }

  /** The layer's field metadata (names/types/aliases) — for building queries. */
  async fields(): Promise<FieldInfo[]> {
    const res = await this.get<{ fields?: FieldInfo[]; error?: { code?: number; message?: string } }>(
      LAYER,
      { f: "json" },
    );
    return res.fields ?? [];
  }
}
