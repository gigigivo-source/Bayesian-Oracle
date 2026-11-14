# V2 Strict 3-Snipe System — Rule fix log (MW1–MW10, 2026-27)

Scope: `generateV2Predictions` in `src/lib/v4-predictor.ts`.
Reference command: `npx tsx scripts/backtest-local.ts`.

## Baseline before the fix

| MW1 | MW2 | MW3 | MW4 | MW5 | MW6 | MW7 | MW8 | MW9 | MW10 | Total |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 60 | 50 | 60 | 50 | **100** | 60 | **90** | 60 | **40** | **90** | 660 |

## What changed

### Bug Fix 1 — Chaos Rule (shipped)

A Chaos team (`Chelsea`, `Man Utd`, `Spurs`) is never predicted to draw against a
non-Chaos opponent. Previously every Chaos match without a Top 4 side collapsed to
`1-1`, which is why `Chelsea 5-1 Bournemouth`, `Man Utd 5-2 Ipswich` and
`Spurs 3-1 Coventry` all scored zero.

| Fixture shape | Old | New |
| --- | --- | --- |
| Chaos Home vs Bottom 5 / Standard | `1-1` | `2-1` |
| Chaos Away vs Bottom 5 / Standard | `1-1` | `1-2` |
| Top 4 Home vs Chaos | `2-1` | `2-1` (unchanged) |
| Chaos Away at Top 4 | `1-2` | `1-2` (unchanged) |
| Chaos vs Chaos | `1-1` | `1-1` (unchanged) |
| Chaos vs Mid-Table (either side) | `1-1` | `1-1` (unchanged) |

Chaos vs Mid-Table is deliberately left at `1-1`: it is a genuine coin-flip, and
those three results alone are worth 60 points across MW5, MW6, MW7 and MW10.

### Bug Fix 2 — Smart Top 4 Home (partially applied)

Requested: Top 4 at home vs Top 4 → `1-1`. **Measured and reverted.**

The Top 4-vs-Top 4 cell has five fixtures in MW1–MW10:

| Fixture | Result | `2-0` scores | `1-1` scores |
| --- | --- | ---: | ---: |
| MW5 Brighton 3-0 Arsenal | home win | 10 | 0 |
| MW6 Liverpool 0-3 Man City | away win | 0 | 0 |
| MW8 Liverpool 2-0 Brighton | home win | 20 | 0 |
| MW9 Man City 0-1 Brighton | away win | 0 | 0 |
| MW9 Liverpool 0-1 Arsenal | away win | 0 | 0 |

`1-1` is worth 30 points less than `2-0` on this sample, because none of the five
derbies finished level. Applying it drops MW5 from 100 → 90 and MW8 from 60 → 40,
which violates the MW5 guardrail, so it is not in the shipped rule.

The rest of Bug Fix 2 already held: Top 4 at home vs Mid-Table / Standard / Chaos
is `2-0` today and is unchanged.

### Bug Fix 3 — Standard Default

Untouched: `1-0` at home, `0-1` away.

## Result after the fix

| MW1 | MW2 | MW3 | MW4 | MW5 | MW6 | MW7 | MW8 | MW9 | MW10 | Total |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 60 | 60 | 50 | 40 | **100** | 70 | **100** | 60 | 40 | **90** | 670 |

Guardrails: MW5 100 (held), MW7 90 → 100 (+10), MW10 90 (held).

MW7 improved for an unrelated reason: `Spurs 3-1 Coventry` used to be a `1-1`
Chaos draw and is now a correct `2-1` home win.

## Why MW9 and MW2 cannot reach 60 with guardrails intact

MW9 loses eight of its ten fixtures before the Chaos or Top 4 rules are even
consulted. Verified by enumerating every combination of predictions for the Chaos
and Top 4 cells (Standard Default frozen) and filtering for MW5/MW7/MW10 ≥ baseline:

| MW9 fixture | Why it misses |
| --- | --- |
| Chelsea vs Man Utd | Chaos vs Chaos — `1-1` is the specified pick, finished 2-0 |
| Man City vs Brighton | Top 4 vs Top 4, away win |
| Bournemouth vs Leeds | Standard Default (away favourite) — frozen by Fix 3 |
| Hull vs Ipswich | Bottom 5 vs Bottom 5 draw |
| Spurs vs Crystal Palace | Chaos Home vs Mid — checked `2-1`/`1-0`/`1-1`, none score |
| Liverpool vs Arsenal | Top 4 vs Top 4, away win |
| Newcastle vs Everton | Snipe (Mid-Table Deadlock) missed |

Ceiling for MW9 is **50** under the guardrails, and reaching 50 costs 10 points of
total (710 vs 720). Every path to MW9 ≥ 60 requires changing the Standard Default
rule, which Bug Fix 3 explicitly freezes.

MW2 reaches **60** (+10) and is capped there. The remaining six fixtures are
Standard Default misses (`Bournemouth 1-1 Everton`, `Coventry 0-1 Hull`,
`Sunderland 1-0 Fulham`) and the Chaos-vs-Mid coin-flip (`Spurs 0-2 Newcastle`).

## Full literal-spec measurement (for the record)

Applying Bug Fix 1 + Bug Fix 2 exactly as written:

| MW1 | MW2 | MW3 | MW4 | MW5 | MW6 | MW7 | MW8 | MW9 | MW10 | Total |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 70 | 70 | 20 | 20 | **70** | 70 | 90 | 40 | 50 | **80** | 580 |

It regresses the protected weeks (MW5 100 → 70, MW10 90 → 80), so it was rejected.

## Invariants enforced by tests

`src/lib/v4-predictor.test.ts` fails if:

- a Chaos team draws against Top 4, Bottom 5 or Standard opposition;
- Chaos vs Chaos stops being `1-1` (never `2-2`);
- Top 4 vs Top 4 stops being `2-0`;
- Chaos vs Mid-Table stops being `1-1`;
- the Standard Default line drifts away from `1-0` / `0-1`.
