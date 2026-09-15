# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `ladesaeulen`, eines pro Skill: eine
Anfrage, die `ladesaeulen`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `ladesaeulen` 0.0.4 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [ladesaeulen-near](#ladesaeulen-near) · [ladesaeulen-search](#ladesaeulen-search) · [ladesaeulen-stats](#ladesaeulen-stats)

## ladesaeulen-near

> Ankunft mit dem Auto am Kölner Hauptbahnhof: Welche Schnelllader gibt es im Umkreis von 2 km?

```bash
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --count
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --where "Typ='Schnellladeeinrichtung'" --count
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --where "Typ='Schnellladeeinrichtung'" --limit 100 --compact
```

Die CLI geokodiert nicht, deshalb nahm der Skill für Köln Hbf ≈ `50.9430,6.9589`. Er zählte zuerst
(297 Ladeeinrichtungen im Umkreis, 14 davon Schnelllader) und listete dann die 14. `Betreiber` ist
bei 13 der 14 Zeilen leer, der Betreiber kommt daher aus `operator_companyName`. Die Entfernungen
sind Luftlinie, berechnet aus den Koordinaten der Ladeeinrichtungen.

```
Schnelllader im Umkreis von 2 km um Köln Hbf – 14 von 297 Ladeeinrichtungen, alle „In Betrieb"

  km     kW   LP  Betreiber                       Adresse                         ID
 0,53    50    1  carré domstraße gmbh & co.kg    Domstr. 55-73, 50668            1062404
 0,59   100    2  TankE GmbH                      Dagobertstr. 7, 50668           1088717
 0,96    72    2  TankE GmbH                      Am Malzbüchel 1, 50667          1059502
 1,05   150    2  Aral Pulse (BP Europa SE)       Riehler Straße 12-14, 50668     1055348
 1,20   100    2  TankE GmbH                      Peterstr. 29, 50676             1059673
 1,22    72    2  TankE GmbH                      Georgsplatz 17, 50676           1059506
 1,40   100    2  TankE GmbH                      Neusser Wall 1, 50670           1077733
 1,41   120    2  Vattenfall Smarter Living GmbH  Holzmarkt 47, 50676             1152255
 1,48   100    2  TankE GmbH                      Holzmarkt 1, 50676              1062868
 … 5 weitere Standorte von TankE GmbH zwischen 1,57 und 1,99 km (72–100 kW)

Stärkster in der Nähe: Aral Pulse, Riehler Straße 12-14 (150 kW), 1,05 km nördlich des Bahnhofs.
Quelle: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

Als Nächstes angeboten: derselbe Umkreis als GeoJSON für eine Karte (`--geojson --limit 200`) oder alle 297 Ladeeinrichtungen einschließlich AC-Normallader.

## ladesaeulen-search

> Wo in München lässt sich mit 300 kW oder mehr laden?

```bash
ladesaeulen fields
ladesaeulen stations --where "Ort='München' AND Typ='Schnellladeeinrichtung'" --count
ladesaeulen stations --where "Ort='München' AND max_electric_power_station >= 300" --count   # Exit 1: ArcGIS-Fehler 400
ladesaeulen stations --where "Ort='München' AND CAST(max_electric_power_station AS FLOAT) >= 300" --count
ladesaeulen stations --where "Ort='München' AND CAST(max_electric_power_station AS FLOAT) >= 300" --order-by "max_electric_power_station DESC" --limit 100 --compact
```

Der Zahlenfilter aus dem Skill schlug fehl: `fields` führt `max_electric_power_station` als
`esriFieldTypeString`, deshalb wird `>= 300` mit 400 abgelehnt. Mit einem Cast auf die Spalte
klappte es. Die Textsortierung stimmt hier nur, weil alle Treffer dreistellige Werte haben.

```
München, Ladeeinrichtungen mit ≥ 300 kW – 51 (von 268 Schnellladern) an 29 Standorten, 110 Ladepunkte
exceededTransferLimit: false, alle „In Betrieb"

400 kW
  SWM Versorgungs GmbH          Lerchenauer Str. 65, 80809         5 Einrichtungen · 10 LP
  EnBW mobility+ AG und Co.KG   Ludwig-Koch-Straße 3, 81249        3 Einrichtungen ·  6 LP
  Audi AG                       Bodenseestr. 111, 81243            2 Einrichtungen ·  4 LP
  Milence Germany GmbH          Werner-Heisenberg-Allee 21, 80939  2 Einrichtungen ·  4 LP
  Audi München GmbH             Albrechtstr. 16, 80636             1 Einrichtung  ·  2 LP
  SMATRICS GmbH & Co KG         Wasserburger Landstr. 285, 81827   1 Einrichtung  ·  2 LP
320 kW
  Pfalzwerke AG                 Hans-Steinkohl-Str. 30, 81249      4 Einrichtungen ·  8 LP
  Jolt Energy GmbH              6 Standorte mit je 1 Einrichtung, z. B. Arnulfstr. 279, Effnerstr. 130
  Pfalzwerke AG                 Muthmannstr. 4, 80939              1 Einrichtung  ·  2 LP
300 kW
  BP Europa SE (Aral Pulse)     Ingolstädter Str. 164-166, 80939   4 Einrichtungen ·  8 LP
  Georg Jos. Kaes GmbH          Maria-Probst-Str. 6, 80939         2 Einrichtungen ·  8 LP
  … 13 weitere Standorte (Jolt, BP, Pfalzwerke, Shell, EnBW, Audi AG, EWE Go, Mer, Tessol)

Nach Betreiber (Einrichtungen): Jolt Energy 12, Pfalzwerke 8, BP Europa SE 7, EnBW 5, SWM 5.
Quelle: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

## ladesaeulen-stats

> Welches Bundesland hat die meisten Schnelllader, und welche Betreiber haben die meisten davon?

```bash
ladesaeulen fields
ladesaeulen count-by Typ --compact
ladesaeulen count-by state --where "Typ='Schnellladeeinrichtung'" --compact
ladesaeulen count-by state --compact
ladesaeulen count-by Betreiber --where "Typ='Schnellladeeinrichtung'" --compact | jq -c '.[:8], length'   # größte Gruppe ist null
ladesaeulen count-by operator_companyName --where "Typ='Schnellladeeinrichtung'" --compact | jq -c '.[:10], length'
```

Die vom Skill vorgeschlagene Gruppierung nach `Betreiber` setzte `null` mit 17.327 der 31.188
Schnelllader an die Spitze; Tesla und IONITY fehlen ganz, EnBW erscheint nur als `EnBW ODR AG`
(29). Der Skill gruppierte deshalb erneut nach `operator_companyName`, das keine `null`-Gruppe hat.

```
Schnelllader (Schnellladeeinrichtung): 31.188 von 116.343 öffentlichen Ladeeinrichtungen (26,8 %)

  Bundesland            Schnelllader   alle   Anteil schnell
  Bayern                     6.047    22.803      26,5 %
  Nordrhein-Westfalen        5.697    22.521      25,3 %
  Niedersachsen              3.813    11.500      33,2 %
  Baden-Württemberg          3.611    18.754      19,3 %
  Hessen                     2.530     8.944      28,3 %
  … 11 weitere; höchster Anteil Sachsen-Anhalt 44,3 %, niedrigster Berlin 14,1 % (699 von 4.963)

  Betreiber (operator_companyName)      Schnelllader
  EnBW mobility+ AG und Co.KG               4.712  (15,1 %)
  Tesla Germany GmbH                        3.943  (12,6 %)
  BP Europa SE                              1.574
  IONITY GmbH                               1.301
  Shell Deutschland GmbH                    1.265
  … dann EWE Go 1.229, Allego 1.151, Pfalzwerke 951 – insgesamt 1.810 Betreiber

Gezählt sind Ladeeinrichtungen, nicht Ladepunkte.
Quelle: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

Als Nächstes angeboten: dieselbe Aufteilung für ein Bundesland (`--where "state='Bayern' AND …"`) oder die Städte mit den meisten Ladeeinrichtungen per `count-by Ort`.
