---
name: ladesaeulen-stats
description: >
  Aggregate German EV charging-station counts from the Bundesnetzagentur
  Ladesäulenregister using the ladesaeulenregister-cli. Trigger when the user asks
  "how many charging stations per Bundesland?", "which operator has the most
  chargers?", "normal vs fast chargers breakdown", "top cities by number of
  stations", or wants grouped totals rather than a single figure. Uses count-by
  aggregation over the register.
version: 1.0.0
userInvocable: true
---

# Ladesäulen Stats

Grouped station counts — per Bundesland, operator, type, city — from the
Ladesäulenregister.

## Tooling

This skill drives the `ladesaeulen` command. **Before anything else, validate it is available** — run `command -v ladesaeulen` (or `ladesaeulen --version`). If it is not on your PATH, STOP and inform the user that the `ladesaeulen` CLI (`@maschinenlesbar.org/ladesaeulenregister-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** The register is a public ArcGIS FeatureServer. This skill uses `ladesaeulen count-by <field> [--where …]`, which returns `[{value, count}, …]` sorted by count descending. `ladesaeulen fields` lists the group-able columns. `--compact` for `jq`. Data © Bundesnetzagentur under CC BY 4.0 (attribution required) — see DATA_LICENSE.md.

## Commands

```bash
ladesaeulen count-by state       # stations per Bundesland
ladesaeulen count-by Typ         # Normal- vs Schnellladeeinrichtung
ladesaeulen count-by operator_companyName   # per operator (which has the most?)
ladesaeulen count-by Ort         # per city
```

Add `--where` to aggregate a subset first:

```bash
# Fast chargers per Bundesland
ladesaeulen count-by state --where "Typ='Schnellladeeinrichtung'" --compact
```

## Recipes

```bash
# Top 10 operators by number of stations
ladesaeulen count-by operator_companyName --compact | jq '.[:10]'

# Normal vs fast split, as a quick table
ladesaeulen count-by Typ --compact | jq -r '.[] | "\(.value)\t\(.count)"'

# Share of fast chargers nationwide: fast / total
fast=$(ladesaeulen stations --where "Typ='Schnellladeeinrichtung'" --count)
total=$(ladesaeulen stations --count)
echo "fast: $fast / total: $total"
```

## Traps

- **`count-by` is server-side aggregation** — it counts all matching stations, not
  just a page, so it is exact and cheap. Prefer it over paging + counting yourself.
- **Group by a real column** — confirm the field name with `ladesaeulen fields`
  (they include German umlauts, e.g. `Straße`).
- **Group operators by `operator_companyName`, not `Betreiber`.** `Betreiber` is `null`
  on more than half of all stations, so `count-by Betreiber` puts a `null` group first
  (17,327 of 31,188 fast chargers on 2026-09-15) and misses big operators such as Tesla
  and IONITY. `operator_companyName` has no `null` group. Its names are the operator's
  legal entities, so one brand can appear under several (`EnBW mobility+ AG und Co.KG `,
  `EnBW Ostwürttemberg DonauRies AG`); say so when you rank.
- **High-cardinality groups are long and capped** — `count-by Ort` and
  `count-by operator_companyName` stop at **2,000 groups** (the server's page limit;
  the CLI prints no note). The top of the list is still right, because the server sorts
  by count before cutting, so slice with `jq '.[:N]'`; but don't report the length as
  "the number of cities/operators". Narrow with `--where` if you need every group.
- **It counts stations (Ladeeinrichtungen), not charge points** — a station can have
  several `Anzahl_Ladepunkte`; say which the user wants.
- Cite the source: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0).
