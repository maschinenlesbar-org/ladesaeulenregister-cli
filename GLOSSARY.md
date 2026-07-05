# Glossary

Ladesäulenregister terms and fields, as the CLI surfaces them. Field names in the
data are German (with umlauts); keep them verbatim in `--where`.

| Term | In the CLI | What it is |
|---|---|---|
| **Ladesäulenregister** | — | The Bundesnetzagentur's register of publicly accessible EV charging stations in Germany. |
| **Ladeeinrichtung** (station) | a feature / row | One charging station. `Typ` is `Normalladeeinrichtung` (AC) or `Schnellladeeinrichtung` (DC fast). |
| **Ladepunkt** (charge point) | `Anzahl_Ladepunkte` | A single connector/socket. A station has one or more; the register counts *stations*, not charge points. |
| **Betreiber / operator** | `Betreiber`, `operator_companyName` | The charge-point operator (display name and full company name). |
| **`state`** | filter / `count-by` | Bundesland, e.g. `Bayern`. |
| **`Ort` / `Postleitzahl` / `Straße` / `Hausnummer`** | fields | City / postcode / street / house number. |
| **`Status`** | field | Operating status, e.g. `In Betrieb`. |
| **`max_electric_power_station`** | field | Max electric power of the station, in **kW**. |
| **`Steckersystem_Ladepunkt1..10`** | fields | Connector system per charge point (Typ 2, CCS/Combo, CHAdeMO, Schuko, …). |
| **`coordinates_latitude` / `coordinates_longitude`** | fields | WGS84 position (also the feature geometry). |
| **FeatureServer / layer** | `--base-url` | The ArcGIS service; charging stations are layer `0`. |
| **`--where`** | option | Esri SQL filter over the columns (case-sensitive, single-quoted strings). |
| **`--near` / `--radius`** | options | Spatial query: stations within `radius` km of a `lat,lon` point. |
| **`exceededTransferLimit`** | output field | `true` ⇒ more features matched than were returned; page with `--limit`/`--offset`. |
| **`count-by`** | command | Server-side grouped counts (`outStatistics`), e.g. stations per `state`. |

## Reading the data

- **Capacities are in kW.** `max_electric_power_station` is the station maximum.
- **`Typ`** distinguishes normal (AC) from fast (DC) charging.
- **It counts stations, not charge points** — a station may host several
  `Anzahl_Ladepunkte`; be explicit about which the user asked for.
- **The register is a snapshot** refreshed regularly (roughly daily); counts drift.
