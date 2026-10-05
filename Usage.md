# Usage

`ladesaeulen` — a CLI for the Bundesnetzagentur Ladesäulenregister. No API key needed.

```bash
ladesaeulen [global options] <command> [command options]
```

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | API base URL (the ArcGIS FeatureServer); `http:`/`https:` only, no query (`?`), fragment (`#`) or surrounding whitespace, and a `%` in a user name or password must be an escape (write a literal `%` as `%25`); anything else is a usage error (exit 2) before any request |
| `--timeout <ms>` | time limit per request in ms, whole response included (default 30000 = 30 s; 0 = no timeout; at most 2147483647) |
| `--user-agent <ua>` | User-Agent header value (not blank; Latin-1 text without control characters) |
| `--max-retries <n>` | retries for transient 429/503 responses (0..10, default 2). Each retry waits the server's `Retry-After` (seconds or an HTTP-date), else 200 ms, 400 ms, …; a `Retry-After` above 30 s is not retried — the error is reported at once. Network errors (a reset or refused connection, a timeout) are not retried |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line (for piping to `jq`) |
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
| `--count` | print only the number of matching stations (all of them: combine it with `--where` and `--near`/`--radius`; with `--limit`, `--offset`, `--order-by`, `--fields` or `--geojson` it is a usage error) |
| `--geojson` | output a GeoJSON FeatureCollection instead of ArcGIS JSON |

Default output is `{ features, exceededTransferLimit }` — `exceededTransferLimit:
true` means more matched than were returned (the server caps a page at ~2000 rows).
The CLI prints a stderr note in that case, saying whether your `--limit` or the server's
cap cut the page; page with `--offset`, raise `--limit` or narrow `--where`.
`--geojson` gets the same note: there the server puts the flag in the FeatureCollection's
`properties.exceededTransferLimit`.

### `count-by <field>` — grouped counts

`ladesaeulen count-by state` → `[{ value, count }, …]`, sorted by count desc. Add
`--where` to aggregate a subset. It groups by **one** field: a comma-separated list
(`state,Typ`) is a usage error — group by one field and fix the other with `--where`
(`count-by state --where "Typ='Schnellladeeinrichtung'"`). Good fields: `state`, `Typ`, `operator_companyName`, `Ort`
(`Betreiber` is `null` on more than half of the stations). The result stops at 2,000
groups (the server's page limit; the CLI then prints a stderr note); the top groups are
still correct because the server sorts by count first.

### `fields` — list queryable columns

`ladesaeulen fields` → `[{ name, type, alias }, …]`. Use it to build `--where`,
`--fields` and `count-by`.

## The `--where` filter

Standard Esri SQL over the layer's columns:

- strings are **case-sensitive and single-quoted**: `Ort='Berlin'`, `state='Bayern'`
- partial match: `operator_companyName LIKE '%EnBW%'`
- `max_electric_power_station` and `Anzahl_Ladepunkte` are **text** columns (`esriFieldTypeString`
  in `fields`); cast them to compare as numbers:
  `CAST(max_electric_power_station AS FLOAT) >= 150`, `CAST(Anzahl_Ladepunkte AS INTEGER) > 2`.
  An unquoted `max_electric_power_station >= 150` fails with ArcGIS error 400
- `go_live_date` is `dd.mm.yyyy` **text** too, so sorting on it does not find the newest
  stations (`"31.12.2025"` sorts above `"31.08.2026"`); filter by year or month with
  `go_live_date LIKE '%.2026'` or `LIKE '%.08.2026'`
- combine with `AND`/`OR`; the default is `1=1` (all rows)
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
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **The ArcGIS server reports logical errors as HTTP 200 with an `error` object**
  (e.g. a bad `--where` column) — the CLI detects it and exits 1 with the message.
- **`stations` default fields are curated** (`--fields '*'` for all, incl. a large raw
  JSON blob per row).
- The data is © the Bundesnetzagentur under CC BY 4.0 — see
  [DATA_LICENSE.md](DATA_LICENSE.md); attribution is required.
