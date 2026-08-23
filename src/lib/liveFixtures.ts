import type { FixtureLite } from "./espn";
import { compareFixturesByPriority } from "./leaguePriority";

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Date window for the global live scoreboard.
 *
 * Most of the day only today's UTC fixtures are needed. Shortly after UTC
 * midnight we also include yesterday so a late match which crossed midnight
 * does not disappear before full time.
 */
export function liveScoreboardDates(now = new Date()): string {
  const today = dayKey(now);
  if (now.getUTCHours() >= 4) return today;

  const yesterday = new Date(now);
  yesterday.setUTCDate(now.getUTCDate() - 1);
  return `${dayKey(yesterday)}-${today}`;
}

/** Keep every in-play event once, ordered by the shared T1 → T6 comparator. */
export function selectLiveFixtures(fixtures: FixtureLite[]): FixtureLite[] {
  const seen = new Set<string>();
  return fixtures
    .filter((fixture) => {
      if (fixture.state !== "in" || seen.has(fixture.id)) return false;
      seen.add(fixture.id);
      return true;
    })
    .sort((a, b) => compareFixturesByPriority(a, b, (fixture) => fixture.date));
}
