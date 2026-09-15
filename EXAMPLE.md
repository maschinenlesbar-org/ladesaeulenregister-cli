# Examples

Real examples for the Claude Code skills of the `ladesaeulen` plugin, one per skill: a request,
the `ladesaeulen` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `ladesaeulen` 0.0.4.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [ladesaeulen-near](#ladesaeulen-near) · [ladesaeulen-search](#ladesaeulen-search) · [ladesaeulen-stats](#ladesaeulen-stats)

## ladesaeulen-near

> I'm arriving at Köln Hauptbahnhof by car. Which fast chargers are within 2 km?

```bash
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --count
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --where "Typ='Schnellladeeinrichtung'" --count
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --where "Typ='Schnellladeeinrichtung'" --limit 100 --compact
```

The CLI doesn't geocode, so the skill used Köln Hbf ≈ `50.9430,6.9589`. It counted first (297
stations in the radius, 14 of them fast), then listed the 14. `Betreiber` is empty on 13 of the 14
rows, so the operator comes from `operator_companyName`. Distances are straight-line from the
station coordinates.

```
Fast chargers within 2 km of Köln Hbf — 14 of 297 stations, all "In Betrieb"

  km    kW   points  operator                        address                         ID
 0.53   50     1     carré domstraße gmbh & co.kg    Domstr. 55-73, 50668            1062404
 0.59  100     2     TankE GmbH                      Dagobertstr. 7, 50668           1088717
 0.96   72     2     TankE GmbH                      Am Malzbüchel 1, 50667          1059502
 1.05  150     2     Aral Pulse (BP Europa SE)       Riehler Straße 12-14, 50668     1055348
 1.20  100     2     TankE GmbH                      Peterstr. 29, 50676             1059673
 1.22   72     2     TankE GmbH                      Georgsplatz 17, 50676           1059506
 1.40  100     2     TankE GmbH                      Neusser Wall 1, 50670           1077733
 1.41  120     2     Vattenfall Smarter Living GmbH  Holzmarkt 47, 50676             1152255
 1.48  100     2     TankE GmbH                      Holzmarkt 1, 50676              1062868
 … 5 more TankE GmbH sites between 1.57 and 1.99 km (72–100 kW)

Most powerful nearby: Aral Pulse, Riehler Straße 12-14 (150 kW), 1.05 km north of the station.
Source: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

Next steps offered: the same radius as GeoJSON for a map (`--geojson --limit 200`), or all 297 stations including normal AC chargers.

## ladesaeulen-search

> Where in München can I charge at 300 kW or more?

```bash
ladesaeulen fields
ladesaeulen stations --where "Ort='München' AND Typ='Schnellladeeinrichtung'" --count
ladesaeulen stations --where "Ort='München' AND max_electric_power_station >= 300" --count   # exit 1: ArcGIS error 400
ladesaeulen stations --where "Ort='München' AND CAST(max_electric_power_station AS FLOAT) >= 300" --count
ladesaeulen stations --where "Ort='München' AND CAST(max_electric_power_station AS FLOAT) >= 300" --order-by "max_electric_power_station DESC" --limit 100 --compact
```

The skill's numeric filter failed: `fields` lists `max_electric_power_station` as
`esriFieldTypeString`, so `>= 300` is rejected with a 400. Casting the column fixed it. The
string sort is safe here only because every matching value has three digits.

```
München, stations with ≥ 300 kW — 51 stations (of 268 fast chargers) at 29 sites, 110 charge points
exceededTransferLimit: false, all "In Betrieb"

400 kW
  SWM Versorgungs GmbH          Lerchenauer Str. 65, 80809         5 stations · 10 pts
  EnBW mobility+ AG und Co.KG   Ludwig-Koch-Straße 3, 81249        3 stations ·  6 pts
  Audi AG                       Bodenseestr. 111, 81243            2 stations ·  4 pts
  Milence Germany GmbH          Werner-Heisenberg-Allee 21, 80939  2 stations ·  4 pts
  Audi München GmbH             Albrechtstr. 16, 80636             1 station  ·  2 pts
  SMATRICS GmbH & Co KG         Wasserburger Landstr. 285, 81827   1 station  ·  2 pts
320 kW
  Pfalzwerke AG                 Hans-Steinkohl-Str. 30, 81249      4 stations ·  8 pts
  Jolt Energy GmbH              6 sites, 1 station each, e.g. Arnulfstr. 279, Effnerstr. 130
  Pfalzwerke AG                 Muthmannstr. 4, 80939              1 station  ·  2 pts
300 kW
  BP Europa SE (Aral Pulse)     Ingolstädter Str. 164-166, 80939   4 stations ·  8 pts
  Georg Jos. Kaes GmbH          Maria-Probst-Str. 6, 80939         2 stations ·  8 pts
  … 13 more sites (Jolt, BP, Pfalzwerke, Shell, EnBW, Audi AG, EWE Go, Mer, Tessol)

By operator (stations): Jolt Energy 12, Pfalzwerke 8, BP Europa SE 7, EnBW 5, SWM 5.
Source: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

## ladesaeulen-stats

> Which Bundesland has the most fast chargers, and which operators run the most of them?

```bash
ladesaeulen fields
ladesaeulen count-by Typ --compact
ladesaeulen count-by state --where "Typ='Schnellladeeinrichtung'" --compact
ladesaeulen count-by state --compact
ladesaeulen count-by Betreiber --where "Typ='Schnellladeeinrichtung'" --compact | jq -c '.[:8], length'   # top group is null
ladesaeulen count-by operator_companyName --where "Typ='Schnellladeeinrichtung'" --compact | jq -c '.[:10], length'
```

Grouping by `Betreiber`, as the skill suggests, put `null` first with 17,327 of the 31,188 fast
stations; Tesla and IONITY don't appear at all, EnBW only as `EnBW ODR AG` (29). The skill
re-ran the grouping on `operator_companyName`, which has no `null` group.

```
Fast chargers (Schnellladeeinrichtung): 31,188 of 116,343 public stations (26.8 %)

  Bundesland              fast   all stations   fast share
  Bayern                 6,047      22,803        26.5 %
  Nordrhein-Westfalen    5,697      22,521        25.3 %
  Niedersachsen          3,813      11,500        33.2 %
  Baden-Württemberg      3,611      18,754        19.3 %
  Hessen                 2,530       8,944        28.3 %
  … 11 more; highest share Sachsen-Anhalt 44.3 %, lowest Berlin 14.1 % (699 of 4,963)

  Operator (operator_companyName)       fast stations
  EnBW mobility+ AG und Co.KG               4,712  (15.1 %)
  Tesla Germany GmbH                        3,943  (12.6 %)
  BP Europa SE                              1,574
  IONITY GmbH                               1,301
  Shell Deutschland GmbH                    1,265
  … then EWE Go 1,229, Allego 1,151, Pfalzwerke 951 — 1,810 operators in total

These are stations (Ladeeinrichtungen), not charge points.
Source: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

Next steps offered: the same split for one Bundesland (`--where "state='Bayern' AND …"`), or top cities with `count-by Ort`.
