# V4 Predictor backtest — EPL Matchweeks 1–10

Generated: 2026-11-13T07:56:23.182Z · Mode: Pinned GitHub snapshots, 2026/27 EPL

Coverage: **100/100 completed fixtures**, 100/100 archived pre-match odds, 197/200 team-form windows with prior EPL data, 0 Engine failures. 100/100 final scores agree with an independent pinned mirror.

| System | MW1 | MW2 | MW3 | MW4 | MW5 | MW6 | MW7 | MW8 | MW9 | MW10 | Average | Floor | 100+ weeks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Pure EP (Current) | 50 | 80 | 50 | 60 | 60 | 40 | 70 | 20 | 70 | 50 | 55.0 | 20 | 0 |
| V2 Hybrid | 20 | 70 | 90 | 50 | 30 | 20 | 30 | 40 | 40 | 40 | 43.0 | 20 | 0 |
| Consensus Override | 80 | 50 | 40 | 40 | 80 | 70 | 100 | 30 | 80 | 70 | 64.0 | 30 | 1 |
| Pure Engine | 20 | 60 | 90 | 50 | 20 | 20 | 30 | 40 | 30 | 40 | 40.0 | 20 | 0 |
| EP + Draw Guard | 30 | 60 | 110 | 50 | 50 | 40 | 70 | 30 | 60 | 70 | 57.0 | 30 | 1 |

## Decision

- **Implemented winner: Consensus Override** — floor 30, average 64.0, 1 weeks at 100+.
- Highest average: **Consensus Override (64.0)**.
- Highest floor: **Consensus Override, EP + Draw Guard (30)**.
- Most 100+ weeks: **Consensus Override, EP + Draw Guard (1)**.
- Selection rule fixed before scoring: highest floor, then highest average, then most 100+ weeks. No thresholds or team lists were tuned to these results.
- The requested 75–85 average / 60+ floor / two 100+ weeks is a diagnostic target, not a guarantee. The observed results do not all meet it; the measured winner is reported without adjustment. Ten weeks is a small, in-season sample, not proof of future performance.

## Method and leakage controls

1. Fetch each week in kickoff order through the existing `fetchScoreboard` reader. GitHub mode supplies archived schedule rows and disables ESPN merging; MW10 uses the result feed's actual moved kickoff dates.
2. Build last-five form through `buildHistoricalTeamForm`, passing only events strictly before kickoff. The snapshot contains prior-season and current-season EPL results; cup/Championship form and ESPN boxscore mesh profiles are unavailable, so those inputs fall back exactly as the Engine specifies.
3. Price one Dixon–Coles Engine grid per fixture from pre-match form, league anchors and archived **non-closing** average 1X2 / 2.5-goal / Asian-handicap prices. Final scores, match xG, shots, corners, cards and lineups are excluded from the prediction input. Archived odds were retrieved retrospectively, not replayed from timestamped ESPN closing lines.
4. Run all five selectors on that identical bundle. V2 lists/quotas are recovered from merged PR #191. The requested V2 Hybrid preserves the named 2-0 and 1-1 snipes; Elite Away 0-1 goes to the Engine. Consensus retains every original V2 outcome. Draw Guard tests the largest 1X2 probability against a strict 45% threshold.
5. Attach actual scores only after selection; score exact=20, outcome-only=10, miss=0. Average is the mean of ten weekly totals; floor is the minimum weekly total. Every week has ten fixtures.

## Reproduce

```bash
npm ci
npm run backtest:v4 -- --refresh
npx tsc --noEmit
```

The script writes this report and a local per-fixture audit at `.scratch/v4-backtest-audit.json` (gitignored). On sandboxes with a custom CA, set `NODE_EXTRA_CA_CERTS` to the system CA bundle. No API key is required; an existing GitHub token is used only to raise public API rate limits.

## Sources

- [openfootball/football.json/2026-27/en.1.json](https://github.com/openfootball/football.json/blob/e6744429ee395bc86f247348c6184bb08d4eb361/2026-27/en.1.json) (pinned `e6744429ee39`)
- [brysonhen/football_matchup_predictor/data/raw/pl/E0_2627.csv](https://github.com/brysonhen/football_matchup_predictor/blob/96e7dcfc06643213d05b9243aa6c7182e0ac9292/data/raw/pl/E0_2627.csv) (pinned `96e7dcfc0664`)
- [brysonhen/football_matchup_predictor/data/raw/pl/E0_2526.csv](https://github.com/brysonhen/football_matchup_predictor/blob/96e7dcfc06643213d05b9243aa6c7182e0ac9292/data/raw/pl/E0_2526.csv) (pinned `96e7dcfc0664`)
- [ValentinMartine/football_predictions/data/raw/2627_E0.csv](https://github.com/ValentinMartine/football_predictions/blob/d80581a7b830052c8386087b6597d1851d94c13b/data/raw/2627_E0.csv) (pinned `d80581a7b830`)

Results/odds originate from Football-Data.co.uk via the mirrors above; schedule from openfootball. Raw third-party CSVs are cached locally and not redistributed in this PR.
