# Network allowlist — outbound hosts

The stats aggregator is entirely dependent on outbound HTTPS. When egress is
blocked, every source returns `network-error`, the aggregator fills zero fields
and `/api/stats/...` returns `stats: null` for **every** league.

That failure is indistinguishable from "this league has no data" unless you
check connectivity — which is exactly what `GET /api/diagnostics/connectivity`
is for. Run it first whenever coverage looks universally empty.

## Required hosts

All hosts are HTTPS on port 443.

| Host | Used by | Key required |
|---|---|---|
| `sportscore.com` | SportScore handler — aggregator priority #1 | no |
| `v3.football.api-sports.io` | API-Football handler — priority #2 | `API_FOOTBALL_KEY` |
| `raw.githubusercontent.com` | StatsBomb + GitHubDatasets handlers | no |
| `a.espncdn.com` | Team/league crests (UI imagery) | no |
| `site.api.espn.com` | ESPN fixture feed — schedule and event IDs | no |
| `www.thesportsdb.com` | TheSportsDB handler | no (free tier) |
| `fbref.com` | FBref handler — advanced stats | no |
| `understat.com` | Understat handler — xG | no |
| `api.openligadb.de` | OpenLigaDB handler — German football | no |
| `api.highlightly.com` | Highlightly handler, `/api/highlights` | `HIGHLIGHTLY_KEY` |
| `worldcup2026-api.vercel.app` | worldcup2026 handler | no |

### Secondary hosts

Referenced by non-aggregator routes; allowlist them if you use those features.

| Host | Used by |
|---|---|
| `api.football-data.org` | `/api/football-data`, `src/lib/engine/dataMesh.ts` (`FOOTBALL_DATA_KEY`) |
| `sports.core.api.espn.com` | ESPN core API (supplementary team metadata) |
| `footballapi.premierleague.com` | Official Premier League feed |
| `www.legaseriea.it` | Serie A official feed |
| `www.openligadb.de` | OpenLigaDB web host (alongside `api.openligadb.de`) |

## Corrections to the commonly-quoted 8-domain list

The list circulated during the audit does not match the hosts the code actually
requests. Allowlisting it verbatim would leave several sources blocked:

| Quoted | Actual | Note |
|---|---|---|
| `sportscore.io` | `sportscore.com` | `sportscore.io` appears only in a comment in `src/lib/data/sources/sportscore.ts` as a spec alternative. The live `BASE` constant is `https://sportscore.com`, overridable via `SPORTSCORE_BASE`. Allowlist `.com`; add `.io` only if you set that override. |
| `api.thesportsdb.com` | `www.thesportsdb.com` | The handler calls `www.`, not `api.`. |
| `openligadb.de` | `api.openligadb.de` | Bare domain will not match the API subdomain in a host-exact allowlist. |
| *(absent)* | `site.api.espn.com` | **Missing from the quoted list.** This supplies the fixture feed itself — without it there are no matches to fetch stats for, so the entire app is empty regardless of the other ten hosts. |
| *(absent)* | `api.highlightly.com` | **Missing.** Note the host is `api.highlightly.com`, not `soccer.highlightly.net`. |
| *(absent)* | `worldcup2026-api.vercel.app` | **Missing.** |

## Verifying

```bash
curl -s localhost:3000/api/diagnostics/connectivity | jq '.summary, .blockedHosts'
```

`summary.allReachable: true` means egress is correctly configured. Any host in
`blockedHosts` is still firewalled. A host counts as reachable if it answers at
all — `404`, `429` and `5xx` all prove the connection succeeded; only
`network-error` and `timeout` indicate a block.
