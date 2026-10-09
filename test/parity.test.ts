// CLI <-> library parity: the same input through run() and through the matching
// library call, on one recording mock transport, must give the same outcome —
// both reject with no request sent, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LadesaeulenClient, DEFAULT_LIMIT } from "../src/client/client.js";
import * as lib from "../src/index.js";
import { LadesaeulenValidationError } from "../src/client/errors.js";
import {
  baseUrlProblem,
  countIgnoredOptions,
  countQueryProblem,
  headerNameProblem,
  headerValueProblem,
  intRangeProblem,
} from "../src/client/validate.js";
import { assertHeaderValue, MAX_RETRIES, RequestEngine, validateBaseUrl } from "../src/client/engine.js";
import { MAX_TIMEOUT_MS, nodeHttpTransport } from "../src/client/http.js";
import { LadesaeulenNetworkError } from "../src/client/errors.js";
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
      `ERROR [ladesaeulen.cli] --count cannot be combined with ${flags}: it counts every match, so paging, sorting and field options do not apply.`,
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

// ---- #2 (PAT-8): the engine range-checks its numeric options ----

test("intRangeProblem accepts integers in range and explains anything else", () => {
  const p = intRangeProblem(0, 10);
  for (const ok of [0, 5, 10]) assert.equal(p(ok), undefined, String(ok));
  assert.equal(p(-1), "expected an integer from 0 to 10, got -1.");
  assert.equal(p(11), "expected an integer from 0 to 10, got 11.");
  assert.equal(p(1.5), "expected an integer from 0 to 10, got 1.5.");
  assert.equal(p(Number.NaN), "expected an integer from 0 to 10, got NaN.");
  assert.equal(p(Number.POSITIVE_INFINITY), "expected an integer from 0 to 10, got Infinity.");
  assert.equal(p("3" as unknown as number), 'expected an integer from 0 to 10, got "3".');
});

test("parity: out-of-range --timeout, --max-retries, --max-response-bytes are rejected by both, no request", async () => {
  const cases: [string[], Record<string, number>][] = [
    [["--timeout", "-1"], { timeoutMs: -1 }],
    [["--timeout", String(MAX_TIMEOUT_MS + 1)], { timeoutMs: MAX_TIMEOUT_MS + 1 }],
    [["--max-retries", "11"], { maxRetries: 11 }],
    [["--max-retries", "1.5"], { maxRetries: 1.5 }],
    [["--max-response-bytes", "-1"], { maxResponseBytes: -1 }],
  ];
  for (const [flag, opts] of cases) {
    const { cli, lib: res } = await parity(
      ["--compact", ...flag, "stations", "--count"],
      (transport) => new LadesaeulenClient({ ...opts, transport }).count(),
      () => jsonResponse({ count: 660 }),
    );
    assert.equal(cli.code, 2, flag.join(" "));
    assert.equal(cli.requests.length, 0);
    assert.equal(res.ok, false, flag.join(" "));
    assert.ok(!res.ok && res.error instanceof LadesaeulenValidationError, flag.join(" "));
    assert.equal(res.requests.length, 0);
  }
});

test("the engine rejects NaN, Infinity, fractional and negative numeric options with a validation error", () => {
  const bad: [string, number][] = [
    ["timeoutMs", Number.NaN],
    ["timeoutMs", 1.5],
    ["timeoutMs", 2 ** 31],
    ["maxRetries", Number.POSITIVE_INFINITY],
    ["maxRetries", Number.NaN],
    ["maxRetries", MAX_RETRIES + 1],
    ["retryDelayMs", -1],
    ["retryDelayMs", Number.NaN],
    ["maxResponseBytes", Number.NaN],
    ["maxResponseBytes", 0.5],
  ];
  for (const [name, value] of bad) {
    assert.throws(
      () => new RequestEngine({ [name]: value }),
      (err: unknown) =>
        err instanceof LadesaeulenValidationError && (err as Error).message.startsWith(`Invalid ${name}: expected an integer`),
      `${name}=${value}`,
    );
  }
  assert.equal(
    (() => {
      try {
        new RequestEngine({ timeoutMs: -1 });
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })(),
    `Invalid timeoutMs: expected an integer from 0 to ${MAX_TIMEOUT_MS}, got -1.`,
  );
  // 0 keeps its documented meaning and the maxima are accepted.
  new RequestEngine({ timeoutMs: 0, maxRetries: 0, retryDelayMs: 0, maxResponseBytes: 0 });
  new RequestEngine({ timeoutMs: MAX_TIMEOUT_MS, maxRetries: MAX_RETRIES, maxResponseBytes: Number.MAX_SAFE_INTEGER });
});

test("MAX_RETRIES is 10 and exported from the package root", () => {
  assert.equal(MAX_RETRIES, 10);
  assert.equal(lib.MAX_RETRIES, MAX_RETRIES);
  assert.equal(lib.intRangeProblem, intRangeProblem);
});

// ---- #4 (PAT-5): header values are checked by the library ----

test("headerValueProblem rejects blank, control and non-Latin-1 values; tab and Latin-1 pass", () => {
  assert.equal(headerValueProblem("Grüße\tbot/1"), undefined);
  assert.equal(headerValueProblem("ladesaeulen/1.0"), undefined);
  assert.equal(headerValueProblem(""), "Expected a non-empty value.");
  assert.equal(headerValueProblem("   "), "Expected a non-empty value.");
  assert.equal(headerValueProblem("a\r\nX-Injected: 1"), "Value contains control characters.");
  assert.equal(headerValueProblem("a\u0000b"), "Value contains control characters.");
  assert.equal(headerValueProblem("a\u007fb"), "Value contains control characters.");
  assert.equal(headerValueProblem("日本"), "Value contains characters outside Latin-1 (above U+00FF).");
  assert.equal(headerValueProblem(42 as unknown as string), "Expected a string, got 42.");
});

test("headerNameProblem accepts an HTTP token and rejects anything else", () => {
  assert.equal(headerNameProblem("X-Trace-Id"), undefined);
  assert.equal(headerNameProblem(""), "Expected an HTTP header name (a token), got \"\".");
  assert.equal(headerNameProblem("X Bad"), "Expected an HTTP header name (a token), got \"X Bad\".");
  assert.equal(headerNameProblem("X\r\nY"), "Expected an HTTP header name (a token), got \"X\\r\\nY\".");
});

test("assertHeaderValue returns a good value and throws LadesaeulenValidationError for a bad one", () => {
  assert.equal(assertHeaderValue("userAgent", "bot/1"), "bot/1");
  assert.throws(
    () => assertHeaderValue("userAgent", ""),
    (err: unknown) =>
      err instanceof LadesaeulenValidationError && (err as Error).message === "Invalid userAgent: Expected a non-empty value.",
  );
});

test("parity: a bad --user-agent is rejected by both, no request; a tab and Latin-1 pass on both", async () => {
  for (const ua of ["", "   ", "a\r\nX-Injected: 1", "日本", "a\u007fb"]) {
    const { cli, lib: res } = await parity(
      ["--compact", "--user-agent", ua, "stations", "--count"],
      (transport) => new LadesaeulenClient({ userAgent: ua, transport }).count(),
      () => jsonResponse({ count: 42 }),
    );
    assert.equal(cli.code, 2, JSON.stringify(ua));
    assert.equal(cli.requests.length, 0);
    assert.equal(res.ok, false, JSON.stringify(ua));
    assert.ok(!res.ok && res.error instanceof LadesaeulenValidationError, JSON.stringify(ua));
    assert.equal(res.requests.length, 0);
  }
  const { cli, lib: res } = await parity(
    ["--compact", "--user-agent", "Grüße\tbot/1", "stations", "--count"],
    (transport) => new LadesaeulenClient({ userAgent: "Grüße\tbot/1", transport }).count(),
    () => jsonResponse({ count: 42 }),
  );
  assert.equal(cli.code, 0);
  assert.ok(res.ok);
  assert.deepEqual(requestShapes(res.requests), requestShapes(cli.requests));
});

test("the engine checks every defaultHeaders name and value", () => {
  const bad: Record<string, string>[] = [{ "X-A": "" }, { "X-A": "a\r\nb" }, { "X A": "v" }, { "X-A": "€" }];
  for (const headers of bad) {
    assert.throws(() => new RequestEngine({ defaultHeaders: headers }), LadesaeulenValidationError, JSON.stringify(headers));
  }
  new RequestEngine({ defaultHeaders: { "X-Trace-Id": "abc\t1" } });
});

test("nodeHttpTransport rejects a header Node refuses with LadesaeulenNetworkError, not a raw TypeError", async () => {
  await assert.rejects(
    () =>
      nodeHttpTransport({ method: "GET", url: "http://127.0.0.1:9/x", headers: { "User-Agent": "a\r\nb" } }),
    (err: unknown) => err instanceof LadesaeulenNetworkError && (err as Error).cause instanceof TypeError,
  );
});

test("the header checks are exported from the package root", () => {
  assert.equal(lib.assertHeaderValue, assertHeaderValue);
  assert.equal(lib.headerValueProblem, headerValueProblem);
  assert.equal(lib.headerNameProblem, headerNameProblem);
});

// ---- #5 (PAT-1): a base URL with surrounding whitespace ----

test("baseUrlProblem rejects surrounding whitespace", () => {
  assert.equal(baseUrlProblem("https://h.example/fs"), undefined);
  for (const raw of ["https://h.example/fs ", "https://h.example/fs/ ", " https://h.example/fs", "https://h.example/fs\n"]) {
    assert.equal(baseUrlProblem(raw), "A base URL cannot have surrounding whitespace.", JSON.stringify(raw));
  }
});

test("validateBaseUrl checks the raw value and returns it without trailing slashes", () => {
  assert.equal(validateBaseUrl("https://h.example/fs///"), "https://h.example/fs");
  assert.throws(
    () => validateBaseUrl("https://h.example/fs/ "),
    (err: unknown) =>
      err instanceof LadesaeulenValidationError &&
      (err as Error).message === "Invalid baseUrl: A base URL cannot have surrounding whitespace.",
  );
});

test("parity: a base URL with surrounding whitespace is rejected by both, no request", async () => {
  for (const baseUrl of ["https://h.example/fs ", "https://h.example/fs/ ", " https://h.example/fs"]) {
    const { cli, lib: res } = await parity(
      ["--compact", "--base-url", baseUrl, "stations", "--count"],
      (transport) => new LadesaeulenClient({ baseUrl, transport }).count(),
      () => jsonResponse({ count: 42 }),
    );
    assert.equal(cli.code, 2, JSON.stringify(baseUrl));
    assert.equal(cli.requests.length, 0);
    assert.match(cli.err, /A base URL cannot have surrounding whitespace\./);
    assert.equal(res.ok, false, JSON.stringify(baseUrl));
    assert.ok(!res.ok && res.error instanceof LadesaeulenValidationError);
    assert.equal(res.requests.length, 0);
  }
  const { cli, lib: res } = await parity(
    ["--compact", "--base-url", "https://h.example/fs/", "stations", "--count"],
    (transport) => new LadesaeulenClient({ baseUrl: "https://h.example/fs/", transport }).count(),
    () => jsonResponse({ count: 42 }),
  );
  assert.equal(cli.code, 0);
  assert.ok(res.ok);
  assert.deepEqual(requestShapes(res.requests), requestShapes(cli.requests));
});

// ---- #6 (PAT-2): a malformed base URL is a validation error, not a network error ----

test("baseUrlProblem names every malformed shape with the CLI's wording", () => {
  const cases: [string, string][] = [
    ["", "Expected a non-empty value."],
    ["   ", "Expected a non-empty value."],
    ["not a url", "Expected a valid URL (e.g. https://host/path)."],
    ["ftp://example.org/fs", "Only http: and https: base URLs are supported."],
    ["file:///etc/x", "Only http: and https: base URLs are supported."],
    ["https://h.example/fs?x=1", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://h.example/fs#f", "A base URL cannot have a query (?) or fragment (#)."],
  ];
  for (const [raw, reason] of cases) assert.equal(baseUrlProblem(raw), reason, JSON.stringify(raw));
  assert.equal(baseUrlProblem(42 as unknown as string), "Expected a string, got 42.");
  assert.equal(baseUrlProblem("http://127.0.0.1:1/mirror/fs/"), undefined);
});

test("parity: a malformed base URL is rejected by both as a validation error, no request", async () => {
  for (const baseUrl of ["ftp://example.org/fs", "https://h.example/fs?x=1", "https://h.example/fs#f", "not a url", "", "   ", "file:///etc/x"]) {
    const { cli, lib: res } = await parity(
      ["--compact", "--base-url", baseUrl, "stations", "--count"],
      (transport) => new LadesaeulenClient({ baseUrl, transport }).count(),
      () => jsonResponse({ count: 42 }),
    );
    assert.equal(cli.code, 2, JSON.stringify(baseUrl));
    assert.equal(cli.requests.length, 0);
    assert.equal(res.ok, false, JSON.stringify(baseUrl));
    const error = (res as { error: unknown }).error;
    assert.ok(error instanceof LadesaeulenValidationError, JSON.stringify(baseUrl));
    assert.ok(!(error instanceof LadesaeulenNetworkError));
    assert.equal((error as Error).message, `Invalid baseUrl: ${baseUrlProblem(baseUrl)}`);
    assert.match(cli.err, new RegExp(baseUrlProblem(baseUrl)!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(res.requests.length, 0);
  }
});

test("parity: count-by with a field that is no single column name is a usage error in both, nothing sent (B05-1)", async () => {
  const { cli, lib: res } = await parity(
    ["count-by", "Ort\nx"],
    (transport) => new LadesaeulenClient({ transport }).countBy("Ort\nx"),
    () => jsonResponse(fx.countByState),
  );
  assert.equal(cli.code, 2);
  assert.equal(cli.requests.length, 0);
  assert.equal(cli.err, 'ERROR [ladesaeulen.cli] Invalid field: expected one column name (letters, digits and _), got "Ort\\nx".');
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.error instanceof LadesaeulenValidationError);
  assert.equal(res.requests.length, 0);
});
