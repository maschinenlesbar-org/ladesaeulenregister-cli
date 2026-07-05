import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { LadesaeulenClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new LadesaeulenClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("stations renders { features, exceededTransferLimit } and hits /0/query", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  const code = await run(["stations"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname.endsWith("/0/query"), true);
  const parsed = JSON.parse(cli.out.join("\n")) as { features: unknown[]; exceededTransferLimit: boolean };
  assert.equal(parsed.features.length, 2);
  assert.equal(parsed.exceededTransferLimit, false);
});

test("--count prints only the number", async () => {
  const cli = makeCli(() => jsonResponse(fx.countOnly));
  await run(["stations", "--where", "Typ='Schnellladeeinrichtung'", "--count"], cli.deps);
  assert.equal(JSON.parse(cli.out.join("\n")), 660);
  assert.equal(queryOf(cli.mt.last()).get("returnCountOnly"), "true");
});

test("--geojson outputs a FeatureCollection", async () => {
  const cli = makeCli(() => jsonResponse(fx.geojson));
  await run(["stations", "--geojson"], cli.deps);
  assert.equal(JSON.parse(cli.out.join("\n")).type, "FeatureCollection");
  assert.equal(queryOf(cli.mt.last()).get("f"), "geojson");
});

test("--limit / --order-by / --fields are forwarded", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  await run(["stations", "--limit", "5", "--order-by", "Ort ASC", "--fields", "Ort,Typ"], cli.deps);
  const q = queryOf(cli.mt.last());
  assert.equal(q.get("resultRecordCount"), "5");
  assert.equal(q.get("orderByFields"), "Ort ASC");
  assert.equal(q.get("outFields"), "Ort,Typ");
});

test("--near with --radius issues a spatial query", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  await run(["stations", "--near", "52.52,13.405", "--radius", "1.5"], cli.deps);
  const q = queryOf(cli.mt.last());
  assert.equal(q.get("geometry"), "13.405,52.52");
  assert.equal(q.get("distance"), "1500");
});

test("--near without --radius is a usage error and issues no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  const code = await run(["stations", "--near", "52.52,13.405"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /--near and --radius must be given together/);
});

test("a malformed --near is rejected at parse time (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  const code = await run(["stations", "--near", "not-a-point", "--radius", "1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--limit above the max is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  assert.equal(await run(["stations", "--limit", "20000"], cli.deps), 2);
});

test("an ArcGIS error envelope surfaces as an error (exit 1)", async () => {
  const cli = makeCli(() => jsonResponse(fx.arcgisError));
  const code = await run(["stations", "--where", "BOGUS=1"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Unable to complete operation/);
});

test("count-by <field> aggregates and renders rows", async () => {
  const cli = makeCli(() => jsonResponse(fx.countByState));
  const code = await run(["count-by", "state"], cli.deps);
  assert.equal(code, 0);
  assert.equal(queryOf(cli.mt.last()).get("groupByFieldsForStatistics"), "state");
  assert.deepEqual(JSON.parse(cli.out.join("\n"))[0], { value: "Bayern", count: 21969 });
});

test("count-by with no field is a usage error (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.countByState));
  assert.equal(await run(["count-by"], cli.deps), 2);
});

test("fields lists the queryable columns", async () => {
  const cli = makeCli(() => jsonResponse(fx.fields));
  const code = await run(["fields"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname.endsWith("/0"), true);
  assert.equal(JSON.parse(cli.out.join("\n"))[0].name, "Betreiber");
});

test("a control character in --user-agent is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  const code = await run(["stations", "--user-agent", "bad\r\nX-Injected: 1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("an empty --base-url is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  const code = await run(["--base-url", "", "stations"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--max-retries above the sane maximum is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  const code = await run(["--max-retries", "1000000", "stations"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a bare invocation prints help and exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: ladesaeulen/);
});

test("an unknown command exits 2", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["boguscmd"], cli.deps), 2);
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.stations));
  await run(["stations", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});
