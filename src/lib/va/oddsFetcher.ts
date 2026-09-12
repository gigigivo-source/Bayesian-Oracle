// Value Accumulator — Odds fetcher (independent, no accumulator reuse)
export interface VaBookmakerOdds {
  bookmaker: string;
  marketLabel: string;
  line: number | null;
  selection: string;
  odds: number;
}

interface AfOddsValue {
  value: string;
  odd: string;
}
interface AfBet {
  id?: number;
  name: string;
  values: AfOddsValue[];
}
interface AfBookmaker {
  id?: number;
  name: string;
  bets: AfBet[];
}
interface AfOddsResponse {
  get?: string;
  response: Array<{
    league?: unknown;
    fixture?: unknown;
    bookmakers: AfBookmaker[];
  }>;
  errors?: unknown;
}

function getApiKey(): string {
  return (process.env.API_FOOTBALL_KEY ?? process.env.FOOTBALL_API_KEY ?? "").trim();
}

function parseLineFromValue(value: string): number | null {
  // Extract first floating number from string, e.g. "Over 2.5" => 2.5, "Home -1.5" => -1.5?
  const m = value.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function parseOdds(oddStr: string): number | null {
  const n = Number(oddStr);
  if (!Number.isFinite(n) || n <= 1) return null;
  return n;
}

export async function fetchOddsForFixture(apiFootballFixtureId: string): Promise<VaBookmakerOdds[]> {
  const key = getApiKey();
  if (!key) return [];
  const idTrim = apiFootballFixtureId.trim();
  if (!idTrim) return [];

  const url = `https://v3.football.api-sports.io/odds?fixture=${encodeURIComponent(idTrim)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      headers: { "x-apisports-key": key },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as AfOddsResponse;
    if (!data?.response || data.response.length === 0) return [];

    const out: VaBookmakerOdds[] = [];
    for (const entry of data.response) {
      const bookmakers = entry.bookmakers ?? [];
      for (const bm of bookmakers) {
        const bookmakerName = bm.name?.trim() || "Unknown";
        for (const bet of bm.bets ?? []) {
          const marketLabel = bet.name?.trim();
          if (!marketLabel) continue;
          for (const v of bet.values ?? []) {
            const sel = v.value?.trim();
            if (!sel) continue;
            const odds = parseOdds(v.odd);
            if (odds === null) continue;
            const line = parseLineFromValue(sel);
            // For markets where line is part of selection, keep line separate but also keep selection full
            // For match winner, line will be null (no number)
            out.push({
              bookmaker: bookmakerName,
              marketLabel,
              line,
              selection: sel,
              odds,
            });
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
