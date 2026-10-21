import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "@maschinenlesbar.org/ladesaeulenregister-client/internal/validate";
import { LadesaeulenError, LadesaeulenValidationError } from "@maschinenlesbar.org/ladesaeulenregister-client/internal/errors";
import * as lib from "../src/index.js";
import { run } from "../src/cli/run.js";
import { LadesaeulenClient } from "@maschinenlesbar.org/ladesaeulenregister-client/internal/client";
import type { CliDeps } from "../src/cli/io.js";
import { jsonResponse, makeMockTransport, parity, requestShapes, untimed } from "./helpers.js";

const notFoo: Problem<string> = (v) => (v === "foo" ? "Must not be foo." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("thing", "bar", notFoo), "bar");
});

test("assertValid throws LadesaeulenValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("thing", "foo", notFoo),
    (err: unknown) => {
      assert.ok(err instanceof LadesaeulenValidationError);
      assert.ok(err instanceof LadesaeulenError);
      assert.equal((err as Error).name, "LadesaeulenValidationError");
      assert.equal((err as Error).message, "Invalid thing: Must not be foo.");
      return true;
    },
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.LadesaeulenValidationError, LadesaeulenValidationError);
  assert.equal(lib.assertValid, assertValid);
});

function cliWith(createClient: CliDeps["createClient"]) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, createClient };
  return { deps, out, err };
}

test("run() maps a LadesaeulenValidationError from an action to the usage exit code 2 and an ERROR record", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const cli = cliWith((opts) => {
    const client = new LadesaeulenClient({ ...opts, transport: mt.transport });
    client.fields = async () => {
      throw new LadesaeulenValidationError("Invalid thing: Must not be foo.");
    };
    return client;
  });
  const code = await run(["fields"], cli.deps);
  assert.equal(code, 2);
  assert.deepEqual(cli.out, []);
  assert.equal(untimed(cli.err.join("\n")), "ERROR [ladesaeulen.cli] Invalid thing: Must not be foo.");
  assert.equal(mt.calls.length, 0);
});

test("run() maps a LadesaeulenValidationError thrown while building the client the same way", async () => {
  const cli = cliWith(() => {
    throw new LadesaeulenValidationError("Invalid timeoutMs: Must be >= 0.");
  });
  assert.equal(await run(["fields"], cli.deps), 2);
  assert.equal(untimed(cli.err.join("\n")), "ERROR [ladesaeulen.cli] Invalid timeoutMs: Must be >= 0.");
});

test("parity() drives the same input through run() and the library on one transport", async () => {
  const fields = { fields: [{ name: "Ort", type: "esriFieldTypeString", alias: "Ort" }] };
  const { cli, lib: res } = await parity(
    ["--compact", "fields"],
    (transport) => new LadesaeulenClient({ transport }).fields(),
    () => jsonResponse(fields),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.out, JSON.stringify(fields.fields));
  assert.ok(res.ok);
  assert.deepEqual(res.value, fields.fields);
  assert.deepEqual(requestShapes(cli.requests), requestShapes(res.requests));
});

test("a refused value shows its invisible and control characters escaped, never raw (D10)", async () => {
  // A zero-width space, a bidi override and a soft hyphen in a group field: the refusal used to
  // print them raw, so the quoted value looked like a valid column name.
  for (const [field, escape] of [["Ort​", "\\u200b"], ["Ort‮", "\\u202e"], ["Stra­ße", "\\u00ad"]] as const) {
    const o = await parity(["count-by", field], (t) => new LadesaeulenClient({ transport: t }).countBy(field));
    assert.equal(o.cli.code, 2, field);
    assert.ok(o.cli.err.includes(escape) && !o.cli.err.includes(field), `${JSON.stringify(field)}: ${o.cli.err}`);
    assert.equal(o.lib.ok, false);
    const message = (o.lib as { error: Error }).error.message;
    assert.ok(message.includes(escape) && !message.includes(field), message);
  }
  // A long value is cut at 500 characters, the "…" after the closing quote.
  const long = `${"x".repeat(600)} y`;
  await assert.rejects(new LadesaeulenClient({ transport: makeMockTransport(() => jsonResponse({})).transport }).countBy(long), (err: Error) =>
    err.message.includes(`"${"x".repeat(500)}"…`));
});
