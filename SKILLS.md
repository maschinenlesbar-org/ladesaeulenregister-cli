# Skills

`ladesaeulenregister-cli` ships **Claude Code Agent Skills** as a Claude Code plugin,
so Claude can drive the `ladesaeulen` CLI for common charging-station tasks. The
skills **validate** that the `ladesaeulen` CLI is on your PATH and tell you if it is
missing — they never install anything.

| Skill | Use it when you want to… |
|---|---|
| **ladesaeulen-search** | Find and count stations — by place, operator, connector, power or status — with the SQL `--where` filter, and discover the field names. |
| **ladesaeulen-near** | Find stations near a location — a spatial `--near`/`--radius` query around a `lat,lon` point (optionally as GeoJSON). |
| **ladesaeulen-stats** | Aggregate — stations per Bundesland, per operator, normal vs fast, top cities — via `count-by`. |

They compose: **search → near**, or **search → stats**.

## Requirements

- The `ladesaeulen` CLI on PATH: `npm install -g @maschinenlesbar.org/ladesaeulenregister-cli`.
- **No API key** — the register's public data is open.
- **Notes:** `--where` is Esri SQL (single-quoted strings, compared ignoring case — confirm
  column names and types with `ladesaeulen fields`); `max_electric_power_station` is the
  station's figure, often the sum of its charge points, so "charge at N kW" uses
  `--min-point-kw N` and its `max_charge_point_kw` per charge point; filter and group operators
  on `operator_companyName`, since `Betreiber` is often `null`; `--near` needs `lat,lon` coordinates (this
  CLI does not geocode); a `true` `exceededTransferLimit` means page with
  `--limit`/`--offset`; use `--count`/`count-by` for totals rather than paging;
  `ladesaeulen info` gives the date the data was last edited, to cite with an answer.

## Installing the plugin

This repo is a Claude Code plugin (`.claude-plugin/plugin.json` + `skills/`),
published as `ladesaeulen` in the
[maschinenlesbar.org plugin marketplace](https://github.com/maschinenlesbar-org/plugins).
Install it inside Claude Code to enable the three skills:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install ladesaeulen@maschinenlesbar
```

The `skills/` and `.claude-plugin/` files are **not** shipped in the npm tarball — the
published package is the client/CLI only.

The data these skills surface is the Bundesnetzagentur's, under **CC BY 4.0**
(attribution required) — see [DATA_LICENSE.md](DATA_LICENSE.md). Cite the source.
