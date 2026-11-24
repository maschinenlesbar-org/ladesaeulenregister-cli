// This server's tools against a mock of the register's FeatureServer (the client's live-shaped
// rows), with the skills' traps as cases: each tool answers through the protocol (its
// structuredContent checked by the SDK against its output schema), the power a car gets is one
// charge point's, fast is not DC, a place is a whole name (an unknown one answers with the places
// that contain it), a point is latitude first, a page says where the next one starts, and every
// result carries the source, the licence and the attribution with the register's data date.
// The rules every server follows are the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { TOOLS } from "../src/mcp/tools.js";
import { connect } from "./harness.js";
import { paramsOf, registerApi, stationRow } from "./helpers.js";

const KOELN_HBF = { lat: 50.943, lon: 6.9589 };

test("six tools: the three use cases first, then the map, one station and the register's date", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["findStationsNear", "searchStations", "countStationsBy", "getStationMap", "getStation", "getRegisterInfo"]);
});

test("findStationsNear: nearest first with the distance; the source names the query, the point and the radius; the attribution has the data date", async () => {
  const connection = await connect({ transport: registerApi() });
  const result = await connection.call("findStationsNear", { ...KOELN_HBF, radiusKm: 2, type: "fast", limit: 2 });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.deepEqual((content["nearest"] as { id: string; distanceKm: number }[]).map((s) => [s.id, s.distanceKm]), [["1062404", 0.3], ["1059502", 0.73]]);
  assert.equal(content["total"], 3);
  const source = new URL(String(content["source"]));
  assert.equal(source.searchParams.get("where"), "Typ = 'Schnellladeeinrichtung'");
  assert.deepEqual([source.searchParams.get("geometry"), source.searchParams.get("distance")], ["6.9589,50.943", "2000"]);
  assert.match(String((content["attribution"] as { text: string }).text), /^Datenquelle: Ladesäulenregister der Bundesnetzagentur \(bundesnetzagentur\.de\), lizenziert unter CC BY 4\.0 — Datenstand 12\.11\.2026, abgerufen am \d\d\.\d\d\.\d{4}$/);
  assert.match(String(content["licence"]), /CC BY 4\.0/);
  await connection.close();
});

test("findStationsNear with minPointKw: none at that power names the fastest charge point found, the station total doesn't count", async () => {
  const connection = await connect({ transport: registerApi() });
  const result = (await connection.call("findStationsNear", { ...KOELN_HBF, radiusKm: 1, minPointKw: 60 })).structuredContent ?? {};
  assert.equal(result["status"], "empty");
  assert.match(String(result["reason"]), /reaches 60 kW only as the station's total.*fastest delivers 50 kW/);
  await connection.close();
});

test("searchStations: by power per charge point, fastest first; Jolt's 2 x 160 kW (station 320) is not a 300 kW charger", async () => {
  const connection = await connect({ transport: registerApi() });
  const content = (await connection.call("searchStations", { place: "münchen", minPointKw: 300 })).structuredContent ?? {};
  assert.deepEqual((content["stations"] as { operator: string; maxChargePointKw: number }[]).map((s) => [s.operator, s.maxChargePointKw]), [["SWM Versorgungs GmbH", 400], ["EnBW mobility+ AG und Co.KG", 300]]);
  assert.equal(content["total"], 2);
  await connection.close();
});

test("searchStations pages with nextOffset; limit 0 counts only; an unknown place answers with the places that contain it", async () => {
  const api = registerApi();
  const connection = await connect({ transport: api });
  const first = (await connection.call("searchStations", { state: "NRW", limit: 2 })).structuredContent ?? {};
  assert.deepEqual([first["total"], (first["stations"] as unknown[]).length, first["nextOffset"]], [5, 2, 2]);
  assert.deepEqual(first["searched"], { state: "Nordrhein-Westfalen" });
  const count = (await connection.call("searchStations", { dc: true, limit: 0 })).structuredContent ?? {};
  assert.deepEqual([count["total"], count["stations"]], [7, []]);
  const frankfurt = (await connection.call("searchStations", { place: "Frankfurt" })).structuredContent ?? {};
  assert.equal(frankfurt["status"], "empty");
  assert.deepEqual(frankfurt["suggestions"], [{ place: "Frankfurt am Main", stations: 1 }]);
  await connection.close();
});

test("searchStations: half a point is refused before any request; an unknown state is a tool error naming the 16", async () => {
  const api = registerApi();
  const connection = await connect({ transport: api });
  const half = await connection.call("searchStations", { lat: 50.9, lon: 6.9 });
  assert.equal(half.isError, true);
  assert.match(half.content[0]?.text ?? "", /lat, lon and radiusKm together/);
  const state = await connection.call("searchStations", { state: "Bayer" });
  assert.equal(state.isError, true);
  assert.match(state.content[0]?.text ?? "", /unknown state "Bayer".*BY \(Bayern\)/);
  assert.equal(api.calls.length, 0, "no request");
  await connection.close();
});

test("countStationsBy: per state with the server's group-by, the column named; operators as legal entities with a note", async () => {
  const api = registerApi();
  const connection = await connect({ transport: api });
  const content = (await connection.call("countStationsBy", { groupBy: "state", type: "fast", top: 2 })).structuredContent ?? {};
  assert.deepEqual(content["groups"], [{ value: "Nordrhein-Westfalen", stations: 3 }, { value: "Bayern", stations: 3 }]);
  assert.deepEqual([content["column"], content["totalStations"], content["complete"], content["groupCount"]], ["state", 8, true, 4]);
  assert.equal(new URL(String(content["source"])).searchParams.get("groupByFieldsForStatistics"), "state");
  const operators = (await connection.call("countStationsBy", { groupBy: "operator", operator: "EnBW" })).structuredContent ?? {};
  assert.ok((operators["notes"] as string[]).some((n) => /legal entities/.test(n)));
  await connection.close();
});

test("getStationMap: GeoJSON points [lon, lat] with the station's fields, paged; getStation: the details; getRegisterInfo: the date and the columns", async () => {
  const connection = await connect({ transport: registerApi() });
  const map = (await connection.call("getStationMap", { place: "Köln", limit: 3 })).structuredContent ?? {};
  assert.equal(map["type"], "FeatureCollection");
  const features = map["features"] as { geometry: { coordinates: number[] }; properties: Record<string, unknown> }[];
  assert.deepEqual([features.length, map["total"], map["nextOffset"]], [3, 4, 3]);
  assert.deepEqual(features[0]?.geometry.coordinates, [6.961666, 50.952291]);
  assert.equal(features[0]?.properties["maxChargePointKw"], 150);
  const station = (await connection.call("getStation", { id: "1062404" })).structuredContent ?? {};
  assert.deepEqual((station["station"] as { openingHours: unknown }).openingHours, { monday: "07:00-22:00" });
  assert.match(String(station["source"]), /\/0\/query\?where=ID\+%3D\+%271062404%27$/);
  const info = (await connection.call("getRegisterInfo", {})).structuredContent ?? {};
  assert.deepEqual([info["dataLastEditDate"], info["totalStations"]], ["2026-11-12T07:17:19.492Z", 13]);
  assert.match(String(info["source"]), /\/FeatureServer\/0$/);
  await connection.close();
});

test("minPointKw over more candidates than one call reads (--max-pages) is a tool error saying what to narrow, before any page is read", async () => {
  const rows = Array.from({ length: 2001 }, (_, i) => stationRow(i + 1, String(i + 1), { max_electric_power_station: "150", Steckersystem_Ladepunkt1: "DC Fahrzeugkupplung Typ Combo 2 (CCS) (150 kw)" }));
  const api = registerApi({ rows });
  const connection = await connect({ transport: api, config: { maxPages: 1 } });
  const result = await connection.call("searchStations", { minPointKw: 150, limit: 0 });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /2001 stations to read, more than one call reads \(2000\); narrow it with state, place, operator or a radius/);
  assert.equal(api.calls.map(paramsOf).filter((p) => p.has("resultOffset")).length, 0, "no page read");
  await connection.close();
});

test("getStationMap offers the page sizes it takes: limit up to 100, as a search page; 101 is refused by the schema, before any request", async () => {
  const map = TOOLS.find((t) => t.name === "getStationMap");
  const limit = (map?.inputSchema as { properties: Record<string, { maximum: number; description: string }> }).properties["limit"];
  assert.equal(limit?.maximum, 100);
  assert.match(limit?.description ?? "", /\(1-100, default 100\)/);
  const api = registerApi();
  const connection = await connect({ transport: api });
  const full = await connection.call("getStationMap", { place: "Köln", limit: 100 });
  assert.equal(full.structuredContent?.["status"], "ok", full.content[0]?.text);
  const before = api.calls.length;
  const over = await connection.call("getStationMap", { place: "Köln", limit: 101 });
  assert.equal(over.isError, true);
  assert.match(over.content[0]?.text ?? "", /limit/);
  assert.equal(api.calls.length, before, "no request");
  await connection.close();
});

test("findStationsNear cut by the size cap says where the farther stations go on: nextOffset, then offset", async () => {
  const points = Array.from({ length: 4 }, (_, i) => `DC Fahrzeugkupplung Typ Combo 2 (CCS) (${150 + i} kw)`);
  const rows = Array.from({ length: 30 }, (_, i) =>
    stationRow(500 + i, `k${i}`, { Ort: "Köln", state: "Nordrhein-Westfalen", coordinates_latitude: 50.943 + (i + 1) / 5000, coordinates_longitude: 6.9589, ...Object.fromEntries(points.map((p, n) => [`Steckersystem_Ladepunkt${n + 1}`, p])) }),
  );
  const connection = await connect({ transport: registerApi({ rows }), config: { maxResultChars: 8000 } });
  const first = (await connection.call("findStationsNear", { ...KOELN_HBF, radiusKm: 5, limit: 30 })).structuredContent ?? {};
  const kept = (first["nearest"] as { id: string }[]).map((s) => s.id);
  assert.equal(first["truncated"], true);
  assert.ok(kept.length > 0 && kept.length < 30, `${kept.length}`);
  assert.equal(first["nextOffset"], kept.length);
  const next = (await connection.call("findStationsNear", { ...KOELN_HBF, radiusKm: 5, limit: 30, offset: first["nextOffset"] })).structuredContent ?? {};
  assert.equal((next["nearest"] as { id: string }[])[0]?.id, `k${kept.length}`, "the next nearest, none skipped or repeated");
  await connection.close();
});
