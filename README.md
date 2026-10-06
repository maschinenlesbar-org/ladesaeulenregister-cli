# ladesaeulenregister-cli

[![CI](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/ladesaeulenregister-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/ladesaeulenregister-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/ladesaeulenregister-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/ladesaeulenregister-cli/de/) — command reference, guides and API docs

A dependency-light **TypeScript client + CLI** for the **Ladesäulenregister** — the
Bundesnetzagentur's register of public EV charging stations in Germany (about 117,600
Ladeeinrichtungen as of October 2026). It lists the stations whose operators have completed
the BNetzA's notification procedure, so the real number of public stations is higher. Backed by a public **ArcGIS FeatureServer**. A
[bund.dev](https://bund.dev) API.

- **No API key.** The public charging-station data is open.
- **Zero runtime HTTP dependencies.** Built on `node:http`/`https`; the CLI's only
  runtime dependency is `commander`.
- **Library + CLI.** Use the typed `LadesaeulenClient`, or the `ladesaeulen` command.

> **We provide the tool, not the data.** The data is © the Bundesnetzagentur under
> **CC BY 4.0** — free to use with attribution. See [DATA_LICENSE.md](DATA_LICENSE.md).

## Install

```bash
npm install -g @maschinenlesbar.org/ladesaeulenregister-cli   # the `ladesaeulen` command
# or as a library:
npm install @maschinenlesbar.org/ladesaeulenregister-cli
```

Requires **Node.js 22.12+**. If `ladesaeulen` isn't found after a global install, run
`npm prefix -g` and add its `bin` directory (on Windows, the prefix itself) to `PATH`.

## CLI

```bash
# (counts as of 2026-09-15)
ladesaeulen stations --count                                   # stations in the register → 116343
ladesaeulen stations --where "Ort='Berlin' AND Typ='Schnellladeeinrichtung'" --count   # → 695
ladesaeulen stations --near 52.52,13.405 --radius 1 --count    # within 1 km of a point → 127
ladesaeulen stations --where "state='Bayern'" --limit 20       # a page of stations
ladesaeulen stations --geojson --limit 200 > stations.geojson  # GeoJSON for a map
ladesaeulen count-by state                                     # stations per Bundesland
ladesaeulen fields                                             # the queryable columns
ladesaeulen info                                               # how current the data is (last edit date)
```

- **`stations`** searches with an SQL `--where`, paging (`--limit`/`--offset`),
  sorting (`--order-by`), field selection (`--fields`), a spatial `--near`/`--radius`,
  and `--count` (just the number) or `--geojson` output.
- **`count-by <field>`** aggregates (e.g. per `state`, `Typ`, `operator_companyName`).
- **`fields`** lists the queryable columns (build `--where`/`--fields`/`count-by`).
- **`info`** prints the layer's last edit date (`dataLastEditDate`), the register's as-of
  date: the data is a snapshot, refreshed irregularly, and no row carries a date.

Filter values are **SQL, single-quoted** (`Ort='Berlin'`); text comparisons ignore case. `max_electric_power_station` is
the operator's figure for the whole station — often the **sum** of its charge points (2 × 160 kW
reads `320`) — and a text column (`CAST(max_electric_power_station AS FLOAT) >= 150`). For
"where can a car charge at N kW", use `--min-point-kw N`: it reads each charge point's
connector rating and adds `max_charge_point_kw` to every row
(`ladesaeulen stations --where "Ort='München'" --min-point-kw 300` → 36 stations, where the
station figure alone gives 49; 2026-10-06). Global
flags: `--base-url`, `--timeout`, `--user-agent`, `--max-retries` (429/503 responses and
reset connections), `--max-response-bytes`, `--compact`. A `--base-url` on plain `http:` to a host other than
loopback (`localhost`, `127.0.0.0/8`, `::1`) prints one
`warning: requests to <host> are sent unencrypted (http:, not https:)` line on stderr
before the first request (naming the URL's credentials instead when it carries any,
never printing them); stdout and the exit code are unchanged. See [Usage.md](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/blob/main/Usage.md).

## Library

```ts
import { LadesaeulenClient } from "@maschinenlesbar.org/ladesaeulenregister-cli";

const c = new LadesaeulenClient();
await c.count({ where: "Typ='Schnellladeeinrichtung'" });          // number
await c.countBy("state");                                          // per Bundesland
const near = await c.stations({ near: { lat: 52.52, lon: 13.405, radiusKm: 1 } });
// stations with a charge point of at least 300 kW; each row gets max_charge_point_kw
const fast = await c.stations({ where: "Ort='München'", minChargePointKw: 300, limit: 200 });
```

## Documentation

- [Usage.md](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/blob/main/Usage.md) — commands, the `--where`/spatial options, exit codes
- [DEVELOPING.md](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/blob/main/DEVELOPING.md) — architecture, testing, the ArcGIS specifics
- [GLOSSARY.md](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/blob/main/GLOSSARY.md) — the register's fields and terms
- [DATA_LICENSE.md](DATA_LICENSE.md) — the CC BY 4.0 data terms
- [SKILLS.md](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/blob/main/SKILLS.md) — the Claude Code skills this repo ships

## Licence

Code is dual-licensed **AGPL-3.0-or-later OR commercial** — see
[LICENSING.md](LICENSING.md). No external code contributions are accepted (see
[CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and AGPL forks are welcome.
