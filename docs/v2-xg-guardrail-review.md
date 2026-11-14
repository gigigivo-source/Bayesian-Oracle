# V2 xG rule trial — guardrail review

**Date:** 2026-11-14  
**Branch:** `arena/3560e907-bayesian-oracle`  
**Season / league:** 2026-27 Premier League, MW1–MW10  
**Decision:** Keep V2 Strict 3-Snipe intact. Revert the Chaos and Top-4 derby overrides because they violate the no-regression guardrails; retain the Standard Engine-xG rule because its isolated trial preserves every matchweek score. No post-match xG was used as a prediction input.

## Trial results

Scores are out of 200 per matchweek (20 exact, 10 correct outcome, 0 miss). “Chaos trial” is Step 1 alone. “Engine xG trial” is Steps 2 and 3 with the existing Chaos rule retained. Both xG trials use only strictly prior scores and form; no observed xG columns are included.

| Variant | MW1 | MW2 | MW3 | MW4 | MW5 | MW6 | MW7 | MW8 | MW9 | MW10 | Avg | Floor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Existing V2 baseline (retained) | 60 | 50 | 60 | 50 | 100 | 60 | 90 | 60 | 40 | 90 | 66.0 | 40 |
| Chaos override only | 70 | 60 | 40 | 30 | 80 | 70 | 90 | 60 | 50 | 80 | 63.0 | 30 |
| Engine xG rules (Top-4 derbies + Standard blowouts; form-only inputs) | 60 | 50 | 60 | 50 | 90 | 60 | 90 | 40 | 50 | 90 | 64.0 | 40 |
| Standard Engine-xG rule only (retained) | 60 | 50 | 60 | 50 | 100 | 60 | 90 | 60 | 40 | 90 | 66.0 | 40 |

## Guardrail decisions

- **Chaos:** rolled back. It raises MW2 from 50 to 60, but takes MW5 from 100 to 80 and MW10 from 90 to 80. That fails two hard guardrails.
- **Top-4 derby xG:** rolled back. The form-only Engine trial raises MW9 from 40 to 50, but lowers MW5 from 100 to 90 and MW8 from 60 to 40. That fails the no-regression rule on two weeks, so the derby override was reverted despite the MW9 gain.
- **Standard blowout / high-draw xG:** retained. In an isolated rerun, every matchweek stayed at or above baseline. MW4 stays 50: the eligible Standard fixtures did not cross the specified 1.2 xG margin or 1.8/1.8 draw thresholds, so V2 kept its conservative picks. The rule remains available when Engine xG strongly supports a change.
- The input builder reads only earlier final scores to construct a pre-kickoff team-form summary. It does not read or parse the CSV's observed `HxG`/`AxG` columns; the Engine generates its expected-goal estimates from that prior form and its league anchors.
- **MW7 ≥100:** not achievable as a no-regression criterion on the supplied baseline: MW7 is 90 before any change. The baseline was preserved rather than tuning rules to that week's outcomes.
- The Chaos and Top-4 derby score overrides were reverted; the eligible Standard-only Engine xG rule is retained. The final table shows its isolated backtest, which equals the baseline for this sample.

## Final retained backtest (Standard Engine-xG rule only)

| Matchweek | MW1 | MW2 | MW3 | MW4 | MW5 | MW6 | MW7 | MW8 | MW9 | MW10 | Average | Floor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Points (max 200) | 60 | 50 | 60 | 50 | 100 | 60 | 90 | 60 | 40 | 90 | 66.0 | 40 |

**Retained target-week scores:** MW2 50, MW4 50, MW9 40. **Floor ≥60:** No (40).
