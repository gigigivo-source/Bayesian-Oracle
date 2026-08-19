// API-Football (api-sports.io) integration — 11 bookmaker odds + match stats
const BASE = "https://v3.football.api-sports.io";

function getKey(): string {
  return process.env.API_FOOTBALL_KEY ?? process.env.FOOTBALL_API_KEY ?? "";
}

async function apiFetch<T>(path: string): Promise<T | null> {
  const key = getKey();
  if (!key) return null; // no API-Football key configured → skip (fail-soft)
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "x-apisports-key": key },
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MultiBookOdds {
  bookmaker: string;
  homeOdds:  number;
  drawOdds:  number;
  awayOdds:  number;
}

export interface OverUnderLine {
  bookmaker: string;
  line:      string;
  over:      number;
  under:     number;
}

export interface ApiFootballOddsResult {
  fixtureId:      number;
  bookmakers:     MultiBookOdds[];
  bestHome:       number;
  bestDraw:       number;
  bestAway:       number;
  overUnderLines: OverUnderLine[];
}

// ─── Internal ESPN response shapes ───────────────────────────────────────────

interface AfFixtureResponse {
  response: Array<{
    fixture: { id: number; date: string; status: { short: string } };
    teams:   { home: { name: string }; away: { name: string } };
    league:  { name: string };
  }>;
}

interface AfOddsValue  { value: string; odd: string }
interface AfBet        { name: string; values: AfOddsValue[] }
interface AfBookmaker  { name: string; bets: AfBet[] }
interface AfOddsResponse {
  response: Array<{ bookmakers: AfBookmaker[] }>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Search API-Football for a fixture by team names and date */
export async function searchFixture(
  home: string,
  away: string,
  date: string,
): Promise<number | null> {
  const data = await apiFetch<AfFixtureResponse>(`/fixtures?date=${date}`);
  if (!data?.response) return null;

  const match = data.response.find((f) => {
    const h = f.teams.home.name.toLowerCase();
    const a = f.teams.away.name.toLowerCase();
    return (
      h.includes(home.toLowerCase().slice(0, 5)) ||
      a.includes(away.toLowerCase().slice(0, 5))
    );
  });
  return match?.fixture.id ?? null;
}

/** Get multi-bookmaker odds for a fixture */
export async function getMultiBookOdds(
  fixtureId: number,
): Promise<ApiFootballOddsResult | null> {
  const data = await apiFetch<AfOddsResponse>(`/odds?fixture=${fixtureId}`);
  if (!data?.response?.[0]?.bookmakers) return null;

  const bookmakers: MultiBookOdds[]  = [];
  const ouLines:    OverUnderLine[] = [];

  for (const bm of data.response[0].bookmakers) {
    // ── 1X2 ──────────────────────────────────────────────────────────────────
    const mw = bm.bets.find((b) => b.name === "Match Winner");
    if (mw) {
      const h = parseFloat(mw.values.find((v) => v.value === "Home")?.odd ?? "0");
      const d = parseFloat(mw.values.find((v) => v.value === "Draw")?.odd ?? "0");
      const a = parseFloat(mw.values.find((v) => v.value === "Away")?.odd ?? "0");
      if (h > 0) bookmakers.push({ bookmaker: bm.name, homeOdds: h, drawOdds: d, awayOdds: a });
    }

    // ── Goals O/U ─────────────────────────────────────────────────────────────
    const goals = bm.bets.find((b) => b.name?.includes("Goals Over/Under"));
    if (goals) {
      for (const v of goals.values) {
        const [direction, line] = v.value.split(" ");
        if (direction === "Over" && line) {
          const under = goals.values.find((uv) => uv.value === `Under ${line}`);
          if (under) {
            ouLines.push({
              bookmaker: bm.name,
              line,
              over:  parseFloat(v.odd),
              under: parseFloat(under.odd),
            });
          }
        }
      }
    }
  }

  return {
    fixtureId,
    bookmakers,
    bestHome: bookmakers.length > 0 ? Math.max(...bookmakers.map((b) => b.homeOdds)) : 0,
    bestDraw: bookmakers.length > 0 ? Math.max(...bookmakers.map((b) => b.drawOdds)) : 0,
    bestAway: bookmakers.length > 0 ? Math.max(...bookmakers.map((b) => b.awayOdds)) : 0,
    overUnderLines: ouLines,
  };
}

/** Get today's fixtures from API-Football */
export async function getTodayFixtures(): Promise<
  Array<{ id: number; home: string; away: string; league: string; date: string; status: string }>
> {
  const today = new Date().toISOString().slice(0, 10);
  const data  = await apiFetch<AfFixtureResponse>(`/fixtures?date=${today}`);
  if (!data?.response) return [];
  return data.response.map((f) => ({
    id:     f.fixture.id,
    home:   f.teams.home.name,
    away:   f.teams.away.name,
    league: f.league.name,
    date:   f.fixture.date,
    status: f.fixture.status.short,
  }));
}
