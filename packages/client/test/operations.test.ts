// The skills' use cases as library functions, against a mock of the register's FeatureServer
// shaped like its live answers (fixtures.ts), with the traps the skills document as cases: the
// operator is the company name (Betreiber is often null), the power a car gets is one charge
// point's, not the station's sum, "fast" is not "DC" (and DC can sit on any of six points), the
// go-live date is dd.mm.yyyy text, places are whole names, the register is a snapshot that
// undercounts, and the operator groups are legal entities.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LadesaeulenClient } from "../src/client.js";
import { LadesaeulenApiError, LadesaeulenError, LadesaeulenParseError, LadesaeulenValidationError } from "../src/errors.js";
import { countStationsBy, findStationsNear, getRegisterInfo, getStation, resolveState, searchStations, stationsToGeoJson, stationWhere, toStation } from "../src/operations.js";
import { paramsOf, registerApi, registerRows, stationRow } from "./fixtures.js";
import { jsonResponse } from "./helpers.js";

const NOW = () => new Date("2026-11-19T15:00:00Z");
const clientOf = (api = registerApi()) => ({ api, client: new LadesaeulenClient({ transport: api.transport }) });
const KOELN_HBF = { lat: 50.943, lon: 6.9589 };
const queries = (api: ReturnType<typeof registerApi>) => api.calls.map(paramsOf).filter((p) => p.has("where"));

test("states are taken as codes or names, German or English, umlauts or not, and sent as the register writes them; an unknown one is refused", () => {
  assert.deepEqual(["by", "Bayern", "Bavaria", "NRW", "Thueringen", "thüringen", "Baden-Wuerttemberg", "Lower Saxony"].map(resolveState), ["Bayern", "Bayern", "Bayern", "Nordrhein-Westfalen", "Thüringen", "Thüringen", "Baden-Württemberg", "Niedersachsen"]);
  assert.throws(() => resolveState("Bayer"), (err: unknown) => err instanceof LadesaeulenValidationError && /unknown state "Bayer".*BY \(Bayern\)/.test(err.message));
  assert.throws(() => resolveState(" "), LadesaeulenValidationError);
});

test("the filters become the register's SQL: quotes doubled, DC over all six charge points, the power figure cast, the go-live date as text", () => {
  assert.equal(stationWhere({}), "1=1");
  assert.equal(stationWhere({ place: " Köln ", operator: "O'Neill" }), "Ort = 'Köln' AND operator_companyName LIKE '%O''Neill%' ESCAPE '\\'");
  assert.equal(stationWhere({ dc: true }), "(" + [1, 2, 3, 4, 5, 6].map((i) => `Steckersystem_Ladepunkt${i} LIKE '%DC%'`).join(" OR ") + ")");
  assert.match(stationWhere({ dc: false }), /^\(Steckersystem_Ladepunkt1 IS NULL OR Steckersystem_Ladepunkt1 NOT LIKE '%DC%'\) AND .*Steckersystem_Ladepunkt6 NOT LIKE '%DC%'\)$/);
  assert.equal(stationWhere({ minPointKw: 150, type: "fast" }), "Typ = 'Schnellladeeinrichtung' AND CAST(max_electric_power_station AS FLOAT) >= 150");
  assert.equal(stationWhere({ goLiveYear: 2026, goLiveMonth: 8 }), "go_live_date LIKE '%.08.2026'");
  assert.equal(stationWhere({ postcode: "80", state: "BY" }), "Postleitzahl LIKE '80%' AND state = 'Bayern'");
  assert.equal(stationWhere({ where: "Status = 'In Wartung'", postcode: "50667" }), "Postleitzahl = '50667' AND (Status = 'In Wartung')");
  assert.throws(() => stationWhere({ goLiveMonth: 8 }), /give goLiveYear/);
  assert.throws(() => stationWhere({ postcode: "8080x" }), /postcode/);
  assert.throws(() => stationWhere({ place: "​" }), LadesaeulenValidationError);
  assert.throws(() => stationWhere({ type: "dc" as never }), /"normal" or "fast"/);
});

test("% and _ in operator, district and connector match themselves, not every station; so do they in a place's suggestions", async () => {
  assert.equal(stationWhere({ operator: "50%_a\\b" }), "operator_companyName LIKE '%50\\%\\_a\\\\b%' ESCAPE '\\'");
  const rows = [...registerRows(), stationRow(90002, "1600001", { operator_companyName: "Lade_Punkt GmbH", Ort: "Köln" })];
  const { api, client } = clientOf(registerApi({ rows }));
  const under = await searchStations(client, { operator: "_", limit: 0 }, { now: NOW });
  assert.deepEqual([under.status, under.total], ["ok", 1], "only the operator with an underscore");
  for (const filter of [{ operator: "%" }, { district: "%" }, { connector: "_" }, { district: "%", connector: "_" }]) {
    const result = await searchStations(client, { ...filter, limit: 0 }, { now: NOW });
    assert.deepEqual([result.status, result.total], ["empty", 0], JSON.stringify(filter));
  }
  const place = await searchStations(client, { place: "%" }, { now: NOW });
  assert.deepEqual([place.status, place.suggestions], ["empty", undefined], "no place contains a %");
  assert.ok(queries(api).some((p) => p.get("where") === "Ort LIKE '%\\%%' ESCAPE '\\'"), "the suggestions' query escapes it too");
});

test("a where must be one condition on its own: one that closes the parenthesis it is put in, opens one, leaves a quote open or holds a comment is refused before any request", async () => {
  const { api, client } = clientOf();
  const escapes = ["1=1) OR (1=1", "(1=1", "Ort = 'x", "1=1 --", "/* ( */ 1=1) OR (1=1 /* ) */", "Ort = \"x"];
  for (const where of escapes) {
    await assert.rejects(searchStations(client, { place: "München", where, limit: 0 }, { now: NOW }), (err: unknown) => err instanceof LadesaeulenValidationError && /^Invalid where: /.test(err.message), where);
    await assert.rejects(client.count({ where, minChargePointKw: 300 }), LadesaeulenValidationError, `the client ANDs it with the power figure: ${where}`);
    await assert.rejects(client.countBy("state", where), LadesaeulenValidationError, where);
  }
  assert.equal(api.calls.length, 0, "no request");
  await assert.rejects(searchStations(client, { where: "1=1) OR (1=1" }), /closes a parenthesis it never opened.*ANDed with the other filters/);
  // Parentheses and quotes inside a string literal are text; '' is a quote in one.
  const fine = await searchStations(client, { place: "München", where: "(Ort <> 'a) OR (b' OR Ort = 'it''s (')", limit: 0 }, { now: NOW });
  assert.equal(fine.status, "ok");
  assert.equal(queries(api).find((p) => p.has("returnCountOnly"))?.get("where"), "Ort = 'München' AND ((Ort <> 'a) OR (b' OR Ort = 'it''s ('))");
});

test("the attribution names one retrieval day: retrieved is the German date of the text, also in the hours after midnight in Berlin", async () => {
  const { client } = clientOf();
  for (const [now, day, text] of [["2026-11-22T23:30:00Z", "2026-11-23", "23.11.2026"], ["2026-06-30T22:30:00Z", "2026-07-01", "01.07.2026"], ["2026-11-22T12:00:00Z", "2026-11-22", "22.11.2026"]] as const) {
    const { attribution } = await getRegisterInfo(client, { now: () => new Date(now) });
    assert.equal(attribution.retrieved, day, now);
    assert.ok(attribution.text.endsWith(`abgerufen am ${text}`), attribution.text);
  }
});

test("a row becomes a station: the operator from the company name (Betreiber is null), trimmed; figures as numbers; the go-live date as ISO; connectors per point", () => {
  const rows = registerRows();
  const tanke = toStation(rows[2] as Record<string, unknown>);
  assert.equal(tanke.operator, "TankE GmbH");
  assert.deepEqual([tanke.stationKw, tanke.maxChargePointKw, tanke.chargePoints], [72, 50, 2], "72 is 50 kW CCS plus 22 kW AC: a car gets 50");
  assert.deepEqual(tanke.points, [{ connectors: ["DC Fahrzeugkupplung Typ Combo 2 (CCS) (50 kw)"], kw: 50 }, { connectors: ["AC Typ 2 Steckdose (22 kw)"], kw: 22 }]);
  assert.equal(tanke.goLive, "2021-03-05");
  assert.equal(tanke.street, "Am Malzbüchel 1");
  assert.equal(toStation(rows[7] as Record<string, unknown>).operator, "EnBW mobility+ AG und Co.KG", "the trailing space is gone");
  assert.equal(toStation(rows[0] as Record<string, unknown>).payment, null, "an empty Bezahlsystem is no payment system");
});

test("searchStations counts every match and lists a page; DC is found on any charge point, and fast is not DC", async () => {
  const { api, client } = clientOf();
  const dc = await searchStations(client, { state: "Berlin", dc: true }, { now: NOW });
  assert.equal(dc.status, "ok");
  assert.deepEqual(dc.stations.map((s) => [s.id, s.dc]), [["1200001", true]], "Tesla's CCS is on point 2");
  const fast = await searchStations(client, { type: "fast", place: "hamburg" }, { now: NOW });
  assert.deepEqual(fast.stations.map((s) => [s.id, s.dc]), [["1300001", false]], "a fast AC station");
  assert.ok(fast.notes.some((n) => /not DC/.test(n)));
  assert.ok(fast.notes.some((n) => /notification.*never 'Germany has N'/.test(n)), "the register undercounts");
  assert.equal(fast.attribution.text, "Datenquelle: Ladesäulenregister der Bundesnetzagentur (bundesnetzagentur.de), lizenziert unter CC BY 4.0 — Datenstand 12.11.2026, abgerufen am 19.11.2026");
  assert.deepEqual(fast.searched, { place: "hamburg", type: "fast" });
  assert.ok(queries(api).every((p) => p.get("where") !== "1=1"), "no request without the filter");
});

test("searchStations pages: total is every match, nextOffset where the next page starts; limit 0 counts without listing", async () => {
  const { api, client } = clientOf();
  const first = await searchStations(client, { place: "Köln", limit: 2 }, { now: NOW });
  assert.deepEqual([first.total, first.stations.length, first.nextOffset], [4, 2, 2]);
  const last = await searchStations(client, { place: "Köln", limit: 2, offset: 2 }, { now: NOW });
  assert.deepEqual([last.stations.map((s) => s.id), last.nextOffset], [["1062404", "1070001"], undefined]);
  const before = api.calls.length;
  const count = await searchStations(client, { place: "Köln", limit: 0 }, { now: NOW });
  assert.deepEqual([count.total, count.stations, count.nextOffset], [4, [], undefined]);
  assert.equal(api.calls.length - before, 3, "the count, the layer's date and the places that contain the name; no page");
});

test("searchStations by power per charge point: the station sum doesn't count (Jolt's 2 x 160 reads 320), fastest first", async () => {
  const { client } = clientOf();
  const result = await searchStations(client, { place: "München", minPointKw: 300 }, { now: NOW });
  assert.deepEqual(result.stations.map((s) => [s.operator, s.maxChargePointKw, s.stationKw]), [["SWM Versorgungs GmbH", 400, 800], ["EnBW mobility+ AG und Co.KG", 300, 300]]);
  assert.equal(result.total, 2);
  assert.ok(result.notes.some((n) => /often the sum/.test(n)));
});

test("searchStations: a place is the whole name; empty names what was searched and the places that contain it", async () => {
  const { client } = clientOf();
  const result = await searchStations(client, { place: "Frankfurt" }, { now: NOW });
  assert.equal(result.status, "empty");
  assert.deepEqual(result.suggestions, [{ place: "Frankfurt am Main", stations: 1 }]);
  assert.match(result.reason ?? "", /whole name/);
  const none = await searchStations(client, { place: "Atlantis" }, { now: NOW });
  assert.equal(none.suggestions, undefined);
  assert.match(none.reason ?? "", /No place's name contains "Atlantis"/);
});

test("searchStations: a place found under its whole name still names the other places that contain it (Frankfurt am Main is also under Frankfurt)", async () => {
  const rows = [...registerRows(), stationRow(80002, "1400002", { Ort: "Frankfurt", state: "Hessen" }), stationRow(80003, "1400003", { Ort: "Frankfurt (Oder)", state: "Brandenburg" })];
  const result = await searchStations(clientOf(registerApi({ rows })).client, { place: "frankfurt" }, { now: NOW });
  assert.deepEqual([result.status, result.total], ["ok", 1]);
  assert.match(result.notes[0] ?? "", /other places contain it: Frankfurt am Main \(1\), Frankfurt \(Oder\) \(1\)\. For a whole city, district/);
  const counts = await countStationsBy(clientOf(registerApi({ rows })).client, { groupBy: "state", place: "Frankfurt" }, { now: NOW });
  assert.match(counts.notes[0] ?? "", /other places contain it/);
});

test("findStationsNear marks a station whose address is in another state than nearly all around it: its coordinates may be wrong", async () => {
  const berlin = Array.from({ length: 20 }, (_, i) => stationRow(100 + i, `b${i}`, { coordinates_latitude: 52.5163 + (i + 1) / 2000, coordinates_longitude: 13.3777 }));
  const dueren = stationRow(99, "1128389", { Ort: "Düren", state: "Nordrhein-Westfalen", coordinates_latitude: 52.516181, coordinates_longitude: 13.376935 });
  const near = await findStationsNear(clientOf(registerApi({ rows: [...berlin, dueren] })).client, { lat: 52.5163, lon: 13.3777, radiusKm: 2, limit: 3 }, { now: NOW });
  assert.deepEqual(near.nearest.map((s) => [s.id, s.checkLocation]), [["1128389", true], ["b0", undefined], ["b1", undefined]]);
  assert.match(near.notes.find((n) => /checkLocation/.test(n)) ?? "", /^1 of 21 stations here give an address in another state.*1128389, Düren/);
  const few = await findStationsNear(clientOf(registerApi({ rows: [...berlin.slice(0, 5), dueren] })).client, { lat: 52.5163, lon: 13.3777, radiusKm: 1 }, { now: NOW });
  assert.ok(few.nearest.every((s) => s.checkLocation === undefined), "too few stations to judge");
});

test("searchStations: operators match any part of the company name, any case; a year or month of going live matches the dd.mm.yyyy text", async () => {
  const { client } = clientOf();
  const enbw = await searchStations(client, { operator: "enbw" }, { now: NOW });
  assert.deepEqual(enbw.stations.map((s) => s.operator), ["EnBW mobility+ AG und Co.KG", "EnBW Ostwürttemberg DonauRies AG"]);
  assert.ok(enbw.notes.some((n) => /legal entity/.test(n)));
  const august = await searchStations(client, { goLiveYear: 2026, goLiveMonth: 8 }, { now: NOW });
  assert.deepEqual(august.stations.map((s) => s.goLive), ["2026-08-31", "2026-08-15"]);
  const year = await searchStations(client, { goLiveYear: 2026, limit: 0 }, { now: NOW });
  assert.equal(year.total, 4);
});

test("a where naming a column that is empty on every row gets a note; SQL the server can't read is its error", async () => {
  const { client } = clientOf();
  const result = await searchStations(client, { where: "json_type IS NULL", limit: 0 }, { now: NOW });
  assert.ok(result.notes.some((n) => /json_type is empty on every row/.test(n)));
  await assert.rejects(searchStations(client, { where: "max_electric_power_station >>= 1" }), (err: unknown) => err instanceof LadesaeulenError && /ArcGIS error 400/.test(err.message));
});

test("a where the server can't read gets an error that names the where and where the columns are listed, not only 'check your parameters'", async () => {
  const { client } = clientOf();
  const names = (err: unknown) => err instanceof LadesaeulenApiError && err.arcgisCode === 400 && /Unable to perform query\. Please check your parameters\..*the where given.*getRegisterInfo lists the columns/.test(err.message);
  await assert.rejects(searchStations(client, { where: "Leistung > 50", limit: 0 }, { now: NOW }), names);
  await assert.rejects(findStationsNear(client, { ...KOELN_HBF, radiusKm: 2, where: "Leistung > 50" }, { now: NOW }), names);
  await assert.rejects(countStationsBy(client, { groupBy: "state", where: "Leistung > 50" }, { now: NOW }), names);
  // Without a where of one's own, the server's error stays as it is.
  const bad = clientOf(registerApi({ rows: [stationRow(1, "x")] }));
  bad.client.count = async () => {
    throw new LadesaeulenApiError({ url: "https://example.test/0/query", method: "GET", body: "", arcgisCode: 400, detail: "Unable to perform query. Please check your parameters." });
  };
  await assert.rejects(searchStations(bad.client, { place: "Berlin" }, { now: NOW }), (err: unknown) => err instanceof LadesaeulenApiError && !/where/.test(err.message));
});

test("findStationsNear ranks by distance, nearest first, with the distance; filters and power per point apply", async () => {
  const { client } = clientOf();
  const near = await findStationsNear(client, { ...KOELN_HBF, radiusKm: 2, type: "fast" }, { now: NOW });
  assert.equal(near.status, "ok");
  assert.deepEqual(near.nearest.map((s) => s.id), ["1062404", "1059502", "1055348"]);
  assert.ok(near.nearest.every((s, i, all) => i === 0 || (s.distanceKm ?? 0) >= (all[i - 1]?.distanceKm ?? 0)));
  assert.equal(near.nearest[0]?.distanceKm, 0.3);
  const fast = await findStationsNear(client, { ...KOELN_HBF, radiusKm: 2, minPointKw: 100, limit: 1 }, { now: NOW });
  assert.deepEqual([fast.total, fast.nearest.map((s) => s.operator)], [1, ["BP Europa SE"]]);
});

test("findStationsNear pages: nextOffset says where the farther stations go on, nearest first throughout", async () => {
  const { client } = clientOf();
  const first = await findStationsNear(client, { ...KOELN_HBF, radiusKm: 2, limit: 2 }, { now: NOW });
  assert.deepEqual([first.total, first.nearest.length, first.nextOffset], [4, 2, 2]);
  const rest = await findStationsNear(client, { ...KOELN_HBF, radiusKm: 2, limit: 2, offset: first.nextOffset }, { now: NOW });
  assert.deepEqual([rest.nearest.length, rest.nextOffset], [2, undefined], "the last page has no nextOffset");
  const all = await findStationsNear(client, { ...KOELN_HBF, radiusKm: 2, limit: 10 }, { now: NOW });
  assert.deepEqual([...first.nearest, ...rest.nearest].map((s) => s.id), all.nearest.map((s) => s.id));
  assert.deepEqual(first.searched, { lat: 50.943, lon: 6.9589, radiusKm: 2 }, "the page is not a filter");
});

test("findStationsNear: none at that power says what the station figures reach; a swapped point is named; too many to rank is refused before reading", async () => {
  const { api, client } = clientOf();
  const none = await findStationsNear(client, { ...KOELN_HBF, radiusKm: 1, minPointKw: 60 }, { now: NOW });
  assert.equal(none.status, "empty");
  assert.match(none.reason ?? "", /1 station within 1 km reaches 60 kW only as the station's total.*fastest delivers 50 kW/, "TankE's 72 is 50 + 22");
  const swapped = await findStationsNear(client, { lat: 6.9589, lon: 50.943, radiusKm: 1 }, { now: NOW });
  assert.equal(swapped.status, "empty");
  assert.match(swapped.notes[0] ?? "", /outside Germany; swapped it would be inside/);
  const before = api.calls.length;
  await assert.rejects(findStationsNear(client, { ...KOELN_HBF, radiusKm: 2 }, { now: NOW, maxRows: 2 }), /4 stations to read, more than one call reads \(2\); use a smaller radiusKm/);
  assert.equal(api.calls.slice(before).map(paramsOf).filter((p) => p.has("resultOffset")).length, 0, "no page read");
});

test("a read of every station that gets fewer than it counted (the register changed, a page lost) is an error, not a short answer given as complete", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => stationRow(600 + i, `p${i}`, { coordinates_latitude: 52.52 + i / 10000, coordinates_longitude: 13.405, max_electric_power_station: "150", Steckersystem_Ladepunkt1: "DC Fahrzeugkupplung Typ Combo 2 (CCS) (150 kw)" }));
  const api = registerApi({ rows, pageCap: 2 });
  // The pages from the third station on come back empty.
  const lossy = { transport: (request: Parameters<typeof api.transport>[0]) => (Number(paramsOf(request).get("resultOffset") ?? 0) >= 2 ? Promise.resolve(jsonResponse({ features: [] })) : api.transport(request)) };
  const client = new LadesaeulenClient({ transport: lossy.transport });
  const short = (err: unknown) => err instanceof LadesaeulenParseError && /answered 2 of the 5 stations it counted.*ask again/.test(err.message);
  await assert.rejects(findStationsNear(client, { lat: 52.52, lon: 13.405, radiusKm: 5 }, { now: NOW }), short);
  await assert.rejects(searchStations(client, { minPointKw: 100, limit: 0 }, { now: NOW }), short);
  await assert.rejects(countStationsBy(client, { groupBy: "state", near: { lat: 52.52, lon: 13.405, radiusKm: 5 } }, { now: NOW }), short);
  const whole = await findStationsNear(new LadesaeulenClient({ transport: api.transport }), { lat: 52.52, lon: 13.405, radiusKm: 5 }, { now: NOW });
  assert.equal(whole.total, 5, "pages of 2 read to the end");
});

test("countStationsBy groups on the server, largest first; operator names with a trailing space are one group", async () => {
  const rows = [...registerRows(), stationRow(90001, "1500001", { operator_companyName: "EnBW mobility+ AG und Co.KG", state: "Bayern" })];
  const { client } = clientOf(registerApi({ rows }));
  const states = await countStationsBy(client, { groupBy: "state" }, { now: NOW });
  assert.deepEqual(states.groups.slice(0, 2), [{ value: "Nordrhein-Westfalen", stations: 5 }, { value: "Bayern", stations: 5 }]);
  assert.deepEqual([states.totalStations, states.complete, states.column], [14, true, "state"]);
  const operators = await countStationsBy(client, { groupBy: "operator", operator: "EnBW mobility" }, { now: NOW });
  assert.deepEqual(operators.groups, [{ value: "EnBW mobility+ AG und Co.KG", stations: 2 }]);
  assert.ok(operators.notes.some((n) => /legal entities/.test(n)));
});

test("countStationsBy: a list cut at the server's group cap says so and counts the total apart; by power per point it groups the stations read", async () => {
  const { client } = clientOf(registerApi({ groupCap: 2 }));
  const cut = await countStationsBy(client, { groupBy: "place", top: 1 }, { now: NOW });
  assert.deepEqual([cut.complete, cut.totalStations, cut.groups.length], [false, 13, 1]);
  assert.ok(cut.notes.some((n) => /More than 2,000 groups/.test(n)));
  const fast = await countStationsBy(clientOf().client, { groupBy: "state", minPointKw: 150 }, { now: NOW });
  assert.deepEqual(fast.groups, [{ value: "Bayern", stations: 3 }, { value: "Berlin", stations: 1 }, { value: "Nordrhein-Westfalen", stations: 1 }]);
  await assert.rejects(countStationsBy(clientOf().client, { groupBy: "Betreiber" as never }), /Invalid groupBy/);
});

test("getStation: one station with its opening hours and connectors; an unknown id is empty with where ids come from", async () => {
  const { client } = clientOf();
  const found = await getStation(client, { id: "1062404" }, { now: NOW });
  assert.equal(found.status, "ok");
  assert.deepEqual(found.station?.openingHours, { monday: "07:00-22:00" });
  assert.deepEqual(found.station?.points[0]?.connectors, ["DC Fahrzeugkupplung Typ Combo 2 (CCS) (50 kw)", "DC CHAdeMO (50 kw)"]);
  const none = await getStation(client, { id: "999" }, { now: NOW });
  assert.equal(none.status, "empty");
  assert.match(none.reason ?? "", /ids come from searchStations or findStationsNear/);
  await assert.rejects(getStation(client, { id: "1' OR '1'='1" }), LadesaeulenValidationError);
});

test("getRegisterInfo: the as-of date, the total, the columns with their traps, the empty ones apart", async () => {
  const { client } = clientOf();
  const info = await getRegisterInfo(client, { now: NOW });
  assert.deepEqual([info.dataLastEditDate, info.totalStations], ["2026-11-12T07:17:19.492Z", 13]);
  assert.match(info.columns.find((c) => c.name === "max_electric_power_station")?.note ?? "", /CAST/);
  assert.ok(!info.columns.some((c) => ["json_type", "F_response_body", "Steckersystem_Ladepunkt7"].includes(c.name)));
  assert.ok(info.emptyColumns.includes("json_type"));
});

test("stations become GeoJSON points [lon, lat]; one without coordinates is named, not placed at 0,0", () => {
  const stations = [toStation(registerRows()[1] as Record<string, unknown>), toStation(stationRow(1, "x", { coordinates_latitude: null, coordinates_longitude: null }))];
  const { features, leftOff } = stationsToGeoJson(stations);
  assert.deepEqual(features[0]?.geometry, { type: "Point", coordinates: [6.961666, 50.952291] });
  assert.equal((features[0]?.properties as Record<string, unknown>)["points"], undefined);
  assert.deepEqual(leftOff, [{ id: "x", place: "Berlin" }]);
});
