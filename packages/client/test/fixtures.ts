// Canned Ladesäulenregister ArcGIS responses for the unit suite, shaped like the
// live FeatureServer.

import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";
import type { HttpRequest } from "../src/http.js";

export const stations = {
  objectIdFieldName: "OBJECTID",
  geometryType: "esriGeometryPoint",
  exceededTransferLimit: false,
  features: [
    {
      attributes: {
        ID: "1000000",
        Betreiber: "SWD AG",
        operator_companyName: "Stadtwerke Düsseldorf AG",
        "Straße": "Forststraße",
        Hausnummer: "29",
        Postleitzahl: "40597",
        Ort: "Düsseldorf",
        state: "Nordrhein-Westfalen",
        Typ: "Normalladeeinrichtung",
        Status: "In Betrieb",
        max_electric_power_station: "22",
        Anzahl_Ladepunkte: "2",
        coordinates_latitude: 51.169901,
        coordinates_longitude: 6.876787,
        OBJECTID: 1,
      },
    },
    {
      attributes: {
        ID: "1000001",
        Betreiber: "EnBW",
        Ort: "Berlin",
        state: "Berlin",
        Typ: "Schnellladeeinrichtung",
        Status: "In Betrieb",
        OBJECTID: 2,
      },
    },
  ],
};

/** A `returnCountOnly` response. */
export const countOnly = { count: 660 };

/** An ArcGIS logical error (HTTP 200 + `error`). */
export const arcgisError = {
  error: { code: 400, message: "Unable to complete operation.", details: ["Invalid field: BOGUS"] },
};

/** An `outStatistics` group-by response (used by countBy). */
export const countByState = {
  features: [
    { attributes: { state: "Bayern", count: 21969 } },
    { attributes: { state: "Nordrhein-Westfalen", count: 21697 } },
    { attributes: { state: "Baden-Württemberg", count: 18259 } },
  ],
};

/** The layer field metadata (used by `fields`). */
export const fields = {
  fields: [
    { name: "Betreiber", type: "esriFieldTypeString", alias: "Betreiber" },
    { name: "Ort", type: "esriFieldTypeString", alias: "Ort" },
    { name: "state", type: "esriFieldTypeString", alias: "state" },
  ],
};

/** A GeoJSON FeatureCollection (f=geojson). */
export const geojson = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { Betreiber: "SWD AG", Ort: "Düsseldorf" }, geometry: { type: "Point", coordinates: [6.876787, 51.169901] } },
  ],
};

// ---- a mock of the register's FeatureServer -------------------------------------------------
// Rows shaped like the live layer (2026-11-19: the columns, the text figures, the connector
// lines, a trailing space in a company name, Betreiber null), and a transport that answers the
// layer document and /0/query as the server does: a `where` in the subset of its SQL the use
// cases send (AND, OR, NOT, parentheses, =, >=, LIKE, NOT LIKE, IS [NOT] NULL, CAST … AS FLOAT;
// text compared ignoring case, NULL as unknown), a point and a radius, counts, groups (cut at
// 2,000 like the server), pages in OBJECTID order with exceededTransferLimit, outFields; SQL it
// can't read is the server's error envelope with HTTP 200.


export type Row = Record<string, unknown>;

const CCS = (kw: number): string => `DC Fahrzeugkupplung Typ Combo 2 (CCS) (${kw} kw)`;
const TYPE2 = (kw: number): string => `AC Typ 2 Steckdose (${kw} kw)`;

/** One station row: the live columns, with `overrides`. */
export function stationRow(objectId: number, id: string, overrides: Row = {}): Row {
  return {
    OBJECTID: objectId,
    ID: id,
    Betreiber: null,
    operator_companyName: "Stadtwerke Musterstadt GmbH",
    "Straße": "Hauptstraße",
    Hausnummer: "1",
    Postleitzahl: "10115",
    Ort: "Berlin",
    district_independent_city: "Kreisfreie Stadt Berlin",
    state: "Berlin",
    Typ: "Normalladeeinrichtung",
    Status: "In Betrieb",
    max_electric_power_station: "22",
    Anzahl_Ladepunkte: "1",
    coordinates_latitude: 52.52,
    coordinates_longitude: 13.405,
    go_live_date: "01.06.2020",
    Bezahlsystem: "",
    address_addition: null,
    location_description: null,
    access_restriction: null,
    Steckersystem_Ladepunkt1: TYPE2(22),
    Steckersystem_Ladepunkt2: null,
    Steckersystem_Ladepunkt3: null,
    Steckersystem_Ladepunkt4: null,
    Steckersystem_Ladepunkt5: null,
    Steckersystem_Ladepunkt6: null,
    Offnungszeiten_Weekday_0: null,
    Offnungszeiten_Weekday_1: null,
    Offnungszeiten_Weekday_2: null,
    Offnungszeiten_Weekday_3: null,
    Offnungszeiten_Weekday_4: null,
    Offnungszeiten_Weekday_5: null,
    Offnungszeiten_Weekday_6: null,
    F_response_body: "{\"raw\":true}",
    ...overrides,
  };
}

/** Thirteen stations as the register writes them (live shapes, 2026-11-19). */
export function registerRows(): Row[] {
  return [
    stationRow(1, "1000000", { Betreiber: "SWD AG", operator_companyName: "Stadtwerke Düsseldorf AG", "Straße": "Forststraße", Hausnummer: "29", Postleitzahl: "40597", Ort: "Düsseldorf", district_independent_city: "Kreisfreie Stadt Düsseldorf", state: "Nordrhein-Westfalen", max_electric_power_station: "44", Anzahl_Ladepunkte: "2", coordinates_latitude: 51.169901, coordinates_longitude: 6.876787, go_live_date: "01.06.2017", Steckersystem_Ladepunkt1: `${TYPE2(22)}\nAC Schuko (22 kw)`, Steckersystem_Ladepunkt2: `${TYPE2(22)}\nAC Schuko (22 kw)` }),
    stationRow(38199, "1055348", { Betreiber: "Aral Pulse", operator_companyName: "BP Europa SE", "Straße": "Riehler Straße", Hausnummer: "12-14", Postleitzahl: "50668", Ort: "Köln", district_independent_city: "Kreisfreie Stadt Köln", state: "Nordrhein-Westfalen", Typ: "Schnellladeeinrichtung", max_electric_power_station: "150", Anzahl_Ladepunkte: "2", coordinates_latitude: 50.952291, coordinates_longitude: 6.961666, go_live_date: "13.12.2023", Bezahlsystem: "Onlinezahlungsverfahren, RFID-Karte", Steckersystem_Ladepunkt1: CCS(150), Steckersystem_Ladepunkt2: CCS(150) }),
    stationRow(40001, "1059502", { operator_companyName: "TankE GmbH", "Straße": "Am Malzbüchel", Hausnummer: "1", Postleitzahl: "50667", Ort: "Köln", district_independent_city: "Kreisfreie Stadt Köln", state: "Nordrhein-Westfalen", Typ: "Schnellladeeinrichtung", max_electric_power_station: "72", Anzahl_Ladepunkte: "2", coordinates_latitude: 50.9365, coordinates_longitude: 6.958, go_live_date: "05.03.2021", Steckersystem_Ladepunkt1: CCS(50), Steckersystem_Ladepunkt2: TYPE2(22) }),
    stationRow(40002, "1062404", { operator_companyName: "carré domstraße gmbh & co.kg", "Straße": "Domstr.", Hausnummer: "55-73", Postleitzahl: "50668", Ort: "Köln", district_independent_city: "Kreisfreie Stadt Köln", state: "Nordrhein-Westfalen", Typ: "Schnellladeeinrichtung", max_electric_power_station: "50", coordinates_latitude: 50.945, coordinates_longitude: 6.956, go_live_date: "20.10.2022", Steckersystem_Ladepunkt1: `${CCS(50)}\nDC CHAdeMO (50 kw)`, Offnungszeiten_Weekday_1: "07:00-22:00" }),
    stationRow(40003, "1070001", { Betreiber: "RheinEnergie", operator_companyName: "RheinEnergie AG", Postleitzahl: "50667", Ort: "Köln", district_independent_city: "Kreisfreie Stadt Köln", state: "Nordrhein-Westfalen", max_electric_power_station: "11", coordinates_latitude: 50.942, coordinates_longitude: 6.96, go_live_date: "31.08.2026", Steckersystem_Ladepunkt1: TYPE2(11) }),
    stationRow(50001, "1100001", { operator_companyName: "SWM Versorgungs GmbH", "Straße": "Lerchenauer Str.", Hausnummer: "65", Postleitzahl: "80809", Ort: "München", district_independent_city: "Kreisfreie Stadt München", state: "Bayern", Typ: "Schnellladeeinrichtung", max_electric_power_station: "800", Anzahl_Ladepunkte: "2", coordinates_latitude: 48.18, coordinates_longitude: 11.55, go_live_date: "15.08.2026", Steckersystem_Ladepunkt1: CCS(400), Steckersystem_Ladepunkt2: CCS(400) }),
    stationRow(50002, "1100002", { operator_companyName: "Jolt Energy GmbH", "Straße": "Chiemgaustr.", Hausnummer: "185", Postleitzahl: "81549", Ort: "München", district_independent_city: "Kreisfreie Stadt München", state: "Bayern", Typ: "Schnellladeeinrichtung", max_electric_power_station: "320", Anzahl_Ladepunkte: "2", coordinates_latitude: 48.11, coordinates_longitude: 11.61, go_live_date: "02.02.2025", Steckersystem_Ladepunkt1: CCS(160), Steckersystem_Ladepunkt2: CCS(160) }),
    stationRow(50003, "1100003", { Betreiber: "EnBW", operator_companyName: "EnBW mobility+ AG und Co.KG ", "Straße": "Ludwig-Koch-Straße", Hausnummer: "3", Postleitzahl: "81249", Ort: "München", district_independent_city: "Kreisfreie Stadt München", state: "Bayern", Typ: "Schnellladeeinrichtung", max_electric_power_station: "300", Anzahl_Ladepunkte: "2", coordinates_latitude: 48.15, coordinates_longitude: 11.42, go_live_date: "10.01.2026", Steckersystem_Ladepunkt1: CCS(300), Steckersystem_Ladepunkt2: CCS(300) }),
    stationRow(50004, "1100004", { operator_companyName: "EnBW Ostwürttemberg DonauRies AG", Postleitzahl: "86150", Ort: "Augsburg", district_independent_city: "Kreisfreie Stadt Augsburg", state: "Bayern", coordinates_latitude: 48.37, coordinates_longitude: 10.9, go_live_date: "03.03.2026" }),
    stationRow(60001, "1200001", { operator_companyName: "Tesla Germany GmbH", Ort: "Berlin", Typ: "Schnellladeeinrichtung", max_electric_power_station: "250", Anzahl_Ladepunkte: "2", coordinates_latitude: 52.51, coordinates_longitude: 13.38, go_live_date: "12.12.2024", Steckersystem_Ladepunkt1: TYPE2(22), Steckersystem_Ladepunkt2: CCS(250) }),
    stationRow(60002, "1200002", { operator_companyName: "Stromnetz Berlin GmbH", coordinates_latitude: 52.53, coordinates_longitude: 13.41 }),
    stationRow(70001, "1300001", { operator_companyName: "Stromnetz Hamburg GmbH", Postleitzahl: "20095", Ort: "Hamburg", district_independent_city: "Kreisfreie Stadt Hamburg", state: "Hamburg", Typ: "Schnellladeeinrichtung", max_electric_power_station: "25", coordinates_latitude: 53.55, coordinates_longitude: 10.0, Steckersystem_Ladepunkt1: "AC Typ 2 Fahrzeugkupplung (25 kw)" }),
    stationRow(80001, "1400001", { operator_companyName: "Mainova AG", Postleitzahl: "60311", Ort: "Frankfurt am Main", district_independent_city: "Kreisfreie Stadt Frankfurt am Main", state: "Hessen", coordinates_latitude: 50.11, coordinates_longitude: 8.68 }),
  ];
}

/** The layer document's edit dates (live: 2026-11-12T07:17:19.492Z). */
export const DATA_LAST_EDIT = Date.parse("2026-11-12T07:17:19.492Z");

const LAYER_FIELDS = [
  ...Object.keys(stationRow(0, "0")).map((name) => ({ name, type: name === "OBJECTID" ? "esriFieldTypeOID" : name.startsWith("coordinates_") ? "esriFieldTypeDouble" : "esriFieldTypeString", alias: name })),
  { name: "json_type", type: "esriFieldTypeString", alias: "json_type" },
  { name: "Steckersystem_Ladepunkt7", type: "esriFieldTypeString", alias: "Steckersystem_Ladepunkt7" },
  { name: "F_count", type: "esriFieldTypeString", alias: "F_count" },
];

/** The layer document (`/0?f=json`). */
export function layerDoc(): Row {
  return { name: "Ladesaeulen_einfach", maxRecordCount: 2000, editingInfo: { lastEditDate: DATA_LAST_EDIT, dataLastEditDate: DATA_LAST_EDIT }, fields: LAYER_FIELDS };
}

/** The server's answer to SQL it can't read (HTTP 200). */
export const UNABLE = { error: { code: 400, message: "Unable to perform query. Please check your parameters.", details: [] } };

// -- the SQL subset ---------------------------------------------------------------------------

type Tri = boolean | null;
type Token = { kind: "str" | "num" | "id" | "op" | "kw"; text: string };

const KEYWORDS = new Set(["AND", "OR", "NOT", "LIKE", "ESCAPE", "IS", "NULL", "CAST", "AS", "FLOAT", "INTEGER"]);

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'") {
      let text = "";
      i++;
      for (;;) {
        if (i >= sql.length) throw new Error("unterminated string");
        if (sql[i] === "'" && sql[i + 1] === "'") {
          text += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else text += sql[i++];
      }
      tokens.push({ kind: "str", text });
    } else if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(sql.slice(i)) as RegExpExecArray;
      tokens.push({ kind: "num", text: m[0] });
      i += m[0].length;
    } else if (/[\p{L}_]/u.test(c)) {
      const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(sql.slice(i)) as RegExpExecArray;
      const word = m[0];
      tokens.push(KEYWORDS.has(word.toUpperCase()) ? { kind: "kw", text: word.toUpperCase() } : { kind: "id", text: word });
      i += word.length;
    } else {
      const op = [">=", "<=", "<>", "=", ">", "<", "(", ")"].find((o) => sql.startsWith(o, i));
      if (op === undefined) throw new Error(`unexpected ${c}`);
      tokens.push({ kind: "op", text: op });
      i += op.length;
    }
  }
  return tokens;
}

/** A predicate for `where`, or an Error for SQL outside the subset. */
export function compileWhere(where: string): (row: Row) => Tri {
  const tokens = tokenize(where);
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const take = (text?: string): Token => {
    const t = tokens[at];
    if (t === undefined || (text !== undefined && t.text !== text)) throw new Error(`expected ${text ?? "a token"} at ${at}`);
    at++;
    return t;
  };
  const columnOf = (row: Row, name: string): unknown => {
    const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key === undefined && !LAYER_FIELDS.some((f) => f.name.toLowerCase() === name.toLowerCase())) throw new Error(`unknown column ${name}`);
    return key === undefined ? null : row[key];
  };
  type Operand = (row: Row) => unknown;
  const operand = (): Operand => {
    const t = take();
    if (t.kind === "str") return () => t.text;
    if (t.kind === "num") return () => Number(t.text);
    if (t.kind === "kw" && t.text === "CAST") {
      take("(");
      const column = take();
      take("AS");
      const type = take();
      take(")");
      return (row) => {
        const v = columnOf(row, column.text);
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
        return Number.isFinite(n) ? (type.text === "INTEGER" ? Math.trunc(n) : n) : null;
      };
    }
    if (t.kind === "id") {
      // Validate the column at compile time.
      columnOf({}, t.text);
      return (row) => columnOf(row, t.text);
    }
    throw new Error(`unexpected ${t.text}`);
  };
  const compare = (a: unknown, b: unknown, op: string): Tri => {
    if (a === null || a === undefined || b === null || b === undefined) return null;
    const x = typeof a === "string" ? a.toLowerCase() : a;
    const y = typeof b === "string" ? b.toLowerCase() : b;
    if (typeof x !== typeof y) return null;
    switch (op) {
      case "=": return x === y;
      case "<>": return x !== y;
      case ">=": return (x as number) >= (y as number);
      case "<=": return (x as number) <= (y as number);
      case ">": return (x as number) > (y as number);
      default: return (x as number) < (y as number);
    }
  };
  // `ESCAPE 'c'`: c before a character makes it match itself (`%`, `_`, c), as on the server.
  const like = (value: unknown, pattern: unknown, escape?: string): Tri => {
    if (typeof value !== "string" || typeof pattern !== "string") return value === null || value === undefined ? null : false;
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i] as string;
      if (c === escape && i + 1 < pattern.length) source += (pattern[++i] as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      else if (c === "%") source += ".*";
      else if (c === "_") source += ".";
      else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${source}$`, "is").test(value);
  };
  const escapeOf = (): string | undefined => {
    if (peek()?.text !== "ESCAPE") return undefined;
    take("ESCAPE");
    const t = take();
    if (t.kind !== "str" || t.text.length !== 1) throw new Error("ESCAPE takes one character");
    return t.text;
  };
  const not = (v: Tri): Tri => (v === null ? null : !v);
  const primary = (): ((row: Row) => Tri) => {
    if (peek()?.text === "(") {
      take("(");
      const inner = orExpr();
      take(")");
      return inner;
    }
    const left = operand();
    const t = take();
    if (t.kind === "op") {
      const right = operand();
      return (row) => compare(left(row), right(row), t.text);
    }
    if (t.text === "LIKE") {
      const right = operand();
      const escape = escapeOf();
      return (row) => like(left(row), right(row), escape);
    }
    if (t.text === "NOT") {
      take("LIKE");
      const right = operand();
      const escape = escapeOf();
      return (row) => not(like(left(row), right(row), escape));
    }
    if (t.text === "IS") {
      const negated = peek()?.text === "NOT";
      if (negated) take("NOT");
      take("NULL");
      return (row) => {
        const v = left(row);
        const isNull = v === null || v === undefined;
        return negated ? !isNull : isNull;
      };
    }
    throw new Error(`unexpected ${t.text}`);
  };
  const notExpr = (): ((row: Row) => Tri) => {
    if (peek()?.text === "NOT") {
      take("NOT");
      const inner = notExpr();
      return (row) => not(inner(row));
    }
    return primary();
  };
  const andExpr = (): ((row: Row) => Tri) => {
    const parts = [notExpr()];
    while (peek()?.text === "AND") {
      take("AND");
      parts.push(notExpr());
    }
    return (row) => {
      const values = parts.map((p) => p(row));
      return values.includes(false) ? false : values.includes(null) ? null : true;
    };
  };
  function orExpr(): (row: Row) => Tri {
    const parts = [andExpr()];
    while (peek()?.text === "OR") {
      take("OR");
      parts.push(andExpr());
    }
    return (row) => {
      const values = parts.map((p) => p(row));
      return values.includes(true) ? true : values.includes(null) ? null : false;
    };
  }
  const predicate = orExpr();
  if (at !== tokens.length) throw new Error(`trailing ${tokens[at]?.text}`);
  return predicate;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The parameters of a request, from its URL or, for a long query, its form body. */
export function paramsOf(request: HttpRequest): URLSearchParams {
  if (request.method === "POST" && request.body !== undefined) return new URLSearchParams(request.body.toString());
  return new URL(request.url).searchParams;
}

/** What a mock of the register answers, and how it is built. */
export interface RegisterApiOptions {
  rows?: Row[];
  /** The most groups a group-by answers (the server: 2,000). */
  groupCap?: number;
  /** The most rows a page holds (the server: 2,000). */
  pageCap?: number;
}

/**
 * A transport over `rows`, answering like the register's FeatureServer (layer 0): the layer
 * document, counts, groups, pages. Records every request (`calls`, `last()`).
 */
export function registerApi(options: RegisterApiOptions = {}): MockTransport {
  const rows = options.rows ?? registerRows();
  const groupCap = options.groupCap ?? 2000;
  const pageCap = options.pageCap ?? 2000;
  return makeMockTransport((request) => {
    const path = new URL(request.url).pathname;
    if (/\/0\/?$/.test(path)) return jsonResponse(layerDoc());
    if (!/\/0\/query$/.test(path)) return jsonResponse({ error: { code: 400, message: "Invalid URL", details: [] } });
    const p = paramsOf(request);
    let matches: Row[];
    try {
      const predicate = compileWhere(p.get("where") ?? "1=1");
      matches = rows.filter((row) => predicate(row) === true);
    } catch {
      return jsonResponse(UNABLE);
    }
    const geometry = p.get("geometry");
    if (geometry !== null) {
      const [lon, lat] = geometry.split(",").map(Number) as [number, number];
      const km = Number(p.get("distance")) / 1000;
      matches = matches.filter((row) => haversineKm(lat, lon, row["coordinates_latitude"] as number, row["coordinates_longitude"] as number) <= km);
    }
    if (p.get("returnCountOnly") === "true") return jsonResponse({ count: matches.length });
    const group = p.get("groupByFieldsForStatistics");
    if (group !== null) {
      const counts = new Map<unknown, number>();
      for (const row of matches) counts.set(row[group] ?? null, (counts.get(row[group] ?? null) ?? 0) + 1);
      const all = [...counts].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ attributes: { [group]: value, count } }));
      return jsonResponse({ features: all.slice(0, groupCap), ...(all.length > groupCap ? { exceededTransferLimit: true } : {}) });
    }
    matches.sort((a, b) => (a["OBJECTID"] as number) - (b["OBJECTID"] as number));
    const offset = Number(p.get("resultOffset") ?? 0);
    const count = Math.min(Number(p.get("resultRecordCount") ?? pageCap), pageCap);
    const page = matches.slice(offset, offset + count);
    const fields = (p.get("outFields") ?? "*").split(",");
    const pick = (row: Row): Row => (fields.includes("*") ? row : Object.fromEntries(fields.map((f) => [f, row[f] ?? null])));
    return jsonResponse({ objectIdFieldName: "OBJECTID", features: page.map((row) => ({ attributes: pick(row) })), exceededTransferLimit: offset + page.length < matches.length });
  });
}
