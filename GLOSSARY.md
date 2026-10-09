# Glossary

Ladesäulenregister terms and fields, as the CLI surfaces them. Field names in the
data are German (with umlauts); keep them verbatim in `--where`.

| Term | In the CLI | What it is |
|---|---|---|
| **Ladesäulenregister** | — | The Bundesnetzagentur's register of publicly accessible EV charging stations in Germany. It lists only the stations whose operators have completed the notification procedure (Anzeigeverfahren), so it **undercounts**: the BNetzA notes that the number of public charging stations in Germany is higher. |
| **Ladeeinrichtung** (station) | a feature / row | One charging station. `Typ` is `Normalladeeinrichtung` or `Schnellladeeinrichtung` — by power, not by current type (see below). |
| **Ladepunkt** (charge point) | `Anzahl_Ladepunkte` | A single connector/socket. A station has one or more; the register counts *stations*, not charge points. `Anzahl_Ladepunkte` is a text column (`"2"`). |
| **Betreiber / operator** | `Betreiber`, `operator_companyName` | The charge-point operator. `operator_companyName` is the company name and is filled on every station; `Betreiber` is a short display name that is `null` on more than half of the stations, so filter and group on `operator_companyName`. |
| **`state`** | filter / `count-by` | Bundesland, e.g. `Bayern`. |
| **`Ort` / `Postleitzahl` / `Straße` / `Hausnummer`** | fields | City / postcode / street / house number. |
| **`Status`** | field | Operating status, e.g. `In Betrieb`. |
| **`max_electric_power_station`** | field | The operator's power figure for the **whole station**, in **kW**, stored as text (`"150"`, `"3.7"`; the column is `esriFieldTypeString`). **Not the power a car can get:** many operators enter the sum of the charge points (2 × 160 kW CCS → `"320"`, 2 × 22 kW AC → `"44"`), others the fastest point (4 × 22 kW → `"22"`), some a station limit below the connectors' rating. Compare and sort it with `CAST(max_electric_power_station AS FLOAT)`. |
| **`max_charge_point_kw`** | derived field, `--min-point-kw` | Added by the CLI and library, not a register column: the most **one charge point** can deliver — the fastest connector rating in `Steckersystem_Ladepunkt1..10` (`… (160 kw)`), capped at `max_electric_power_station` when that is lower. Present on every row that carries a connector column; `null` when no connector has a rating. `stations --min-point-kw N` filters on it. |
| **`go_live_date`** | field | Date the station went into operation, stored as **`dd.mm.yyyy` text** (`"31.08.2026"`; `esriFieldTypeString`). Sorting on it sorts the text, day first, so it does not give the newest stations; filter by year or month with `LIKE` (`go_live_date LIKE '%.2026'`, `go_live_date LIKE '%.08.2026'`). |
| **`Steckersystem_Ladepunkt1..10`** | fields | Connector system per charge point, one line per connector with its rating: `DC Fahrzeugkupplung Typ Combo 2 (CCS) (150 kw)`, `AC Typ 2 Steckdose (22 kw)\nAC Schuko (22 kw)`; `( kw)` when the operator left the rating empty. The register fills at most six. |
| **`coordinates_latitude` / `coordinates_longitude`** | fields | WGS84 position (also the feature geometry). |
| **FeatureServer / layer** | `--base-url` | The ArcGIS service; charging stations are layer `0`. |
| **`--where`** | option | Esri SQL filter over the columns, strings single-quoted. Text comparisons ignore case (`Ort='berlin'` matches `Berlin`, also with `LIKE`), so a case variant finds nothing new. |
| **`--near` / `--radius`** | options | Spatial query: stations within `radius` km of a `lat,lon` point. |
| **`exceededTransferLimit`** | output field | `true` ⇒ more features matched than were returned; page with `--limit`/`--offset`. |
| **`count-by`** | command | Server-side grouped counts (`outStatistics`), e.g. stations per `state`. |
| **`info`** | command | How current the register is: the layer's name and its last edit dates (`dataLastEditDate`, ISO 8601). |
| **Log record** | stderr, `--log-format` | Every diagnostic line the CLI writes to stderr: a timestamp, a level (`ERROR`, `WARN`, `INFO`) and a topic `ladesaeulen.<area>`, as text (log4j style) or with `--log-format jsonl` as one JSON object per line. The areas: `cli` (usage errors, commander's messages, unexpected errors, the `--near` swap note), `api` (the API's answers and the notes on them: an error status, the ArcGIS `error` envelope, a malformed answer — bad JSON, the wrong shape, an empty body), `http` (the connection, the cleartext warning) and `output` (a failed write to stdout). A record is always one line; control characters in it are escaped. |
| **`--max-retries`** | option | How often a transient failure is retried (default `2`): a `429`/`503` response, and a GET whose connection was reset mid-request (`socket hang up`, `ECONNRESET`), each after a linear backoff from 200 ms or the server's longer `Retry-After`. A failure that persists ends its message with `(after 2 retries)`; a refused connection, a DNS failure or a timeout is not retried. |

## Reading the data

- **Capacities are in kW.** `max_electric_power_station` is the operator's figure for the
  whole station, and operators fill it differently: often the sum of the charge points, so
  2 × 160 kW reads `320` and 2 × 22 kW reads `44`. In München, 13 of the 49 stations with a
  figure of 300 kW or more had no charge point above 200 kW (2026-10-05). For "where can a
  car charge at N kW", use `stations --min-point-kw N` (library: `minChargePointKw`), which
  reads the connector ratings and adds `max_charge_point_kw`. The station figure is a text
  column: `max_electric_power_station >= 150` fails with an ArcGIS error 400, so write
  `CAST(max_electric_power_station AS FLOAT) >= 150` (and cast in `--order-by`, which
  otherwise sorts as text).
- **`Typ` is about power, not AC versus DC.** It follows the Ladesäulenverordnung: a
  `Schnellladeeinrichtung` has a charge point with more than 22 kW. Most of them are DC,
  but not all — 48 fast stations had no DC connector on 2026-09-26 (e.g. AC Typ 2 at
  25 kW). For "DC chargers", filter on the connector columns of **every** charge point,
  `(Steckersystem_Ladepunkt1 LIKE '%DC%' OR Steckersystem_Ladepunkt2 LIKE '%DC%' OR … OR Steckersystem_Ladepunkt6 LIKE '%DC%')`, in parentheses when combined with `AND`. Point 1 alone misses about 6 %: 30,798
  stations have DC on point 1, 32,825 on any point (2026-10-06).
- **`go_live_date` is `dd.mm.yyyy` text**, so `--order-by "go_live_date DESC"` returns
  `31.12.2025` first although stations went live in 2026. Filter by year or month with
  `LIKE '%.2026'` / `LIKE '%.08.2026'` instead of sorting.
- **Sixteen listed columns are always empty.** `ladesaeulen fields` lists them, but they are
  `null` on every row (checked 2026-10-06): the per-connector `evses_*` columns (e.g.
  `evses_evse_connectors_connector___max_electric_power_connector`), `documentDate`,
  `documentTime`, `json_type` and `Steckersystem_Ladepunkt7..10`. A filter on one matches
  nothing (`0`, exit 0) and a group on one is a single `null` group; the CLI prints a note
  when you name one. `F_overlaps` (always `1`) and `fme_rejection_code` (always
  `MISSING_PARAMETER_LIST`) are filled but say nothing about a station. Per-connector power
  is in the `Steckersystem_LadepunktN` text instead (`max_charge_point_kw`).
- **It counts stations, not charge points** — a station may host several
  `Anzahl_Ladepunkte`; be explicit about which the user asked for.
- **The register is a snapshot, refreshed irregularly.** No row carries an as-of date
  (`documentDate` is empty on every row); the layer's own edit date is the only one, and
  `ladesaeulen info` prints it (`dataLastEditDate`). On 2026-10-05 the layer had last been
  edited on 2026-10-01, and in September its total stayed unchanged for at least 11 days;
  the BNetzA's own CSV download is monthly. Give the date with every count.
