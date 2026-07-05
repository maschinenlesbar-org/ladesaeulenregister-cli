# Usage

`ladesaeulen` — a CLI for the Bundesnetzagentur Ladesäulenregister. No API key needed.

```bash
ladesaeulen [global options] <command> [command options]
```

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | API base URL (the ArcGIS FeatureServer) |
| `--timeout <ms>` | per-request timeout in ms (0 = no timeout) |
| `--user-agent <ua>` | User-Agent header value |
| `--max-retries <n>` | retries for transient 429/503 responses (0..10) |
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
| `--order-by <spec>` | sort, e.g. `"max_electric_power_station DESC"` |
| `--fields <list>` | comma-separated field list, or `'*'` for all |
| `--near <lat,lon>` | only stations near this WGS84 point (needs `--radius`) |
| `--radius <km>` | search radius in km for `--near` |
| `--count` | print only the number of matching stations |
| `--geojson` | output a GeoJSON FeatureCollection instead of ArcGIS JSON |

Default output is `{ features, exceededTransferLimit }` — `exceededTransferLimit:
true` means more matched than were returned (the server caps a page at ~2000 rows).
The CLI prints a stderr note in that case; page with `--offset` or narrow `--where`.

### `count-by <field>` — grouped counts

`ladesaeulen count-by state` → `[{ value, count }, …]`, sorted by count desc. Add
`--where` to aggregate a subset. Good fields: `state`, `Typ`, `Betreiber`, `Ort`.

### `fields` — list queryable columns

`ladesaeulen fields` → `[{ name, type, alias }, …]`. Use it to build `--where`,
`--fields` and `count-by`.

## The `--where` filter

Standard Esri SQL over the layer's columns:

- strings are **case-sensitive and single-quoted**: `Ort='Berlin'`, `state='Bayern'`
- partial match: `Betreiber LIKE '%EnBW%'`
- numbers unquoted: `max_electric_power_station >= 150`, `Anzahl_Ladepunkte > 2`
- combine with `AND`/`OR`; the default is `1=1` (all rows)

Common fields: `Ort`, `Postleitzahl`, `state`, `Betreiber`, `operator_companyName`,
`Typ` (`Normalladeeinrichtung`/`Schnellladeeinrichtung`), `Status`,
`max_electric_power_station`, `Anzahl_Ladepunkte`.

## Examples

```bash
ladesaeulen stations --count                                        # 111524
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
| `2` | usage error (bad flags, unknown command, `--near` without `--radius`, redirecting base URL) |
| `4` | HTTP 404 |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **The ArcGIS server reports logical errors as HTTP 200 with an `error` object**
  (e.g. a bad `--where` column) — the CLI detects it and exits 1 with the message.
- **`stations` default fields are curated** (`--fields '*'` for all, incl. a large raw
  JSON blob per row).
- The data is © the Bundesnetzagentur under CC BY 4.0 — see
  [DATA_LICENSE.md](DATA_LICENSE.md); attribution is required.
