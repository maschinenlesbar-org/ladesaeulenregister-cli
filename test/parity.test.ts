// CLI <-> library parity: the same input through run() and through the matching
// library call, on one recording mock transport, must give the same outcome —
// both reject with no request sent, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LadesaeulenClient, DEFAULT_LIMIT } from "../src/client/client.js";
import * as lib from "../src/index.js";
import { jsonResponse, parity, queryOf, requestShapes } from "./helpers.js";
import * as fx from "./fixtures.js";

// ---- #1 (PAT-15): the default page size is the library's ----

test("parity: stations without a limit sends the same page size from the CLI and the library", async () => {
  const cases: [string[], (c: LadesaeulenClient) => Promise<unknown>][] = [
    [["--compact", "stations"], (c) => c.stations()],
    [["--compact", "stations", "--where", "Ort='Berlin'"], (c) => c.stations({ where: "Ort='Berlin'" })],
    [["--compact", "stations", "--offset", "7"], (c) => c.stations({ offset: 7 })],
    [["--compact", "stations", "--order-by", "Ort ASC"], (c) => c.stations({ orderBy: "Ort ASC" })],
    [
      ["--compact", "stations", "--near", "52.5,13.4", "--radius", "1"],
      (c) => c.stations({ near: { lat: 52.5, lon: 13.4, radiusKm: 1 } }),
    ],
  ];
  for (const [argv, call] of cases) {
    const { cli, lib: res } = await parity(argv, (transport) => call(new LadesaeulenClient({ transport })), () =>
      jsonResponse(fx.stations),
    );
    assert.equal(cli.code, 0, argv.join(" "));
    assert.ok(res.ok, argv.join(" "));
    assert.deepEqual(requestShapes(res.requests), requestShapes(cli.requests), argv.join(" "));
    assert.equal(queryOf(res.requests[0]!).get("resultRecordCount"), String(DEFAULT_LIMIT));
  }
});

test("parity: stations --geojson without a limit sends the same page size as geojson()", async () => {
  const { cli, lib: res } = await parity(
    ["--compact", "stations", "--geojson"],
    (transport) => new LadesaeulenClient({ transport }).geojson(),
    () => jsonResponse(fx.geojson),
  );
  assert.equal(cli.code, 0);
  assert.ok(res.ok);
  assert.deepEqual(requestShapes(res.requests), requestShapes(cli.requests));
  assert.equal(queryOf(res.requests[0]!).get("resultRecordCount"), String(DEFAULT_LIMIT));
});

test("parity: stations --count and count() send no page size", async () => {
  const { cli, lib: res } = await parity(
    ["--compact", "stations", "--count"],
    (transport) => new LadesaeulenClient({ transport }).count(),
    () => jsonResponse(fx.countOnly),
  );
  assert.equal(cli.code, 0);
  assert.ok(res.ok);
  assert.deepEqual(requestShapes(res.requests), requestShapes(cli.requests));
  assert.equal(queryOf(res.requests[0]!).has("resultRecordCount"), false);
});

test("DEFAULT_LIMIT is 50 and exported from the package root", () => {
  assert.equal(DEFAULT_LIMIT, 50);
  assert.equal(lib.DEFAULT_LIMIT, DEFAULT_LIMIT);
});
