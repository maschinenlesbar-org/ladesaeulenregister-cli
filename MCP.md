# ladesaeulen-mcp

An [MCP](https://modelcontextprotocol.io/) server for the public EV charging stations in Germany,
the Bundesnetzagentur's [Ladesäulenregister](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenkarte/start.html)
(about 120,000 stations with operator, address, coordinates, connectors and power), as tools for
AI agents. Read-only, no API key; the data is CC BY 4.0 (attribution).

The register lists only the stations whose operators completed the Bundesnetzagentur's
notification procedure, so it undercounts the public chargers in Germany, and it is a snapshot,
refreshed irregularly: every answer carries the register's data date.

It is the MCP side of [ladesaeulenregister-cli](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/ladesaeulenregister-mcp
```

This installs the **`ladesaeulen-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/ladesaeulenregister-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add ladesaeulen -- ladesaeulen-mcp
# or with the image:
claude mcp add ladesaeulen -- docker run -i --rm ghcr.io/maschinenlesbar-org/ladesaeulenregister-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "ladesaeulen": { "command": "ladesaeulen-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "ladesaeulen": { "type": "stdio", "command": "ladesaeulen-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
ladesaeulen-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http ladesaeulen http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/ladesaeulenregister-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/releases) instead of
`latest`: `…/ladesaeulenregister-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/ladesaeulenregister-mcp:<version> --repo maschinenlesbar-org/ladesaeulenregister-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `findStationsNear` | The stations within a radius of a point (latitude, longitude), nearest first, with the straight-line distance; with the filters below. None at a power names the fastest charge point found. |
| `searchStations` | Counts the stations matching the filters and lists a page of them (`limit` 0 counts only); by power per charge point fastest first. An unknown place answers with the places whose name contains it. |
| `countStationsBy` | Station counts per state, place, district, operator, type, status, postcode or number of charge points, largest first, exact; says when the server cut a list at 2,000 groups. |
| `getStationMap` | The stations of a search as a GeoJSON FeatureCollection of points, a page at a time. |
| `getStation` | One station by its register id: every charge point's connectors and rating, payment, opening hours and access notes where the register has them. |
| `getRegisterInfo` | The register's data date (the one to cite), its size, and the columns a `where` of your own can use, with their traps. |

The filters (all tools on stations): `place` (the whole name), `postcode` (or its start),
`district`, `state` (`BY`, `Bayern`, `Bavaria`, `NRW`), `operator` (a part of the company name),
`type` (`normal`, `fast`), `dc`, `connector` (`CHAdeMO`, `Typ 2`), `minPointKw`, `goLiveYear` and
`goLiveMonth`, and `where`, one more condition in the register's SQL.

The traps the tools handle: the power a car can get is `maxChargePointKw`, one charge point's
rating, not `stationKw`, the operator's figure for the whole station, often the sum of its
points (2 × 160 kW reads 320); `fast` (Schnellladeeinrichtung, above 22 kW) is not DC, which is
read from the connectors of all six charge points; the operator is the company name
(`Betreiber` is empty on more than half of the stations), and operators are legal entities, so a
brand can appear under several; the go-live date is `dd.mm.yyyy` text, filtered by year or month.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. A failure is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--base-url <url>           API base URL (default https://services-eu1.arcgis.com/TJm8oSvOdJUQvQT5/arcgis/rest/services/Ladesaeulen/FeatureServer)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP. It listens on loopback by default; it checks the `Host` header
  and, from a browser, the `Origin` (only the origins given with `--allowed-origins`, matched
  exactly) against DNS rebinding and other web pages. Exposed beyond localhost (it logs a warning then), it
  belongs behind a proxy that authenticates.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429, and stops a tool call after its deadline.
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio it ends at once, and when stdin ends.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/blob/main/LICENSING.md)).
Data: the Bundesnetzagentur's, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):
use, also commercial, with the source named
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/ladesaeulenregister-cli/blob/main/DATA_LICENSE.md)).
Every result's `attribution.text` is that credit ("Datenquelle: Ladesäulenregister der
Bundesnetzagentur (bundesnetzagentur.de), lizenziert unter CC BY 4.0 — Datenstand …, abgerufen
am …"); keep it with whatever is passed on. Running this server as a service for others passes
the Bundesnetzagentur's data on: the attribution goes with it.
