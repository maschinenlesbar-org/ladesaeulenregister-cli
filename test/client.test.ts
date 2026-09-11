import { test } from "node:test";
import assert from "node:assert/strict";
import { LadesaeulenClient, DEFAULT_FIELDS } from "../src/client/client.js";
import { LadesaeulenApiError, LadesaeulenParseError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

function clientFor(body: unknown) {
  const mt = makeMockTransport(() => jsonResponse(body));
  return { client: new LadesaeulenClient({ transport: mt.transport }), mt };
}

test("stations() GETs /0/query with f=json, default where/outFields, no geometry", async () => {
  const { client, mt } = clientFor(fx.stations);
  const page = await client.stations();
  const q = queryOf(mt.last());
  assert.equal(new URL(mt.last().url).pathname.endsWith("/0/query"), true);
  assert.equal(q.get("f"), "json");
  assert.equal(q.get("where"), "1=1");
  assert.equal(q.get("outFields"), DEFAULT_FIELDS);
  assert.equal(q.get("returnGeometry"), "false");
  assert.equal(page.features.length, 2);
  assert.equal(page.exceededTransferLimit, false);
  assert.equal(page.features[0]?.attributes.Ort, "Düsseldorf");
});

test("stations() forwards where/limit/offset/order-by/fields", async () => {
  const { client, mt } = clientFor(fx.stations);
  await client.stations({ where: "Ort='Berlin'", limit: 5, offset: 10, orderBy: "Ort ASC", outFields: "Ort,Typ" });
  const q = queryOf(mt.last());
  assert.equal(q.get("where"), "Ort='Berlin'");
  assert.equal(q.get("resultRecordCount"), "5");
  assert.equal(q.get("resultOffset"), "10");
  assert.equal(q.get("orderByFields"), "Ort ASC");
  assert.equal(q.get("outFields"), "Ort,Typ");
});

test("count() sends returnCountOnly and returns the number", async () => {
  const { client, mt } = clientFor(fx.countOnly);
  const n = await client.count({ where: "Typ='Schnellladeeinrichtung'" });
  const q = queryOf(mt.last());
  assert.equal(q.get("returnCountOnly"), "true");
  assert.equal(q.has("outFields"), false); // not requested for a count
  assert.equal(n, 660);
});

test("a spatial near query sends geometry/distance/units/spatialRel", async () => {
  const { client, mt } = clientFor(fx.stations);
  await client.stations({ near: { lat: 52.52, lon: 13.405, radiusKm: 2 } });
  const q = queryOf(mt.last());
  assert.equal(q.get("geometry"), "13.405,52.52");
  assert.equal(q.get("geometryType"), "esriGeometryPoint");
  assert.equal(q.get("inSR"), "4326");
  assert.equal(q.get("distance"), "2000"); // km -> m
  assert.equal(q.get("units"), "esriSRUnit_Meter");
  assert.equal(q.get("spatialRel"), "esriSpatialRelIntersects");
});

test("an ArcGIS error envelope (HTTP 200) throws LadesaeulenApiError", async () => {
  const { client } = clientFor(fx.arcgisError);
  await assert.rejects(
    () => client.stations({ where: "BOGUS=1" }),
    (err) =>
      err instanceof LadesaeulenApiError &&
      err.arcgisCode === 400 &&
      /Unable to complete operation/.test(err.message) &&
      /Invalid field: BOGUS/.test(err.message),
  );
});

test("an ArcGIS error envelope with control chars is stripped before it reaches stderr", async () => {
  // Built via char codes so no raw control byte appears in this source file.
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const evil = { error: { code: 400, message: `bad${ESC}[2Jclause`, details: [`hint${BEL}here`] } };
  const { client } = clientFor(evil);
  await assert.rejects(
    () => client.stations({ where: "BOGUS=1" }),
    (err) => {
      assert.ok(err instanceof LadesaeulenApiError);
      const hasControl = [...err.message].some((c) => {
        const n = c.charCodeAt(0);
        return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
      });
      assert.ok(!hasControl);
      assert.match(err.message, /bad\[2Jclause/);
      assert.match(err.message, /hinthere/);
      return true;
    },
  );
});

test("an empty 200 body surfaces as a typed LadesaeulenParseError, not a raw TypeError", async () => {
  const mt = makeMockTransport(() => rawResponse("", "application/json", 200));
  const client = new LadesaeulenClient({ transport: mt.transport });
  await assert.rejects(
    () => client.stations(),
    (err) => err instanceof LadesaeulenParseError && /Expected a JSON object/.test(err.message),
  );
});

test("countBy() sends outStatistics group-by and maps rows to {value, count}", async () => {
  const { client, mt } = clientFor(fx.countByState);
  const rows = await client.countBy("state");
  const q = queryOf(mt.last());
  assert.equal(q.get("groupByFieldsForStatistics"), "state");
  assert.match(q.get("outStatistics") ?? "", /"statisticType":"count"/);
  assert.deepEqual(rows[0], { value: "Bayern", count: 21969 });
  assert.equal(rows.length, 3);
});

test("fields() GETs the layer metadata and returns the fields", async () => {
  const { client, mt } = clientFor(fx.fields);
  const fields = await client.fields();
  assert.equal(new URL(mt.last().url).pathname.endsWith("/0"), true);
  assert.equal(queryOf(mt.last()).get("f"), "json");
  assert.equal(fields[0]?.name, "Betreiber");
});

test("countBy() throws LadesaeulenParseError when features is not an array", async () => {
  const { client } = clientFor({ features: { message: "unexpected shape" } });
  await assert.rejects(
    () => client.countBy("state"),
    (err) => err instanceof LadesaeulenParseError && /"features".*array.*\/0\/query/.test(err.message),
  );
});

test("fields() throws LadesaeulenParseError when fields is not an array", async () => {
  const { client } = clientFor({ fields: { message: "unexpected shape" } });
  await assert.rejects(
    () => client.fields(),
    (err) => err instanceof LadesaeulenParseError && /"fields".*array.*\/0/.test(err.message),
  );
});

test("geojson() requests f=geojson and returns the FeatureCollection", async () => {
  const { client, mt } = clientFor(fx.geojson);
  const gj = (await client.geojson({ where: "Ort='Berlin'" })) as { type?: string };
  assert.equal(queryOf(mt.last()).get("f"), "geojson");
  assert.equal(gj.type, "FeatureCollection");
});
