// Charging power per charge point, derived from the register's own columns.
//
// `max_electric_power_station` is the operator's figure for the whole station, and
// operators fill it differently: many enter the sum of the charge points (2 × 150 kW
// CCS → "300", 2 × 22 kW AC → "44"), others the fastest point (4 × 22 kW → "22"), and
// some a station limit below the connectors' rating (2 × 300 kW CCS → "150", live
// 2026-10-06). So it is not the power a car can get. Each charge point's connectors
// carry their own rating in `Steckersystem_Ladepunkt1..10`, as text: one line per
// connector, ending in "(N kw)" ("DC Fahrzeugkupplung Typ Combo 2 (CCS) (160 kw)\nDC
// CHAdeMO (50 kw)"; "( kw)" when the operator left it empty). The functions here read
// those ratings; the client uses them for `max_charge_point_kw` and `minChargePointKw`.

/** The ten per-charge-point connector columns (the register fills at most six). */
export const CHARGE_POINT_FIELDS: readonly string[] = Array.from(
  { length: 10 },
  (_, i) => `Steckersystem_Ladepunkt${i + 1}`,
);

/** The derived attribute the client adds to a row that carries connector columns. */
export const MAX_CHARGE_POINT_KW_FIELD = "max_charge_point_kw";

/** A connector rating in a `Steckersystem_LadepunktN` line: "(150 kw)", "(3.7 kw)". */
const RATING = /\((\d+(?:[.,]\d+)?)\s*kw\)/gi;

/** A plain non-negative decimal (`"150"`, `"3.7"`, `"3,7"`) as a number, else null. */
function kw(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  return /^\d+(?:[.,]\d+)?$/.test(text.trim()) && Number.isFinite(n) ? n : null;
}

/** The connector ratings in kW in one `Steckersystem_LadepunktN` value ([] for none). */
export function connectorRatingsKw(text: unknown): number[] {
  if (typeof text !== "string") return [];
  const out: number[] = [];
  for (const m of text.matchAll(RATING)) {
    const n = kw(m[1]!);
    if (n !== null) out.push(n);
  }
  return out;
}

/**
 * The fastest connector rating of each charge point that has a connector column, in
 * column order: `[160, 160]` for a station with two 160 kW CCS points. A point whose
 * column holds no rating ("( kw)") is `null`.
 */
export function chargePointRatingsKw(attributes: Record<string, unknown>): Array<number | null> {
  const out: Array<number | null> = [];
  for (const field of CHARGE_POINT_FIELDS) {
    const value = attributes[field];
    if (typeof value !== "string" || value.trim() === "") continue;
    const ratings = connectorRatingsKw(value);
    out.push(ratings.length > 0 ? Math.max(...ratings) : null);
  }
  return out;
}

/** `max_electric_power_station` as a number (it is a text column), or null. */
export function stationPowerKw(attributes: Record<string, unknown>): number | null {
  const value = attributes["max_electric_power_station"];
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return typeof value === "string" ? kw(value) : null;
}

/**
 * The most one charge point of the station can deliver by the register's own figures:
 * the fastest connector rating over all charge points, capped at the station's
 * `max_electric_power_station` when that is lower (a station limit). `null` when no
 * connector carries a rating. This, not `max_electric_power_station`, answers "where can
 * a car charge at N kW": Jolt's 2 × 160 kW station has a station figure of 320 but a
 * `max_charge_point_kw` of 160.
 */
export function maxChargePointKw(attributes: Record<string, unknown>): number | null {
  const ratings = chargePointRatingsKw(attributes).filter((n): n is number => n !== null);
  if (ratings.length === 0) return null;
  const fastest = Math.max(...ratings);
  const station = stationPowerKw(attributes);
  return station !== null && station < fastest ? station : fastest;
}

/** True when the row carries at least one connector column (so the rating can be read). */
export function hasChargePointFields(attributes: Record<string, unknown>): boolean {
  return CHARGE_POINT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(attributes, field));
}
