---
name: ladesaeulen-near
description: >
  Find public EV charging stations near a location in Germany using the
  ladesaeulenregister-cli. Trigger when the user asks "charging stations near me",
  "fast chargers within 2 km of Brandenburger Tor", "how many chargers are near this
  address / these coordinates?", or wants a spatial search around a point. Runs a
  radius query on the Bundesnetzagentur Ladesäulenregister and returns the nearby
  stations (optionally as GeoJSON).
version: 1.0.0
userInvocable: true
---

# Ladesäulen Near

Find charging stations within a radius of a point. Great for "what can I charge at
near here?".

## Tooling

This skill drives the `ladesaeulen` command. **Before anything else, validate it is available** — run `command -v ladesaeulen` (or `ladesaeulen --version`). If it is not on your PATH, STOP and inform the user that the `ladesaeulen` CLI (`@maschinenlesbar.org/ladesaeulenregister-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** The register is a public ArcGIS FeatureServer. This skill uses `ladesaeulen stations --near <lat,lon> --radius <km>` (both required together); combine with `--where`, `--count`, `--geojson`, `--limit`. `--compact` for `jq`. Data © Bundesnetzagentur under CC BY 4.0 (attribution required) — see DATA_LICENSE.md.

## You need coordinates (lat, lon)

`--near` takes **WGS84 `lat,lon`** in decimal degrees. If the user gives a place or
address, resolve it to coordinates first (a geocoder / the user's known location) —
this CLI does not geocode. Example: Brandenburger Tor ≈ `52.5163,13.3777`.

## Recipes

```bash
# How many stations within 1 km of a Berlin point?
ladesaeulen stations --near 52.52,13.405 --radius 1 --count

# Fast chargers within 3 km, key columns
ladesaeulen stations --near 52.5163,13.3777 --radius 3 --where "Typ='Schnellladeeinrichtung'" \
  --limit 100 --compact \
  | jq '.features[].attributes | {operator_companyName, "Straße": ."Straße", Hausnummer, Ort, max_electric_power_station}'

# The same as GeoJSON (for a map)
ladesaeulen stations --near 52.52,13.405 --radius 2 --geojson --limit 200 > nearby.geojson
```

## Traps

- **`--near` and `--radius` must both be given** (the CLI errors otherwise). `--near`
  is `lat,lon` (latitude first); `--radius` is in **km**.
- **You must supply coordinates** — resolve an address/place to lat/lon before calling;
  the CLI has no geocoder.
- **Combine `--where` to narrow** (e.g. only `Schnellladeeinrichtung`), and use
  `--count` first to gauge how many are nearby before listing.
- **Raise `--limit`** if you need all nearby stations (default is small); a `true`
  `exceededTransferLimit` means there are more.
- **`--geojson`** is ideal when the answer feeds a map.
- **Umlaut field names need quoting in `jq`.** The `{Straße}` shorthand is a jq compile
  error; write `{"Straße": ."Straße"}` or `."Straße"`.
- **Take the operator from `operator_companyName`.** `Betreiber` is `null` on more than
  half of all stations (48 of the 76 fast chargers within 3 km of the Brandenburger Tor
  on 2026-09-15).
- **`max_electric_power_station` is text** (`"150"`). Filter with
  `CAST(max_electric_power_station AS FLOAT) >= 150`, not `max_electric_power_station >= 150`
  (ArcGIS error 400); see the **ladesaeulen-search** skill.
- Cite the source: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0).
