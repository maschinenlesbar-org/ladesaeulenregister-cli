// Compile-time checks of the exported option types, and their runtime counterpart: an option
// given as `undefined` means its default.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BASE_URL, LadesaeulenClient } from "../src/index.js";
import * as fx from "./fixtures.js";
import { jsonResponse, makeMockTransport } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "ladesaeulenregister-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { LadesaeulenClient, type EngineOptions, type LadesaeulenClientOptions, type StationQuery } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const clientOptions: LadesaeulenClientOptions = allUndefined<LadesaeulenClientOptions>();",
        "export const query: StationQuery = allUndefined<StationQuery>();",
        "export const client = new LadesaeulenClient({ baseUrl: process.env.LADESAEULEN_BASE_URL, timeoutMs: 15_000 });",
        "export const count = (): Promise<number> => client.count({ where: process.env.WHERE, near: undefined });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stations));
  const client = new LadesaeulenClient({
    baseUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.stations({});
  await client.stations({
    where: undefined,
    outFields: undefined,
    limit: undefined,
    offset: undefined,
    orderBy: undefined,
    near: undefined,
    minChargePointKw: undefined,
  });
  const [omitted, undef] = mt.calls;
  assert.ok(omitted !== undefined && undef !== undefined);
  assert.equal(undef.url, omitted.url);
  assert.ok(omitted.url.startsWith(`${DEFAULT_BASE_URL}/0/query?`), omitted.url);
  assert.equal(undef.headers?.["User-Agent"], "ladesaeulenregister-cli");
});
