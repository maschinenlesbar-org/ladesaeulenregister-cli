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
  /** Max electric power of the station, in kW. */
  max_electric_power_station?: number;
  /** Number of charge points. */
  Anzahl_Ladepunkte?: number;
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

/** Query options for a station search. */
export interface StationQuery {
  /** SQL `where` filter (default `1=1`). */
  where?: string;
  /** Comma-separated field list, or `*`. Defaults to a curated set. */
  outFields?: string;
  /** Max rows to return (ArcGIS `resultRecordCount`). */
  limit?: number;
  /** Rows to skip (ArcGIS `resultOffset`). */
  offset?: number;
  /** Sort spec, e.g. `"Ort ASC"` (ArcGIS `orderByFields`). */
  orderBy?: string;
  /** Spatial filter: only stations within `radiusKm` of this point. */
  near?: { lat: number; lon: number; radiusKm: number };
}
