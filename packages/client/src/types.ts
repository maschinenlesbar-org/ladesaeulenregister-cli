// Types for the Ladesäulenregister ArcGIS FeatureServer (layer 0 = charging
// stations / Ladeeinrichtungen).

/**
 * A charging-station record (the `attributes` of a feature). The layer has ~60
 * columns; only the broadly-useful ones are typed, and the index signature carries
 * the rest (per-charge-point connector columns `Steckersystem_Ladepunkt1..10`, the
 * raw `F_response_body` JSON blob, opening-hours columns, ...). German field names
 * with umlauts are quoted.
 */
export interface ChargingStation {
  ID?: string;
  OBJECTID?: number;
  /** Operator display name. */
  Betreiber?: string;
  /** Operator full company name. */
  operator_companyName?: string;
  "Straße"?: string;
  Hausnummer?: string;
  Postleitzahl?: string;
  Ort?: string;
  address_addition?: string | null;
  /** Kreis / kreisfreie Stadt. */
  district_independent_city?: string;
  /** Bundesland. */
  state?: string;
  /** "Normalladeeinrichtung" or "Schnellladeeinrichtung". */
  Typ?: string;
  /** Operating status, e.g. "In Betrieb". */
  Status?: string;
  coordinates_latitude?: number;
  coordinates_longitude?: number;
  /**
   * The operator's power figure for the whole station, in kW, as a decimal string
   * (`"150"`, `"3.7"`): the column is `esriFieldTypeString`; filter and sort it with
   * `CAST(max_electric_power_station AS FLOAT)`. **Not the power a car can get:** many
   * operators enter the sum of the charge points (2 × 160 kW CCS → `"320"`, 2 × 22 kW
   * AC → `"44"`), others the fastest point (4 × 22 kW → `"22"`), some a station limit
   * below the connectors' rating. For "charge at N kW" use `max_charge_point_kw` and
   * `StationQuery.minChargePointKw`.
   */
  max_electric_power_station?: string;
  /**
   * Derived by the client, not a register column: the most one charge point can deliver
   * by the register's figures — the fastest connector rating in
   * `Steckersystem_Ladepunkt1..10` ("… (160 kw)"), capped at `max_electric_power_station`
   * when that is lower (`maxChargePointKw`). Added to every row that carries a
   * connector column; `null` when no connector has a rating.
   */
  max_charge_point_kw?: number | null;
  /** Number of charge points, as a string (`"2"`; the column is `esriFieldTypeString`). */
  Anzahl_Ladepunkte?: string;
  go_live_date?: string;
  Bezahlsystem?: string;
  /** Any other column the layer carries. */
  [key: string]: unknown;
}

/** An ArcGIS geometry (point) — present when geometry is returned. */
export interface ArcGisPoint {
  x?: number;
  y?: number;
}

/** An ArcGIS feature: attributes plus optional geometry. */
export interface Feature<T = ChargingStation> {
  attributes: T;
  geometry?: ArcGisPoint;
}

/** ArcGIS field metadata (from the layer / a query response). */
export interface FieldInfo {
  name: string;
  type?: string;
  alias?: string;
  length?: number;
  [key: string]: unknown;
}

/**
 * The raw ArcGIS `/query` response envelope. On a logical failure the server still
 * answers HTTP 200 but sets `error` (checked by the client). `count` is present for
 * a `returnCountOnly` query.
 */
export interface ArcGisQueryResponse {
  features?: Feature[];
  fields?: FieldInfo[];
  exceededTransferLimit?: boolean;
  count?: number;
  objectIdFieldName?: string;
  geometryType?: string;
  error?: { code?: number; message?: string; details?: string[] };
  [key: string]: unknown;
}

/**
 * The GeoJSON reply of `geojson()` (ArcGIS `f=geojson`), checked by the client: a
 * FeatureCollection with a `features` array of objects. ArcGIS puts
 * `exceededTransferLimit` into the collection's `properties`.
 */
export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type?: string;
    id?: number | string;
    geometry?: { type?: string; coordinates?: unknown } | null;
    properties?: ChargingStation | null;
    [key: string]: unknown;
  }>;
  properties?: { exceededTransferLimit?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

/** How current the register is: the layer's own metadata (`layerInfo()`, `ladesaeulen info`). */
export interface LayerInfo {
  /** The layer's name (`Ladesaeulen_einfach`). */
  name: string | null;
  /** When the layer was last edited (schema or data), ISO 8601 UTC; null if not sent. */
  lastEditDate: string | null;
  /** When the layer's data was last edited, ISO 8601 UTC; null if not sent. Cite this as the "as of" date. */
  dataLastEditDate: string | null;
  /** Most rows the server returns per request (2000). */
  maxRecordCount: number | null;
}

/** A page of stations — what the client returns from a feature query. */
export interface StationPage {
  features: Feature[];
  /** True when more features match than were returned (raise `--limit` or page). */
  exceededTransferLimit: boolean;
}

/** One grouped-count row from `countBy` (outStatistics group-by). */
export interface CountByRow {
  /** The group value (e.g. a Bundesland name). */
  value: string | number | null;
  /** Number of stations in the group. */
  count: number;
}

/** All groups `countByPage` got back, and whether the server cut the list. */
export interface CountByPage {
  /** The groups, sorted descending by count. */
  groups: CountByRow[];
  /**
   * True when more groups exist than were returned (the server caps a result at
   * ~2000 groups). The groups returned are still the largest ones.
   */
  exceededTransferLimit: boolean;
}

/** Query options for a station search. */
export interface StationQuery {
  /** SQL `where` filter (default `1=1`). */
  where?: string;
  /** Comma-separated field list, or `*`. Defaults to a curated set. */
  outFields?: string;
  /**
   * Max rows to return (ArcGIS `resultRecordCount`), 1..`MAX_LIMIT`. `stations` and
   * `geojson` default to `DEFAULT_LIMIT` (50); the server sends at most ~2000.
   */
  limit?: number;
  /** Rows to skip (ArcGIS `resultOffset`). */
  offset?: number;
  /** Sort spec, e.g. `"Ort ASC"` (ArcGIS `orderByFields`). */
  orderBy?: string;
  /** Spatial filter: only stations within `radiusKm` of this point. */
  near?: { lat: number; lon: number; radiusKm: number };
  /**
   * Only stations where one charge point can deliver at least this many kW
   * (`max_charge_point_kw >= minChargePointKw`; above 0, at most `MAX_CHARGE_POINT_KW`).
   * The server filters on the station figure (`CAST(max_electric_power_station AS FLOAT)
   * >= n`, exact because `max_charge_point_kw` is capped at it), the client on the
   * connector ratings, which the server cannot read. The connector columns are added to
   * `outFields`. `limit`/`offset` page the server's rows, so a page can hold fewer rows
   * than `limit`; `count()` reads every candidate, 2,000 per request.
   */
  minChargePointKw?: number;
}
