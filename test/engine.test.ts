import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, MAX_GET_URL_LENGTH, parseRetryAfter } from "../src/client/engine.js";
import { LadesaeulenApiError, LadesaeulenNetworkError, LadesaeulenParseError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

test("buildUrl appends the path and query string", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/FeatureServer/" });
  assert.equal(e.buildUrl("/0/query", { where: "1=1" }), "https://example.test/FeatureServer/0/query?where=1%3D1");
  assert.equal(e.buildUrl("0"), "https://example.test/FeatureServer/0");
});

test("getJson performs a GET with query params and the User-Agent/Accept headers", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stations));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/0/query", { where: "1=1", f: "json" });
  const req = mt.last();
  assert.equal(req.method, "GET");
  assert.equal(req.headers?.["Accept"], "application/json");
  assert.equal(req.headers?.["User-Agent"], "ua/1");
  assert.equal(queryOf(req).get("where"), "1=1");
});

test("getJson parses and returns the JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stations));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/0/query"), fx.stations);
});

test("getJson returns null on an empty/204 body", async () => {
  const mt = makeMockTransport(() => rawResponse("", "application/json", 204));
  const e = new RequestEngine({ transport: mt.transport });
  assert.equal(await e.getJson("/x"), null);
});

test("getJson throws LadesaeulenParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), LadesaeulenParseError);
});

test("a non-2xx surfaces as a LadesaeulenApiError with the parsed error.message", async () => {
  const mt = makeMockTransport(() => jsonResponse({ error: { message: "kaputt" } }, 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof LadesaeulenApiError && err.status === 400 && /kaputt/.test(err.message),
  );
});

test("a non-JSON (plain-text) error body is surfaced as the detail", async () => {
  const mt = makeMockTransport(() => rawResponse("Service temporarily down", "text/plain", 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof LadesaeulenApiError && err.status === 500 && /Service temporarily down/.test(err.message),
  );
});

// Control characters are built via char codes so no raw control byte ever appears
// in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1 = String.fromCharCode(0x9b); // a C1 control (CSI)

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f));
  });
}

test("a JSON error detail is stripped of terminal control characters", async () => {
  const evil = `boom${ESC}[31mred${BEL}${C1}2J`;
  const mt = makeMockTransport(() => jsonResponse({ error: { message: evil } }, 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => {
      assert.ok(err instanceof LadesaeulenApiError);
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("a non-JSON error snippet is stripped of terminal control characters", async () => {
  const evil = `down${ESC}]0;pwned${BEL}`;
  const mt = makeMockTransport(() => rawResponse(evil, "text/plain", 502));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => {
      assert.ok(err instanceof LadesaeulenApiError);
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      return true;
    },
  );
});

test("a 503 is retried up to maxRetries then surfaces as a LadesaeulenApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ error: { message: "busy" } }, 503);
  });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(() => e.getJson("/x"), (err) => err instanceof LadesaeulenApiError && err.status === 503);
  assert.equal(calls, 3);
});

test("the engine rejects a non-http(s) base URL before any request, even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.stations));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof LadesaeulenNetworkError && /Unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("the engine rejects an unparseable base URL", () => {
  assert.throws(() => new RequestEngine({ baseUrl: "not a url" }), LadesaeulenNetworkError);
});

test("a query whose GET URL would exceed MAX_GET_URL_LENGTH goes out as a form POST", async () => {
  const mt = makeMockTransport(() => jsonResponse({ count: 4956 }));
  const e = new RequestEngine({ transport: mt.transport, baseUrl: "https://example.test/FS" });
  const where = `Ort IN ('Berlin'${Array.from({ length: 200 }, (_, i) => `,'X${String(i).padStart(4, "0")}'`).join("")})`;
  assert.ok(e.buildUrl("/0/query", { where, f: "json" }).length > MAX_GET_URL_LENGTH);
  assert.deepEqual(await e.getJson("/0/query", { where, f: "json", returnCountOnly: true }), { count: 4956 });
  const req = mt.last();
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://example.test/FS/0/query");
  assert.equal(req.headers?.["Content-Type"], "application/x-www-form-urlencoded");
  const body = String(req.body);
  assert.equal(req.headers?.["Content-Length"], String(Buffer.byteLength(body)));
  const form = new URLSearchParams(body);
  assert.equal(form.get("where"), where);
  assert.equal(form.get("f"), "json");
  assert.equal(form.get("returnCountOnly"), "true");
});

test("a short query stays a GET without a body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ count: 1 }));
  const e = new RequestEngine({ transport: mt.transport });
  await e.getJson("/0/query", { where: "Ort='Berlin'", f: "json" });
  assert.equal(mt.last().method, "GET");
  assert.equal(mt.last().body, undefined);
  assert.equal(mt.last().headers?.["Content-Type"], undefined);
});

test("an HTTP error on a POSTed query names POST and the bare URL", async () => {
  const mt = makeMockTransport(() => jsonResponse({ error: { message: "nope" } }, 400));
  const e = new RequestEngine({ transport: mt.transport, baseUrl: "https://example.test/FS" });
  await assert.rejects(
    () => e.getJson("/0/query", { where: "x".repeat(3000) }),
    (err) => err instanceof LadesaeulenApiError && err.message === "HTTP 400 for POST https://example.test/FS/0/query: nope",
  );
});

function retryingEngine(retryAfter: string | undefined) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => {
    const res = jsonResponse({ error: { message: "slow down" } }, 429);
    if (retryAfter !== undefined) res.headers["retry-after"] = retryAfter;
    return res;
  });
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 waits the Retry-After seconds before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("1");
  await assert.rejects(() => engine.getJson("/x"), (err) => err instanceof LadesaeulenApiError && err.status === 429);
  assert.deepEqual(delays, [1000, 1000]);
  assert.equal(mt.calls.length, 3);
});

test("a malformed Retry-After falls back to the linear backoff", async () => {
  for (const bad of ["-1", "1.5", "+5", "1e3", "0x10", "soon", "2026-10-21T07:28:00Z", ""]) {
    const { engine, delays } = retryingEngine(bad);
    await assert.rejects(() => engine.getJson("/x"), LadesaeulenApiError);
    assert.deepEqual(delays, [200, 400], bad);
  }
});

test("a Retry-After beyond MAX_RETRY_AFTER_MS is not retried", async () => {
  for (const long of ["31", "99999999999", "Wed, 21 Oct 2099 07:28:00 GMT"]) {
    const { engine, mt, delays } = retryingEngine(long);
    await assert.rejects(() => engine.getJson("/x"), (err) => err instanceof LadesaeulenApiError && err.status === 429);
    assert.equal(mt.calls.length, 1, long);
    assert.deepEqual(delays, [], long);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates only", () => {
  const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  assert.equal(parseRetryAfter("5", now), 5000);
  assert.equal(parseRetryAfter([" 7 ", "9"], now), 7000);
  assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:28:10 GMT", now), 10_000);
  assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:27:00 GMT", now), 0);
  assert.equal(parseRetryAfter("Wednesday, 21-Oct-26 07:28:10 GMT", now), undefined);
  assert.equal(parseRetryAfter(undefined, now), undefined);
});

test("the engine rejects a base URL with a query or fragment", () => {
  for (const baseUrl of ["https://example.test/fs?x=1", "https://example.test/fs#f"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (err) => err instanceof LadesaeulenNetworkError && err.message === `Base URL must not contain a query or fragment: ${baseUrl}`,
    );
  }
});
