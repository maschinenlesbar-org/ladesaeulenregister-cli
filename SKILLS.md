# Skills

`ladesaeulenregister-cli` ships **Claude Code Agent Skills** as a plugin marketplace,
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
- **Notes:** `--where` is Esri SQL (case-sensitive, single-quoted strings — confirm
  column names with `ladesaeulen fields`); `--near` needs `lat,lon` coordinates (this
  CLI does not geocode); a `true` `exceededTransferLimit` means page with
  `--limit`/`--offset`; use `--count`/`count-by` for totals rather than paging.

## Installing the plugin

This repo is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json` +
`.claude-plugin/plugin.json` + `skills/`). Add it as a marketplace in Claude Code to
enable the three skills. The `skills/` and `.claude-plugin/` files are **not** shipped
in the npm tarball — the published package is the client/CLI only.

The data these skills surface is the Bundesnetzagentur's, under **CC BY 4.0**
(attribution required) — see [DATA_LICENSE.md](DATA_LICENSE.md). Cite the source.
