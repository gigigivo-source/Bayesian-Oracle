# v4-predictor refactor — measurement report and FAIL-SAFE BLOCK

**Date:** 2026-11-28
**Branch:** `arena/3516e17a-bayesian-oracle` @ `77768c2` (unchanged)
**Verdict:** ❌ **Refactor NOT implemented.** The fail-safe condition (`MW1–MW10 average ≥ 81`) was **not met by any candidate** across 79 measured configurations. Per the protocol: no implementation, no commit, no push, no PR.
**Code changed:** none. `git diff` is empty; all production edits were reverted. `tsc --noEmit` clean, 44/44 v4 tests pass on the original code.

---

## 1. Which metric yields 81 — answered

Not the Consistency Score and not the Overall Performance Score (both are 0–100 composites in `src/lib/performance/modeAnalytics.ts`, and **neither is computed anywhere on the v4 path**).

**81 is the plain mean of matchweek points over the 10 matchweeks**, on the 20 / 10 / 0 rule in `calculateScore`:

```
810 points ÷ 10 matchweeks = 81.0        (max 200 per week, i.e. 10 fixtures × 20)
```

Reproduced offline from real data, exactly:

| Week | MW1 | MW2 | MW3 | MW4 | MW5 | MW6 | MW7 | MW8 | MW9 | MW10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Points | 70 | 100 | 60 | 50 | 100 | 60 | 120 | 80 | 80 | 90 |

Average **81.00**, floor **50**. This also reproduces every value pinned in `src/lib/v4-predictor.test.ts` (MW1 = 70, MW4 = 50, MW5 = 100, MW7 = 120, MW9 = 80, MW10 = 90). MW11 = **30/200** confirmed exactly.

**Data used** (all reachable in this environment, both on the allowlisted `api.github.com`):
- `brysonhen/football_matchup_predictor/…/E0_2627.csv` — 110 matches = **MW1–MW11**, 100% scored, with `HxG`/`AxG` columns.
- `openfootball/football.json` `en.1` for 2022-23 … 2026-27 — 380 matches per prior season, which is exactly what `buildMatchXgResolver` requires.

Matchweek mapping was validated two ways: the CSV splits into 11 clean 10-match chunks (20 distinct teams each, 11/11), and it reproduces every pinned MW1 fixture and score.

---

## 2. Every candidate, measured

Baseline to beat: **train 81.00 / holdout 30**. All runs use the production code path (`generateV2Predictions` + `createMatchXgResolver`), with a strictly pre-kickoff history slice.

### 2.1 Time decay (task 1) — monotonically destroys the baseline

| Half-life | Train avg | Floor | MW11 |
|---|---:|---:|---:|
| none (legacy) | **81.00** | 50 | 30 |
| 730 d | 79.00 | 50 | 30 |
| 540 d | 78.00 | 50 | 30 |
| 365 d | 78.00 | 50 | 30 |
| 300 d | 77.00 | 40 | 30 |
| 240 d | 70.00 | 40 | 20 |
| 180 d | 69.00 | 40 | 20 |
| 120 d | 68.00 | 40 | 20 |
| 90 d | 64.00 | 40 | 20 |
| 60 d | 61.00 | 40 | 30 |
| 45 d | 60.00 | 30 | 30 |

There is no half-life that holds 81. Decay also **lowers MW11** from 30 to 20 between 240 d and 90 d: near MW11 the current season is 10 weeks old, so down-weighting prior seasons mostly injects noise, and MW1 collapses to 50 or 40 points because in August there is almost no current-season history to decay *toward* — only prior seasons, which decay then discards.

### 2.2 λ blend (task 3) — no decay, sweeping the blend weight

| λ weight | Train avg | MW11 |
|---|---:|---:|
| 0.00 (legacy) | **81.00** | 30 |
| 0.10 | 80.00 | 30 |
| 0.25 | 80.00 | 30 |
| 0.50 | 75.00 | 30 |
| 0.75 | 75.00 | 30 |
| 1.00 | 75.00 | 30 |

Blending is **outcome-safe by construction** (both candidate scorelines are filtered to the locked winner, so the outcome cannot flip) — yet it still costs points, because on the training window the rule tree's exact scorelines are usually *more* probable in the grid than the grid's own argmax. And MW11 never moves off 30.

### 2.3 Hybrid dynamic tiers (task 2)

Swept `tierShiftRange ∈ {1,2}`, `tierShiftXgThreshold ∈ {0.25,0.4,0.6}`, `formWeight ∈ {0,0.5,1}`, with and without decay — 36 configurations. Best result: **77.00** (no decay, range 1, formWeight 0.5), with floor collapsing from 50 to 40. Worst: 60.00 with floor 20. Combining all three mechanisms peaked at **71.00**.

### 2.4 The ceiling — why this cannot work

Per-category decomposition of rule tree vs pure Dixon–Coles (same data, same cutoffs):

| Category | n | Rule tree | Dixon–Coles | Δ |
|---|---:|---:|---:|---:|
| Chaos Rule | 27 | 180 | 130 | −50 |
| Elite Away | 12 | 110 | 40 | −70 |
| Home Fortress | 4 | 40 | 40 | 0 |
| Mid vs Bottom | 4 | 20 | 20 | 0 |
| Mid-Table Deadlock | 11 | 80 | 80 | 0 |
| Smart Top 4 Home | 15 | 150 | 80 | −70 |
| Standard Away | 16 | 150 | 130 | −20 |
| Standard Home | 11 | 80 | 10 | −70 |
| **Total** | **100** | **810** | **530** | **−280** |

The λ model is **worse in every category that has headroom** and identical in the three that don't. Any blend that gives it real weight must lose points. A proxy-xG variant (rolling goals-based λ, no DC table) scored 52–53.

### 2.5 The holdout does not discriminate

On MW11 the two models are **exactly tied at 30/200**. So there is no signal on the holdout that could justify preferring the math over the rules — it is not that the blend failed to generalise, it is that the 30/200 sample contains no information distinguishing the two approaches (10 fixtures, ±20 per fixture).

---

## 3. Root cause: the 81 and the 30 are the same phenomenon

**81 and 30 are not a bad model and a good one. They are one model measured on its training set and on fresh data.**

- The tree's 15 thresholds were fitted by the author on MW1–MW10 of this exact season. The module comments record the ablations ("+30 there", "nets −40", "MW9 80 → 60"). The 810 is an **in-sample** number.
- MW11 is the first matchweek outside the fitting window. 30/200 = 15% is the honest expectation for a hand-tuned expert system that has memorised 100 fixtures. The independent Dixon–Coles model gets the same 30, which is strong evidence that MW11 is close to the *predictability floor* of this data rather than evidence of a fixable defect.
- The fail-safe therefore does not test "did the refactor improve the model" — it tests **"did the refactor memorise the training matchweeks at least as well as the original tuning did."** Those pull in opposite directions: every mechanism that generalises (decay, λ evidence, form) necessarily moves picks away from the fitted ones.

**Consequence for the spec:** requirements 1–3 and the fail-safe are mutually exclusive on this data. Requirements 1–3 all raise out-of-sample realism by overriding fitted rules; the fail-safe forbids any override that costs a single point in-sample. Measured on 79 configurations, the two cannot both be satisfied.

---

## 4. Recommendation

1. **Change the fail-safe to a holdout condition** — e.g. "MW11 must improve *and* MW1–MW10 must not drop more than X". Otherwise the upstream instruction is effectively "do not change the behaviour", which no refactor can satisfy.
2. **Get more holdout data before tuning further.** 10 fixtures is ±20 points per pick; a 30-vs-50 difference is 2 matches and is not statistically meaningful. MW12+ results, or the prior seasons replayed as pseudo-holdouts, would give a real signal.
3. **Re-baseline the 81.** Report in-sample and out-of-sample separately. The current single number invites tuning to it.
4. If the goal is genuinely a better *model*, the fix is not decay or blending — it is replacing the hardcoded tier lists (a 16-club snapshot that no result can ever change) with something that learns. That is a different project and will visibly drop the in-sample number.

## 5. Reproducing this

The harness was scratch-only and has been removed to honour "do not implement". It was four files: a CSV/openfootball loader, a `generateV2Predictions` driver over the 11 chunks with strictly pre-kickoff history, a config sweep, and the per-category decomposition. All numbers above are deterministic given the two data sources named in §1; no network beyond `api.github.com` was required.

*Working tree is clean. Nothing was committed, pushed, or opened as a PR.*
