# Examples

Real examples for the Claude Code skills of the `ladesaeulen` plugin, one per skill: a request,
the `ladesaeulen` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026 with `ladesaeulen` 0.2.0; the
register's data was last edited on 1 October 2026 (`ladesaeulen info`).
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [ladesaeulen-near](#ladesaeulen-near) · [ladesaeulen-search](#ladesaeulen-search) · [ladesaeulen-stats](#ladesaeulen-stats)

## ladesaeulen-near

> I'm arriving at Köln Hauptbahnhof by car. Which fast chargers are within 2 km?

```bash
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --count
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --where "Typ='Schnellladeeinrichtung'" --count
ladesaeulen stations --near 50.9430,6.9589 --radius 2 --where "Typ='Schnellladeeinrichtung'" \
  --fields "ID,operator_companyName,Betreiber,Straße,Hausnummer,Postleitzahl,Ort,Status,max_electric_power_station,Anzahl_Ladepunkte,coordinates_latitude,coordinates_longitude,Steckersystem_Ladepunkt1,Steckersystem_Ladepunkt2,Steckersystem_Ladepunkt3,Steckersystem_Ladepunkt4,Steckersystem_Ladepunkt5,Steckersystem_Ladepunkt6" \
  --limit 100 --compact
```

The CLI doesn't geocode, so the skill used Köln Hbf ≈ `50.9430,6.9589`. It counted first (297
stations in the radius, 14 of them fast), then listed the 14 with their connector columns, so
each row came back with `max_charge_point_kw`, the power one charge point delivers. That matters
here: the three TankE stations with a station figure of 72 kW are one 50 kW CCS point plus one
22 kW AC socket, so a car gets 50 kW there, not 72. `Betreiber` is empty on 13 of the 14 rows, so
the operator comes from `operator_companyName`. Distances are straight-line from the station
coordinates.

```
Fast chargers within 2 km of Köln Hbf — 14 of 297 stations, all "In Betrieb"

  km    kW per point  points  operator                        address                       ID
 0.53       50          1     carré domstraße gmbh & co.kg    Domstr. 55-73, 50668          1062404
 0.59      100          2     TankE GmbH                      Dagobertstr. 7, 50668         1088717
 0.96       50          2     TankE GmbH                      Am Malzbüchel 1, 50667        1059502
 1.05      150          2     Aral Pulse (BP Europa SE)       Riehler Straße 12-14, 50668   1055348
 1.20      100          2     TankE GmbH                      Peterstr. 29, 50676           1059673
 1.22       50          2     TankE GmbH                      Georgsplatz 17, 50676         1059506
 1.40      100          2     TankE GmbH                      Neusser Wall 1, 50670         1077733
 1.41      120          2     Vattenfall Smarter Living GmbH  Holzmarkt 47, 50676           1152255
 1.48      100          2     TankE GmbH                      Holzmarkt 1, 50676            1062868
 … 5 more TankE GmbH sites between 1.57 and 1.99 km (50–100 kW per point)

Fastest nearby: Aral Pulse, Riehler Straße 12-14, 150 kW per charge point (CCS), 1.05 km away.
"kW per point" is the fastest connector of a charge point; the register's station figure adds
points up for some operators (TankE's 50 kW CCS + 22 kW AC stations read 72).
Source: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

Next steps offered: only the chargers with at least 100 kW per point (`--min-point-kw 100`), or
the same radius as GeoJSON for a map (`--geojson --limit 200`).

## ladesaeulen-search

> Where in München can I charge at 300 kW or more?

```bash
ladesaeulen info
ladesaeulen stations --where "Ort='München' AND CAST(max_electric_power_station AS FLOAT) >= 300" --count
ladesaeulen stations --where "Ort='München'" --min-point-kw 300 --count
ladesaeulen stations --where "Ort='München'" --min-point-kw 300 --limit 200 --compact
```

The skill took the date from `info` (data last edited 2026-10-01). Filtering on the station
figure `max_electric_power_station` alone gives 49 stations, but that figure is often the sum of
the charge points, so the skill filtered with `--min-point-kw 300`, which reads each charge
point's connector rating: 36 stations. The 13 left out reach 300 kW only as a sum, e.g. Jolt's and
Pfalzwerke's 2 × 160 kW stations (figure 320) and Audi München's 2 × 200 kW (figure 400).

```
München, a car can charge at 300 kW or more at 36 stations (18 sites, 80 charge points),
all "In Betrieb" — register data as of 1 October 2026

400 kW per charge point
  SWM Versorgungs GmbH          Lerchenauer Str. 65, 80809         5 stations · 10 pts
  EnBW mobility+ AG und Co.KG   Ludwig-Koch-Straße 3, 81249        3 stations ·  6 pts
  Audi AG                       Bodenseestr. 111, 81243            2 stations ·  4 pts
  Milence Germany GmbH          Werner-Heisenberg-Allee 21, 80939  2 stations ·  4 pts
300 kW per charge point
  BP Europa SE (Aral Pulse)     Ingolstädter Str. 164-166, 80939   4 stations ·  8 pts
  Pfalzwerke AG                 Goteboldstraße 9, 81247            3 stations ·  6 pts
  Georg Jos. Kaes GmbH          Maria-Probst-Str. 6, 80939         2 stations ·  8 pts
  Shell Deutschland GmbH        Verdistrasse 96, 81247             2 stations ·  4 pts
  Jolt Energy GmbH              4 sites, e.g. Chiemgaustr. 185 (2), Baierbrunner Str. 23
  … 6 more sites (BP ×2, EnBW, Audi AG, Mer, Tessol)

By operator (stations): BP Europa SE 7, Jolt 5, EnBW 5, SWM 5, Pfalzwerke 3, Audi AG 3.
Not counted: 13 stations whose 300+ kW figure is the sum of slower points (2 × 160, 2 × 200 kW).
Source: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

## ladesaeulen-stats

> Which Bundesland has the most fast chargers, and which operators run the most of them?

```bash
ladesaeulen info
ladesaeulen count-by Typ --compact
ladesaeulen count-by state --where "Typ='Schnellladeeinrichtung'" --compact
ladesaeulen count-by state --compact
ladesaeulen count-by operator_companyName --where "Typ='Schnellladeeinrichtung'" --compact | jq -c '.[:10], length'
```

The skill grouped operators by `operator_companyName` (no `null` group) and named the as-of date
from `info`. The operator list has 1,818 groups, below the 2,000-group cap, so it is complete.

```
Fast chargers (Schnellladeeinrichtung): 31,542 of 117,584 stations in the register (26.8 %),
data as of 1 October 2026

  Bundesland              fast   all stations   fast share
  Bayern                 6,116      23,045        26.5 %
  Nordrhein-Westfalen    5,766      22,679        25.4 %
  Niedersachsen          3,874      11,701        33.1 %
  Baden-Württemberg      3,622      18,903        19.2 %
  Hessen                 2,543       9,036        28.1 %
  … 11 more; highest share Sachsen-Anhalt 44.0 %, lowest Berlin 14.1 % (707 of 5,003)

  Operator (operator_companyName)       fast stations
  EnBW mobility+ AG und Co.KG               4,717  (15.0 %)
  Tesla Germany GmbH                        3,950  (12.5 %)
  BP Europa SE                              1,574
  IONITY GmbH                               1,311
  Shell Deutschland GmbH                    1,274
  … then EWE Go 1,245, Allego 1,151, Pfalzwerke 951 — 1,818 operator entities in total
  (one brand can appear under several legal entities)

These are stations (Ladeeinrichtungen), not charge points, and only those whose operators
completed the BNetzA's notification procedure: the real number of public chargers is higher.
Source: © Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)
```

Next steps offered: the same split for one Bundesland (`--where "state='Bayern' AND …"`), or top cities with `count-by Ort`.
