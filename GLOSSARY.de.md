# Glossar

Begriffe und Felder des Ladesäulenregisters, so wie die CLI sie ausgibt. Die Feldnamen in den
Daten sind deutsch (mit Umlauten); übernehmen Sie sie in `--where` unverändert.

| Begriff | In der CLI | Was es ist |
|---|---|---|
| **Ladesäulenregister** | – | Das Register der Bundesnetzagentur für öffentlich zugängliche Ladeeinrichtungen für E-Autos in Deutschland. |
| **Ladeeinrichtung** | ein Feature / eine Zeile | Eine einzelne Ladestation. `Typ` ist `Normalladeeinrichtung` oder `Schnellladeeinrichtung` – nach Leistung, nicht nach Stromart (siehe unten). |
| **Ladepunkt** | `Anzahl_Ladepunkte` | Ein einzelner Anschluss bzw. eine einzelne Steckdose. Eine Ladeeinrichtung hat einen oder mehrere; das Register zählt *Ladeeinrichtungen*, nicht Ladepunkte. `Anzahl_Ladepunkte` ist eine Textspalte (`"2"`). |
| **Betreiber / operator** | `Betreiber`, `operator_companyName` | Der Betreiber der Ladepunkte. `operator_companyName` ist der Firmenname und bei jeder Ladeeinrichtung gefüllt; `Betreiber` ist ein kurzer Anzeigename, der bei mehr als der Hälfte der Ladeeinrichtungen `null` ist. Filtern und gruppieren Sie daher nach `operator_companyName`. |
| **`state`** | Filter / `count-by` | Bundesland, z. B. `Bayern`. |
| **`Ort` / `Postleitzahl` / `Straße` / `Hausnummer`** | Felder | Anschrift: Ort, Postleitzahl, Straße und Hausnummer. |
| **`Status`** | Feld | Betriebsstatus, z. B. `In Betrieb`. |
| **`max_electric_power_station`** | Feld | Maximale elektrische Leistung der Ladeeinrichtung, in **kW**, als Text gespeichert (`"150"`, `"3.7"`; die Spalte ist `esriFieldTypeString`). Vergleichen und sortieren Sie mit `CAST(max_electric_power_station AS FLOAT)`. |
| **`go_live_date`** | Feld | Datum der Inbetriebnahme, gespeichert als **Text im Format `tt.mm.jjjj`** (`"31.08.2026"`; `esriFieldTypeString`). Eine Sortierung danach sortiert den Text, beginnend mit dem Tag, und liefert daher nicht die neuesten Ladeeinrichtungen; filtern Sie nach Jahr oder Monat mit `LIKE` (`go_live_date LIKE '%.2026'`, `go_live_date LIKE '%.08.2026'`). |
| **`Steckersystem_Ladepunkt1..10`** | Felder | Steckersystem je Ladepunkt (Typ 2, CCS/Combo, CHAdeMO, Schuko, …). |
| **`coordinates_latitude` / `coordinates_longitude`** | Felder | Position in WGS84 (zugleich die Geometrie des Features). |
| **FeatureServer / Layer** | `--base-url` | Der ArcGIS-Dienst; die Ladeeinrichtungen liegen in Layer `0`. |
| **`--where`** | Option | Esri-SQL-Filter über die Spalten (unterscheidet Groß- und Kleinschreibung, Zeichenketten in einfachen Anführungszeichen). |
| **`--near` / `--radius`** | Optionen | Räumliche Abfrage: Ladeeinrichtungen im Umkreis von `radius` km um einen Punkt `lat,lon`. |
| **`exceededTransferLimit`** | Ausgabefeld | `true` ⇒ es passten mehr Features, als zurückgegeben wurden; blättern Sie mit `--limit`/`--offset`. |
| **`count-by`** | Befehl | Serverseitig gruppierte Zählungen (`outStatistics`), z. B. Ladeeinrichtungen je `state`. |

## Die Daten lesen

- **Leistungen sind in kW angegeben.** `max_electric_power_station` ist das Maximum der Ladeeinrichtung.
  Es ist eine Textspalte: `max_electric_power_station >= 150` scheitert mit einem ArcGIS-Fehler 400,
  schreiben Sie daher `CAST(max_electric_power_station AS FLOAT) >= 150` (und casten Sie auch in
  `--order-by`, das sonst als Text sortiert).
- **`Typ` richtet sich nach der Leistung, nicht nach AC oder DC.** Er folgt der
  Ladesäulenverordnung: Eine `Schnellladeeinrichtung` hat einen Ladepunkt mit mehr als 22 kW.
  Die meisten davon laden mit Gleichstrom, aber nicht alle – 48 Schnellladeeinrichtungen hatten am
  26.09.2026 keinen DC-Anschluss (z. B. AC Typ 2 mit 25 kW). Für „DC-Lader“ filtern Sie nach den
  Steckerspalten, z. B. `Steckersystem_Ladepunkt1 LIKE '%DC%'`.
- **`go_live_date` ist Text im Format `tt.mm.jjjj`**, daher liefert `--order-by "go_live_date DESC"`
  zuerst `31.12.2025`, obwohl 2026 Ladeeinrichtungen in Betrieb gingen. Filtern Sie nach Jahr oder
  Monat mit `LIKE '%.2026'` / `LIKE '%.08.2026'`, statt zu sortieren.
- **Gezählt werden Ladeeinrichtungen, nicht Ladepunkte** – eine Ladeeinrichtung kann mehrere
  Ladepunkte haben (`Anzahl_Ladepunkte`); machen Sie deutlich, welche Zahl gefragt ist.
- **Das Register ist eine Momentaufnahme**, die regelmäßig (etwa täglich) aktualisiert wird;
  die Zahlen verschieben sich.
