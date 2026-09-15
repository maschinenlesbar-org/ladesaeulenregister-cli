# ladesaeulenregister-cli

[![CI](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/ladesaeulenregister-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/ladesaeulenregister-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/ladesaeulenregister-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/ladesaeulenregister-cli/de/) — command reference, guides and API docs

A dependency-light **TypeScript client + CLI** for the **Ladesäulenregister** — the
Bundesnetzagentur's register of public EV charging stations in Germany (about 116,000
Ladeeinrichtungen as of September 2026). Backed by a public **ArcGIS FeatureServer**. A
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

## CLI

```bash
# (counts as of 2026-09-15)
ladesaeulen stations --count                                   # total public stations → 116343
ladesaeulen stations --where "Ort='Berlin' AND Typ='Schnellladeeinrichtung'" --count   # → 695
ladesaeulen stations --near 52.52,13.405 --radius 1 --count    # within 1 km of a point → 127
ladesaeulen stations --where "state='Bayern'" --limit 20       # a page of stations
ladesaeulen stations --geojson --limit 200 > stations.geojson  # GeoJSON for a map
ladesaeulen count-by state                                     # stations per Bundesland
ladesaeulen fields                                             # the queryable columns
```

- **`stations`** searches with an SQL `--where`, paging (`--limit`/`--offset`),
  sorting (`--order-by`), field selection (`--fields`), a spatial `--near`/`--radius`,
  and `--count` (just the number) or `--geojson` output.
- **`count-by <field>`** aggregates (e.g. per `state`, `Typ`, `operator_companyName`).
- **`fields`** lists the queryable columns (build `--where`/`--fields`/`count-by`).

Filter values are **SQL, case-sensitive, single-quoted** (`Ort='Berlin'`). Power is a
text column, so compare it with `CAST(max_electric_power_station AS FLOAT) >= 150`. Global
flags: `--base-url`, `--timeout`, `--user-agent`, `--max-retries`,
`--max-response-bytes`, `--compact`. See [Usage.md](Usage.md).

## Library

```ts
import { LadesaeulenClient } from "@maschinenlesbar.org/ladesaeulenregister-cli";

const c = new LadesaeulenClient();
await c.count({ where: "Typ='Schnellladeeinrichtung'" });          // number
await c.countBy("state");                                          // per Bundesland
const near = await c.stations({ near: { lat: 52.52, lon: 13.405, radiusKm: 1 } });
```

## Documentation

- [Usage.md](Usage.md) — commands, the `--where`/spatial options, exit codes
- [DEVELOPING.md](DEVELOPING.md) — architecture, testing, the ArcGIS specifics
- [GLOSSARY.md](GLOSSARY.md) — the register's fields and terms
- [DATA_LICENSE.md](DATA_LICENSE.md) — the CC BY 4.0 data terms
- [SKILLS.md](SKILLS.md) — the Claude Code skills this repo ships

## Licence

Code is dual-licensed **AGPL-3.0-or-later OR commercial** — see
[LICENSING.md](LICENSING.md). No external code contributions are accepted (see
[CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and AGPL forks are welcome.
