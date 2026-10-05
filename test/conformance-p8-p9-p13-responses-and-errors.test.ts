// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { LadesaeulenClient as Client } from "../src/client/client.js";
import {
  LadesaeulenError as BaseError,
  LadesaeulenParseError as ParseError,
  LadesaeulenValidationError as ValidationError,
} from "../src/client/errors.js";
import type { StationQuery } from "../src/client/types.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.stations();
const textBody = (text: string): unknown => ({ features: [{ attributes: { Ort: text } }], exceededTransferLimit: false });
const readText = (result: unknown): string =>
  (result as { features: Array<{ attributes: { Ort: string } }> }).features[0]!.attributes.Ort;
/** 2xx bodies the call must reject (empty or wrong shapes; the ArcGIS `error` envelope is an ApiError, tested in client.test.ts). */
const malformedBodies: unknown[] = [
  null, {}, [], "text", 42, { features: "x" }, { features: null }, { features: [1] }, { features: [{}] },
  { features: [{ attributes: null }] },
];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["count([])", () => new Client().count([] as unknown as StationQuery)],
  ["stations('x')", () => new Client().stations("x" as unknown as StationQuery)],
  ["stations({ where: 5 })", () => new Client().stations({ where: 5 as unknown as string })],
  ["stations({ limit: '5' })", () => new Client().stations({ limit: "5" as unknown as number })],
  ["stations({ near: { lat: 'x', lon: 1, radiusKm: 1 } })", () =>
    new Client().stations({ near: { lat: "x" as unknown as number, lon: 1, radiusKm: 1 } })],
  ["stations({ near: null })", () => new Client().stations({ near: null as unknown as StationQuery["near"] })],
  ["countBy(5)", () => new Client().countBy(5 as unknown as string)],
  ["countBy('state', 5)", () => new Client().countBy("state", 5 as unknown as string)],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["defaultHeaders: 'x'", () => new Client({ defaultHeaders: "x" as unknown as Record<string, string> })],
  ["transport: 5", () => new Client({ transport: 5 as unknown as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
