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
- **Retries honour `Retry-After`, but never burst.** A 429/503 is retried up to
  `maxRetries` times, each after `retryDelayMs * attempt` (`retryDelayMs` 0..30 000,
  default 200), or after the response's `Retry-After` (delay-seconds or an IMF-fixdate,
  parsed strictly by `parseRetryAfter`) when that is longer: the header can lengthen a
  wait, never shorten it, so `Retry-After: 0` or a past date doesn't turn the retries
  into a burst. A `Retry-After` above `MAX_RETRY_AFTER_MS` (30 s) is not retried: the
  `LadesaeulenApiError` surfaces at once, with `retryAfterMs` set and a message that
  names the wait (`…; the server asked to retry after 3600 s, longer than the 30 s the
  client waits; not retried — try again after that`). After spent retries the message
  ends `(after N retries)` and `retries` holds the count. Network errors
  (a reset or refused connection, DNS, a timeout) are not retried; they surface at once
  as `LadesaeulenNetworkError` (exit 6).
- **Every transport is held to the same contract** (`engine.ts`), so a custom one (a
  `fetch` adapter, a test double) needs none of it itself: each call runs under the
  overall `timeoutMs` deadline (the request carries an `AbortSignal`,
  `HttpRequest.signal`, that fires then, and the call rejects at the deadline whether
  the transport stops or not); `maxResponseBytes` is checked on the body it returns
  (`Response exceeded the size limit of N bytes (maxResponseBytes; --max-response-bytes
  on the CLI)`); headers may come as a plain record in any case, a `Headers` object or
  a `Map`; the body may be a `Buffer`, any `ArrayBuffer` view or an `ArrayBuffer` (from
  any realm). Whatever else a transport throws or returns — a plain `Error`, a string,
  `null`, a response without a valid status — becomes a `LadesaeulenNetworkError`
  (`GET <url> failed: <reason>`, URL redacted, the original as `cause`).
  `test/conformance-p5-transport-contract.test.ts` checks it.
- **The client validates its own arguments** before any request (not only the CLI):
  `where`/`outFields`/`orderBy` non-blank, `limit` 1..`MAX_LIMIT`, `offset` ≥ 0,
  `near` lat/lon in range and `radiusKm` `MIN_RADIUS_KM`..`MAX_RADIUS_KM`, a single
  non-blank `countBy` field, and no key outside `STATION_QUERY_KEYS` (`where`,
  `outFields`, `limit`, `offset`, `orderBy`, `near`) or `near`'s `lat`/`lon`/`radiusKm`
  — a misspelled `wher`, a `Where` or a `__proto__` from JSON used to be dropped and the
  call answered for every station → `LadesaeulenValidationError`
  (`Invalid <name>: expected <what>, got <value>.`). `count()` also refuses a
  `limit`, `offset`, `orderBy` or `outFields` (`countQueryProblem`, `Invalid count
  query: …`): ArcGIS ignores them next to `returnCountOnly` and returns the full
  total. The CLI's `--count` rewords that error with the flag names.
  The `RequestEngine` constructor (so `new LadesaeulenClient()` too) range-checks its
  numeric options the same way: `timeoutMs` 0..`MAX_TIMEOUT_MS`, `maxRetries`
  0..`MAX_RETRIES` (10), `retryDelayMs` and `maxResponseBytes` non-negative integers
  (`intRangeProblem`); a negative, NaN, infinite or fractional value throws instead
  of silently switching off the timeout or the size cap. The CLI's parsers read the
  same constants.
  It also checks the header values: `userAgent` and every `defaultHeaders` value
  must be non-blank Latin-1 without control characters (tab is fine), and every
  `defaultHeaders` name an HTTP token (`headerValueProblem`/`headerNameProblem`,
  `assertHeaderValue`). `--user-agent` runs the same rule. The default transport
  turns Node's own synchronous header error into a `LadesaeulenNetworkError`.
  The base URL is checked raw, before the trailing-slash strip (`validateBaseUrl`,
  `baseUrlProblem`): blank, unparsable, not `http:`/`https:`, a query or fragment,
  surrounding whitespace (the engine appends request paths to the raw string), or a `%`
  in the user name or password that doesn't start an escape (Node decodes the userinfo
  for the Authorization header and failed at request time with "URI malformed", exit 6;
  a literal `%` is `%25`) is a
  `LadesaeulenValidationError` (`Invalid baseUrl: …`), not a network error.
  `--base-url` runs the same rule. `LadesaeulenNetworkError` stays for the default
  transport's per-hop scheme check and real transport failures.
  **The CLI redacts credentials on output:** `run.ts` (`withRedactedOutput`) takes the
  exact userinfo of every argument (`credentialsIn`, exported) and replaces it with
  `***` in everything it prints — commander's usage errors, which echo rejected values
  (`argument '<url>' is invalid`, `unknown command '<url>'`, `too many arguments … got
  1: <url>`), the help that follows them, and API errors — so a password with spaces,
  quotes, `#`, `?` or `/` is caught as well as an ordinary one. `redactUrl` falls back to
  the same text-based cut (`redactCredentials`) for a value that doesn't parse as a URL.
  `test/conformance-p1-cli-redaction.test.ts` checks ten passwords, seven URL shapes and
  nine argv positions.
  **The library keeps them out too:** the engine holds the base URL in a real `#private`
  field (so `console.log(client)`, `util.inspect` and `JSON.stringify` never show it),
  every error names the request URL through `redactUrl` (`LadesaeulenApiError.url` and
  `.message` read `http://***@host/…`, on the ArcGIS `error` envelope, an HTTP error and
  the POST path alike), and server or transport text that echoes the URL — an error
  body, `detail`, a transport's error message and its `cause` chain — has the userinfo
  (raw and percent-decoded) scrubbed. `test/conformance-p2-library-redaction.test.ts`
  checks the client, nine failing transports and five rejected base URLs.
  Wrong-typed arguments are a `LadesaeulenValidationError` too, never a raw
  `TypeError`: a query that is not an object (`null`/`undefined` mean `{}`), options
  that are not an object, a `transport` or `sleep` that is not a function,
  `defaultHeaders` that is not an object. Messages cut a URL or server text at
  `MAX_MESSAGE_VALUE_LENGTH` (500) characters (`cutForMessage`); `url` and `body` keep
  the full value. `test/conformance-p8-p9-p13-responses-and-errors.test.ts` checks the
  charset, the 2xx shapes and fifteen wrong-typed calls.
  The library owns these rules; the CLI calls the same functions and only turns
  their error into a usage error. `validate.ts` holds the shared pieces: the
  `Problem` type (`(value) => string | undefined`) and `assertValid(name, value,
  problem)`, which throws `LadesaeulenValidationError` (`Invalid <name>: <reason>`).
  A rejected input sends no request; `run.ts` maps the error to exit 2
  (`Error: <message>`). The CLI makes a single-value option given twice a usage error
  (`forbidRepeatedOptions` in `shared.ts`): commander kept the last `--where` silently.
  `test/conformance-p10-strict-filters.test.ts` checks unknown keys, wrong-typed values
  and repeated options.
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
- **Bodies are decoded by their declared charset** (`decodeBody`, `TextDecoder`): UTF-8
  when the Content-Type names none, a leading BOM dropped, an unknown label a
  `LadesaeulenParseError`. A Latin-1 answer keeps its umlauts.
- **Every 2xx reply is checked against its documented shape** before it reaches a
  caller: `stations()`/`countBy()` need a `features` array of objects with `attributes`,
  `count()` a non-negative integer `count`, `fields()` a `fields` array, and `geojson()`
  a `FeatureCollection` with a `features` array of objects. `null`, `{}`, a string or
  an HTML page is a `LadesaeulenParseError` (exit 1), never data or an empty map.
- **Logical errors are HTTP 200 with `{"error":{code,message,details}}`** — the client
  checks for `error` and throws `LadesaeulenApiError` (`arcgisCode` set). This is the
  key correctness point (mirrors the family's HTTP-200-error pattern).
- **`max_electric_power_station` is not per car** (result 01 bug 1 of the 2026-10-05
  review): operators enter the sum of the charge points (Jolt 2 × 160 → 320), the fastest
  point (4 × 22 → 22) or a station limit below the connectors (EnBW 2 × 300 → 150).
  `power.ts` reads each charge point's connector ratings from `Steckersystem_LadepunktN`
  (`… (160 kw)` per line) and derives `max_charge_point_kw` = the fastest rating, capped at
  the station figure (`maxChargePointKw`). The client adds it to every row that carries a
  connector column. `StationQuery.minChargePointKw` (`--min-point-kw`) filters on it: the
  server gets `CAST(max_electric_power_station AS FLOAT) >= n` (exact, because of the cap),
  the client checks the ratings and adds the connector columns to `outFields`; `count()`
  pages through the candidates (2,000 per request, `OBJECTID` order). `test/power.test.ts`
  uses real register rows.
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

- **Zero runtime HTTP deps**; strict TS + ESM; passes on Node 22/24 (`engines` `>=22.12`, the floor of the pinned `commander`).
- **Exit codes** (`run.ts`): help/version → 0; usage → 2; 404 → 4; network → 6; other → 1.
  The bin shim installs `handleOutputErrors()` (`io.ts`) before `run()`: an EPIPE on
  stdout (`| head`) exits 0 quietly, an EPIPE on stderr is ignored so the run's own code
  stands (`test/conformance-p7-pipes-exit-codes.test.ts` runs the built bin).
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
