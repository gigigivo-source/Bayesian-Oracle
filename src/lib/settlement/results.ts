import type { PendingAccumulator, PendingDailyPick, PendingValueBet } from "@/db/queries/settlement";
import { fetchScoreboard, type FixtureLite } from "@/lib/espn";
import type { MatchResult } from "./evaluate";

interface ResultRequest { leagueSlug: string; date: string }
interface AccumulatorLeg { fixtureId?: string; eventId?: string; leagueSlug?: string; date?: string; matchDate?: string; matchLabel?: string }

export interface SettlementQueues {
  accumulators: PendingAccumulator[];
  dailyPicks: PendingDailyPick[];
  valueBets: PendingValueBet[];
}

export function resultKey(label: string): string {
  return label.toLowerCase().replace(/\b(vs?\.?|versus)\b/g, " vs ").replace(/[^a-z0-9]+/g, " ").trim();
}

function espnDate(value?: string | null): string | null {
  if (!value) return null;
  const date = value.slice(0, 10).replace(/-/g, "");
  return /^\d{8}$/.test(date) ? date : null;
}

function addRequest(map: Map<string, ResultRequest>, leagueSlug?: string | null, dateValue?: string | null) {
  const date = espnDate(dateValue);
  if (leagueSlug && date) map.set(`${leagueSlug}|${date}`, { leagueSlug, date });
}

function addDailyPickRequest(map: Map<string, ResultRequest>, leagueSlug?: string | null, pickDate?: string | null) {
  const from = espnDate(pickDate);
  if (!leagueSlug || !from || !pickDate) return;
  // Daily picks may be published up to fourteen days before kick-off.
  const end = new Date(`${pickDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return;
  end.setUTCDate(end.getUTCDate() + 14);
  const to = end.toISOString().slice(0, 10).replace(/-/g, "");
  const date = `${from}-${to}`;
  map.set(`${leagueSlug}|${date}`, { leagueSlug, date });
}

export function collectResultRequests(queues: SettlementQueues): ResultRequest[] {
  const requests = new Map<string, ResultRequest>();
  for (const row of queues.dailyPicks) addDailyPickRequest(requests, row.leagueSlug, row.pickDate);
  for (const row of queues.valueBets) addRequest(requests, row.leagueSlug, row.matchDate);
  for (const slip of queues.accumulators) {
    if (!Array.isArray(slip.picks)) continue;
    for (const raw of slip.picks) {
      const leg = raw as AccumulatorLeg;
      addRequest(requests, leg.leagueSlug, leg.date ?? leg.matchDate);
    }
  }
  return [...requests.values()];
}

export class ResultsProvider {
  private readonly byKey = new Map<string, MatchResult>();

  add(fixture: FixtureLite): void {
    if (fixture.state !== "post" || fixture.home.score === null || fixture.away.score === null) return;
    const result: MatchResult = {
      eventId: fixture.id, leagueSlug: fixture.leagueSlug, date: fixture.date.slice(0, 10),
      homeName: fixture.home.name, awayName: fixture.away.name,
      homeScore: Number(fixture.home.score), awayScore: Number(fixture.away.score),
    };
    if (!Number.isFinite(result.homeScore) || !Number.isFinite(result.awayScore)) return;
    this.byKey.set(result.eventId, result);
    this.byKey.set(resultKey(`${result.homeName} vs ${result.awayName}`), result);
    this.byKey.set(resultKey(`${result.awayName} vs ${result.homeName}`), {
      ...result, homeName: result.awayName, awayName: result.homeName,
      homeScore: result.awayScore, awayScore: result.homeScore,
    });
  }

  find(eventId?: string | null, matchLabel?: string | null): MatchResult | undefined {
    return (eventId ? this.byKey.get(eventId) : undefined) ??
      (matchLabel ? this.byKey.get(resultKey(matchLabel)) : undefined);
  }

  get size(): number { return this.byKey.size; }
}

export async function fetchSettlementResults(queues: SettlementQueues): Promise<ResultsProvider> {
  const requests = collectResultRequests(queues);
  const responses = await Promise.allSettled(
    requests.map(({ leagueSlug, date }) => fetchScoreboard(leagueSlug, date)),
  );
  const provider = new ResultsProvider();
  for (const response of responses) {
    if (response.status === "fulfilled") response.value.forEach((fixture) => provider.add(fixture));
  }
  return provider;
}

export const buildResultsProvider = fetchSettlementResults;
