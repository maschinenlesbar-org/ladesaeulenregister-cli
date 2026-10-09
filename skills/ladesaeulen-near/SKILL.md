---
name: ladesaeulen-near
description: >
  Find public EV charging stations near a location in Germany using the
  ladesaeulenregister-cli. Trigger when the user asks "charging stations near me",
  "fast chargers within 2 km of Brandenburger Tor", "150 kW chargers near me", "how many chargers are near this
  address / these coordinates?", or wants a spatial search around a point. Runs a
  radius query on the Bundesnetzagentur Ladesäulenregister and returns the nearby
  stations (optionally as GeoJSON).
compatibility: >
  Requires the `ladesaeulen` CLI (npm package
  @maschinenlesbar.org/ladesaeulenregister-cli) on PATH, installed by the user;
  the skill never installs it. Uses jq for JSON filtering. Network access to
  services-eu1.arcgis.com (Bundesnetzagentur).
---

# Ladesäulen Near

Find charging stations within a radius of a point. Great for "what can I charge at
near here?".

## Tooling

This skill drives the `ladesaeulen` command. **Before anything else, validate it is available** — run `command -v ladesaeulen` (or `ladesaeulen --version`). If it is not on your PATH, STOP and inform the user that the `ladesaeulen` CLI (`@maschinenlesbar.org/ladesaeulenregister-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**No API key is required.** The register is a public ArcGIS FeatureServer. This skill uses `ladesaeulen stations --near <lat,lon> --radius <km>` (both required together); combine with `--where`, `--count`, `--geojson`, `--limit`. `--compact` for `jq`. Data © Bundesnetzagentur under CC BY 4.0 (attribution required) — see DATA_LICENSE.md.

## You need coordinates (lat, lon)

`--near` takes **WGS84 `lat,lon`** in decimal degrees. If the user gives a place or
address, resolve it to coordinates first (a geocoder / the user's known location) —
this CLI does not geocode. Example: Brandenburger Tor ≈ `52.5163,13.3777`.

## Recipes

```bash
# How many stations within 1 km of a Berlin point?
ladesaeulen stations --near 52.52,13.405 --radius 1 --count

# Fast chargers within 3 km, key columns, with the power per charge point
# (asking for the connector columns makes the CLI add max_charge_point_kw to each row)
ladesaeulen stations --near 52.5163,13.3777 --radius 3 --where "Typ='Schnellladeeinrichtung'" \
  --fields "ID,operator_companyName,Straße,Hausnummer,Ort,max_electric_power_station,Steckersystem_Ladepunkt1,Steckersystem_Ladepunkt2,Steckersystem_Ladepunkt3,Steckersystem_Ladepunkt4,Steckersystem_Ladepunkt5,Steckersystem_Ladepunkt6" \
  --limit 100 --compact \
  | jq '.features[].attributes | {operator_companyName, "Straße": ."Straße", Hausnummer, Ort, max_charge_point_kw}'

# Chargers within 5 km where a car can draw at least 150 kW
ladesaeulen stations --near 52.5163,13.3777 --radius 5 --min-point-kw 150 --limit 200 --compact \
  | jq '.features[].attributes | {operator_companyName, "Straße": ."Straße", Hausnummer, max_charge_point_kw}'

# The same as GeoJSON (for a map)
ladesaeulen stations --near 52.52,13.405 --radius 2 --geojson --limit 200 > nearby.geojson
```

## Traps

- **`--near` and `--radius` must both be given** (the CLI errors otherwise). `--near`
  is `lat,lon` (latitude first); `--radius` is in **km**, a plain decimal from `0.001`
  (1 m) to `1000` (`0.5`, not `500m` or `5e-1`).
- **You must supply coordinates** — resolve an address/place to lat/lon before calling;
  the CLI has no geocoder.
- **Combine `--where` to narrow** (e.g. only `Schnellladeeinrichtung`), and use
  `--count` first to gauge how many are nearby before listing.
- **Raise `--limit`** if you need all nearby stations (default is small); a `true`
  `exceededTransferLimit` means there are more.
- **`--geojson`** is ideal when the answer feeds a map. A cut collection carries
  `properties.exceededTransferLimit: true`, and the CLI logs an `INFO` record `more stations
  match …` on stderr — mention it rather than presenting the map as complete.
- **Umlaut field names need quoting in `jq`.** The `{Straße}` shorthand is a jq compile
  error; write `{"Straße": ."Straße"}` or `."Straße"`.
- **Take the operator from `operator_companyName`.** `Betreiber` is `null` on more than
  half of all stations (48 of the 76 fast chargers within 3 km of the Brandenburger Tor
  on 2026-09-15).
- **Report power per charge point, not per station.** `max_electric_power_station` is the
  operator's figure for the whole station, often the **sum** of its points (2 × 160 kW reads
  `320`). `--min-point-kw N` keeps the stations where one charge point delivers at least N kW
  and adds `max_charge_point_kw` to each row; quote that. (The station figure is text:
  `CAST(max_electric_power_station AS FLOAT) >= 150`, not `max_electric_power_station >= 150`,
  which is ArcGIS error 400; see the **ladesaeulen-search** skill.) `--min-point-kw` drops
  rows after the server's page, so a page can be shorter than `--limit`.
- Cite the source: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0).
