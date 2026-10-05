# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `ladesaeulen`, eines pro Skill: eine
Anfrage, die `ladesaeulen`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 mit `ladesaeulen` 0.2.0 gegen die Live-API; die Daten des
Registers wurden zuletzt am 1. Oktober 2026 bearbeitet (`ladesaeulen info`).
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [ladesaeulen-near](#ladesaeulen-near) · [ladesaeulen-search](#ladesaeulen-search) · [ladesaeulen-stats](#ladesaeulen-stats)

## ladesaeulen-near

> Ankunft mit dem Auto am Kölner Hauptbahnhof: Welche Schnelllader gibt es im Umkreis von 2 km?

```bash
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --count
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --where "Typ='Schnellladeeinrichtung'" --count
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --where "Typ='Schnellladeeinrichtung'" \
  --fields "ID,operator_companyName,Betreiber,Straße,Hausnummer,Postleitzahl,Ort,Status,max_electric_power_station,Anzahl_Ladepunkte,coordinates_latitude,coordinates_longitude,Steckersystem_Ladepunkt1,Steckersystem_Ladepunkt2,Steckersystem_Ladepunkt3,Steckersystem_Ladepunkt4,Steckersystem_Ladepunkt5,Steckersystem_Ladepunkt6" \
  --limit 100 --compact
```

Die CLI geokodiert nicht, deshalb nahm der Skill für Köln Hbf ≈ `50.9430,6.9589`. Er zählte zuerst
(297 Ladeeinrichtungen im Umkreis, 14 davon Schnelllader) und listete dann die 14 mit ihren
Steckerspalten, sodass jede Zeile `max_charge_point_kw` mitbrachte, die Leistung eines Ladepunkts.
Das macht hier einen Unterschied: Die drei TankE-Ladeeinrichtungen mit einer Angabe von 72 kW
bestehen aus einem CCS-Ladepunkt mit 50 kW und einer AC-Steckdose mit 22 kW; ein Auto bekommt dort
also 50 kW, nicht 72. `Betreiber` ist bei 13 der 14 Zeilen leer, der Betreiber kommt daher aus
`operator_companyName`. Die Entfernungen sind Luftlinie, berechnet aus den Koordinaten der
Ladeeinrichtungen.

```
Schnelllader im Umkreis von 2 km um Köln Hbf – 14 von 297 Ladeeinrichtungen, alle „In Betrieb"

  km    kW je Ladepunkt  Punkte  Betreiber                       Adresse                       ID
 0,53         50            1    carré domstraße gmbh & co.kg    Domstr. 55-73, 50668          1062404
 0,59        100            2    TankE GmbH                      Dagobertstr. 7, 50668         1088717
 0,96         50            2    TankE GmbH                      Am Malzbüchel 1, 50667        1059502
 1,05        150            2    Aral Pulse (BP Europa SE)       Riehler Straße 12-14, 50668   1055348
 1,20        100            2    TankE GmbH                      Peterstr. 29, 50676           1059673
 1,22         50            2    TankE GmbH                      Georgsplatz 17, 50676         1059506
 1,40        100            2    TankE GmbH                      Neusser Wall 1, 50670         1077733
 1,41        120            2    Vattenfall Smarter Living GmbH  Holzmarkt 47, 50676           1152255
 1,48        100            2    TankE GmbH                      Holzmarkt 1, 50676            1062868
 … 5 weitere Standorte von TankE GmbH zwischen 1,57 und 1,99 km (50–100 kW je Ladepunkt)

Am schnellsten in der Nähe: Aral Pulse, Riehler Straße 12-14, 150 kW je Ladepunkt (CCS), 1,05 km entfernt.
„kW je Ladepunkt" ist der schnellste Stecker eines Ladepunkts; die Angabe der Ladeeinrichtung im
Register addiert bei manchen Betreibern die Ladepunkte (TankEs 50 kW CCS + 22 kW AC ergeben 72).
Quelle: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

Als Nächstes angeboten: nur die Lader mit mindestens 100 kW je Ladepunkt (`--min-point-kw 100`)
oder derselbe Umkreis als GeoJSON für eine Karte (`--geojson --limit 200`).

## ladesaeulen-search

> Wo in München lässt sich mit 300 kW oder mehr laden?

```bash
ladesaeulen info
ladesaeulen stations --where "Ort='München' AND CAST(max_electric_power_station AS FLOAT) >= 300" --count
ladesaeulen stations --where "Ort='München'" --min-point-kw 300 --count
ladesaeulen stations --where "Ort='München'" --min-point-kw 300 --limit 200 --compact
```

Der Skill nahm das Datum aus `info` (Daten zuletzt bearbeitet am 01.10.2026). Ein Filter nur auf die
Angabe der Ladeeinrichtung `max_electric_power_station` ergibt 49 Ladeeinrichtungen, doch diese
Angabe ist oft die Summe der Ladepunkte. Der Skill filterte deshalb mit `--min-point-kw 300`, das die
Steckerleistung jedes Ladepunkts liest: 36 Ladeeinrichtungen. Die 13 ausgelassenen erreichen 300 kW
nur als Summe, etwa die Ladeeinrichtungen von Jolt und Pfalzwerke mit 2 × 160 kW (Angabe 320) und
die von Audi München mit 2 × 200 kW (Angabe 400).

```
München: Mit 300 kW oder mehr kann ein Auto an 36 Ladeeinrichtungen laden (18 Standorte,
80 Ladepunkte), alle „In Betrieb" – Stand der Registerdaten: 1. Oktober 2026

400 kW je Ladepunkt
  SWM Versorgungs GmbH          Lerchenauer Str. 65, 80809         5 Ladeeinr. · 10 Pkt.
  EnBW mobility+ AG und Co.KG   Ludwig-Koch-Straße 3, 81249        3 Ladeeinr. ·  6 Pkt.
  Audi AG                       Bodenseestr. 111, 81243            2 Ladeeinr. ·  4 Pkt.
  Milence Germany GmbH          Werner-Heisenberg-Allee 21, 80939  2 Ladeeinr. ·  4 Pkt.
300 kW je Ladepunkt
  BP Europa SE (Aral Pulse)     Ingolstädter Str. 164-166, 80939   4 Ladeeinr. ·  8 Pkt.
  Pfalzwerke AG                 Goteboldstraße 9, 81247            3 Ladeeinr. ·  6 Pkt.
  Georg Jos. Kaes GmbH          Maria-Probst-Str. 6, 80939         2 Ladeeinr. ·  8 Pkt.
  Shell Deutschland GmbH        Verdistrasse 96, 81247             2 Ladeeinr. ·  4 Pkt.
  Jolt Energy GmbH              4 Standorte, z. B. Chiemgaustr. 185 (2), Baierbrunner Str. 23
  … 6 weitere Standorte (BP ×2, EnBW, Audi AG, Mer, Tessol)

Nach Betreiber (Ladeeinrichtungen): BP Europa SE 7, Jolt 5, EnBW 5, SWM 5, Pfalzwerke 3, Audi AG 3.
Nicht gezählt: 13 Ladeeinrichtungen, deren Angabe ab 300 kW die Summe langsamerer Ladepunkte ist
(2 × 160, 2 × 200 kW).
Quelle: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

## ladesaeulen-stats

> Welches Bundesland hat die meisten Schnelllader, und welche Betreiber betreiben die meisten davon?

```bash
ladesaeulen info
ladesaeulen count-by Typ --compact
ladesaeulen count-by state --where "Typ='Schnellladeeinrichtung'" --compact
ladesaeulen count-by state --compact
ladesaeulen count-by operator_companyName --where "Typ='Schnellladeeinrichtung'" --compact | jq -c '.[:10], length'
```

Der Skill gruppierte die Betreiber nach `operator_companyName` (keine `null`-Gruppe) und nannte den
Stand aus `info`. Die Betreiberliste hat 1.818 Gruppen, weniger als die Grenze von 2.000 Gruppen,
und ist damit vollständig.

```
Schnelllader (Schnellladeeinrichtung): 31.542 von 117.584 Ladeeinrichtungen im Register (26,8 %),
Stand der Daten: 1. Oktober 2026

  Bundesland            Schnelllader   alle   Anteil schnell
  Bayern                     6.116    23.045      26,5 %
  Nordrhein-Westfalen        5.766    22.679      25,4 %
  Niedersachsen              3.874    11.701      33,1 %
  Baden-Württemberg          3.622    18.903      19,2 %
  Hessen                     2.543     9.036      28,1 %
  … 11 weitere; höchster Anteil Sachsen-Anhalt 44,0 %, niedrigster Berlin 14,1 % (707 von 5.003)

  Betreiber (operator_companyName)      Schnelllader
  EnBW mobility+ AG und Co.KG               4.717  (15,0 %)
  Tesla Germany GmbH                        3.950  (12,5 %)
  BP Europa SE                              1.574
  IONITY GmbH                               1.311
  Shell Deutschland GmbH                    1.274
  … dann EWE Go 1.245, Allego 1.151, Pfalzwerke 951 – insgesamt 1.818 Betreibergesellschaften
  (eine Marke kann unter mehreren Gesellschaften erscheinen)

Gezählt sind Ladeeinrichtungen, nicht Ladepunkte, und nur die von Betreibern, die das Anzeigeverfahren
der Bundesnetzagentur abgeschlossen haben: Die tatsächliche Zahl öffentlicher Ladeeinrichtungen ist höher.
Quelle: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

Als Nächstes angeboten: dieselbe Aufteilung für ein Bundesland (`--where "state='Bayern' AND …"`) oder die Städte mit den meisten Ladeeinrichtungen per `count-by Ort`.
