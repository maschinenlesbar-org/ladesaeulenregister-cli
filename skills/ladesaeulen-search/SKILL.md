---
name: ladesaeulen-search
description: >
  Find and count public EV charging stations in Germany from the Bundesnetzagentur
  Ladesäulenregister using the ladesaeulenregister-cli. Trigger when the user asks
  "how many fast chargers are in Berlin?", "list EnBW charging stations in Bavaria",
  "charging stations with at least 150 kW", "how many public chargers exist in
  Germany?", or wants to filter stations by place, operator, connector type, power
  or status. Builds the SQL --where filter and resolves the field names.
version: 1.0.0
userInvocable: true
---

# Ladesäulen Search

The Ladesäulenregister holds ~111k public charging stations. This skill searches and
counts them with an SQL filter.

## Tooling

This skill drives the `ladesaeulen` command. **Before anything else, validate it is available** — run `command -v ladesaeulen` (or `ladesaeulen --version`). If it is not on your PATH, STOP and inform the user that the `ladesaeulen` CLI (`@maschinenlesbar.org/ladesaeulenregister-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** The register is a public ArcGIS FeatureServer. `ladesaeulen stations` searches with an SQL `--where`, paging (`--limit`/`--offset`), `--count`, `--geojson`, and spatial `--near`/`--radius`; `count-by <field>` aggregates; `fields` lists the columns. `--compact` for `jq`. Data © Bundesnetzagentur under CC BY 4.0 (attribution required) — see DATA_LICENSE.md.

## The fields you filter on

Run `ladesaeulen fields` for the full list. The useful ones:

| Field | Meaning / example values |
|---|---|
| `Ort` | city — `Ort='Berlin'` |
| `Postleitzahl` | postcode (string) — `Postleitzahl='10115'` |
| `state` | Bundesland — `state='Bayern'` |
| `Betreiber` / `operator_companyName` | operator — `Betreiber LIKE '%EnBW%'` |
| `Typ` | `'Normalladeeinrichtung'` or `'Schnellladeeinrichtung'` |
| `Status` | `'In Betrieb'`, … |
| `max_electric_power_station` | station power in kW (number) — `max_electric_power_station >= 150` |
| `Anzahl_Ladepunkte` | number of charge points |

## Recipes

```bash
# How many fast chargers in Berlin? (just the count)
ladesaeulen stations --where "Ort='Berlin' AND Typ='Schnellladeeinrichtung'" --count

# EnBW stations in Bavaria, key columns
ladesaeulen stations --where "state='Bayern' AND Betreiber LIKE '%EnBW%'" --limit 50 --compact \
  | jq '.features[].attributes | {Betreiber, Ort, Typ, max_electric_power_station}'

# High-power (≥150 kW) stations, biggest first
ladesaeulen stations --where "max_electric_power_station >= 150" --order-by "max_electric_power_station DESC" --limit 20

# Total public charging stations in Germany
ladesaeulen stations --count
```

## Traps

- **Prefer `--count` for "how many?"** — never page all 111k rows to count.
- **`stations` returns `{ features, exceededTransferLimit }`.** If
  `exceededTransferLimit` is `true`, more matched than were returned — page with
  `--limit`/`--offset` (or narrow the `--where`).
- **`--where` is SQL, values are case-sensitive** and single-quoted (`Ort='Berlin'`,
  not `Berlin`). Use `LIKE '%…%'` for partial operator names. Confirm exact field
  names with `ladesaeulen fields`.
- **String vs number:** quote strings, don't quote numbers (`>= 150`).
- **Default columns are curated** — pass `--fields '*'` for everything (includes a
  large raw JSON blob per row).
- Nearby-a-point search → the **ladesaeulen-near** skill; per-region totals → the
  **ladesaeulen-stats** skill.
- Cite the source: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0).
