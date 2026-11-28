# `v4-predictor` — Technical Breakdown

**Repository:** `gigigivo-source/Bayesian-Oracle`
**Branch:** `arena/3516e17a-bayesian-oracle` @ `77768c2`
**Scope:** `src/lib/v4-predictor.ts`, `src/lib/v4-predictor-server.ts`, `src/app/api/v4-predictor/**`, `src/app/v4-predictor/**`, `scripts/backtest-local.ts`, and the math/feed modules they depend on.
**Verified:** all 44 v4 tests pass (`vitest run`: 35 in `src/lib/v4-predictor.test.ts`, 9 in `src/app/v4-predictor/v4-predictor.test.tsx`). Every behavioural claim below was reproduced by executing the code, not just read off the source.

---

## 0. Executive summary — and one correction up front

`v4-predictor` is **not a Bayesian model**. It is a **deterministic, hardcoded rule tree** over tier lists of Premier League clubs, with an **optional classical (frequentist) Dixon–Coles / Maher expected-goals layer** used only as a *gate* on four rules and as a *tie-breaker* for exact scorelines. There is no prior distribution over model parameters, no posterior, and no sequential belief update after a match anywhere in the v4 code path.

The genuinely probabilistic machinery in the repo — Bayesian shrinkage, profile MLE of ρ, Brier/calibration scoring — lives in `src/lib/data/attackDefence.ts`, `src/lib/data/dixonColes.ts` and the **Engine** (`src/lib/engine/*`). V4 *borrows* the attack/defence output and deliberately imports nothing from `@/lib/engine` (there is a test that throws if the route imports it, `v4-predictor.test.ts:485`).

> **On the "flow score":** there is no `flowScore` — not in `v4-predictor`, not anywhere in `src/` or `scripts/`, and not anywhere in the git history (`git log -S "flowScore"` and `git log --all -i --grep=flow` both return nothing; the only `flow` matches repo-wide are CSS `overflow-*` classes and two prose comments). **§5.4** maps the closest real metrics so you can tell me which one you meant.

### Verified headline numbers (MW1–MW10, 2026-27 EPL, as recorded in the test fixtures)

| Metric | Value | Source |
|---|---|---|
| Scoring rule | exact = 20 · correct outcome = 10 · miss = 0 | `calculateScore`, `v4-predictor.ts:662` |
| Max per matchweek | 200 (10 fixtures × 20) | UI: `TOTAL SCORE: {total} / 200` |
| MW1 / MW4 / MW5 / MW7 / MW9 / MW10 | 70 / 50 / 100 / 120 / 80 / 90 | `v4-predictor.test.ts:576–646` |
| Average over the 6 pinned weeks | 85.0 | derived |
| Floor | 50 (MW4) | derived |
| Pinned guardrails | MW5 ≥ 100, MW7 ≥ 100, MW9 ≥ 80, MW10 ≥ 90 | `v4-predictor.test.ts:673` |

MW2, MW3, MW6 and MW8 are **not** in the offline replay, so any "average" quoted from those six weeks is a **6-week average, not a 10-week average**.

---

## 1. Architecture & file structure

### 1.1 The five v4 modules

| File | Lines | Role |
|---|---:|---|
| `src/lib/v4-predictor.ts` | 696 | **The whole brain.** Tier constants, 15 tuning constants, `translateTeamName`, `generateV2Predictions` (Snipes + Locks), `pickCorrectScore` / `pickCorrectScoreHybrid`, `buildPredictions`, `calculateScore`. Pure, synchronous, zero I/O, zero DB, zero network, no Engine import. |
| `src/lib/v4-predictor-server.ts` | 113 | **The only bridge to the maths.** `createMatchXgResolver()` turns a pre-kickoff history slice into a `MatchXgResolver` closure backed by `buildAttackDefenceTable` + `computeMatchExpectedGoals`. Marked server-only. Also holds `fixtureReadsXg` (the `onlyRelevant` filter). |
| `src/app/api/v4-predictor/auto/route.ts` | 302 | **The live prediction path.** `GET ?week=N` → ESPN scoreboard → name translation → history assembly (4 prior openfootball seasons + current-season Football-Data CSV) → build resolver → `generateV2Predictions` → JSON. |
| `src/app/api/v4-predictor/route.ts` | 46 | **Persistence only.** `GET` = recent saved matchweeks from Postgres. `POST` = validated insert into `v4_predictions`. Never recomputes predictions. |
| `src/app/v4-predictor/page.tsx` | 387 | **Client dashboard.** Week dropdown 1–38, auto-fetch on mount and on week change, status badges, per-match points table, TOTAL SCORE footer. |

Supporting cast called by v4: `src/lib/data/dixonColes.ts` (τ grid), `src/lib/data/attackDefence.ts` (λ), `src/lib/data/historical.ts` (ingestion/aggregation), `src/lib/espn.ts` (fixtures), `src/lib/data/sources/githubDatasets.ts` (`parseCsv`), `src/db/schema.ts` (`v4_predictions`).

### 1.2 Layering (enforced, not just conventional)

```
┌──────────────────────────────────────────────────────────────┐
│ UI  src/app/v4-predictor/page.tsx        "use client"        │
└───────────────┬──────────────────────────────────────────────┘
                │ fetch /api/v4-predictor/auto?week=N
┌───────────────▼──────────────────────────────────────────────┐
│ Route  src/app/api/v4-predictor/auto/route.ts                │
│        espn.fetchScoreboard → history → xg resolver          │
└───────┬────────────────────────────────┬─────────────────────┘
        │                                │
┌───────▼──────────────────┐   ┌─────────▼──────────────────────┐
│ v4-predictor-server.ts   │   │ v4-predictor.ts                │
│ attack/defence → λ pair  │──▶│ generateV2Predictions(fx, xg)  │
└───────┬──────────────────┘   │  Pure rule tree                │
        │                      └─────────┬──────────────────────┘
┌───────▼──────────────┐                 │ pickCorrectScoreHybrid
│ data/attackDefence.ts│        ┌────────▼─────────┐
│ data/historical.ts   │        │ data/dixonColes  │
└──────────────────────┘        └──────────────────┘
```

Three hard boundaries worth knowing:

1. **`v4-predictor.ts` is isomorphic.** It imports only `dixonColes`. That is what lets the client component call `buildPredictions` and `calculateScore` directly.
2. **`v4-predictor-server.ts` is the server-only edge.** It imports `historical.ts`, which touches `node:dns`/DB paths. Never import it from a client component.
3. **No Engine coupling.** `generateV2Predictions` takes `xg?: MatchXgResolver | null` as a *pure function argument*. The Engine is used only through `attackDefence`, and `applyElo: false` is passed (`v4-predictor-server.ts:105`) so v4 xG is ELO-free.

### 1.3 The tier lists — the real "model"

```ts
TOP_4      = ["Arsenal","Liverpool","Man City","Brighton"]
MID_TABLE  = ["Fulham","Brentford","Everton","Leeds","Crystal Palace","Newcastle","Aston Villa"]
BOTTOM_5   = ["Coventry","Ipswich","Sunderland","Burnley"]   // 4 teams, not 5
CHAOS_TEAMS= ["Chelsea","Man Utd","Spurs"]
```
`v4-predictor.ts:29–40`. Note:

- **`BOTTOM_5` holds 4 clubs.** Hull was demoted out of it to "Standard" (measured 810 vs 790 over MW1–MW10; the 30-line comment at `:32–38` has the full ablation).
- **Hull is in no list at all**, so it is `Standard` by the `homeIsStandard` computation at `:355–356`.
- **Any club not in these 12+4+3 names is silently "Standard"** — including promoted sides, non-EPL clubs, and typos. This is a hardcoded 2026-27 snapshot; it does not learn from standings.
- `TOP_4` contains **Brighton**, which is not a conventional top four. These lists encode the author's fitted priors, not the table.

### 1.4 Name normalisation: `translateTeamName` (`:61`)

Three-stage: exact `TEAM_NAME_MAP` lookup → strip leading `AFC ` / trailing ` AFC|FC` → lookup again → return stripped. `"Manchester City FC"` → `"Man City"`, `"Hull City AFC"` → `"Hull"`, `"AFC Bournemouth"` → `"Bournemouth"`.

`normalizeFixturePair` (`:200`) applies it to **both** sides of every fixture before any rule runs, and the fixture accepted tuple/object union `V2FixtureInput` lets callers pass `["Arsenal","Coventry"]` or `{home,away}`.

---

## 2. Data pipeline

There are **three distinct ingestion paths**, and they are not equivalent.

### 2.1 Path A — live fixtures (`auto/route.ts`)

```
?week=N
 ├─ parseWeekParam                     (:49)  ints 1..38, else 400; null → espn.getCurrentMatchweek("eng.1") → DEFAULT_WEEK = 11
 ├─ espn.fetchScoreboard("eng.1", undefined, week)          (:253)
 ├─ filter by matchweek if the feed supplies it             (:254-257)
 ├─ backfillOpenfootballResults(...)                        (:115)
 │    └─ for fixtures id-prefixed "openfootball:" that are past kickoff,
 │       not state="post", and in season 2026-27:
 │       join on `${translateTeamName(home)}|${translateTeamName(away)}` against
 │       E0_2627.csv → set state="post", statusDetail="FT", home/away.score
 ├─ sort chronologically                                    (:261)
 └─ map to { home, away } short names                       (:265-268)
```

The CSV source is `brysonhen/football_matchup_predictor…/E0_2627.csv` fetched from `api.github.com` with `Accept: application/vnd.github.raw+json`, optional `GITHUB_TOKEN`, `AbortSignal.timeout(8_000)`, **30-minute in-process cache** (`RESULTS_TTL_MS`). Parsed by `parseCsv`; columns located **by header name** (`Div`, `Date`, `Time`, `HomeTeam`, `AwayTeam`, `FTHG`, `FTAG`), `Div` filtered to `E0`. Rows with blank or non-integer goals are dropped rather than coerced to 0-0. Dates go through `parseHistoricalDate`, and the date is rebuilt as `${day}T${HH:MM}:00Z` with `15:00` as the default time.

A `dns.setDefaultResultOrder("ipv4first")` + merged CA-certificate shim runs at module load (`:24–40`) — a sandbox/CI workaround.

### 2.2 Path B — xG history (`buildMatchXgResolver`, `:206`)

```
cutoffIso = sorted[0].date                       ← FIRST KICKOFF of the slate
seasonCodes(kickoff, 5).reverse() → [S, S-1, S-2, S-3, S-4]
  ├─ drop S, load S-1..S-4 via loadPriorSeason (openfootball JSON per season)
  │    valid only if notes.length === 0 AND matches.length === 380  (20×19)
  │    60-min per-season cache; a partial season is used once, uncached
  ├─ if ANY prior season is empty  →  return null  (flat V2 for the whole request)
  ├─ current season: csvHistoryBefore(results, cutoffIso)
  └─ createMatchXgResolver({ history, leagueSlug:"eng.1", onlyRelevant:false })
```

Two things to internalise:

- **The cut-off is the earliest fixture, and it is one cut-off for the entire slate.** Fixtures later in the same matchweek do *not* see results that happen earlier in that same week. That is leak-free (strictly pre-kickoff) but it means a Sunday fixture is predicted with Wednesday's information.
- **All-or-nothing degradation.** One missing prior season ⇒ `null` ⇒ the *entire* slate runs flat V2. There is no partial/xG-for-some path.

### 2.3 Path C — historical matches → features (`data/historical.ts`)

`HistoricalMatch` (`:45`) is the internal row: `{id, homeTeam, awayTeam, leagueSlug, matchDate, homeGoals, awayGoals, competitionName, source}`. V4's own route builds these objects inline (with synthetic `id` = `league|home|away|date|index`, `source:"github-datasets"`) rather than going through `loadHistoricalMatches`'s multi-layer cascade.

Cleaning rules that matter:

- `parseHistoricalDate` accepts `YYYY-MM-DD`, `YYYYMMDD`, `D/M/YYYY`, `D/M/YY` (→ `20YY`) and anything `new Date()` parses; everything normalises to `…T00:00:00Z`. Unparseable → `null` → row skipped.
- `fullTimeScore` (openfootball) returns `null` for unplayed fixtures so a scheduled match is **dropped, never read as 0-0**.
- `dedupeAndSortMatches`: **first source wins** on duplicate `id`, then chronological sort.
- `aggregateTeamStats` skips `teamsMatch(home, away)` (a team cannot play itself).

Feature construction is `buildAttackDefenceTable` (§3.1). **The only features V4 ever sees are two numbers: a home λ and an away λ.**

### 2.4 Team aggregation (`aggregateTeamStats`, `historical.ts:333`)

Per team, per match, it accumulates both raw and *weighted* totals across `matches`, `homeMatches`, `awayMatches`, `homeGoalsScored/Conceded`, `awayGoalsScored/Conceded`, `goalsScored/Conceded`, with `weight = matchWeight(matchDate, halfLifeDays, nowMs)`.

```ts
weight = 0.5 ** (ageDays / halfLifeDays)      // null half-life ⇒ 1
```
V4 **never passes a half-life**, so in the live route and the backtest every match is weighted 1.0 — including four-season-old openfootball rows. `DEFAULT_HALF_LIFE_DAYS = 365` and `ATTACK_DEFENCE_HALF_LIFE_DAYS` both exist but are not wired into the V4 path. *Verified: `matchWeight(x, null, now) === 1`.*

### 2.5 The `onlyRelevant` trap

`createMatchXgResolver` defaults `onlyRelevant = true`, which calls `fixtureReadsXg` (`server.ts:39`) and returns `null` for fixtures whose rule "doesn't need xG":

- Chaos fixture vs Top 4 → `false` (flat 2-1/1-2 is correct)
- Top 4 host → `true` **only** if the visitor is also Top 4
- otherwise → `true` only if **both** sides are Standard

That gate is **stale relative to the rule tree.** With `onlyRelevant: true`, a Mid vs Mid fixture gets `xg = null`, so `Rule 3b (Mid-Table Favourite)` can never fire, and the `MID_DEADLOCK_MAX_XG_GAP` skip in the Deadlock Snipe can never fire either. *Verified:* `Newcastle vs Everton` returns `1-1 / SNIPE: Mid-Table Deadlock` under `true` and `1-1 / SNIPE: Mid-Table Deadlock` under `false` (the example xG happened to be inside the band) — but the **ranking of which two Mid-vs-Mid fixtures earn the 2 Snipes changes**, because with xG a separated pair is skipped and does not consume the budget.

Both real callers are immune: `auto/route.ts:223` and `backtest-local.ts:294` both pass **`onlyRelevant: false`**. And `buildPredictions` passes **no resolver at all**, so the whole client path is flat V2 (§5.1).

---

## 3. Core logic: the maths, the "priors", the "likelihoods"

### 3.1 The expected-goals layer (classical, not Bayesian)

**League baseline** (`computeLeagueAverages`, `attackDefence.ts:141`) — weighted mean goals per side:

```
L_home = Σ w·homeGoals / Σ w        L_away = Σ w·awayGoals / Σ w
```
Empty input → `FALLBACK_LEAGUE_AVERAGES = {home: 1.5, away: 1.22}`, `fallback: true`. `Σw = 0` → fall back to row count.

**Two-level shrinkage** — this is the *only* prior/posterior structure in the v4 path, and it is **empirical-Bayes pseudo-count shrinkage**, closed-form, not a sampled posterior (`shrink`, `:183`):

```
shrink(goals, played, priorRate, priorMatches) = (goals + priorMatches·priorRate) / (played + priorMatches)

overallScored   = shrink(w.goalsScored,   w.matches,   L_total/2, PRIOR_OVERALL_MATCHES = 6)
overallConceded = shrink(w.goalsConceded, w.matches,   L_total/2, 6)
scoredHome      = shrink(w.homeGoalsScored,   w.homeMatches, overallScored,   PRIOR_VENUE_MATCHES = 4)
concededHome    = shrink(w.homeGoalsConceded, w.homeMatches, overallConceded, 4)
scoredAway      = shrink(w.awayGoalsScored,   w.awayMatches, overallScored,   4)
concededAway    = shrink(w.awayGoalsConceded, w.awayMatches, overallConceded, 4)
```

Read this as a conjugate Gamma–Poisson mean: `priorMatches` = prior sample size, `priorRate` = prior mean, and the posterior mean is the precision-weighted blend. **Level 1** pulls a team toward league average with 6 pseudo-matches. **Level 2** pulls each venue split toward the team's own overall rate with 4 pseudo-matches — a *hierarchical* prior, which is why a team with 0 away games collapses exactly to its overall rate instead of dividing by zero.

**Strengths** (`toAttackDefence`, `:220`) — note the *crossed* normalisation, which is what makes the product equal the Maher form:

```
attackHome  = scoredHome   / L_home
defenceHome = concededHome / L_away      ← normalised against AWAY scoring
attackAway  = scoredAway   / L_away
defenceAway = concededAway / L_home      ← normalised against HOME scoring
attack      = overallScored   / (L_total/2)
defence     = overallConceded / (L_total/2)
```

**λ** (`computeMatchExpectedGoals`, `:292`):

```
structuralHome = attackHome(home) · defenceAway(away) · L_home
structuralAway = attackAway(away) · defenceHome(home) · L_away
```
Substituting collapses these to `homeScored × awayConceded ÷ L_home` — the familiar Maher ratio. Unknown team → `neutralStrengths` (all 1.0) ⇒ λ = league average. ELO is available (`eloLambdaMultipliers`: `exp(±0.25·Δ/400)`, clamped) but V4 passes `applyElo: false`, so `multipliers = {1,1}`. Finally `clampExpectedGoals` pins λ to `[0.05, 6.5]`.

**Worked example, executed** (10 home games, Arsenal 3-1 in each; 10 away games, Coventry 0-2 in each):

```
L_home = 2.5000   L_away = 0.5000
Arsenal  homeMatches 10, avgScoredHome 2.839 (shrunk from 3.0), attackHome 1.1357
Coventry awayMatches 10, avgConcededAway 1.946 (from 2.0),   defenceAway 0.7786
λ = [2.2106, 0.3386]   sources: venue / venue
unknown visitor ⇒ attackSource "league", λ_home = L_home = 1.9464
```

### 3.2 The Dixon–Coles correct-score grid

**Independent Poisson** base, computed in log space: `poissonPmf(k,λ) = exp(k·lnλ − λ − ln k!)` (`engine/stats.ts:55`).

**τ correction** (`dixonColes.ts`, published form — *not* the uniform `P×(1+ρ)` that the original brief specified, which is kept aside as `applyDixonColesUniform` for A/B only):

```
τ(0,0) = 1 − λμρ      τ(1,0) = 1 + λρ
τ(0,1) = 1 + μρ       τ(1,1) = 1 − ρ        τ(x,y) = 1 otherwise   (x,y ≤ 1)
ρ < 0  ⇒  0-0 and 1-1 up, 1-0 and 0-1 down
```
Guarded by `effectiveRho = max(ρ, −0.99/max(λ,μ))` and `TAU_FLOOR = 0`, so no cell can go negative.

`dixonColesGrid(λh, λa, ρ, maxGoals)` builds the full `(max+1)²` grid, reporting `gridProbability = Σ P` and `tailProbability = 1 − Σ P` — **unnormalised**, because the τ factors do not sum to one.

**ρ is not estimated on the V4 path.** `pickCorrectScore` / `pickCorrectScoreHybrid` default to **`DEFAULT_RHO = −0.1`** (`dixonColes.ts:44`); the per-league estimate (`estimateLeagueRho`, profile MLE with the `1 + Σ(τ−1)P` normaliser, grid search `ρ ∈ [−0.2, 0.05]` step `0.005`, `MIN_RHO_MATCHES = 60`) is used by the correct-score route and Engine, **not by v4**. So V4's exact-score tie-break assumes ρ = −0.1 regardless of league or season.

### 3.3 The structural "model": where the real priors live

Every threshold in `v4-predictor.ts` is a **hardcoded fitted hyper-parameter**, and the doc comments beside each one record the ablation that produced it. This is effectively a hand-tuned expert system with a measured prior baked into each gate:

| Constant | Value | Line | What it gates |
|---|---:|---:|---|
| `MAX_SNIPES` | 3 | 97 | Total Snipe budget |
| `CHAOS_DRAW_MAX_XG_GAP` | 0.15 | 118 | Chaos 1-1 band (narrow: 0.092–0.153 window on the replay) |
| `CHAOS_VISITOR_XG_EDGE` | 0.55 | 129 | Edge a non-Chaos visitor needs at a Chaos host for 1-2 (set wide so the MW4 Chelsea 2-2 Hull 1-1 survives) |
| `TOP4_DERBY_MIN_XG_EDGE` | 0.4 | 135 | **Superseded / unused** — kept documented |
| `TOP4_DERBY_AWAY_TOLERANCE` | 0.1 | 140 | Derby flip allowed while home λ is ≤ +0.1 better |
| `TOP4_DERBY_MAX_AWAY_EDGE` | 0.2 | 149 | …and while away λ is ≤ 0.2 better |
| `MID_DEADLOCK_MAX_XG_GAP` | 1.0 | 159 | Gap past which Mid-vs-Mid is not a deadlock |
| `MID_FAVOURITE_BIG_WIN_XG` | 2.5 | 161 | Favourite λ for 3-1 / 1-3 instead of 2-1 / 1-2 |
| `STANDARD_AWAY_DRAW_MAX_XG_GAP` | 0.3 | 166 | \|gap\| under which Standard Away becomes a draw |
| `STANDARD_BLOWOUT_GAP` | 1.2 | 168 | **Exported, never read by the rule tree** |
| `STANDARD_DRAW_XG` | 1.8 | 170 | Both λ ≥ this ⇒ 2-2 instead of 1-1 |
| `CORRECT_SCORE_MAX_GOALS` | 6 | 176 | Grid size for the hybrid |

Also dead or near-dead: `blowoutGoals` (`:545`) has **no production call site** (only a test), for the same reason — the blowout branch was replaced by the hybrid grid. `STANDARD_BLOWOUT_GAP` is exported and referenced only in a comment/test.

### 3.4 Belief updating after a match — what actually happens

There is **no online update**. "Updating" is a full recompute:

```
new match result → appended to the CSV/openfootball history
                 → λ tables rebuilt from scratch (all matches re-aggregated)
                 → ρ still DEFAULT_RHO
                 → tier lists unchanged (hardcoded, never learn)
```

The *only* quantity that moves is λ, through the shrinkage denominators: one extra match adds 1 to `played`, so the posterior mean drifts toward the observed rate by a factor `1/(n+6)` (overall) or `1/(n+4)` (venue). That is a genuine conjugate update — but it is **latent**, invisible to the rule tree except through the four gap comparisons, and it **cannot change a team's tier**, which is what actually selects the rule. A team that wins 10 straight stays `Standard` and keeps getting `1-0`.

---

## 4. Execution flow: one prediction, start to finish

Trace `GET /api/v4-predictor/auto?week=7`; "Everton vs Chelsea" is fixture *i*.

**Step 1 — Request and week resolution.** `GET` (`auto/route.ts:226`) → `parseWeekParam("7")` → `7`. (`null` → `espn.getCurrentMatchweek("eng.1")`, default `11`; out-of-range/non-integer → `400`.)

**Step 2 — Fixtures.** `espn.fetchScoreboard("eng.1", undefined, 7)`; if the payload carries `matchweek`, filter to `=== 7`; dedupe by `id`; keep `inSeason(date, 2026)`; attempt CSV backfill on stale `openfootball:` rows.

**Step 3 — Canonicalise.** `sorted` by kickoff; `v2Fixtures[i] = {home: translateTeamName(fx.home.name), away: …}` → `{home:"Everton", away:"Chelsea"}`.

**Step 4 — Build the λ resolver.** `buildMatchXgResolver(sorted[0].date)`: load 2025-26…2022-23 openfootball (each must be 380 rows), append current-season CSV rows strictly before the first kickoff, `createMatchXgResolver({history, leagueSlug:"eng.1", onlyRelevant:false})` ⇒ `buildAttackDefenceTable` ⇒ a closure. Any failure ⇒ `null`.

**Step 5 — Rule tree.** `generateV2Predictions(v2Fixtures, xg)`:
1. `normalizeFixturePair` (name translation again — belt and braces).
2. `readXg` / `resolveXg` (`:245`, `:261`): memoised per index; a throwing resolver, a `null`, or a non-finite pair is treated as "no xG". **The Engine can never crash a prediction.**
3. **Snipe pass 1** (`:271`): `CHAOS` excluded; first `TOP_4(home) × BOTTOM_5(away)` with `fortressUsed < 1 && totalSnipes() < 3` → `SNIPE: Home Fortress`, `2-0`, 20 pts, `fortressUsed++`.
4. **Snipe pass 2** (`:286`): `MID × MID`, Chaos-free, `deadlocksUsed < 2`, budget OK. If `|λh − λa| > 1.0` → **`continue` without incrementing** (no Snipe spent; fixture falls through to Rule 3b). Else `SNIPE: Mid-Table Deadlock`, `1-1`, 20 pts.
5. **Snipe pass 3** (`:322`): *only if `deadlocksUsed < 2`*. Loop every unpicked, Chaos-free fixture with `TOP_4(away) && !TOP_4(home)`, `totalSnipes() < 3` → `SNIPE: Elite Away`, `0-1`, 20 pts, `eliteAwayUsed++`. Note the guard is `< 3` against a **shared** budget and Elite Away has **no per-rule cap**.
6. **Lock pass** (`:348`): `pairs.map(...)`; already-picked fixtures return unchanged. Compute 8 boolean tier flags and `xg = resolveXg(i, …)` (memo hit, no second call). Then the first matching branch sets `outcome`, `fallback`, `category`:
   - **Rule 1 Chaos** (`:392`) — precedence: Top-4 host → `H`/`2-1`; Top-4 visitor → `A`/`1-2`; else `chaosGap = λh − λa`; `chaosGap > 0.15` → `H`/`2-1`; `−chaosGap > awayWinEdge` → `A`/`1-2`; else `D`/`1-1`. `awayWinEdge = 0.55` if a Chaos host faces a non-Chaos visitor, otherwise `0.15`. With **no** xG: `chaosHostsVisitor ? H/2-1 : D/1-1`. **Never 2-2.**
   - **Rule 2 Top-4 Home** (`:420`) — `derbyIsCoinFlip = gap ≤ +0.1 && gap ≥ −0.2`; if the visitor is Top 4 and it's a coin flip → `A`/`0-1`, else `H`/`2-0`. Flat fallback is `2-0` including for a non-derby.
   - **Rule 3 Mid vs Bottom** (`:457`) — `H`/`2-1`, **xG-blind**.
   - **Rule 3b Mid-Table Favourite** (`:462`) — `MID×MID` with xG and `|gap| > 1.0`: favourite by sign of `gap`; `bigWin = max λ ≥ 2.5` → `2-1`/`3-1` or `1-2`/`1-3`.
   - **Rule 4 Standard** (`:478`) — `awayIsStronger = awayIsTop4 || (homeIsBottom5&&awayIsMid) || (homeIsStandard&&awayIsMid) || (homeIsBottom5&&awayIsStandard)`. If so: `|standardGap| < 0.3` → `D` and `min λ ≥ 1.8 ? 2-2 : 1-1`; else `A`/`0-1`. Otherwise `H`/`1-0`.

   **Everton vs Chelsea:** `homeIsMid=true`, `awayIsChaos=true` ⇒ Rule 1 (the branch is tested first, so Everton's Mid tier is irrelevant). With `λ = [1.15, 1.36]`: `chaosGap = −0.21`; `chaosHostsVisitor = false` so `awayWinEdge = 0.15`; `−(−0.21) = 0.21 > 0.15` ⇒ `A` / `1-2`.
7. **Exact-score hybrid** (`:529`) — `pickCorrectScoreHybrid(1.15, 1.36, "A", "1-2")`: build the 7×7 τ-grid; filter to away-win cells; sort desc; if `"1-2"` ranks in the top 3 → keep `"1-2"`; else return the grid argmax. `xg === null` ⇒ `exact = null` ⇒ flat `fallback`.

**Step 6 — Response shaping.** `{home:{name,logo}, away:{…}, state, actual, prediction, category, targetPts}`; `actual` only when `state === "post"` **and** both scores parse as finite numbers.

**Step 7 — Client projection.** `normalizeRow` validates (`isScoreline`, finite `actual`, positive `targetPts`), then `buildPredictions(v4Fixtures)` **re-runs the entire tree on names alone** — no resolver — and then overwrites with the route's value wherever `isScoreline(row.prediction)`. So:

- the **displayed** pick is the route's xG-aware pick;
- the **fallback** — used whenever the route's pick is missing or malformed — is a flat-V2 re-derivation that can **disagree** with the route. *Verified:* route `LN: Chaos Rule / 1-2`, while `buildPredictions([{home:"Everton",away:"Chelsea"}])` returns `1-1`.

**Step 8 — Scoring.** `calculateScore(finished.map(prediction), finished.map(actual))`: 20 exact / 10 same outcome / 0. `Target_Pts` is **never consulted** — the 20/10 split is a property of the *result*, not the category. So the UI's "max 3 Snipes (20 pts)" framing and the scorecard are only loosely coupled: a Snipe that lands on the right outcome scores 10, a Lock that hits exactly scores 20.

**Step 9 — Persistence (optional, not on this path).** `POST /api/v4-predictor` validates hard (fixtures 1–20, matching `predictions` length, `Prediction` matching `/^\d+-\d+$/`, integer non-negative `Target_Pts`, `totalScore ≤ 2147483647`) then inserts into `v4_predictions`. **Nothing calls it** — the page never saves, and the client could re-post arbitrary "predictions", so the table is not a trustworthy audit trail.

---

## 5. Evaluation & backtesting

### 5.1 Three evaluation surfaces, none of which is an out-of-sample model test

| Surface | File | What it does |
|---|---|---|
| Offline replay | `v4-predictor.test.ts:546` | 60 hardcoded MW1/4/5/7/9/10 fixtures × (xG, actual, expected pick, expected points). Re-runs the real rule tree and asserts every pick, every point value, the week totals, and the four guardrails. **This is a regression pin, not a backtest** — the xG values were *captured from* `backtest-local.ts`, and the thresholds were fitted on the same window. |
| Local backtest | `scripts/backtest-local.ts` (731 lines) | The real replay engine: network fetch, chronological rebuild of the λ model per week from a strictly pre-kickoff slice, predict, score, render Markdown. |
| Live scorecard | `page.tsx:186–211` | Client-side, on any matchweek whose fixtures are `state === "post"`. |

### 5.2 `scripts/backtest-local.ts` — mechanics

```
parseArgs  →  {league:"eng.1", season:<currentSeasonYear()>, weeks:[1..10], detail, selfTest}
             currentSeasonYear() = UTC month ≥ 6 ? year : year-1
for week in weeks:
  backtestWeek(week):
    espn.fetchScoreboard(league, undefined, week)          → fail ⇒ emptyWeek(note), continue
    filter by matchweek → dedupe by id → inSeason(year) → backfill (only eng.1 + 2026)
    sort chronologically
    buildXgResolver(sorted[0].date, cfg):                   ← cutoff = FIRST kickoff
        eng.1 only, else null
        loadXgHistory: 4 prior seasons, one cached fetch for the whole run
        + seasonalCsvHistory(results, cutoff)                ← strictly before cutoff
        createMatchXgResolver({..., onlyRelevant:false})
    generateV2Predictions(inputs, xg)
    for each finished fixture: calculateScore([pred],[actual])
    WeekResult { points, scored, exact, outcomeHits, misses, snipes }
renderMarkdown → points row, fixture-count row, per-week table, totals, warnings, optional --detail
```

Leak control is the whole point of the design: `buildXgResolver` receives the **first kickoff of the matchweek**, and `csvHistoryBefore` drops `Date.parse(isoDate) >= cutoff`. A result can therefore never inform its own prediction. The cost is that later fixtures in a week are predicted without earlier same-week information.

**CLI:** `--league <slug>`, `--season <year>`, `--weeks "1-10"` or `"1,2,3"`, `--detail`, `--self-test` (12-fixture, network-free rule assertion — note it has **no xG**, so it pins the flat tree only), `--help`. Exit code 1 if every week scored 0.

### 5.3 Metrics — exact formulas

**`calculateScore` (`v4-predictor.ts:662`)** — the atom of every surface:

```
predH,predA = Prediction.split("-");  actH,actA = actual
exact   → (predH==actH && predA==actA)                              → 20 pts, "🎯 EXACT (20 pts)",     MissReason "—"
outcome → outcomeOf(pred) == outcomeOf(actual)                      → 10 pts, "✅ OUTCOME (10 pts)",   MissReason "❌ MISS: Wrong Score"
else                                                                →  0 pts, "❌ MISSED (0 pts)",    MissReason "❌ MISS: Wrong Outcome"
total = Σ points                       (returns [ScoredPrediction[], number])
```

`Target_Pts` is not an input. A malformed `Prediction` (`!isScoreline`) yields `NaN` comparisons ⇒ 0 points and `MissReason "—"` — it is not distinguished from a real miss.

**`WeekResult` fields (`backtest-local.ts`):**

| Field | Definition |
|---|---|
| `points` | `Σ calculateScore(...)[0].Points` over scored (non-skipped) fixtures |
| `scored` | count of `state==="post"` with finite non-negative scores |
| `exact` / `outcomeHits` / `misses` | counts by status |
| `snipes` | `predictions.filter(p => p.Category.startsWith("SNIPE:")).length` |
| `note` | fetch failure, empty week, or "no finished fixture could be scored" |

**Aggregate metrics (`renderMarkdown`):**

```
maxPoints = 20 × max(scored) over weeks
Average   = Σ points of scored weeks / |scored weeks|
Floor     = min(points) over scored weeks
maxFixtures = max(scored) over weeks          ← reported as "Fixtures scored" total column
```

**Hit rates are not computed.** The report prints *counts* (exact/outcome/miss) and raw points; there is no ROI, no hit rate, no Brier score, no calibration, no log-loss, no significance test. `scoredWeeks` **excludes zero-scored weeks from the average**, so a week that failed to fetch silently vanishes from the Average instead of dragging it down — that is a survivorship bias in the headline number.

CI guardrails (`v4-predictor.test.ts:673`) pin `MW5 ≥ 100, MW7 ≥ 100, MW9 ≥ 80, MW10 ≥ 90`. MW1 (70) and MW4 (50) are asserted as exact totals only.

### 5.4 "Flow score" — no such metric exists

Searched: case-insensitive `flow`, `flow score`, `flowScore`, `scoreFlow`, `flows` across `src/`, `scripts/`, `docs/`, all markdown, plus `git log --all -S flowScore` and `git log --all -i --grep=flow`. **Zero hits** outside CSS classes and two prose comments ("stats are flowing", "keeps xG flowing"). Nothing in the v4 code even tracks a per-match sequence or momentum term, which is what a "flow" score would normally require.

The plausible readings, with the actual formula:

| If you meant | Actual metric | Formula | Where |
|---|---|---|---|
| Matchweek-to-matchweek momentum | **None** | — | — |
| Consistency across days | `calculateConsistencyScore` | `0.30·winDayScore + 0.25·ddFactor + 0.25·volScore + 0.20·streakScore`, each 0–100 | `performance/modeAnalytics.ts:304` |
| Overall performance | `calculateOverallPerformanceScore` | `0.30·hitRateScore + 0.30·roiScore + 0.20·pnlScore + 0.20·consistencyScore` | same file, `:340` |
| Score-line distance | `meanAbsoluteError` / `meanAbsoluteErrorTop3` | mean \|predicted − actual\| goals | `correct-score/backtest/core.ts` |
| Probabilistic accuracy | `brierScore`, `calibrationScore = 1 − ECE` | `(1/n)Σ brier`; ECE over calibrated buckets | same file, `:453` |
| The 3-snipe budget "flowing" | `snipes` counter | `Σ startsWith("SNIPE:")` | `backtest-local.ts` |

None of those four analytic scores is computed on the v4 path.

### 5.5 What the backtesting does *not* measure

- **No walk-forward on unseen weeks.** Thresholds were fitted on MW1–MW10 and validated on MW1–MW10. The 6-week replay in tests is the same window.
- **No baseline comparison.** Flat-V2-without-xG is never scored head-to-head in the harness, despite the comments claiming specific deltas (e.g. "the Deadlock gate changes no pick and no score"). Those deltas were measured manually and are only preserved as prose.
- **No probability output, so no proper scoring rule.** V4 emits a scoreline, not a distribution; Brier/log-loss/calibration are structurally unavailable to it.
- **No confidence intervals** on 50–120-point weeks from 10 fixtures (±20 per fixture is enormous relative to the totals).

---

## 6. Findings that matter

Ordered by how much they change behaviour.

1. **`onlyRelevant: true` is stale and silently disables Rule 3b and the Deadlock gate.** `fixtureReadsXg` (`server.ts:39`) does not know about Mid-vs-Mid. Both real callers pass `false`, so production is safe — but any new caller taking the default gets a different rule tree. This is a latent trap, verified.
2. **The live page's fallback path is a different model from its primary path.** `buildPredictions` supplies no resolver, so any missing/malformed route pick falls back to flat V2, which disagrees with the displayed xG-aware pick (verified: `1-2` vs `1-1`). It also re-translates names and re-runs the tree purely to recover `Match`/`Category`.
3. **Snipe allocation is order-dependent.** Fixtures are processed in kickoff order, first-come-first-served. Verified: `[Arsenal–Coventry, Liverpool–Burnley]` gives Arsenal the Fortress Snipe; reversing the two gives it to Liverpool, and both teams still get the same `2-0` scoreline but different categories/points weights. Same leak into the GLOBAL `MAX_SNIPES` budget and the unpaid `deadlocksUsed` skip.
4. **`Target_Pts` is decorative.** A 20-point Snipe that lands on the right outcome pays 10; a 10-point Lock that hits exactly pays 20. Meanwhile `MAX_SNIPES = 3` does real economic work (each exact score is worth double), so the budget is well-motivated while `Target_Pts` is not.
5. **Two constants are dead code with strong documentation** — `STANDARD_BLOWOUT_GAP` and `blowoutGoals` — plus `TOP4_DERBY_MIN_XG_EDGE`, which is explicitly "superseded". A reader who trusts the module docstring ("a 3-0 / 4-0 / 0-3 / 0-4 blowout") will believe in a branch that no longer exists.
6. **Time decay is inert.** No caller supplies a half-life, so a 2022-23 match counts exactly as much as last week's in the λ estimate. `DEFAULT_HALF_LIFE_DAYS = 365` is documented as the Dixon–Coles ballpark and never used here.
7. **ρ is frozen at −0.1 for the hybrid.** The repo has a proper profile-MLE estimator and a per-league cache; v4 bypasses both.
8. **`BOTTOM_5` names 4 clubs, and the tier lists are a 16-club hardcoded snapshot.** Every unlisted club is Standard; no promotion, relegation, or form can change a tier.
9. **Average excludes failed weeks** (`scoredWeeks` filter). A week that 500s is not a 0 — it is invisible.
10. **The persistence route is write-only and unauthenticated.** No caller, and its schema validation would accept any client-supplied "prediction". Treat `v4_predictions` as untrusted input, not ground truth.

---

## 7. Quick reference

**Key functions**

| Function | File:line | Contract |
|---|---|---|
| `generateV2Predictions(fixtures, xg?)` | `v4-predictor.ts:237` | Pure. `Prediction[]`, index-aligned. Never throws on a bad resolver. |
| `generatePredictions` | `:626` | Alias. |
| `buildPredictions(fixtures: Fixture[])` | `:636` | Route-row → `Prediction[]`; **flat V2 fallback**, no xG. |
| `calculateScore(preds, actuals)` | `:662` | `[ScoredPrediction[], total]`; 20/10/0; ignores `Target_Pts`. |
| `pickCorrectScore(λh, λa, outcome, max=6, ρ=−0.1)` | `:563` | Argmax eligible cell, `null` if none. |
| `pickCorrectScoreHybrid(λh, λa, outcome, flatScore, max=6, ρ=−0.1)` | `:597` | Flat line if it ranks top-3, else argmax. |
| `translateTeamName(name)` | `:61` | Canonical short name. |
| `createMatchXgResolver({history, leagueSlug, onlyRelevant})` | `v4-predictor-server.ts:71` | `MatchXgResolver \| null`; `null` on empty/throwing history. |
| `createMatchXgResolver().fixtureReadsXg` | `:39` | `onlyRelevant` gate — **stale** (§6.1). |

**Signature the rules expose**

```ts
type MatchXgResolver = (index: number, home: string, away: string) => readonly [number, number] | null;
type Prediction      = { Match: string; Category: string; Prediction: string; Target_Pts: number };
type ScoredPrediction= { Match; Prediction; Actual; Points; Status; MissReason };
```

**Category strings (exhaustive)** — `SNIPE: Home Fortress`, `SNIPE: Mid-Table Deadlock`, `SNIPE: Elite Away`, `LOCK: Chaos Rule`, `LOCK: Smart Top 4 Home`, `LOCK: Mid vs Bottom`, `LOCK: Mid-Table Favourite`, `LOCK: Standard Away`, `LOCK: Standard Home`. Anything else in the DB did not come from this code.

**Run it**

```bash
npx tsx scripts/backtest-local.ts --self-test          # 12 fixtures, no network
npx tsx scripts/backtest-local.ts --weeks 1-10 --detail
npx tsx scripts/backtest-local.ts --season 2025 --weeks 1-5
npx vitest run src/lib/v4-predictor.test.ts src/app/v4-predictor/v4-predictor.test.tsx   # 44 tests
```
