// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { LadesaeulenClient as Client } from "../src/client/client.js";
import { LadesaeulenValidationError as ValidationError } from "../src/client/errors.js";
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> => client.stations(query as never);
/** A valid query, and the filter it sends (read back from the request by `sentFilter`). */
const GOOD = { query: { where: "Ort='Berlin' AND Typ='Schnellladeeinrichtung'" } };
const GOOD_SENT = "Ort='Berlin' AND Typ='Schnellladeeinrichtung'";
/** What a data request carries as its filter (to compare with GOOD_SENT). */
const sentFilter = (req: HttpRequest): string | null => new URL(req.url).searchParams.get("where");
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { Ort: "Berlin" }],
  ["misspelled key", { wher: "Ort='Berlin'" }],
  ["wrong-case key", { Where: "Ort='Berlin'" }],
  ["__proto__ key", JSON.parse('{"__proto__": {"where": "Ort=\'Berlin\'"}}') as Record<string, unknown>],
  ["misspelled near key", { near: { lat: 52.5, lng: 13.4, radiusKm: 1 } }],
];
/**
 * Queries whose filter names the API doesn't have. Not applicable here: the filter is
 * free Esri SQL, and ArcGIS itself rejects an unknown column (`Ort2='x'`, `__proto__=1`)
 * with error 400, which the client raises as LadesaeulenApiError (exit 1) — nothing is
 * silently dropped (result 01, session note 8). client.test.ts covers the error envelope.
 */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [];
/** Values of the wrong type: arrays where the API takes one value, NaN, objects. */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["array where", { where: ["Ort='Berlin'", "Typ='Schnellladeeinrichtung'"] }],
  ["object where", { where: { Ort: "Berlin" } }],
  ["NaN limit", { limit: Number.NaN }],
  ["NaN offset", { offset: Number.NaN }],
  ["array limit", { limit: [1, 2] }],
  ["NaN radius", { near: { lat: 52.5, lon: 13.4, radiusKm: Number.NaN } }],
];
/**
 * Queries that differ from GOOD only in how a filter name is spelled. Not applicable: column
 * names live inside the SQL text, which goes out as written, and ArcGIS resolves them itself
 * (an unknown spelling is its error 400, not an ignored filter).
 */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [];
const UNNORMALISED_POLICY = "normalise" as "normalise" | "reject";
/** The CLI's filter flag given twice (the two halves of GOOD), and what the repo does with it. */
const REPEATED_FLAG_ARGV = ["stations", "--count", "--where", "Ort='Berlin'", "--where", "Typ='Schnellladeeinrichtung'"];
const REPEATED_POLICY = "reject" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["stations", "--limit", "5", "--limit", "10"];
const USAGE_EXIT = 2;
/** True for a request that fetches data (every request here does). */
const isDataRequest = (_req: HttpRequest): boolean => true;
/** The answer to any request. */
const respond = (_req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: Buffer.from(JSON.stringify({ features: [], exceededTransferLimit: false, count: 0 })),
});
/** CliDeps for this repo. */
const makeDeps = (io: CliDeps["io"], transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io,
  createClient: (opts) => new Client({ ...opts, transport }),
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
