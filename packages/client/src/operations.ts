// The use cases of the skills as library functions, built on the client: each composes its calls
// and carries the traps the skills document, so no caller (the MCP server's use-case tools, a
// library user) has to know them.
// - searchStations: find and count stations by place, postcode, state, operator, type, DC,
//   connector, power per charge point and go-live date (the search skill);
// - findStationsNear: the stations around a point, nearest first, with the distance (the near
//   skill);
// - countStationsBy: station counts per state, place, operator, type … (the stats skill);
// - getStation and getRegisterInfo: one station by its register id; how current the register is
//   and which columns it has (for a `where` of one's own).
// The traps they carry: the operator comes from `operator_companyName` (`Betreiber` is null on
// more than half of the rows); the power a car gets is the fastest charge point's rating, not the
// station figure (often the sum of its points), and both are numbers here, not the register's
// text; "fast" (Schnellladeeinrichtung, above 22 kW) is not "DC", which is read from the
// connectors of all six charge points; the go-live date is `dd.mm.yyyy` text, filtered by year or
// month, never sorted; a name in a string literal is quoted ('' for '); the register undercounts
// and is a snapshot, so every answer carries its date (`attribution.text`). No bare "not found":
// an empty answer says what was searched and, for a place, which places contain the text.

import type { LadesaeulenClient } from "./client.js";
import { MAX_RADIUS_KM, MIN_RADIUS_KM } from "./client.js";
import { emptyFieldsIn, EMPTY_FIELDS } from "./columns.js";
import { LadesaeulenApiError, LadesaeulenParseError, LadesaeulenValidationError } from "./errors.js";
import { CHARGE_POINT_FIELDS, connectorRatingsKw, maxChargePointKw, stationPowerKw } from "./power.js";
import type { StationQuery } from "./types.js";
import { assertValid, normalizeText, textProblem, tokenProblem, whereProblem, type Problem } from "./validate.js";

// ---- shared ---------------------------------------------------------------------------------

/** The Bundesländer by code, as the register's `state` column writes them. */
export const STATES: Readonly<Record<string, string>> = Object.freeze({
  BB: "Brandenburg",
  BE: "Berlin",
  BW: "Baden-Württemberg",
  BY: "Bayern",
  HB: "Bremen",
  HE: "Hessen",
  HH: "Hamburg",
  MV: "Mecklenburg-Vorpommern",
  NI: "Niedersachsen",
  NW: "Nordrhein-Westfalen",
  RP: "Rheinland-Pfalz",
  SH: "Schleswig-Holstein",
  SL: "Saarland",
  SN: "Sachsen",
  ST: "Sachsen-Anhalt",
  TH: "Thüringen",
});

/** Other names a state goes by (English, short forms), folded as {@link fold} folds them. */
const STATE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  bavaria: "BY",
  hesse: "HE",
  "mecklenburg-western pomerania": "MV",
  "lower saxony": "NI",
  nrw: "NW",
  "north rhine-westphalia": "NW",
  "rhineland-palatinate": "RP",
  saxony: "SN",
  "saxony-anhalt": "ST",
  thuringia: "TH",
  "baden-wurttemberg": "BW",
});

/** A name folded for comparison: lower case, umlauts and their ae/oe/ue spellings alike, ß as ss. */
function fold(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss")
    .replace(/([aou])e/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The register's name of a state given as a code ("BY"), its German name ("Bayern",
 * "Thueringen") or an English or short one ("Bavaria", "NRW"). An unknown one is a validation
 * error naming the 16, never a dropped filter (which would answer for all of Germany).
 */
export function resolveState(state: string): string {
  const value = assertValid("state", state, tokenProblem).trim();
  const folded = fold(value);
  const code =
    Object.keys(STATES).find((c) => c === value.toUpperCase()) ??
    Object.entries(STATES).find(([, name]) => fold(name) === folded)?.[0] ??
    STATE_ALIASES[folded];
  if (code === undefined) {
    throw new LadesaeulenValidationError(
      `Invalid state: unknown state ${JSON.stringify(value)}. Expected a code or name: ${Object.entries(STATES).map(([c, n]) => `${c} (${n})`).join(", ")}.`,
    );
  }
  return STATES[code] as string;
}

/** The filters every use case takes; each one is ANDed. */
export interface StationFilter {
  /** The place (`Ort`), whole name, any case: "München". */
  place?: string | undefined;
  /** A postcode (5 digits) or its start (1–4 digits). */
  postcode?: string | undefined;
  /** A part of the Kreis or kreisfreie Stadt (`district_independent_city`): "Landkreis München". */
  district?: string | undefined;
  /** A Bundesland as a code or a name ({@link resolveState}). */
  state?: string | undefined;
  /** A part of the operator's company name (`operator_companyName`): "EnBW". */
  operator?: string | undefined;
  /** `fast`: Schnellladeeinrichtung (a charge point above 22 kW, not the same as DC); `normal`: the others. */
  type?: "normal" | "fast" | undefined;
  /** true: a DC connector on any of the six charge points; false: none. */
  dc?: boolean | undefined;
  /** A part of a connector's name on any charge point: "CHAdeMO", "Combo", "Typ 2", "Schuko". */
  connector?: string | undefined;
  /** Only stations where one charge point delivers at least this many kW (the connector ratings). */
  minPointKw?: number | undefined;
  /** The year the station went live. */
  goLiveYear?: number | undefined;
  /** The month (1–12) of `goLiveYear`. */
  goLiveMonth?: number | undefined;
  /** One more condition in the register's SQL (`ladesaeulen fields` names the columns), ANDed. */
  where?: string | undefined;
}

/** A point and a radius: the stations within `radiusKm` of (`lat`, `lon`), WGS84. */
export interface NearPoint {
  lat: number;
  lon: number;
  radiusKm: number;
}

/** The filter keys, in the order `searched` lists them. */
const FILTER_KEYS = ["place", "postcode", "district", "state", "operator", "type", "dc", "connector", "minPointKw", "goLiveYear", "goLiveMonth", "where"] as const;

/** Options of the use cases: the clock (the retrieval date in the attribution) and how many rows a call may read. */
export interface OperationOptions {
  /** The clock, for "abgerufen am" (default: now). */
  now?: (() => Date) | undefined;
  /**
   * The most rows a call reads to filter by power per charge point, rank by distance or group
   * near a point (default 20,000: ten requests of 2,000). More candidates are refused with what
   * to narrow, never answered from a part.
   */
  maxRows?: number | undefined;
}

/** Rows per request (the register's `maxRecordCount`). */
const PAGE = 2000;

/** Default for {@link OperationOptions.maxRows}. */
export const DEFAULT_MAX_ROWS = 10 * PAGE;

/** An SQL string literal: quoted, a quote inside written twice. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A contains-match for `LIKE`: `'%…%'` with `%`, `_` and the escape character `\` in the value
 * escaped (`ESCAPE '\'`), so they match themselves: a bare `_` would match every name, and the
 * filter would answer for the whole register.
 */
function containing(value: string): string {
  return `${literal(`%${value.replace(/[\\%_]/g, "\\$&")}%`)} ESCAPE '\\'`;
}

/** The six connector columns the register fills (7–10 are empty on every row). */
const CONNECTOR_FIELDS = CHARGE_POINT_FIELDS.slice(0, 6);

const integerIn =
  (min: number, max: number): Problem<number> =>
  (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? undefined : `expected an integer from ${min} to ${max}, got ${String(value)}.`;

const numberIn =
  (min: number, max: number): Problem<number> =>
  (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? undefined : `expected a number from ${min} to ${max}, got ${String(value)}.`;

const postcodeProblem: Problem<string> = (value) => {
  const problem = tokenProblem(value);
  if (problem !== undefined) return problem;
  return /^\d{1,5}$/.test(value.trim()) ? undefined : `expected a postcode (5 digits) or its start (1-4 digits), got ${JSON.stringify(value)}.`;
};

/** The filters checked and canonicalised, the state resolved: what `searched` reports. */
function checkFilter(filter: StationFilter): StationFilter {
  const f: StationFilter = {};
  const text = (name: keyof StationFilter, value: unknown): string | undefined =>
    value === undefined ? undefined : normalizeText(assertValid(name, value as string, textProblem));
  if (filter.place !== undefined) f.place = text("place", filter.place);
  if (filter.postcode !== undefined) f.postcode = assertValid("postcode", filter.postcode, postcodeProblem).trim();
  if (filter.district !== undefined) f.district = text("district", filter.district);
  if (filter.state !== undefined) f.state = resolveState(filter.state);
  if (filter.operator !== undefined) f.operator = text("operator", filter.operator);
  if (filter.type !== undefined) {
    if (filter.type !== "normal" && filter.type !== "fast") throw new LadesaeulenValidationError(`Invalid type: expected "normal" or "fast", got ${JSON.stringify(filter.type)}.`);
    f.type = filter.type;
  }
  if (filter.dc !== undefined) {
    if (typeof filter.dc !== "boolean") throw new LadesaeulenValidationError(`Invalid dc: expected true or false, got ${JSON.stringify(filter.dc)}.`);
    f.dc = filter.dc;
  }
  if (filter.connector !== undefined) f.connector = text("connector", filter.connector);
  if (filter.minPointKw !== undefined) f.minPointKw = assertValid("minPointKw", filter.minPointKw, numberIn(0.1, 10_000));
  if (filter.goLiveYear !== undefined) f.goLiveYear = assertValid("goLiveYear", filter.goLiveYear, integerIn(1990, 2100));
  if (filter.goLiveMonth !== undefined) {
    if (f.goLiveYear === undefined) throw new LadesaeulenValidationError("Invalid goLiveMonth: give goLiveYear with it (the month of which year?).");
    f.goLiveMonth = assertValid("goLiveMonth", filter.goLiveMonth, integerIn(1, 12));
  }
  if (filter.where !== undefined) f.where = normalizeText(assertValid("where", filter.where, whereProblem));
  return f;
}

/**
 * The register's SQL for checked filters (`1=1` for none). Values are string literals with their
 * quotes doubled; contains-matches are `LIKE '%…%'` with the value's `%` and `_` escaped (the
 * server ignores case); DC is read from all
 * six connector columns, a NULL column counted as "no DC"; the go-live date is `dd.mm.yyyy` text,
 * so a year or month is a `LIKE`; power per charge point is narrowed by the station figure (cast,
 * since it is text), which is exact as the per-point figure is capped at it.
 */
function whereOf(f: StationFilter): string {
  const parts: string[] = [];
  if (f.place !== undefined) parts.push(`Ort = ${literal(f.place)}`);
  if (f.postcode !== undefined) parts.push(f.postcode.length === 5 ? `Postleitzahl = ${literal(f.postcode)}` : `Postleitzahl LIKE ${literal(`${f.postcode}%`)}`);
  if (f.district !== undefined) parts.push(`district_independent_city LIKE ${containing(f.district)}`);
  if (f.state !== undefined) parts.push(`state = ${literal(f.state)}`);
  if (f.operator !== undefined) parts.push(`operator_companyName LIKE ${containing(f.operator)}`);
  if (f.type !== undefined) parts.push(`Typ = ${literal(f.type === "fast" ? "Schnellladeeinrichtung" : "Normalladeeinrichtung")}`);
  if (f.dc === true) parts.push(`(${CONNECTOR_FIELDS.map((c) => `${c} LIKE '%DC%'`).join(" OR ")})`);
  if (f.dc === false) parts.push(CONNECTOR_FIELDS.map((c) => `(${c} IS NULL OR ${c} NOT LIKE '%DC%')`).join(" AND "));
  if (f.connector !== undefined) {
    const pattern = containing(f.connector);
    parts.push(`(${CONNECTOR_FIELDS.map((c) => `${c} LIKE ${pattern}`).join(" OR ")})`);
  }
  if (f.minPointKw !== undefined) parts.push(`CAST(max_electric_power_station AS FLOAT) >= ${f.minPointKw}`);
  if (f.goLiveYear !== undefined) {
    const month = f.goLiveMonth === undefined ? "" : `${String(f.goLiveMonth).padStart(2, "0")}.`;
    parts.push(`go_live_date LIKE ${literal(`%.${month}${f.goLiveYear}`)}`);
  }
  if (f.where !== undefined) parts.push(`(${f.where})`);
  return parts.length === 0 ? "1=1" : parts.join(" AND ");
}

/**
 * The register's SQL `where` for `filter`, checked and canonicalised (what the use cases send).
 * Exported for the source of a result and for a library user's own queries.
 */
export function stationWhere(filter: StationFilter = {}): string {
  return whereOf(checkFilter(filter));
}

/** Germany with a margin, to catch a swapped latitude and longitude. */
function inGermany(lat: number, lon: number): boolean {
  return lat >= 47 && lat <= 56 && lon >= 5 && lon <= 16;
}

function checkNear(near: NearPoint): NearPoint {
  if (near === null || typeof near !== "object") throw new LadesaeulenValidationError("Invalid near: expected { lat, lon, radiusKm }.");
  return {
    lat: assertValid("lat", near.lat, numberIn(-90, 90)),
    lon: assertValid("lon", near.lon, numberIn(-180, 180)),
    radiusKm: assertValid("radiusKm", near.radiusKm, numberIn(MIN_RADIUS_KM, MAX_RADIUS_KM)),
  };
}

/** The note for a point outside Germany whose swapped coordinates lie inside it. */
function swapNote(near: NearPoint): string[] {
  return !inGermany(near.lat, near.lon) && inGermany(near.lon, near.lat)
    ? [`The point (lat ${near.lat}, lon ${near.lon}) is outside Germany; swapped it would be inside: latitude first, then longitude.`]
    : [];
}

/** Where the data comes from, as CC BY 4.0 and the Bundesnetzagentur ask it to be named. */
export interface Attribution {
  /** "Datenquelle: Ladesäulenregister der Bundesnetzagentur (bundesnetzagentur.de), lizenziert unter CC BY 4.0 — Datenstand 12.11.2026, abgerufen am 19.11.2026". */
  text: string;
  sourceName: string;
  sourceUrl: string;
  licence: string;
  licenceName: string;
  /** When the register's data was last edited (the layer's `dataLastEditDate`), ISO 8601; null if the server sent none. */
  dataLastEdited: string | null;
  /** The day the answer was read, YYYY-MM-DD: the German date (Europe/Berlin) of "abgerufen am" in `text`. */
  retrieved: string;
}

const SOURCE_NAME = "Ladesäulenregister der Bundesnetzagentur";
const SOURCE_URL = "https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenkarte/start.html";
const LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/";

/** `2026-11-12T07:17:19.492Z` as `12.11.2026` (German local date). */
function germanDate(iso: string): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
}

/** The German local day of `date`, YYYY-MM-DD: the day "abgerufen am" names. */
function germanDay(date: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
}

/**
 * The attribution for an answer read now, from the register's own edit date (one request),
 * started alongside the call's other requests: its failure surfaces where it is awaited, never as
 * an unhandled rejection when another request fails first.
 */
function attributionOf(client: LadesaeulenClient, options: OperationOptions): Promise<Attribution> {
  const pending = readAttribution(client, options);
  pending.catch(() => {});
  return pending;
}

async function readAttribution(client: LadesaeulenClient, options: OperationOptions): Promise<Attribution> {
  return attributionFrom((await client.layerInfo()).dataLastEditDate, options);
}

/** The attribution for data last edited at `dataLastEditDate`, read now. */
function attributionFrom(dataLastEditDate: string | null, options: OperationOptions): Attribution {
  const now = (options.now ?? (() => new Date()))();
  const stand = dataLastEditDate === null ? "" : ` — Datenstand ${germanDate(dataLastEditDate)}`;
  return {
    text: `Datenquelle: ${SOURCE_NAME} (bundesnetzagentur.de), lizenziert unter CC BY 4.0${stand}, abgerufen am ${germanDate(now.toISOString())}`,
    sourceName: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    licence: LICENCE_URL,
    licenceName: "CC BY 4.0",
    dataLastEdited: dataLastEditDate,
    retrieved: germanDay(now),
  };
}

const UNDERCOUNT =
  "The register lists only the stations whose operators completed the Bundesnetzagentur's notification (Anzeigeverfahren): say 'the register lists N', never 'Germany has N'. It counts stations (Ladeeinrichtungen), not charge points.";

/** Notes for the filters as given: the traps they touch. */
function filterNotes(f: StationFilter): string[] {
  const notes: string[] = [];
  if (f.type === "fast" && f.dc === undefined) notes.push("fast (Schnellladeeinrichtung) means a charge point above 22 kW, not DC: a few fast stations are AC only; use dc for DC.");
  if (f.operator !== undefined) notes.push("operator matches operator_companyName, the legal entity: one brand can appear under several names.");
  if (f.minPointKw !== undefined) notes.push(`minPointKw reads each charge point's connector rating: maxChargePointKw is what a car can get; stationKw is the operator's figure for the whole station, often the sum of its points.`);
  if (f.where !== undefined) {
    for (const column of emptyFieldsIn(f.where)) notes.push(`${column} is empty on every row of the register: a condition on it matches nothing (IS NULL: everything).`);
  }
  return notes;
}

/**
 * `run`, with a 400 from the server for a call with a `where` of one's own said to be about that
 * where: the register answers SQL it can't read (an unknown column, a text column compared with
 * a number) with "Unable to perform query. Please check your parameters." only, and the where is
 * the one parameter a caller wrote as SQL.
 */
async function explainingWhere<T>(where: unknown, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (where === undefined || !(err instanceof LadesaeulenApiError) || (err.arcgisCode ?? err.status) !== 400) throw err;
    throw new LadesaeulenApiError({
      url: err.url,
      method: err.method,
      body: err.body,
      status: err.status,
      arcgisCode: err.arcgisCode,
      detail: `${err.detail ?? "the server refused the query"} The likely cause is the where given: a column the register doesn't have, or SQL it can't read (text columns hold numbers: CAST). getRegisterInfo lists the columns and their types.`,
      retries: err.retries,
    });
  }
}

// ---- stations -------------------------------------------------------------------------------

/** The columns a station is read with. */
const STATION_FIELDS = [
  "OBJECTID",
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
  ...CONNECTOR_FIELDS,
];

/** The columns of one station's detail ({@link getStation}): the station's, plus where and when it opens. */
const DETAIL_FIELDS = [...STATION_FIELDS, "address_addition", "location_description", "access_restriction", ...Array.from({ length: 7 }, (_, i) => `Offnungszeiten_Weekday_${i}`)];

/** One charge point: its connectors as the register writes them, and the fastest rating. */
export interface ChargePoint {
  connectors: string[];
  /** The fastest connector's rating in kW, or null when the operator gave none. */
  kw: number | null;
}

/** A station as the use cases give it: numbers as numbers, the operator from the company name. */
export interface Station {
  /** The register's id (`ID`). */
  id: string | null;
  /** The operator's company name (`operator_companyName`, trimmed), else the short `Betreiber`. */
  operator: string | null;
  street: string | null;
  postcode: string | null;
  place: string | null;
  district: string | null;
  state: string | null;
  /** `Schnellladeeinrichtung` or `Normalladeeinrichtung`. */
  type: string | null;
  status: string | null;
  /** The number of charge points. */
  chargePoints: number | null;
  /** The most one charge point delivers, in kW: what a car can get. */
  maxChargePointKw: number | null;
  /** The operator's figure for the whole station, in kW: often the sum of its points. */
  stationKw: number | null;
  /** A DC connector on any charge point. */
  dc: boolean;
  points: ChargePoint[];
  lat: number | null;
  lon: number | null;
  /** The go-live date, YYYY-MM-DD. */
  goLive: string | null;
  payment: string | null;
  /** The straight-line distance from the point asked about, km ({@link findStationsNear}). */
  distanceKm?: number;
  /**
   * True when the station's address lies in another state than nearly all stations around it
   * ({@link findStationsNear}): its coordinates may be wrong (the register has stations of
   * Düren and Dahme/Mark on the Brandenburger Tor).
   */
  checkLocation?: true;
}

/** A station's details: the {@link Station} plus where it is and when it opens. */
export interface StationDetail extends Station {
  /** The short operator name (`Betreiber`), null on more than half of the stations. */
  operatorShortName: string | null;
  addressAddition: string | null;
  locationDescription: string | null;
  accessRestriction: string | null;
  /** Opening hours per weekday as the register writes them, when it has any. */
  openingHours: Record<string, string> | null;
}

const textOf = (value: unknown): string | null => {
  if (typeof value !== "string") return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  const text = value.trim();
  return text === "" ? null : text;
};
const numberOf = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** `31.08.2026` as `2026-08-31`, else null. */
function isoOf(goLive: unknown): string | null {
  const m = typeof goLive === "string" ? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(goLive.trim()) : null;
  return m === null ? null : `${m[3]}-${m[2]}-${m[1]}`;
}

const DC = /\bDC\b/;

/** A register row as a {@link Station}. */
export function toStation(a: Record<string, unknown>): Station {
  const points: ChargePoint[] = [];
  for (const field of CONNECTOR_FIELDS) {
    const value = a[field];
    if (typeof value !== "string" || value.trim() === "") continue;
    const ratings = connectorRatingsKw(value);
    points.push({ connectors: value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ""), kw: ratings.length > 0 ? Math.max(...ratings) : null });
  }
  const street = [textOf(a["Straße"]), textOf(a["Hausnummer"])].filter((part) => part !== null).join(" ");
  const count = Number(textOf(a["Anzahl_Ladepunkte"]));
  return {
    id: textOf(a["ID"]),
    operator: textOf(a["operator_companyName"]) ?? textOf(a["Betreiber"]),
    street: street === "" ? null : street,
    postcode: textOf(a["Postleitzahl"]),
    place: textOf(a["Ort"]),
    district: textOf(a["district_independent_city"]),
    state: textOf(a["state"]),
    type: textOf(a["Typ"]),
    status: textOf(a["Status"]),
    chargePoints: Number.isSafeInteger(count) && count > 0 ? count : null,
    maxChargePointKw: maxChargePointKw(a),
    stationKw: stationPowerKw(a),
    dc: points.some((p) => p.connectors.some((c) => DC.test(c))),
    points,
    lat: numberOf(a["coordinates_latitude"]),
    lon: numberOf(a["coordinates_longitude"]),
    goLive: isoOf(a["go_live_date"]),
    payment: textOf(a["Bezahlsystem"]),
  };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function toDetail(a: Record<string, unknown>): StationDetail {
  const hours: Record<string, string> = {};
  for (let i = 0; i < 7; i++) {
    const text = textOf(a[`Offnungszeiten_Weekday_${i}`]);
    if (text !== null) hours[WEEKDAYS[i] as string] = text;
  }
  return {
    ...toStation(a),
    operatorShortName: textOf(a["Betreiber"]),
    addressAddition: textOf(a["address_addition"]),
    locationDescription: textOf(a["location_description"]),
    accessRestriction: textOf(a["access_restriction"]),
    openingHours: Object.keys(hours).length === 0 ? null : hours,
  };
}

/** The great-circle distance in km. */
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Every row matching `where` (and `near`), read 2,000 per request in `OBJECTID` order, after a
 * count: more than `maxRows` is refused with what to narrow, before any row is read. A page that
 * comes back empty before the count is reached (the register changed between the requests, or
 * lost a page) is an error: the rows read would be a part given as the whole.
 */
async function readAll(client: LadesaeulenClient, where: string, near: NearPoint | undefined, fields: readonly string[], maxRows: number, narrow: string): Promise<Record<string, unknown>[]> {
  const q: StationQuery = { where, ...(near === undefined ? {} : { near }) };
  const candidates = await client.count(q);
  if (candidates > maxRows) {
    throw new LadesaeulenValidationError(`Invalid query: ${candidates} stations to read, more than one call reads (${maxRows}); ${narrow}`);
  }
  const rows: Record<string, unknown>[] = [];
  while (rows.length < candidates) {
    const page = await client.stations({ ...q, outFields: fields.join(","), limit: PAGE, offset: rows.length, orderBy: "OBJECTID" });
    if (page.features.length === 0) {
      throw new LadesaeulenParseError(`The register answered ${rows.length} of the ${candidates} stations it counted: it changed while this call read it, or lost a page. Nothing is answered from a part; ask again.`);
    }
    for (const f of page.features) rows.push(f.attributes as Record<string, unknown>);
  }
  return rows;
}

/** The rows whose fastest charge point reaches `minKw` (all rows without one). */
function atLeast(rows: Record<string, unknown>[], minKw: number | undefined): Record<string, unknown>[] {
  if (minKw === undefined) return rows;
  return rows.filter((a) => {
    const kw = maxChargePointKw(a);
    return kw !== null && kw >= minKw;
  });
}

/** What `searched` reports: the filters as sent, and the point. */
function searchedOf(f: StationFilter, near?: NearPoint): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) if (f[key] !== undefined) out[key] = f[key];
  if (near !== undefined) Object.assign(out, near);
  return out;
}

// ---- searchStations -------------------------------------------------------------------------

/** The input of {@link searchStations}. */
export interface SearchStationsInput extends StationFilter {
  /** Only the stations within a radius of a point (not ranked; {@link findStationsNear} ranks). */
  near?: NearPoint | undefined;
  /** How many stations to list (0–100, default 20); 0 counts only. */
  limit?: number | undefined;
  /** Where the page starts (default 0). */
  offset?: number | undefined;
}

/** The answer of {@link searchStations}. */
export interface StationSearch {
  status: "ok" | "empty";
  searched: Record<string, unknown>;
  /** All stations that match (not only the page). */
  total: number;
  stations: Station[];
  /** Where the next page starts, when there is one. */
  nextOffset?: number;
  /** Why it is empty, and what to change. */
  reason?: string;
  /** For an empty place: the places whose name contains it, with their station counts. */
  suggestions?: { place: string; stations: number }[];
  attribution: Attribution;
  notes: string[];
}

/** Default for {@link SearchStationsInput.limit}. */
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Find and count stations. `total` counts every match; `stations` is one page of them (`limit`,
 * `offset`), in the register's order, or with `minPointKw` fastest first. With `minPointKw` the
 * server narrows by the station figure and the connector ratings are read here, so every
 * candidate is read (up to `maxRows`). Empty says what was searched; for a place, the places
 * whose name contains it (`Frankfurt` → `Frankfurt am Main`).
 */
export async function searchStations(client: LadesaeulenClient, input: SearchStationsInput = {}, options: OperationOptions = {}): Promise<StationSearch> {
  return explainingWhere(input?.where, () => searchStationsOf(client, input, options));
}

async function searchStationsOf(client: LadesaeulenClient, input: SearchStationsInput, options: OperationOptions): Promise<StationSearch> {
  const f = checkFilter(input);
  const near = input.near === undefined ? undefined : checkNear(input.near);
  const limit = assertValid("limit", input.limit ?? DEFAULT_SEARCH_LIMIT, integerIn(0, 100));
  const offset = assertValid("offset", input.offset ?? 0, integerIn(0, 1_000_000));
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const where = whereOf(f);
  const searched = searchedOf(f, near);
  const notes = [...filterNotes(f), ...(near === undefined ? [] : swapNote(near)), UNDERCOUNT];
  const attribution = attributionOf(client, options);
  const places = otherPlaces(client, f.place);
  let total: number;
  let stations: Station[];
  if (f.minPointKw !== undefined) {
    const rows = atLeast(await readAll(client, where, near, STATION_FIELDS, maxRows, "narrow it with state, place, operator or a radius."), f.minPointKw);
    const all = rows.map(toStation).sort((a, b) => (b.maxChargePointKw ?? 0) - (a.maxChargePointKw ?? 0));
    total = all.length;
    stations = all.slice(offset, offset + limit);
  } else {
    const q: StationQuery = { where, ...(near === undefined ? {} : { near }) };
    total = await client.count(q);
    stations =
      limit === 0 || offset >= total
        ? []
        : (await client.stations({ ...q, outFields: STATION_FIELDS.join(","), limit, offset, orderBy: "OBJECTID" })).features.map((x) => toStation(x.attributes as Record<string, unknown>));
  }
  const others = await places;
  notes.unshift(...placeNote(f.place, others));
  if (total === 0) {
    const suggestions = others;
    return {
      status: "empty",
      searched,
      total,
      stations: [],
      reason: emptyReason(f, near, suggestions.length > 0),
      ...(suggestions.length === 0 ? {} : { suggestions }),
      attribution: await attribution,
      notes,
    };
  }
  notes.unshift(...pastTheEnd(offset, limit, total));
  const next = offset + stations.length;
  return { status: "ok", searched, total, stations, ...(limit > 0 && next < total ? { nextOffset: next } : {}), attribution: await attribution, notes };
}

/**
 * The other places (Ort) whose name contains `place`, most stations first (at most 10; one
 * request, started alongside the search): the register writes the place as the operator gave it,
 * so Frankfurt am Main's stations are also under "Frankfurt" and "Frankfurt am Main-Niedereschbach".
 */
function otherPlaces(client: LadesaeulenClient, place: string | undefined): Promise<{ place: string; stations: number }[]> {
  if (place === undefined) return Promise.resolve([]);
  const pending = client
    .countByPage("Ort", `Ort LIKE ${containing(place)}`)
    .then(({ groups }) =>
      groups
        .filter((g): g is { value: string; count: number } => typeof g.value === "string" && g.value.trim().toLowerCase() !== place.toLowerCase())
        .slice(0, 10)
        .map((g) => ({ place: g.value.trim(), stations: g.count })),
    );
  pending.catch(() => {});
  return pending;
}

/** The note naming the other places that contain `place`, when there are any. */
function placeNote(place: string | undefined, others: { place: string; stations: number }[]): string[] {
  if (place === undefined || others.length === 0) return [];
  return [
    `place matches the whole name "${place}"; the register writes the place as the operator gave it, and other places contain it: ${others.slice(0, 5).map((o) => `${o.place} (${o.stations})`).join(", ")}. For a whole city, district ("Kreisfreie Stadt …") or postcode is surer.`,
  ];
}

/** The note for a page that starts past the last match: an empty list beside a total. */
function pastTheEnd(offset: number, limit: number, total: number): string[] {
  return limit > 0 && total > 0 && offset >= total ? [`offset ${offset} is past the last of the ${total} stations that match: the pages start at 0, the last at ${Math.floor((total - 1) / limit) * limit} (limit ${limit}).`] : [];
}

function emptyReason(f: StationFilter, near: NearPoint | undefined, suggested: boolean): string {
  const parts = ["No station in the register matches all of the filters given (see searched)."];
  if (f.place !== undefined) parts.push(suggested ? `place is the whole name of the place: the suggestions contain "${f.place}".` : `No place's name contains "${f.place}": check the spelling, or use postcode or district.`);
  if (near !== undefined) parts.push("Widen radiusKm, or check the point (latitude first).");
  if (f.minPointKw !== undefined) parts.push("Lower minPointKw: it is the power of one charge point.");
  if (f.goLiveYear !== undefined) parts.push("goLiveYear is the year the station went live.");
  parts.push("Leave out one filter at a time to see which one empties the answer.");
  return parts.join(" ");
}

// ---- findStationsNear -----------------------------------------------------------------------

/** The input of {@link findStationsNear}. */
export interface FindStationsNearInput extends StationFilter, NearPoint {
  /** How many of the nearest to list (1–50, default 10). */
  limit?: number | undefined;
  /** How many of the nearest to skip (default 0): the farther ones, from a nextOffset. */
  offset?: number | undefined;
}

/** The answer of {@link findStationsNear}. */
export interface StationsNear {
  status: "ok" | "empty";
  searched: Record<string, unknown>;
  /** All matching stations within the radius. */
  total: number;
  /** The nearest (from `offset` on), with `distanceKm`. */
  nearest: Station[];
  /** Where the next page of farther stations starts, when there is one. */
  nextOffset?: number;
  reason?: string;
  attribution: Attribution;
  notes: string[];
}

/** Default for {@link FindStationsNearInput.limit}. */
export const DEFAULT_NEAR_LIMIT = 10;

/**
 * The stations within `radiusKm` of a point, nearest first, with the straight-line distance:
 * every station in the radius is read (up to `maxRows`) and ranked here, as the register sorts
 * by no distance. The point is latitude, longitude (WGS84); one that only lies in Germany when
 * swapped gets a note. Empty says what to widen; with `minPointKw`, the fastest charge point
 * found in the radius. Paged: `offset` skips the nearest, `nextOffset` says where the farther go on.
 */
export async function findStationsNear(client: LadesaeulenClient, input: FindStationsNearInput, options: OperationOptions = {}): Promise<StationsNear> {
  return explainingWhere(input?.where, () => findStationsNearOf(client, input, options));
}

async function findStationsNearOf(client: LadesaeulenClient, input: FindStationsNearInput, options: OperationOptions): Promise<StationsNear> {
  const f = checkFilter(input);
  const near = checkNear({ lat: input.lat, lon: input.lon, radiusKm: input.radiusKm });
  const limit = assertValid("limit", input.limit ?? DEFAULT_NEAR_LIMIT, integerIn(1, 50));
  const offset = assertValid("offset", input.offset ?? 0, integerIn(0, 1_000_000));
  const searched = searchedOf(f, near);
  const notes = [...swapNote(near), ...filterNotes(f), "distanceKm is the straight line from the point, not the way by road."];
  const attribution = attributionOf(client, options);
  const rows = await readAll(client, whereOf(f), near, STATION_FIELDS, options.maxRows ?? DEFAULT_MAX_ROWS, "use a smaller radiusKm or more filters.");
  const kept = atLeast(rows, f.minPointKw).map((a) => toStation(a));
  for (const s of kept) if (s.lat !== null && s.lon !== null) s.distanceKm = Math.round(distanceKm(near.lat, near.lon, s.lat, s.lon) * 100) / 100;
  kept.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  notes.push(...checkLocations(kept));
  if (kept.length === 0) {
    let reason = `No station in the register within ${near.radiusKm} km of (${near.lat}, ${near.lon}) matches the filters (see searched). Widen radiusKm or drop a filter.`;
    if (f.minPointKw !== undefined && rows.length > 0) {
      // The server narrowed by the station figure; the charge points themselves fall short.
      const fastest = Math.max(...rows.map((a) => maxChargePointKw(a) ?? 0));
      reason = `${rows.length === 1 ? "1 station" : `${rows.length} stations`} within ${near.radiusKm} km ${rows.length === 1 ? "reaches" : "reach"} ${f.minPointKw} kW only as the station's total; no single charge point does (the fastest delivers ${fastest} kW). Lower minPointKw or widen radiusKm.`;
    }
    return { status: "empty", searched, total: 0, nearest: [], reason, attribution: await attribution, notes };
  }
  notes.unshift(...pastTheEnd(offset, limit, kept.length));
  const next = offset + limit;
  return { status: "ok", searched, total: kept.length, nearest: kept.slice(offset, next), ...(next < kept.length ? { nextOffset: next } : {}), attribution: await attribution, notes };
}

/** Fewest stations in a radius for {@link checkLocations} to judge, and the share below which a state stands out. */
const LOCATION_SAMPLE = 20;
const LOCATION_SHARE = 0.05;

/**
 * Mark the stations whose address is in a state that holds under 5 % of the (at least 20)
 * stations around: their coordinates likely belong to another address. The register has
 * stations of Düren (NRW) and Dahme/Mark (Brandenburg) at the Brandenburger Tor's coordinates
 * (2026-11-19). A border area keeps both states well above 5 %.
 */
function checkLocations(stations: Station[]): string[] {
  if (stations.length < LOCATION_SAMPLE) return [];
  const byState = new Map<string | null, number>();
  for (const s of stations) byState.set(s.state, (byState.get(s.state) ?? 0) + 1);
  const odd = stations.filter((s) => s.state !== null && (byState.get(s.state) ?? 0) / stations.length < LOCATION_SHARE);
  for (const s of odd) s.checkLocation = true;
  if (odd.length === 0) return [];
  return [
    `${odd.length} of ${stations.length} stations here give an address in another state than nearly all the others (checkLocation: ${odd.slice(0, 5).map((s) => `${s.id}, ${s.place ?? "?"}`).join("; ")}): their coordinates may belong to another address. Check before sending a driver there.`,
  ];
}

// ---- countStationsBy ------------------------------------------------------------------------

/** What {@link countStationsBy} groups by, and the column it is. */
export const GROUP_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  state: "state",
  place: "Ort",
  district: "district_independent_city",
  operator: "operator_companyName",
  type: "Typ",
  status: "Status",
  postcode: "Postleitzahl",
  chargePoints: "Anzahl_Ladepunkte",
});

/** A group key of {@link countStationsBy}. */
export type GroupBy = "state" | "place" | "district" | "operator" | "type" | "status" | "postcode" | "chargePoints";

/** The input of {@link countStationsBy}. */
export interface CountStationsByInput extends StationFilter {
  groupBy: GroupBy;
  /** Only the stations within a radius of a point. */
  near?: NearPoint | undefined;
  /** How many groups to list, largest first (1–100, default 20). */
  top?: number | undefined;
}

/** The answer of {@link countStationsBy}. */
export interface StationCounts {
  status: "ok" | "empty";
  searched: Record<string, unknown>;
  groupBy: GroupBy;
  /** The register's column. */
  column: string;
  /** The largest groups, most stations first. */
  groups: { value: string | number | null; stations: number }[];
  /** How many groups there are (at least, when `complete` is false). */
  groupCount: number;
  /** False when the server cut the groups at 2,000 (the largest are all there). */
  complete: boolean;
  /** The stations counted, in all groups. */
  totalStations: number;
  reason?: string;
  attribution: Attribution;
  notes: string[];
}

/**
 * Station counts per group (state, place, operator, type …), largest first. The server counts
 * every match, so the counts are exact; it cuts a list at 2,000 groups (the largest still all
 * there: `complete` false). With `minPointKw` or `near` every candidate is read (up to `maxRows`)
 * and grouped here. The operator groups are legal entities (`operator_companyName`, trimmed), not
 * brands; `Betreiber`, null on more than half of the rows, is never used.
 */
export async function countStationsBy(client: LadesaeulenClient, input: CountStationsByInput, options: OperationOptions = {}): Promise<StationCounts> {
  return explainingWhere(input?.where, () => countStationsByOf(client, input, options));
}

async function countStationsByOf(client: LadesaeulenClient, input: CountStationsByInput, options: OperationOptions): Promise<StationCounts> {
  const groupBy = input.groupBy;
  const column = typeof groupBy === "string" && Object.prototype.hasOwnProperty.call(GROUP_COLUMNS, groupBy) ? (GROUP_COLUMNS[groupBy] as string) : undefined;
  if (column === undefined) throw new LadesaeulenValidationError(`Invalid groupBy: expected one of ${Object.keys(GROUP_COLUMNS).join(", ")}, got ${JSON.stringify(groupBy)}.`);
  const f = checkFilter(input);
  const near = input.near === undefined ? undefined : checkNear(input.near);
  const top = assertValid("top", input.top ?? 20, integerIn(1, 100));
  const where = whereOf(f);
  const searched = searchedOf(f, near);
  const notes = [...filterNotes(f), ...(near === undefined ? [] : swapNote(near)), UNDERCOUNT];
  if (groupBy === "operator") notes.push("Operators are legal entities: one brand can appear under several (EnBW mobility+ AG und Co.KG, EnBW Ostwürttemberg DonauRies AG).");
  const attribution = attributionOf(client, options);
  const places = otherPlaces(client, f.place);
  let groups: { value: string | number | null; stations: number }[];
  let complete = true;
  let totalStations: number;
  if (f.minPointKw !== undefined || near !== undefined) {
    const rows = atLeast(await readAll(client, where, near, ["OBJECTID", column, "max_electric_power_station", ...CONNECTOR_FIELDS], options.maxRows ?? DEFAULT_MAX_ROWS, "narrow it with state, place or a smaller radius."), f.minPointKw);
    const counts = new Map<string | null, number>();
    for (const a of rows) {
      const value = textOf(a[column]);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    groups = [...counts].map(([value, stations]) => ({ value, stations })).sort((a, b) => b.stations - a.stations || String(a.value).localeCompare(String(b.value)));
    totalStations = rows.length;
  } else {
    const page = await client.countByPage(column, where);
    // The operator names carry trailing spaces at times: the same name, one group.
    const merged = new Map<string | number | null, number>();
    for (const g of page.groups) {
      const value = typeof g.value === "string" ? (textOf(g.value) ?? null) : g.value;
      merged.set(value, (merged.get(value) ?? 0) + g.count);
    }
    groups = [...merged].map(([value, stations]) => ({ value, stations })).sort((a, b) => b.stations - a.stations);
    complete = !page.exceededTransferLimit;
    totalStations = complete ? groups.reduce((sum, g) => sum + g.stations, 0) : await client.count({ where });
  }
  notes.unshift(...placeNote(f.place, await places));
  if (!complete) notes.push("More than 2,000 groups: the list was cut; the largest groups are all there, but groupCount is not the number of groups. Narrow with a filter for every group.");
  const base = { searched, groupBy, column, groupCount: groups.length, complete, totalStations, attribution: await attribution, notes };
  if (totalStations === 0) {
    return { status: "empty", ...base, groups: [], reason: "No station in the register matches the filters (see searched); leave out one filter at a time to see which one empties the answer." };
  }
  return { status: "ok", ...base, groups: groups.slice(0, top) };
}

// ---- getStation and getRegisterInfo ---------------------------------------------------------

/** The answer of {@link getStation}. */
export interface StationLookup {
  status: "ok" | "empty";
  searched: { id: string };
  station?: StationDetail;
  reason?: string;
  attribution: Attribution;
}

const idProblem: Problem<string> = (value) => {
  const problem = tokenProblem(value);
  if (problem !== undefined) return problem;
  return /^[A-Za-z0-9_.-]{1,40}$/.test(value.trim()) ? undefined : `expected a station id from the register ("1055348"), got ${JSON.stringify(value)}.`;
};

/** One station by its register id (`ID`), with its connectors, opening hours and access notes. */
export async function getStation(client: LadesaeulenClient, input: { id: string }, options: OperationOptions = {}): Promise<StationLookup> {
  const id = assertValid("id", input.id, idProblem).trim();
  const attribution = attributionOf(client, options);
  const page = await client.stations({ where: `ID = ${literal(id)}`, outFields: DETAIL_FIELDS.join(","), limit: 2, orderBy: "OBJECTID" });
  const first = page.features[0];
  if (first === undefined) {
    return { status: "empty", searched: { id }, reason: `No station with the id ${id} in the register: ids come from searchStations or findStationsNear; the register drops stations that close.`, attribution: await attribution };
  }
  return { status: "ok", searched: { id }, station: toDetail(first.attributes as Record<string, unknown>), attribution: await attribution };
}

/** The answer of {@link getRegisterInfo}. */
export interface RegisterInfo {
  status: "ok";
  name: string | null;
  /** When the data was last edited, ISO 8601: the "as of" date of every answer. */
  dataLastEditDate: string | null;
  totalStations: number;
  /** The columns a `where` can use, with their type and the traps. */
  columns: { name: string; type: string | null; note?: string }[];
  /** Columns listed by the server but empty on every row: a condition on one matches nothing. */
  emptyColumns: string[];
  attribution: Attribution;
}

/** Notes on the columns whose type or content misleads. */
const COLUMN_NOTES: Readonly<Record<string, string>> = Object.freeze({
  max_electric_power_station: "text: compare with CAST(max_electric_power_station AS FLOAT) >= 150; the whole station's figure, often the sum of its points",
  Anzahl_Ladepunkte: "text: CAST(Anzahl_Ladepunkte AS INTEGER) > 2",
  go_live_date: "dd.mm.yyyy text: filter a year with LIKE '%.2026', never sort by it",
  Betreiber: "null on more than half of the rows: use operator_companyName",
  operator_companyName: "the legal entity, sometimes with a trailing space: match with LIKE '%…%'",
  Typ: "Schnellladeeinrichtung (above 22 kW, not the same as DC) or Normalladeeinrichtung",
  state: "the Bundesland's German name: 'Bayern'",
  Ort: "the place: text comparisons ignore case",
});

/** Columns that are filled but say nothing about a station (pipeline leftovers). */
const NOISE = new Set(["F_response_body", "F_count", "F_overlaps", "fme_rejection_code", "json_index"]);

/** How current the register is, its size, and the columns a `where` can use (three requests: the layer twice, a count). */
export async function getRegisterInfo(client: LadesaeulenClient, options: OperationOptions = {}): Promise<RegisterInfo> {
  const [info, fields, totalStations] = await Promise.all([client.layerInfo(), client.fields(), client.count()]);
  const columns = fields
    .filter((field) => !EMPTY_FIELDS.includes(field.name) && !NOISE.has(field.name))
    .map((field) => ({ name: field.name, type: typeof field.type === "string" ? field.type.replace(/^esriFieldType/, "") : null, ...(COLUMN_NOTES[field.name] === undefined ? {} : { note: COLUMN_NOTES[field.name] as string }) }));
  return { status: "ok", name: info.name, dataLastEditDate: info.dataLastEditDate, totalStations, columns, emptyColumns: [...EMPTY_FIELDS], attribution: attributionFrom(info.dataLastEditDate, options) };
}

// ---- GeoJSON --------------------------------------------------------------------------------

/** A GeoJSON Feature of a station: a Point ([longitude, latitude]) and the station's fields. */
export interface StationFeature {
  type: "Feature";
  id: string | null;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Omit<Station, "lat" | "lon" | "points">;
}

/** Stations as GeoJSON Features; the ones without coordinates are named in `leftOff`. */
export function stationsToGeoJson(stations: readonly Station[]): { features: StationFeature[]; leftOff: { id: string | null; place: string | null }[] } {
  const features: StationFeature[] = [];
  const leftOff: { id: string | null; place: string | null }[] = [];
  for (const s of stations) {
    if (s.lat === null || s.lon === null) {
      leftOff.push({ id: s.id, place: s.place });
      continue;
    }
    const { lat, lon, points: _points, ...properties } = s;
    features.push({ type: "Feature", id: s.id, geometry: { type: "Point", coordinates: [lon, lat] }, properties });
  }
  return { features, leftOff };
}
