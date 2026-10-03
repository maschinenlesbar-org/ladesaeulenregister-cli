# Developing `ladesaeulenregister-cli`

Architecture, testing, and the ArcGIS specifics of the Bundesnetzagentur
Ladesäulenregister. Read this before changing the client or CLI.

## What this is

A typed client + CLI over the Ladesäulenregister's public **ArcGIS FeatureServer**
(layer 0 = charging stations), part of the `*-cli` family. It follows the shared
two-layer blueprint (a dependency-free `client/` usable as a library, and a commander
`cli/` over it) with the family's two test seams.

## Commands

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # pretest builds, then `node --test dist/test/*.test.js`
npm start -- --help
```

## Layout

```
src/
  client/        # typed API client, usable independently of the CLI
    types.ts     # Feature / ArcGIS query envelope / ChargingStation / query types
    query.ts     # dependency-free query-string builder
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building, GET (POST for long queries), retry/backoff, JSON decode, HTTP-error mapping
    errors.ts    # LadesaeulenError / …ApiError / …NetworkError / …ValidationError / …ParseError
    validate.ts  # Problem type + assertValid(): the library's input rules, shared with the CLI
    client.ts    # LadesaeulenClient (stations / count / geojson / countBy / fields)
    index.ts
  cli/
    io.ts        # injectable I/O (CliDeps / CliIO) — no env seam (no auth)
    shared.ts    # option parsers (incl. --near lat,lon), global->engine mapping, render
    commands/stations.ts  # stations / count-by / fields
    program.ts   # assembles the commander program
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
  index.ts       # library entry
```

## THE thing to know: the documented endpoint is dead

The bund.dev spec (`bundesAPI/ladestationen-api`) points at
`services6.arcgis.com/6jU7RmJig2Wwo1b0/…/Ladesaeulenregister/FeatureServer/7` — which
now returns **`{"error":{"code":499,"message":"Token Required"}}` on every layer**
(private). The live public data moved to a different ArcGIS org. The current endpoint
(found by tracing the live Ladesäulenkarte Experience Builder app → its web maps →
operational layers) is:

```
https://services-eu1.arcgis.com/TJm8oSvOdJUQvQT5/arcgis/rest/services/Ladesaeulen/FeatureServer/0
```

116,343 charging stations on 2026-09-15, anonymous. This is the `DEFAULT_BASE_URL` (the
`/FeatureServer` part; the client appends `/0`). If it moves again, override
`--base-url` and re-trace the map app.

## ArcGIS specifics (all live-verified)

- Standard Esri `/query`: `where` (SQL), `outFields`, `resultRecordCount`/
  `resultOffset` (paging), `orderByFields`, `f` (`json`|`geojson`), `returnCountOnly`,
  `outStatistics`+`groupByFieldsForStatistics` (used by `countBy`), and geometry
  params (`geometry`/`geometryType`/`inSR`/`distance`/`units`/`spatialRel`) for `--near`.
- **Retries honour `Retry-After`.** A 429/503 is retried up to `maxRetries` times, each
  after the response's `Retry-After` (delay-seconds or an IMF-fixdate, parsed strictly by
  `parseRetryAfter`), else after `retryDelayMs * attempt`. A `Retry-After` above
  `MAX_RETRY_AFTER_MS` (30 s) is not retried: the error surfaces at once.
- **The client validates its own arguments** before any request (not only the CLI):
  `where`/`outFields`/`orderBy` non-blank, `limit` 1..`MAX_LIMIT`, `offset` ≥ 0,
  `near` lat/lon in range and `radiusKm` `MIN_RADIUS_KM`..`MAX_RADIUS_KM`, a single
  non-blank `countBy` field → `LadesaeulenValidationError`
  (`Invalid <name>: expected <what>, got <value>.`).
  The library owns these rules; the CLI calls the same functions and only turns
  their error into a usage error. `validate.ts` holds the shared pieces: the
  `Problem` type (`(value) => string | undefined`) and `assertValid(name, value,
  problem)`, which throws `LadesaeulenValidationError` (`Invalid <name>: <reason>`).
  A rejected input sends no request; `run.ts` maps the error to exit 2
  (`Error: <message>`).
- **The library owns the request defaults.** `stations()`/`geojson()` send `where=1=1`,
  `outFields=DEFAULT_FIELDS` and `resultRecordCount=DEFAULT_LIMIT` (50) when the query
  leaves them out; without a page size the server would send its cap of about 2000
  rows. `count()` sends no page size. The CLI passes `--limit` only when given and
  reads `DEFAULT_LIMIT` for its help text and truncation note.
- **Long queries go as a POST.** ArcGIS Online answers a GET URL of about 2.9 KB with a
  misleading HTTP 404 (and above about 20 KB with 414). `/query` takes the same parameters
  as an `application/x-www-form-urlencoded` POST body, so the engine switches to a POST to
  the bare path once the GET URL would pass `MAX_GET_URL_LENGTH` (2,000 characters;
  `requestTarget()` decides, and error messages name the method actually used).
- **Logical errors are HTTP 200 with `{"error":{code,message,details}}`** — the client
  checks for `error` and throws `LadesaeulenApiError` (`arcgisCode` set). This is the
  key correctness point (mirrors the family's HTTP-200-error pattern).
- The layer has ~60 columns incl. per-charge-point connector fields and a large
  `F_response_body` JSON blob → the client ships a **curated `DEFAULT_FIELDS`**; the
  CLI's `--fields '*'` returns everything.
- Coordinates are in `coordinates_latitude`/`coordinates_longitude` (and the geometry).
  `stations()` requests `returnGeometry=false` for lean JSON; `--geojson` returns full
  geometry.

## Testing

`node --test` on `dist/test/`. Coverage highlights (`client.test.ts`): the full param
mapping (where/outFields/paging), `returnCountOnly`, the ArcGIS `error` envelope
throwing, `countBy` (outStatistics group-by → `{value,count}`), and the `--near`
geometry params. `cli.test.ts` covers the three commands, `--near`/`--radius`
validation, and the hardening guards (control-char UA, empty base URL, bounded retries).
Parity tests use `parity()` from `test/helpers.ts`: it runs one input through `run()`
and through the matching library call on one recording mock transport, so a test
asserts that both reject with no request sent, or both send the identical request.

## Conventions to keep

- **Zero runtime HTTP deps**; strict TS + ESM; passes on Node 20/22/24.
- **Exit codes** (`run.ts`): help/version → 0; usage → 2; 404 → 4; network → 6; other → 1.
- **Scaffold origin:** scaffolded from `marktstammdatenregister-cli` (GET + query,
  no auth); adapted for the ArcGIS `/query` semantics and the `error` envelope.

## Website

The project website — <https://maschinenlesbar-org.github.io/ladesaeulenregister-cli/> in
English and <https://maschinenlesbar-org.github.io/ladesaeulenregister-cli/de/> in German — is
built from `site/` with [Jekyll](https://jekyllrb.com/),
[banira](https://sebs.github.io/banira/) web components and [Fylgja](https://fylgja.dev/) CSS,
and deployed by `docs.yml` together with the TypeDoc API reference under `/api/`. Its content
comes from this repository: the README intro and quick start, the command tree of the built CLI
(`site/scripts/cli-reference.mjs`), `Usage.md`, `GLOSSARY.md` and its German version
`GLOSSARY.de.md`, the skills, and the skill examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The
only repo-specific files are `site/_config.yml` and `site/_data/project.yml` (the German intro
and the access requirements); the rest of `site/` is identical in every maschinenlesbar.org
CLI, so change it in all of them together. When the README intro changes, update the German
intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/ladesaeulenregister-cli/
```
