# Glossar

Begriffe und Felder des Ladesäulenregisters, so wie die CLI sie ausgibt. Die Feldnamen in den
Daten sind deutsch (mit Umlauten); übernehmen Sie sie in `--where` unverändert.

| Begriff | In der CLI | Was es ist |
|---|---|---|
| **Ladesäulenregister** | – | Das Register der Bundesnetzagentur für öffentlich zugängliche Ladeeinrichtungen für E-Autos in Deutschland. Es enthält nur die Ladeeinrichtungen der Betreiber, die das Anzeigeverfahren vollständig abgeschlossen haben, und **zählt daher zu wenig**: Laut Bundesnetzagentur ist die Zahl der öffentlich zugänglichen Ladeeinrichtungen in Deutschland größer. |
| **Ladeeinrichtung** | ein Feature / eine Zeile | Eine einzelne Ladestation. `Typ` ist `Normalladeeinrichtung` oder `Schnellladeeinrichtung` – nach Leistung, nicht nach Stromart (siehe unten). |
| **Ladepunkt** | `Anzahl_Ladepunkte` | Ein einzelner Anschluss bzw. eine einzelne Steckdose. Eine Ladeeinrichtung hat einen oder mehrere; das Register zählt *Ladeeinrichtungen*, nicht Ladepunkte. `Anzahl_Ladepunkte` ist eine Textspalte (`"2"`). |
| **Betreiber / operator** | `Betreiber`, `operator_companyName` | Der Betreiber der Ladepunkte. `operator_companyName` ist der Firmenname und bei jeder Ladeeinrichtung gefüllt; `Betreiber` ist ein kurzer Anzeigename, der bei mehr als der Hälfte der Ladeeinrichtungen `null` ist. Filtern und gruppieren Sie daher nach `operator_companyName`. |
| **`state`** | Filter / `count-by` | Bundesland, z. B. `Bayern`. |
| **`Ort` / `Postleitzahl` / `Straße` / `Hausnummer`** | Felder | Anschrift: Ort, Postleitzahl, Straße und Hausnummer. |
| **`Status`** | Feld | Betriebsstatus, z. B. `In Betrieb`. |
| **`max_electric_power_station`** | Feld | Die Leistungsangabe des Betreibers für die **ganze Ladeeinrichtung**, in **kW**, als Text gespeichert (`"150"`, `"3.7"`; die Spalte ist `esriFieldTypeString`). **Nicht die Leistung, die ein Auto bekommt:** Viele Betreiber tragen die Summe der Ladepunkte ein (2 × 160 kW CCS → `"320"`, 2 × 22 kW AC → `"44"`), andere den schnellsten Ladepunkt (4 × 22 kW → `"22"`), manche eine Begrenzung der Ladeeinrichtung unterhalb der Steckerleistung. Vergleichen und sortieren Sie mit `CAST(max_electric_power_station AS FLOAT)`. |
| **`max_charge_point_kw`** | abgeleitetes Feld, `--min-point-kw` | Von CLI und Bibliothek ergänzt, keine Spalte des Registers: das Höchste, was **ein Ladepunkt** liefern kann – die höchste Steckerleistung in `Steckersystem_Ladepunkt1..10` (`… (160 kw)`), begrenzt auf `max_electric_power_station`, wenn diese niedriger ist. Steht in jeder Zeile mit einer Steckerspalte; `null`, wenn kein Stecker eine Leistung hat. `stations --min-point-kw N` filtert danach. |
| **`go_live_date`** | Feld | Datum der Inbetriebnahme, gespeichert als **Text im Format `tt.mm.jjjj`** (`"31.08.2026"`; `esriFieldTypeString`). Eine Sortierung danach sortiert den Text, beginnend mit dem Tag, und liefert daher nicht die neuesten Ladeeinrichtungen; filtern Sie nach Jahr oder Monat mit `LIKE` (`go_live_date LIKE '%.2026'`, `go_live_date LIKE '%.08.2026'`). |
| **`Steckersystem_Ladepunkt1..10`** | Felder | Steckersystem je Ladepunkt, eine Zeile je Stecker mit seiner Leistung: `DC Fahrzeugkupplung Typ Combo 2 (CCS) (150 kw)`, `AC Typ 2 Steckdose (22 kw)\nAC Schuko (22 kw)`; `( kw)`, wenn der Betreiber die Leistung leer gelassen hat. Das Register füllt höchstens sechs. |
| **`coordinates_latitude` / `coordinates_longitude`** | Felder | Position in WGS84 (zugleich die Geometrie des Features). |
| **FeatureServer / Layer** | `--base-url` | Der ArcGIS-Dienst; die Ladeeinrichtungen liegen in Layer `0`. |
| **`--where`** | Option | Esri-SQL-Filter über die Spalten, Zeichenketten in einfachen Anführungszeichen. Textvergleiche ignorieren Groß- und Kleinschreibung (`Ort='berlin'` findet `Berlin`, auch mit `LIKE`); eine andere Schreibweise findet also nichts Neues. |
| **`--near` / `--radius`** | Optionen | Räumliche Abfrage: Ladeeinrichtungen im Umkreis von `radius` km um einen Punkt `lat,lon`. |
| **`exceededTransferLimit`** | Ausgabefeld | `true` ⇒ es passten mehr Features, als zurückgegeben wurden; blättern Sie mit `--limit`/`--offset`. |
| **`count-by`** | Befehl | Serverseitig gruppierte Zählungen (`outStatistics`), z. B. Ladeeinrichtungen je `state`. |
| **`info`** | Befehl | Wie aktuell das Register ist: Name des Layers und seine letzten Bearbeitungsdaten (`dataLastEditDate`, ISO 8601). |

## Die Daten lesen

- **Leistungen sind in kW angegeben.** `max_electric_power_station` ist die Angabe des Betreibers
  für die ganze Ladeeinrichtung, und die Betreiber füllen sie unterschiedlich: oft als Summe der
  Ladepunkte, sodass 2 × 160 kW als `320` und 2 × 22 kW als `44` erscheinen. In München hatten 13 der
  49 Ladeeinrichtungen mit einer Angabe ab 300 kW keinen Ladepunkt über 200 kW (05.10.2026). Für
  „Wo kann ein Auto mit N kW laden?“ nutzen Sie `stations --min-point-kw N` (Bibliothek:
  `minChargePointKw`); das liest die Steckerleistungen und ergänzt `max_charge_point_kw`. Die Angabe
  der Ladeeinrichtung ist eine Textspalte: `max_electric_power_station >= 150` scheitert mit einem
  ArcGIS-Fehler 400, schreiben Sie daher `CAST(max_electric_power_station AS FLOAT) >= 150` (und
  casten Sie auch in `--order-by`, das sonst als Text sortiert).
- **`Typ` richtet sich nach der Leistung, nicht nach AC oder DC.** Er folgt der
  Ladesäulenverordnung: Eine `Schnellladeeinrichtung` hat einen Ladepunkt mit mehr als 22 kW.
  Die meisten davon laden mit Gleichstrom, aber nicht alle – 48 Schnellladeeinrichtungen hatten am
  26.09.2026 keinen DC-Anschluss (z. B. AC Typ 2 mit 25 kW). Für „DC-Lader“ filtern Sie nach den
  Steckerspalten **aller** Ladepunkte, `(Steckersystem_Ladepunkt1 LIKE '%DC%' OR Steckersystem_Ladepunkt2 LIKE '%DC%' OR … OR Steckersystem_Ladepunkt6 LIKE '%DC%')`, in Klammern, wenn Sie mit `AND` kombinieren.
  Ladepunkt 1 allein verfehlt etwa 6 %: 30.798 Ladeeinrichtungen haben DC an Ladepunkt 1, 32.825 an
  irgendeinem Ladepunkt (06.10.2026).
- **`go_live_date` ist Text im Format `tt.mm.jjjj`**, daher liefert `--order-by "go_live_date DESC"`
  zuerst `31.12.2025`, obwohl 2026 Ladeeinrichtungen in Betrieb gingen. Filtern Sie nach Jahr oder
  Monat mit `LIKE '%.2026'` / `LIKE '%.08.2026'`, statt zu sortieren.
- **Sechzehn aufgeführte Spalten sind immer leer.** `ladesaeulen fields` nennt sie, aber sie sind in
  jeder Zeile `null` (geprüft am 06.10.2026): die Spalten je Stecker `evses_*` (z. B.
  `evses_evse_connectors_connector___max_electric_power_connector`), `documentDate`, `documentTime`,
  `json_type` und `Steckersystem_Ladepunkt7..10`. Ein Filter darauf findet nichts (`0`, Exit-Code 0),
  eine Gruppierung ergibt eine einzige `null`-Gruppe; die CLI gibt einen Hinweis aus, wenn Sie eine
  davon nennen. `F_overlaps` (immer `1`) und `fme_rejection_code` (immer `MISSING_PARAMETER_LIST`)
  sind gefüllt, sagen aber nichts über eine Ladeeinrichtung. Die Leistung je Stecker steht stattdessen
  im Text von `Steckersystem_LadepunktN` (`max_charge_point_kw`).
- **Gezählt werden Ladeeinrichtungen, nicht Ladepunkte** – eine Ladeeinrichtung kann mehrere
  Ladepunkte haben (`Anzahl_Ladepunkte`); machen Sie deutlich, welche Zahl gefragt ist.
- **Das Register ist eine Momentaufnahme und wird unregelmäßig aktualisiert.** Keine Zeile trägt
  ein Stand-Datum (`documentDate` ist in jeder Zeile leer); das einzige Datum ist das Bearbeitungsdatum
  des Layers, das `ladesaeulen info` ausgibt (`dataLastEditDate`). Am 05.10.2026 war der Layer zuletzt
  am 01.10.2026 bearbeitet worden, und im September blieb seine Gesamtzahl mindestens 11 Tage gleich;
  der CSV-Download der Bundesnetzagentur erscheint monatlich. Nennen Sie das Datum zu jeder Zahl.
