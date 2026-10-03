// CLI <-> library parity: the same input through run() and through the matching
// library call, on one recording mock transport, must give the same outcome —
// both reject with no request sent, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LadesaeulenClient, DEFAULT_LIMIT } from "../src/client/client.js";
import * as lib from "../src/index.js";
import { LadesaeulenValidationError } from "../src/client/errors.js";
import { countIgnoredOptions, countQueryProblem } from "../src/client/validate.js";
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

// ---- #3 (PAT-14): count() refuses paging, sort and field options ----

test("countIgnoredOptions names the set paging, sort and field keys in a fixed order", () => {
  assert.deepEqual(countIgnoredOptions({}), []);
  assert.deepEqual(countIgnoredOptions({ where: "1=1", near: { lat: 52.5, lon: 13.4, radiusKm: 1 } }), []);
  assert.deepEqual(countIgnoredOptions({ offset: 116000, limit: 10 }), ["limit", "offset"]);
  assert.deepEqual(countIgnoredOptions({ outFields: "ID", orderBy: "Ort ASC" }), ["orderBy", "outFields"]);
});

test("countQueryProblem explains why the keys do not apply, or returns undefined", () => {
  assert.equal(countQueryProblem({ where: "Ort='Berlin'" }), undefined);
  assert.equal(
    countQueryProblem({ limit: 10, offset: 116000 }),
    "limit, offset cannot be combined with count(): it counts every match, so paging, sorting and field options do not apply.",
  );
});

test("parity: stations --count with a paging, sort or field option is rejected by both, no request", async () => {
  const cases: [string[], Record<string, unknown>, string][] = [
    [["--limit", "10", "--offset", "116000"], { limit: 10, offset: 116000 }, "--limit, --offset"],
    [["--order-by", "Ort ASC"], { orderBy: "Ort ASC" }, "--order-by"],
    [["--fields", "Ort"], { outFields: "Ort" }, "--fields"],
  ];
  for (const [extra, q, flags] of cases) {
    const { cli, lib: res } = await parity(
      ["--compact", "stations", "--count", ...extra],
      (transport) => new LadesaeulenClient({ transport }).count(q),
      () => jsonResponse({ count: 116343 }),
    );
    assert.equal(cli.code, 2, extra.join(" "));
    assert.equal(cli.requests.length, 0);
    assert.equal(
      cli.err,
      `Error: --count cannot be combined with ${flags}: it counts every match, so paging, sorting and field options do not apply.`,
    );
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.error instanceof LadesaeulenValidationError);
    assert.equal(res.requests.length, 0);
    assert.match(String((res as { error: Error }).error.message), /^Invalid count query: /);
  }
});

test("parity: stations --count with --where and --near sends the same request as count()", async () => {
  const { cli, lib: res } = await parity(
    ["--compact", "stations", "--count", "--where", "Ort='Berlin'", "--near", "52.5,13.4", "--radius", "1"],
    (transport) =>
      new LadesaeulenClient({ transport }).count({ where: "Ort='Berlin'", near: { lat: 52.5, lon: 13.4, radiusKm: 1 } }),
    () => jsonResponse({ count: 116343 }),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.out, "116343");
  assert.ok(res.ok);
  assert.deepEqual(requestShapes(res.requests), requestShapes(cli.requests));
});
