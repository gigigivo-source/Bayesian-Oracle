# v4-predictor — mechanics of the scoring, the rolling state, and the MW11 break

**Date:** 2026-11-28 · **Branch:** `arena/3516e17a-bayesian-oracle` @ `77768c2` (unmodified)
**Data:** Football-Data `E0_2627.csv` (110 matches = MW1–MW11, 100% scored, with `HxG`/`AxG`) + `openfootball/football.json` `en.1` 2022-23…2026-27 (380 matches/season). Both fetched from the allowlisted `api.github.com`.
**Method:** every number below is produced by driving the **unmodified production code** (`generateV2Predictions`, `createMatchXgResolver`, `calculateScore`, `buildAttackDefenceTable`) over a strictly pre-kickoff history slice. Nothing is estimated.

Baseline reproduced exactly: `[70, 100, 60, 50, 100, 60, 120, 80, 80, 90]` → **810 / 10 = 81.00**; MW11 = **30/200**.

---

## 1. Matchweek scoring formula

### 1.1 The point system

There are **three** outcomes per fixture, worth 20 / 10 / 0. The whole rule is `calculateScore`, `src/lib/v4-predictor.ts:662`:

```ts
const [predH, predA] = row.Prediction.split("-").map(Number);
const [actH,  actA ] = actuals[index];
const predOutcome = predH > predA ? "H" : predH < predA ? "A" : "D";
const actOutcome  = actH  > actA  ? "H" : actH  < actA  ? "A" : "D";

if (predH === actH && predA === actA)      [points, status] = [20, "🎯 EXACT (20 pts)"];
else if (predOutcome === actOutcome)       [points, status] = [10, "✅ OUTCOME (10 pts)"];
else                                       [points, status] = [ 0, "❌ MISSED (0 pts)"];
total += points;
```

| Condition | Points | Example |
|---|---:|---|
| Both goal counts exact | **20** | predict `2-0`, actual `2-0` |
| Outcome (H/A/D) right, score wrong | **10** | predict `2-1`, actual `3-1`; predict `1-0`, actual `2-0` |
| Outcome wrong | **0** | predict `2-1`, actual `1-1` |

Three properties that are easy to miss:

1. **`Target_Pts` is never read.** A `SNIPE` row carries `Target_Pts: 20` and a `LOCK` row `Target_Pts: 10`, but the field never enters scoring. A "20-point Snipe" that only gets the winner right earns **10**; a "10-point Lock" that hits the exact score earns **20**. Only `MAX_SNIPES = 3` does real work (limiting how many fixtures chase an exact score).
2. **A wrong scoreline at the right venue-differential is still 0.** `2-1` vs `3-2` = 0 (both home wins, but 20 requires exact). `2-1` vs `2-1` = 20.
3. **A malformed prediction scores 0 silently.** If `Prediction` fails `isScoreline` (`/^\d{1,2}-\d{1,2}$/`), `Number()` yields `NaN`, every comparison is false, and the row scores 0 with `MissReason: "—"` — indistinguishable from a real miss.

### 1.2 Matchweek total

```
weekPoints = Σ over the 10 fixtures of {0, 10, 20}
```

Maximum **200** = 10 fixtures × 20. This is the `/ 200` in the UI footer and in every backtest table.

Worked from the real data:

- **MW7 = 120** → 3 exact (3×20 = 60) + 6 right-outcome (6×10 = 60) + 1 miss = **120**
- **MW4 = 50** → **0 exact** + 5 right-outcome (5×10 = 50) + 5 misses = **50**

That is the entire difference between the two weeks: MW7 found 3 exact scorelines, MW4 found none.

### 1.3 MW7 (120) vs MW4 (50) fixture by fixture

**MW7** — `cutoff=2026-10-17`, history 1553 rows (1493 prior + 60 season):

| # | Match | Category | Pick | Actual | Pts |
|---|---|---|---|---:|---:|
| 1 | Everton vs Chelsea | Chaos Rule | 1-2 | 0-2 | 10 |
| 2 | Brentford vs Liverpool | Elite Away | 0-1 | 1-2 | 10 |
| 3 | Fulham vs Hull | Standard Home | 1-0 | **1-0** | **20** |
| 4 | Man City vs Ipswich | Home Fortress | 2-0 | 3-2 | 10 |
| 5 | Newcastle vs Aston Villa | Mid-Table Deadlock | 1-1 | 0-1 | 0 |
| 6 | Bournemouth vs Sunderland | Standard Home | 1-0 | 2-0 | 10 |
| 7 | Brighton vs Crystal Palace | Smart Top 4 Home | 2-0 | 5-0 | 10 |
| 8 | Leeds vs Man Utd | Chaos Rule | 1-1 | **1-1** | **20** |
| 9 | Nott'm Forest vs Arsenal | Standard Away | 0-1 | **0-1** | **20** |
| 10 | Spurs vs Coventry | Chaos Rule | 2-1 | 3-1 | 10 |

**MW4** — `cutoff=2026-09-12`, history 1523 rows (1493 prior + 30 season):

| # | Match | Category | Pick | Actual | Pts |
|---|---|---|---|---:|---:|
| 1 | Aston Villa vs Nott'm Forest | Standard Home | 2-1 | 1-2 | 0 |
| 2 | Bournemouth vs Brentford | Standard Away | 1-1 | 2-2 | 10 |
| 3 | Chelsea vs Hull | Chaos Rule | 1-1 | 2-2 | 10 |
| 4 | Crystal Palace vs Ipswich | Mid vs Bottom | 2-1 | 2-3 | 0 |
| 5 | Liverpool vs Fulham | Smart Top 4 Home | 2-0 | 0-0 | 0 |
| 6 | Spurs vs Everton | Chaos Rule | 2-1 | 0-0 | 0 |
| 7 | Sunderland vs Arsenal | Elite Away | 0-1 | 0-2 | 10 |
| 8 | Coventry vs Brighton | Elite Away | 0-1 | 0-5 | 10 |
| 9 | Man Utd vs Man City | Chaos Rule | 1-2 | 0-1 | 10 |
| 10 | Leeds vs Newcastle | Mid-Table Deadlock | 1-1 | 4-1 | 0 |

Note rows 7 and 8: `0-1` vs `0-2` and `0-1` vs `0-5` are both **10**, not 20. Exact-score prediction is a very narrow target — MW4 produced five correct winners and five wrong ones, and not one exact score.

### 1.4 The aggregate metric

The "81" is **not** a 0–100 index. It is the arithmetic mean of the ten weekly totals:

```
810 / 10 = 81.00        floor = 50 (MW4)        ceiling = 200/week
```

---

## 2. Rolling simulation state

### 2.1 What "rolling" means in this codebase

The state is **not** carried in an object that mutates. The simulation is a **recomputation from an ever-growing window**: for matchweek *N*, everything strictly before *N*'s first kickoff is loaded, the model is rebuilt from scratch, and the matchweek is predicted. Nothing persists between weeks except the raw result rows.

`auto/route.ts` binds the cutoff to **the first kickoff of the slate**:

```ts
// auto/route.ts:265-267
const xg = sorted.length ? await buildMatchXgResolver(sorted[0].date) : null;
const v2Predictions = generateV2Predictions(v2Fixtures, xg);
```

There is a single cutoff for all ten fixtures — a Sunday fixture does not see Saturday's results. That is leak-free, but it means the last fixture of a matchweek is predicted with the same information as the first.

### 2.2 Exactly what is fed in, week by week

| Week | cutoff | prior-season rows | current-season rows | total | league avg H / A |
|---|---|---:|---:|---:|---|
| MW1 | 2026-08-21 | 1493 | 0 | 1493 | 1.6477 / 1.3597 |
| MW2 | 2026-08-28 | 1493 | 10 | 1503 | 1.6514 / 1.3560 |
| MW3 | 2026-09-04 | 1493 | 20 | 1513 | 1.6504 / 1.3582 |
| MW4 | 2026-09-12 | 1493 | 30 | 1523 | 1.6467 / 1.3572 |
| MW5 | 2026-09-18 | 1493 | 40 | 1533 | 1.6432 / 1.3601 |
| MW6 | 2026-10-10 | 1493 | 50 | 1543 | 1.6436 / 1.3577 |
| MW7 | 2026-10-17 | 1493 | 60 | 1553 | 1.6465 / 1.3587 |
| MW8 | 2026-10-23 | 1493 | 70 | 1563 | 1.6462 / 1.3564 |
| MW9 | 2026-10-31 | 1493 | 80 | 1573 | 1.6408 / 1.3547 |
| MW10 | 2026-11-06 | 1493 | 90 | 1583 | 1.6393 / 1.3506 |
| **MW11** | **2026-11-21** | **1493** | **100** | **1593** | **1.6403 / 1.3497** |

The single correct answer to "what changes from MW10 to MW11": **10 new result rows**. Everything else is a pure function of that.

Note MW5→MW6 jumps 2026-09-18 → 2026-10-10: an international break, which the model is completely blind to (no rest-days or congestion feature).

### 2.3 The hardcoded tiers do not update — at all

`v4-predictor.ts:29–40`:

```ts
export const TOP_4      = ["Arsenal", "Liverpool", "Man City", "Brighton"];
export const MID_TABLE  = ["Fulham", "Brentford", "Everton", "Leeds", "Crystal Palace", "Newcastle", "Aston Villa"];
export const BOTTOM_5   = ["Coventry", "Ipswich", "Sunderland", "Burnley"];
export const CHAOS_TEAMS= ["Chelsea", "Man Utd", "Spurs"];
```

These are module-level `export const` string literals. **No function in `src/` writes to them**, and the rolling loop never rebuilds them. The tier a club has in MW1 is byte-identical in MW11 and in MW38.

Consequences visible in the data:

- **Coventry and Hull** are `BOTTOM_5` / `Standard` in MW1 with *zero* prior top-flight rows, and remain so at MW11 after 10 matches each.
- **Brighton** is `TOP_4` and stays `TOP_4` even though its λ `attackHome` is **1.0796** at MW11 — lower than Spurs (1.0442)? no: higher, but well below Man City (1.5696) and Arsenal (1.4172). A club's tier is an input, never an output.
- **`BOTTOM_5` contains four clubs**, so the name is aspirational.

### 2.4 The λ values are rebuilt each week but barely move

`createMatchXgResolver` → `buildAttackDefenceTable(history, leagueSlug, {})`. The λs are recomputed from scratch every week, but the **shrinkage prior dominates**:

| Week | Arsenal `attackHome` | `defenceHome` | λ vs a league-average away side |
|---|---:|---:|---:|
| MW1 | 1.42440 | 0.67627 | 2.34697 |
| MW3 | 1.42700 | 0.66811 | 2.35507 |
| MW6 | 1.42981 | 0.66948 | 2.34997 |
| MW9 | 1.42683 | 0.66331 | 2.34117 |
| MW11 | 1.41716 | 0.65750 | 2.32458 |

Over ten matchweeks, Arsenal's home λ moved **−0.51%**. The model's opinion of Arsenal is effectively frozen because ~150 prior-season matches outweigh 10 new ones.

### 2.5 Decay is inert

`buildAttackDefenceTable(history, 'eng.1', {})` — the third argument is `DecayOptions`, and it is **empty**. So `matchWeight` returns 1 for everything (`historical.ts:118`):

```
matchWeight('2022-08-05T00:00:00Z', null, now) = 1
matchWeight('2025-08-15T00:00:00Z', null, now) = 1
```

For contrast, **with** a 365-day half-life the 2022-23 matches would weigh **0.0508** and an MW10 match **0.9738**. The half-life machinery exists (`DEFAULT_HALF_LIFE_DAYS = 365`, `ATTACK_DEFENCE_HALF_LIFE_DAYS`) but **no v4 caller supplies one**. Every one of the 1,593 matches counts 1.0; the 2022-23 season is 25% of the evidence weight in an MW11 prediction.

### 2.6 The Snipe budget resets every week

`fortressUsed`, `deadlocksUsed`, `eliteAwayUsed` are declared **inside** `generateV2Predictions` (`:266–269`) and initialised to 0. The 3-Snipe budget is **per matchweek, not per season**. This is a deliberate design, but it means a Snipe spent in MW10 has no bearing on MW11.

### 2.7 What is recomputed vs. carried — the full ledger

| Quantity | Behaviour | Evidence |
|---|---|---|
| Raw match rows | appended, never dropped | 1493 → 1593 |
| League goal baseline | recomputed weekly | 1.6477/1.3597 → 1.6403/1.3497 |
| Team attack/defence λ | recomputed weekly, heavily shrunk | Arsenal 1.4244 → 1.4172 |
| **Tier lists** | **frozen constants** | `v4-predictor.ts:29–40` |
| **ρ (Dixon–Coles)** | **frozen at `DEFAULT_RHO = −0.1`** | `pickCorrectScoreHybrid` default arg |
| Snipe counters | reset each call | `:266` |
| **Rolling form / momentum** | **does not exist** | no such feature in `src/` |
| Time-decay weights | exist but never supplied | `DecayOptions = {}` |

---

## 3. The MW11 failure, fixture by fixture

`cutoff=2026-11-21`, 10 fixtures, **0 exact, 3 right-outcome, 7 wrong = 30/200**.

| # | Match | Tier | Rule that fired | Pick | Actual | Pts |
|---|---|---|---|---|---:|
| 1 | Man City vs Fulham | TOP_4 vs MID | Rule 2 (Smart Top 4 Home) | 2-0 | 1-1 | 0 |
| 2 | Aston Villa vs Sunderland | MID vs BOTTOM | Rule 3 (Mid vs Bottom) | 2-1 | 0-0 | 0 |
| 3 | Bournemouth vs Nott'm Forest | STD vs STD | Rule 4 (Standard Home) | 1-0 | 2-0 | 10 |
| 4 | Chelsea vs Leeds | CHAOS vs MID | Rule 1 (Chaos) | 2-1 | 1-4 | 0 |
| 5 | Coventry vs Crystal Palace | BOTTOM vs MID | Rule 4 (Standard Away) — draw band | 1-1 | 3-2 | 0 |
| 6 | Spurs vs Ipswich | CHAOS vs BOTTOM | Rule 1 (Chaos) | 2-1 | 2-0 | 10 |
| 7 | Newcastle vs Arsenal | MID vs TOP_4 | **Snipe: Elite Away** | 0-1 | 2-2 | 0 |
| 8 | Hull vs Brighton | STD vs TOP_4 | **Snipe: Elite Away** | 0-1 | 2-0 | 0 |
| 9 | Liverpool vs Man Utd | TOP_4 vs CHAOS | Rule 1 (Chaos) | 2-1 | 4-0 | 10 |
| 10 | Brentford vs Everton | MID vs MID | **Snipe: Mid-Table Deadlock** | 1-1 | 4-0 | 0 |

**Structural fact worth internalising:** the Snipe pass runs **before** the Lock tree, and Snipes are pure tier rules that never read λ. So for fixtures 7, 8 and 10 the λ gap was computed and then **ignored**. The Lock branch recorded alongside each is what *would* have run.

### 3.1 Per-fixture trace

**1 · Man City vs Fulham — 2-0 vs 1-1 (0)**
`λ = 2.379 / 0.856`, gap **+1.523**. Rule 2 is not a derby (Fulham is MID), so the flat `H/2-0` is locked and xG only influences the *exact score*. The grid agrees: top-3 home cells `2-0@11.1%`, `2-1@9.5%`, `3-0@8.8%`, hybrid keeps `2-0`. Real xG was `1.87/0.74` (+1.13) — the **outcome** read was reasonable; City simply failed to win. Nothing in the tree can express "strong favourite draws".

**2 · Aston Villa vs Sunderland — 2-1 vs 0-0 (0)**
`λ = 2.088 / 0.975`, gap **+1.113**. Rule 3 (`Mid vs Bottom`) is **xG-blind** — it emits `H/2-1` unconditionally. Real xG was `1.03/0.25`: a 0-0 was not a surprise. This is the clearest case of a rule that discards available information.

**3 · Bournemouth vs Nott'm Forest — 1-0 vs 2-0 (10)**
`λ = 1.506 / 1.133`, gap **+0.373**. Rule 4 Standard Home branch has **no xG gate at all** — it emits `H/1-0` regardless of the gap. Grid top-3 were `2-1@9.2%`, `1-0@9.1%`, `2-0@8.1%`; `1-0` ranked 2nd, so the hybrid kept it. Right winner, wrong score, +10.

**4 · Chelsea vs Leeds — 2-1 vs 1-4 (0)**
`λ = 2.046 / 1.001`, gap **+1.045**. Rule 1: `gap > CHAOS_DRAW_MAX_XG_GAP (0.15)` ⇒ `H/2-1`. Real xG was the mirror image: `0.64 / 2.77`, **−2.13**. This is the largest model-vs-reality disagreement on the slate. Leeds were rated markedly worse and won 4-1. Note the λ gap *direction* was the failure, not its size.

**5 · Coventry vs Crystal Palace — 1-1 vs 3-2 (0)**
`λ = 1.212 / 1.507`, gap **−0.295**. `|−0.295| < STANDARD_AWAY_DRAW_MAX_XG_GAP (0.3)` — by **0.005** — so Rule 4 emitted `D/1-1`. The actual was a 3-2 home win. This is a threshold boundary hit: a 0.005 nudge the other way gives `A/0-1`, which would also have scored 0, but the *reason* would differ. The draw band turned a coin-flip into a locked draw.

**6 · Spurs vs Ipswich — 2-1 vs 2-0 (10)**
`λ = 2.208 / 1.438`, gap **+0.770** ⇒ `H/2-1`. Right winner. Real xG `2.65/0.47` (+2.18) suggested a bigger margin; the grid's top cell was `2-1@9.1%` before `3-1@6.7%`, so the hybrid kept `2-1`. Ten points lost purely on the exact score.

**7 · Newcastle vs Arsenal — 0-1 vs 2-2 (0) — SNIPE**
Resolved by **Snipe: Elite Away** (away is TOP_4, home is not, Chaos-free, budget available). A pure rule: `0-1`, λ never consulted. `λ gap = −0.536` and real xG `1.71/1.49` (**+0.22**, i.e. the home side created more) both pointed away from a comfortable Arsenal win. The Lock branch that was skipped — Rule 4 Standard Away, `|gap| 0.536 ≥ 0.3 ⇒ A/0-1` — would also have predicted the away win, so xG would not have saved this one either; it would have needed the draw band.

**8 · Hull vs Brighton — 0-1 vs 2-0 (0) — SNIPE**
**Snipe: Elite Away** again. `λ gap = +0.002` — a dead heat — yet the tier rule forced `0-1` because Brighton is `TOP_4` and Hull is `Standard`. The skipped Lock branch is dramatic: Rule 4 Standard Away with `|gap| 0.002 < 0.3` would have predicted **`D/1-1`**, *and* with the Chaos/hybrid logic a draw. Reality: Hull won 2-0. The most information-rich fixture on the slate was resolved by the one rule that reads no information.

**9 · Liverpool vs Man Utd — 2-1 vs 4-0 (10)**
`λ = 2.033 / 0.925`, gap **+1.108**. Rule 1's `homeIsTop4` branch fires first: forced `H/2-1` before any gap test. Real xG `4.35/0.65` (+3.70) — the model had the right winner but is structurally capped at a 2-1 line, so a 4-0 rout can only ever be 10 points.

**10 · Brentford vs Everton — 1-1 vs 4-0 (0) — SNIPE**
**Snipe: Mid-Table Deadlock** (both MID, `|gap| = 0.562 ≤ MID_DEADLOCK_MAX_XG_GAP 1.0`, so the deadlock stands). Pure rule, `1-1`, λ ignored. Real xG `2.77/0.23` (+2.54) and a 4-0 home win.

### 3.2 What the Snipe budget did

| Snipe type | Cap | Eligible at MW11 | Awarded |
|---|---|---:|---:|
| Home Fortress (TOP_4 host vs BOTTOM_5) | 1 | **0** (no such fixture) | 0 |
| Mid-Table Deadlock | 2 | 1 | 1 |
| Elite Away (TOP_4 visitor) | none individually, shared `MAX_SNIPES=3` | 2 | 2 |
| **Total** | **3** | — | **3** |

All three Snipes scored **0** (7, 8, 10) — 60 potential points, 0 realised. Two of the three were matches where the λ gap flatly contradicted the tier rule (fixtures 8 and 10).

### 3.3 The failure taxonomy for MW11

| Failure mode | Fixtures | Points at stake |
|---|---|---:|
| Rule is **xG-blind by design** (Rule 3, Standard Home) | 2, 3 | 20 |
| **Snipe bypassed λ entirely** | 7, 8, 10 | 60 |
| λ **direction was wrong** (not the tier) | 4 | 20 |
| Correct winner, **capped exact score** | 6, 9 | 20 redeemed, 20 lost |
| Threshold boundary (|gap| = 0.295 vs 0.30) | 5 | 10 |
| Nothing could help (strong favourite drew) | 1 | 20 |

The 30 points came from the three fixtures where the tier call and the λ call happened to agree with reality (3, 6, 9). All three paid 10, none 20.

---

## 4. Feature availability at MW11

### 4.1 Evidence composition — the current season is a rounding error

| Week | prior rows | current rows | current share |
|---|---:|---:|---:|
| MW1 | 1493 | 0 | **0.0%** |
| MW2 | 1493 | 10 | 0.7% |
| MW5 | 1493 | 40 | 2.6% |
| MW10 | 1493 | 90 | 5.7% |
| **MW11** | **1493** | **100** | **6.3%** |

At MW11 the model is **93.7% prior-season opinion and 6.3% current-season evidence**. Nothing is literally empty, but the signal from *this* season is the thinnest it will ever be apart from MW1.

### 4.2 Shrinkage: how much a club's own results move its λ

`attackDefence.ts:183`: `shrink(goals, played, priorRate, priorMatches) = (goals + priorMatches·priorRate) / (played + priorMatches)` with `PRIOR_OVERALL_MATCHES = 6`, `PRIOR_VENUE_MATCHES = 4`.

| own matches n | weight of own rate (overall) | weight (per venue) |
|---:|---:|---:|
| 4 | 40.0% | 50.0% |
| 10 | 62.5% | 71.4% |
| 20 | 76.9% | 83.3% |
| 38 | 86.4% | 90.5% |
| 80 | 93.0% | 95.2% |

But `n` here is **total** matches, not this season's. Because decay is inert, an MW11 club has `n ≈ 160` (150 prior + 10 current), so **the ten 2026-27 matches are 6.25% of the evidence** behind λ.

### 4.3 Per-club counts and the venue split

| Club | MW1 matches | MW1 home/away | MW11 matches | MW11 home/away | MW11 `attackHome` |
|---|---:|---|---:|---|---:|
| Arsenal | 150 | 75/75 | 160 | 80/80 | 1.4172 |
| Man City | 151 | 76/75 | 161 | 81/80 | 1.5696 |
| Brighton | 150 | 75/75 | 160 | 80/80 | 1.0796 |
| Chelsea | 150 | 75/75 | 160 | 80/80 | 1.0479 |
| Man Utd | 151 | 76/75 | 161 | 81/80 | 1.0401 |
| Spurs | 151 | 76/75 | 161 | 81/80 | 1.0442 |
| **Coventry** | **0** | **n/a** | **10** | **5/5** | **0.7954** |
| **Hull** | **0** | **n/a** | **10** | **5/5** | **0.8123** |

### 4.4 The one genuinely empty feature: promoted clubs

| Club | matchesPlayed | home | away | `attackHome` | `defenceAway` |
|---|---:|---:|---:|---:|---:|
| Coventry | 10 | 5 | 5 | 0.7954 | 1.1510 |
| Hull | 10 | 5 | 5 | 0.8123 | 0.7446 |
| Ipswich | 48 | 24 | 24 | 0.5322 | 1.2894 |
| Sunderland | 44 | 22 | 22 | 0.7437 | 1.1001 |

Coventry and Hull have **zero** top-flight rows in the 2022-26 window. `neutralStrengths` (`attackDefence.ts:267`) hands them `attack = defence = 1.0` — exactly league average — until their own matches accumulate. But they also enter at MW1 with **0 home and 0 away matches**, so their very first venue split collapses exactly to the overall prior (`shrink(0, 0, rate, 4) = rate`). The model begins the season treating promoted sides as average Premier League teams, and it takes ~10 matchweeks before their own (poor) numbers bite — and even then only at 6% weight.

Ipswich (48) and Sunderland (44) are promoted clubs with *Championship* history in the openfootball window, mixed into a Premier League table. That is a quieter version of the same problem: their rows are real matches, but against weaker opposition.

### 4.5 Responsiveness: one matchweek moves λ very little

Arsenal's `attackHome`, MW1 → MW11: **1.4244 → 1.4172**, a **−0.51%** change over ten matchweeks. The model is not "learning" in any meaningful sense during the season. A club could win 10-0 ten times and its λ would move by a fraction of a goal, because 150 prior matches are pulling it back.

### 4.6 Features that are absent, not merely weak

These cannot be "empty at MW11" because they are not implemented anywhere:

- rolling form / last-N points per game
- momentum or trend of any kind
- league position or points tally
- recent home/away form splits
- injuries, lineups, rest days, fixture congestion (the MW5→MW6 international break is invisible)
- promotion/relegation adjustment
- in-season re-estimation of the tier lists
- in-season estimation of ρ (fixed at `DEFAULT_RHO = −0.1`)
- time decay (the machinery exists, no caller supplies a half-life)

### 4.7 The available-but-unused feature: real xG in the input

The 2026-27 CSV carries `HxG` and `AxG` for every fixture. The historical loader (openfootball) carries goals only, so the attack/defence model is fitted on **goals**, and the `HxG`/`AxG` columns are read by **nothing** — not `auto/route.ts`, not `v4-predictor-server.ts`, not `v4-predictor.ts`.

At MW11 the model's λ gap and the recorded xG gap **disagree in sign on 3 of 10 fixtures**:

| Match | model gap (λH−λA) | real xG gap | agree? | pick | actual |
|---|---:|---:|:--:|---|---|
| Man City vs Fulham | +1.523 | +1.13 | yes | 2-0 | 1-1 |
| Aston Villa vs Sunderland | +1.113 | +0.78 | yes | 2-1 | 0-0 |
| Bournemouth vs Nott'm Forest | +0.373 | +0.90 | yes | 1-0 | 2-0 |
| **Chelsea vs Leeds** | **+1.045** | **−2.13** | **NO** | 2-1 | 1-4 |
| **Coventry vs Crystal Palace** | **−0.295** | **+0.33** | **NO** | 1-1 | 3-2 |
| Spurs vs Ipswich | +0.770 | +2.18 | yes | 2-1 | 2-0 |
| **Newcastle vs Arsenal** | **−0.536** | **+0.22** | **NO** | 0-1 | 2-2 |
| Hull vs Brighton | +0.002 | −0.40 | yes | 0-1 | 2-0 |
| Liverpool vs Man Utd | +1.108 | +3.70 | yes | 2-1 | 4-0 |
| Brentford vs Everton | +0.562 | +2.54 | yes | 1-1 | 4-0 |

Two of the three sign-flips (Chelsea–Leeds, Newcastle–Arsenal) are among the "wrong direction" failures. That is a genuine, unexploited signal in the input — but note that it is *post-hoc* xG, unavailable at kickoff; a real fix would need rolling pre-match xG, which the goal-based loader does not provide.

---

## 5. Where it breaks, in one paragraph

The engine is a **tier lookup with an optional λ gate**, not a learning model. The tier lists are frozen constants; ρ is frozen at −0.1; decay is never applied, so ~150 prior-season matches dominate ~10 current ones and λ barely moves all season; and the three Snipes are pure tier rules that resolve **before** the λ gate is ever consulted. On MW11 that combination scored 30/200: three fixtures were settled by λ-blind rules (60 points at stake, none realised), three by a Snipe that never looked at λ, one by a λ that pointed the wrong way, and three paid only 10 because the flat line caps the exact score at 2-1 or 1-0. The 81 on MW1–MW10 and the 30 on MW11 are produced by the same code path — the difference is that MW1–MW10 are the weeks the thresholds were tuned on.
