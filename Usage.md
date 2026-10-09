# Usage

`ladesaeulen` — a CLI for the Bundesnetzagentur Ladesäulenregister. No API key needed.
The register lists the stations whose operators have completed the BNetzA's notification
procedure, so counts are "listed in the register", not every public charger in Germany.

```bash
ladesaeulen [global options] <command> [command options]
```

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | API base URL (the ArcGIS FeatureServer); `http:`/`https:` only, no query (`?`), fragment (`#`) or surrounding whitespace, and a `%` in a user name or password must be an escape (write a literal `%` as `%25`); anything else is a usage error (exit 2) before any request. A plain `http:` URL to a non-loopback host (not `localhost`, `127.0.0.0/8`, `::1`) gets one `WARN` record of `ladesaeulen.http` (`… sent unencrypted (http:, not https:)`) on stderr naming the host (and the URL's credentials, never printed); stdout and the exit code are unchanged. A `user:password@` in it is sent as Basic auth and shown as `***@` in every message; echoed back by a server (the `Basic` value, `user:password`, the password), it is shown as `***` |
| `--timeout <ms>` | time limit per request in ms, whole response included (default 30000 = 30 s; 0 = no timeout; at most 2147483647) |
| `--user-agent <ua>` | User-Agent header value (not blank; Latin-1 text without control characters) |
| `--max-retries <n>` | retries for transient 429/503 responses and reset connections (0..10, default 2). Each retry backs off 200 ms, 400 ms, …, or waits the server's `Retry-After` (seconds or an HTTP-date) when that is longer; a `Retry-After` above 30 s is not retried — the error is reported at once and names the wait the server asked for. A connection reset mid-request (`socket hang up`, `ECONNRESET`, a body cut off mid-way) is retried the same way, with the linear backoff, for a GET (a long `--where` sent as a form POST is not re-sent); a run that recovers exits 0. A status or reset that persists ends the message with `(after N retries)`. Other network errors (a refused connection, DNS, a timeout) are not retried |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line (for piping to `jq`) |
| `--log-format <format>` | how errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [ladesaeulen.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `-V, --version` / `-h, --help` | version / help |

## Commands

### `stations` — search charging stations

| Option | Description |
|---|---|
| `--where <sql>` | SQL filter, e.g. `"Ort='Berlin' AND Typ='Schnellladeeinrichtung'"` |
| `--limit <n>` | max rows per request (1..10000, default 50). The server returns **at most ~2000** — page the rest with `--offset` |
| `--offset <n>` | rows to skip (paging) |
| `--order-by <spec>` | sort, e.g. `"Ort ASC"` or `"CAST(max_electric_power_station AS FLOAT) DESC"` (power is a text column; without the cast it sorts as text) |
| `--fields <list>` | comma-separated field list, or `'*'` for all |
| `--near <lat,lon>` | only stations near this WGS84 point (needs `--radius`) |
| `--radius <km>` | search radius in km for `--near`: a plain decimal from `0.001` (1 m) to `1000` |
| `--min-point-kw <kW>` | only stations where **one charge point** can deliver at least this many kW (a plain decimal above 0, at most 10000). Read from the connector ratings in `Steckersystem_Ladepunkt1..10`, capped at the station figure; each row gets the derived `max_charge_point_kw`, and the connector columns are added to `--fields`. The server filters on the station figure and the CLI on the ratings, so a page can be shorter than `--limit`; with `--count` the CLI reads every candidate, one request per 2,000 |
| `--count` | print only the number of matching stations (all of them: combine it with `--where` and `--near`/`--radius`; with `--limit`, `--offset`, `--order-by`, `--fields` or `--geojson` it is a usage error) |
| `--geojson` | output a GeoJSON FeatureCollection instead of ArcGIS JSON |

Default output is `{ features, exceededTransferLimit }` — `exceededTransferLimit:
true` means more matched than were returned (the server caps a page at ~2000 rows).
The CLI prints a stderr note in that case, saying whether your `--limit` or the server's
cap cut the page; page with `--offset`, raise `--limit` or narrow `--where`.
`--geojson` gets the same note: there the server puts the flag in the FeatureCollection's
`properties.exceededTransferLimit`. A reply that is not a FeatureCollection with a
`features` array (a gateway's `{}`, `features: null`) is an error (exit 1), not an empty
map.

### `count-by <field>` — grouped counts

`ladesaeulen count-by state` → `[{ value, count }, …]`, sorted by count desc. Add
`--where` to aggregate a subset. It groups by **one** field: a comma-separated list
(`state,Typ`) is a usage error — group by one field and fix the other with `--where`
(`count-by state --where "Typ='Schnellladeeinrichtung'"`). Good fields: `state`, `Typ`, `operator_companyName`, `Ort`
(`Betreiber` is `null` on more than half of the stations). The result stops at 2,000
groups (the server's page limit; the CLI then prints a stderr note); the top groups are
still correct because the server sorts by count first.

### `info` — how current the data is

`ladesaeulen info` → `{ name, lastEditDate, dataLastEditDate, maxRecordCount }`, the
layer's own metadata; the dates are ISO 8601 UTC (`"2026-10-01T13:53:22.139Z"`). The register
is a snapshot, refreshed irregularly, and no row carries an as-of date (`documentDate` is
always empty), so cite `dataLastEditDate` with an answer.

### `fields` — list queryable columns

`ladesaeulen fields` → `[{ name, type, alias }, …]`. Use it to build `--where`,
`--fields` and `count-by`. Sixteen of the listed columns are `null` on every row (the
`evses_*` per-connector columns, `documentDate`, `documentTime`, `json_type`,
`Steckersystem_Ladepunkt7..10`; see GLOSSARY.md): `fields` names them on stderr, and
`stations`/`count-by` log an `INFO` record (`… is empty on every row`) when a filter, sort,
field list or group names one, since its `0` or single `null` group is not an answer.

## The `--where` filter

Standard Esri SQL over the layer's columns:

- strings are **single-quoted**: `Ort='Berlin'`, `state='Bayern'`. Text comparisons
  **ignore case**, with `=` and `LIKE` alike: `Ort='berlin'` counts the same 4,996
  stations as `Ort='Berlin'` (2026-10-06), so retrying with another casing finds nothing
  new, and case cannot tell two values apart
- partial match: `operator_companyName LIKE '%EnBW%'`
- `max_electric_power_station` is the operator's figure for the **whole station**, often the
  sum of its charge points (2 × 160 kW reads `320`), so it is not the power a car can get:
  use `--min-point-kw` for that (above)
- `max_electric_power_station` and `Anzahl_Ladepunkte` are **text** columns (`esriFieldTypeString`
  in `fields`); cast them to compare as numbers:
  `CAST(max_electric_power_station AS FLOAT) >= 150`, `CAST(Anzahl_Ladepunkte AS INTEGER) > 2`.
  An unquoted `max_electric_power_station >= 150` fails with ArcGIS error 400
- `go_live_date` is `dd.mm.yyyy` **text** too, so sorting on it does not find the newest
  stations (`"31.12.2025"` sorts above `"31.08.2026"`); filter by year or month with
  `go_live_date LIKE '%.2026'` or `LIKE '%.08.2026'`
- combine with `AND`/`OR` inside one `--where`; the default is `1=1` (all rows). Giving
  `--where` (or any other option that takes a value) twice is a usage error (exit 2), not
  "the last one wins"
- long filters are fine: when the request URL would pass 2,000 characters (a long
  `IN (…)` list), the CLI sends the query as a form-encoded POST instead of a GET, and an
  error message then reads `… for POST <url>`

Common fields: `Ort`, `Postleitzahl`, `state`, `Betreiber`, `operator_companyName`,
`Typ` (`Normalladeeinrichtung`/`Schnellladeeinrichtung`), `Status`,
`max_electric_power_station`, `Anzahl_Ladepunkte`.

## Examples

```bash
ladesaeulen stations --count                                        # 116343 on 2026-09-15
ladesaeulen stations --where "state='Berlin'" --count
ladesaeulen count-by Typ --compact
ladesaeulen stations --near 52.5163,13.3777 --radius 2 --where "Typ='Schnellladeeinrichtung'" --geojson
ladesaeulen fields --compact | jq '.[].name'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty result also exits 0 |
| `1` | API/logical error (the ArcGIS `error` envelope), or a catch-all |
| `2` | usage error (bad flags, unknown command, `--near` without `--radius`, `--count` with a paging/field option, a non-`http(s)` or malformed `--base-url`, redirecting base URL) |
| `4` | HTTP 404 |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap; a reset connection once the retries are spent) |

A reader that stops early (`ladesaeulen count-by Ort | head -n 3`) ends the run quietly
with `0`. When stderr's reader is gone (`2>&1 | true`), a failed run still exits with its
own code.

## Notes

- **The ArcGIS server reports logical errors as HTTP 200 with an `error` object**
  (e.g. a bad `--where` column) — the CLI detects it and exits 1 with the message.
- **`stations` default fields are curated** (`--fields '*'` for all, incl. a large raw
  JSON blob per row).
- The data is © the Bundesnetzagentur under CC BY 4.0 — see
  [DATA_LICENSE.md](DATA_LICENSE.md); attribution is required.
