---
name: ladesaeulen-search
description: >
  Find and count public EV charging stations in Germany from the Bundesnetzagentur
  Ladesäulenregister using the ladesaeulenregister-cli. Trigger when the user asks
  "how many fast chargers are in Berlin?", "list EnBW charging stations in Bavaria",
  "where can I charge at 300 kW in Munich?", "how many public chargers exist in
  Germany?", or wants to filter stations by place, operator, connector type, power
  or status. Builds the SQL --where filter and resolves the field names.
compatibility: >
  Requires the `ladesaeulen` CLI (npm package
  @maschinenlesbar.org/ladesaeulenregister-cli) on PATH, installed by the user;
  the skill never installs it. Uses jq for JSON filtering. Network access to
  services-eu1.arcgis.com (Bundesnetzagentur).
---

# Ladesäulen Search

The Ladesäulenregister holds well over 100,000 public charging stations (116,343 on
2026-09-15; `ladesaeulen stations --count` gives today's figure). This skill searches and
counts them with an SQL filter.

## Tooling

This skill drives the `ladesaeulen` command. **Before anything else, validate it is available** — run `command -v ladesaeulen` (or `ladesaeulen --version`). If it is not on your PATH, STOP and inform the user that the `ladesaeulen` CLI (`@maschinenlesbar.org/ladesaeulenregister-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**No API key is required.** The register is a public ArcGIS FeatureServer. `ladesaeulen stations` searches with an SQL `--where`, paging (`--limit`/`--offset`), `--count`, `--geojson`, and spatial `--near`/`--radius`; `count-by <field>` aggregates; `fields` lists the columns. `--compact` for `jq`. Data © Bundesnetzagentur under CC BY 4.0 (attribution required) — see DATA_LICENSE.md.

## The fields you filter on

Run `ladesaeulen fields` for the full list. The useful ones:

| Field | Meaning / example values |
|---|---|
| `Ort` | city — `Ort='Berlin'` |
| `Postleitzahl` | postcode (string) — `Postleitzahl='10115'` |
| `state` | Bundesland — `state='Bayern'` |
| `operator_companyName` | operator company name, filled on every station — `operator_companyName LIKE '%EnBW%'` |
| `Betreiber` | short operator name, **`null` on more than half of all stations** — don't filter or group on it |
| `Typ` | `'Normalladeeinrichtung'` or `'Schnellladeeinrichtung'` (more than 22 kW — not the same as DC) |
| `Steckersystem_Ladepunkt1..10` | connector per charge point — `Steckersystem_Ladepunkt1 LIKE '%DC%'` for DC |
| `Status` | `'In Betrieb'`, … |
| `max_electric_power_station` | the operator's figure for the **whole station** in kW, **stored as text** (`"150"`, `"3.7"`) — often the **sum** of the charge points, so not what a car gets; `CAST(max_electric_power_station AS FLOAT) >= 150` |
| `max_charge_point_kw` | **derived, not a column:** the most one charge point delivers (fastest connector rating, capped at the station figure); filter with `--min-point-kw N`, which adds it to every row |
| `Anzahl_Ladepunkte` | number of charge points, also text (`"2"`) — `CAST(Anzahl_Ladepunkte AS INTEGER) > 2` |
| `go_live_date` | date it went live, **`dd.mm.yyyy` text** (`"31.08.2026"`) — `go_live_date LIKE '%.2026'` |

## Recipes

```bash
# How many fast chargers in Berlin? (just the count)
ladesaeulen stations --where "Ort='Berlin' AND Typ='Schnellladeeinrichtung'" --count

# EnBW stations in Bavaria, key columns
ladesaeulen stations --where "state='Bayern' AND operator_companyName LIKE '%EnBW%'" --limit 50 --compact \
  | jq '.features[].attributes | {operator_companyName, Ort, Typ, max_electric_power_station}'

# Where in München can a car charge at 300 kW or more? (per charge point, not the station sum)
ladesaeulen stations --where "Ort='München'" --min-point-kw 300 --limit 200 --compact \
  | jq '.features[].attributes | {operator_companyName, "Straße": ."Straße", Hausnummer, max_charge_point_kw}'

# How many stations nationwide have a charge point of at least 150 kW?
ladesaeulen stations --min-point-kw 150 --count   # reads every candidate: one request per 2,000

# Stations in the register (not every public charger in Germany: see Traps)
ladesaeulen stations --count
```

## Traps

- **Prefer `--count` for "how many?"** — never page through the whole register to count.
- **The register undercounts.** It lists only the stations whose operators have completed
  the BNetzA's notification procedure (Anzeigeverfahren); the BNetzA itself says the number
  of public charging stations in Germany is higher. Answer "how many public chargers exist in
  Germany?" as "the register lists N stations", with that caveat, never as the total.
- **Say how current the answer is.** The register is a snapshot, refreshed irregularly,
  and no row carries a date: run `ladesaeulen info` once and give its `dataLastEditDate`
  ("as of 1 October 2026") with every count.
- **`stations` returns `{ features, exceededTransferLimit }`.** If
  `exceededTransferLimit` is `true`, more matched than were returned — page with
  `--limit`/`--offset` (or narrow the `--where`).
- **`--where` is SQL, values are single-quoted** (`Ort='Berlin'`, not `Berlin`). Text
  comparisons ignore case (`Ort='berlin'` = `Ort='Berlin'`, `LIKE '%enbw%'` = `LIKE
  '%EnBW%'`), so don't retry with other casings or add `UPPER()`/`LOWER()`. Use `LIKE '%…%'` for partial operator names. Confirm exact field
  names with `ladesaeulen fields`.
- **`max_electric_power_station` is not the power a car can get.** It is the operator's
  figure for the whole station, and many operators enter the **sum** of the charge points:
  Jolt's 2 × 160 kW stations read `320`, 2 × 22 kW AC stations read `44`. In München, 13 of
  the 49 stations with a figure ≥ 300 had no charge point above 200 kW (2026-10-05). For
  "charge at N kW", "fast enough for my car" or "at least 150 kW", filter with
  `--min-point-kw N` and report `max_charge_point_kw` (per charge point), not the station
  figure. With `--limit`, a page can come back shorter than the limit (rows below the
  minimum are dropped after the server's page); `--count` reads every candidate, one
  request per 2,000, so narrow `--where` first for a nationwide question.
- **Power and charge-point count are text columns.** `ladesaeulen fields` lists
  `max_electric_power_station` and `Anzahl_Ladepunkte` as `esriFieldTypeString`.
  `max_electric_power_station >= 150` fails with `ArcGIS error 400 … Invalid query
  parameters` (some values have decimals), so wrap the column in
  `CAST(max_electric_power_station AS FLOAT)` in `--where` **and** `--order-by`: a plain
  `--order-by "max_electric_power_station DESC"` sorts as text (`"99"` above `"400"`).
  Check a column's `type` in `ladesaeulen fields` before comparing it with a number.
- **"Fast" is not "DC".** `Typ='Schnellladeeinrichtung'` means a charge point above
  22 kW (the Ladesäulenverordnung's definition); 48 fast stations had only AC connectors
  on 2026-09-26. When the user asks for DC chargers, filter on the connector columns
  (`Steckersystem_Ladepunkt1 LIKE '%DC%'`, and the other `Steckersystem_Ladepunkt*`
  columns for multi-point stations) and say which definition you used.
- **Don't sort by `go_live_date` for "newest stations".** It is `dd.mm.yyyy` text, so
  `--order-by "go_live_date DESC"` puts `31.12.2025` first although 9,697 stations went
  live in 2026 (on 2026-09-26). Filter by year or month instead
  (`--where "go_live_date LIKE '%.2026'" --count`, `LIKE '%.08.2026'`).
- **Filter operators on `operator_companyName`, not `Betreiber`.** `Betreiber` is `null`
  on 64,635 of 116,343 stations (2026-09-15), so `state='Bayern' AND Betreiber LIKE
  '%EnBW%'` counted 42 stations where `operator_companyName LIKE '%EnBW%'` counted 825.
  Company names can carry a trailing space (`EnBW mobility+ AG und Co.KG `), so match
  with `LIKE '%…%'` rather than `=`.
- **Default columns are curated** — pass `--fields '*'` for everything (includes a
  large raw JSON blob per row).
- Nearby-a-point search → the **ladesaeulen-near** skill; per-region totals → the
  **ladesaeulen-stats** skill.
- Cite the source: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0).
