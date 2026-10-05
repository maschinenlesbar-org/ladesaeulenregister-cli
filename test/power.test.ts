// Per-charge-point power (result 01 bug 1 of the 2026-10-05 review): max_electric_power_station
// is often the sum of the charge points, so "charge at N kW" is answered from the connector
// ratings instead. Rows below are real register rows (live, 2026-10-05/06).

import { test } from "node:test";
import assert from "node:assert/strict";
import { LadesaeulenClient } from "../src/client/client.js";
import { LadesaeulenValidationError } from "../src/client/errors.js";
import {
  chargePointRatingsKw,
  connectorRatingsKw,
  maxChargePointKw,
  stationPowerKw,
} from "../src/client/power.js";
import type { HttpRequest } from "../src/client/http.js";
import { run } from "../src/cli/run.js";
import { jsonResponse, makeMockTransport, queryOf } from "./helpers.js";

const CCS = "DC Fahrzeugkupplung Typ Combo 2 (CCS)";
/** Shell, München: 2 × 300 kW, station figure 300. */
const shell = { ID: "1009334", max_electric_power_station: "300", Steckersystem_Ladepunkt1: `${CCS} (300 kw)`, Steckersystem_Ladepunkt2: `${CCS} (300 kw)` };
/** Jolt, München (Würmtalstr. 97): 2 × 160 kW, station figure 320 — the sum. */
const jolt = { ID: "1011044", max_electric_power_station: "320", Steckersystem_Ladepunkt1: `${CCS} (160 kw)`, Steckersystem_Ladepunkt2: `${CCS} (160 kw)` };
/** EnBW: 2 × 300 kW connectors, station figure 150 — a station limit below the rating. */
const enbw = { ID: "1025791", max_electric_power_station: "150", Steckersystem_Ladepunkt1: `${CCS} (300 kw)`, Steckersystem_Ladepunkt2: `${CCS} (300 kw)` };
/** Düsseldorf: 43 kW AC on point 1, 50 kW DC (two connectors) on point 2, station figure 93. */
const mixed = {
  ID: "1000079",
  max_electric_power_station: "93",
  Steckersystem_Ladepunkt1: "AC Typ 2 Fahrzeugkupplung (43 kw)",
  Steckersystem_Ladepunkt2: `${CCS} (50 kw)\nDC CHAdeMO (50 kw)`,
};
/** A point whose rating the operator left empty. */
const unrated = { ID: "x", max_electric_power_station: "22", Steckersystem_Ladepunkt1: "AC Typ 2 Fahrzeugkupplung ( kw)" };

test("connector ratings are read from every '(N kw)' line; an empty rating is none", () => {
  assert.deepEqual(connectorRatingsKw(`${CCS} (50 kw)\nDC CHAdeMO (50 kw)`), [50, 50]);
  assert.deepEqual(connectorRatingsKw("AC Typ 2 Steckdose (3.7 kw)"), [3.7]);
  assert.deepEqual(connectorRatingsKw("AC Typ 2 Fahrzeugkupplung ( kw)"), []);
  assert.deepEqual(connectorRatingsKw(null), []);
  assert.deepEqual(chargePointRatingsKw(mixed), [43, 50]);
  assert.deepEqual(chargePointRatingsKw(unrated), [null]);
  assert.equal(stationPowerKw({ max_electric_power_station: "3.7" }), 3.7);
  assert.equal(stationPowerKw({ max_electric_power_station: "" }), null);
});

test("max_charge_point_kw is the fastest point, capped at the station figure", () => {
  assert.equal(maxChargePointKw(shell), 300);
  assert.equal(maxChargePointKw(jolt), 160); // not the station's 320
  assert.equal(maxChargePointKw(enbw), 150); // the station limit
  assert.equal(maxChargePointKw(mixed), 50); // not the station's 93
  assert.equal(maxChargePointKw(unrated), null);
  assert.equal(maxChargePointKw({ max_electric_power_station: "44" }), null);
});

function powerClient(rows: Array<Record<string, unknown>>, pages = 1) {
  const mt = makeMockTransport((req: HttpRequest) => {
    const q = queryOf(req);
    const offset = Number(q.get("resultOffset") ?? 0);
    const size = Math.ceil(rows.length / pages);
    const slice = rows.slice(offset, offset + size);
    return jsonResponse({ features: slice.map((attributes) => ({ attributes })), exceededTransferLimit: offset + size < rows.length });
  });
  return { client: new LadesaeulenClient({ transport: mt.transport }), mt };
}

test("minChargePointKw keeps the stations where one point reaches it, and says what each point gives", async () => {
  const { client, mt } = powerClient([shell, jolt, enbw, mixed, unrated]);
  const page = await client.stations({ where: "Ort='München'", minChargePointKw: 300 });
  assert.deepEqual(page.features.map((f) => f.attributes.ID), ["1009334"]);
  assert.equal(page.features[0]!.attributes.max_charge_point_kw, 300);
  const q = queryOf(mt.last());
  assert.equal(q.get("where"), "(Ort='München') AND CAST(max_electric_power_station AS FLOAT) >= 300");
  const fields = q.get("outFields")!.split(",");
  for (const f of ["ID", "max_electric_power_station", "Steckersystem_Ladepunkt1", "Steckersystem_Ladepunkt6"]) assert.ok(fields.includes(f), f);
});

test("rows with connector columns get max_charge_point_kw without a minimum", async () => {
  const { client } = powerClient([jolt, { ID: "no-columns", max_electric_power_station: "11" }]);
  const page = await client.stations({ outFields: "*" });
  assert.equal(page.features[0]!.attributes.max_charge_point_kw, 160);
  assert.equal("max_charge_point_kw" in page.features[1]!.attributes, false);
});

test("count({ minChargePointKw }) reads every candidate page and counts the matches", async () => {
  const rows = [shell, jolt, enbw, mixed, shell, jolt];
  const { client, mt } = powerClient(rows, 3);
  assert.equal(await client.count({ minChargePointKw: 150 }), 5); // shell ×2, jolt ×2, enbw; not mixed (50)
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(mt.calls.map((r) => queryOf(r).get("resultOffset")), ["0", "2", "4"]);
  assert.equal(queryOf(mt.calls[0]!).get("orderByFields"), "OBJECTID");
  assert.equal(queryOf(mt.calls[0]!).get("returnCountOnly"), null);
});

test("geojson({ minChargePointKw }) filters the features' properties the same way", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({ type: "FeatureCollection", features: [shell, jolt].map((properties) => ({ type: "Feature", properties, geometry: null })) }),
  );
  const gj = await new LadesaeulenClient({ transport: mt.transport }).geojson({ minChargePointKw: 200 });
  assert.deepEqual(gj.features.map((f) => f.properties?.ID), ["1009334"]);
  assert.equal(gj.features[0]!.properties?.max_charge_point_kw, 300);
});

test("minChargePointKw is checked before any request", async () => {
  const { client, mt } = powerClient([]);
  for (const bad of [0, -5, Number.NaN, 10_001, "150"]) {
    await assert.rejects(client.stations({ minChargePointKw: bad as number }), LadesaeulenValidationError, String(bad));
  }
  assert.equal(mt.calls.length, 0);
});

test("--min-point-kw drives the same filter; bad values are usage errors", async () => {
  const { mt } = powerClient([shell, jolt]);
  const out: string[] = [];
  const err: string[] = [];
  const deps = { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, createClient: () => new LadesaeulenClient({ transport: mt.transport }) };
  assert.equal(await run(["--compact", "stations", "--where", "Ort='München'", "--min-point-kw", "300"], deps), 0, err.join("\n"));
  const page = JSON.parse(out.join("")) as { features: Array<{ attributes: { ID: string; max_charge_point_kw: number } }> };
  assert.deepEqual(page.features.map((f) => [f.attributes.ID, f.attributes.max_charge_point_kw]), [["1009334", 300]]);
  out.length = 0;
  assert.equal(await run(["stations", "--min-point-kw", "300", "--count"], deps), 0, err.join("\n"));
  assert.equal(out.join(""), "1");
  for (const bad of ["0", "-1", "1e3", "abc", "10001"]) {
    assert.equal(await run(["stations", "--min-point-kw", bad], deps), 2, bad);
  }
});
