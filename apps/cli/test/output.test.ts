// The output sink (src/cli/output.ts): how an answer is printed — control characters escaped,
// a deep or huge answer printed (or refused) cleanly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/output.js";
import type { CliDeps } from "../src/cli/io.js";
import { LadesaeulenClient } from "@maschinenlesbar.org/ladesaeulenregister-client/internal/client";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/ladesaeulenregister-client/internal/http";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";
import * as fx from "@maschinenlesbar.org/ladesaeulenregister-client/test/fixtures";

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse(fx.stations)) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(untimed(s)) },
    createClient: (opts) => new LadesaeulenClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26) and the stack:
  // probed here, never assumed.
  const depth = 200_000;
  const body = `{"features":[{"attributes":{"ID":"1","x":${"[".repeat(depth)}${"]".repeat(depth)}}}]}`;
  let compactPrints = true;
  try {
    JSON.stringify(JSON.parse(body));
  } catch {
    compactPrints = false;
  }
  const answer = () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(body) });
  const pretty = makeCli(answer);
  assert.equal(await run(["stations"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.deepEqual(pretty.err, [
    `ERROR [ladesaeulen.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  ]);
  const compact = makeCli(answer);
  assert.equal(await run(["--compact", "stations"], compact.deps), compactPrints ? 0 : 1);
  if (!compactPrints) assert.deepEqual(compact.err, ["ERROR [ladesaeulen.output] The answer is nested too deeply to print."]);
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli();
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli();
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("printed JSON escapes DEL, C1 and the bidi controls, which JSON.stringify leaves raw", async () => {
  const name = "Ein \u001b[31mrotes\u009b\u007f Ort \u202e\u061c\u200e\u200f\u202a\u2066\u2069 Ende";
  const cli = makeCli(() => jsonResponse({ features: [{ attributes: { ID: "1", Ort: name } }] }));
  assert.equal(await run(["--compact", "stations"], cli.deps), 0);
  const printed = cli.out.join("\n");
  assert.doesNotMatch(printed, /[\u001b\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  assert.match(printed, /\\u202e\\u061c\\u200e\\u200f\\u202a\\u2066\\u2069/);
  assert.equal((JSON.parse(printed) as { features: Array<{ attributes: { Ort: string } }> }).features[0]?.attributes.Ort, name);
});
