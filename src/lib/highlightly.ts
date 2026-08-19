/**
 * Highlightly API client — match highlights & video clips.
 * Docs: https://highlightly.net/soccer-api
 *
 * Requires HIGHLIGHTLY_KEY environment variable.
 */

const BASE    = "https://soccer.highlightly.net";
const API_KEY = process.env.HIGHLIGHTLY_KEY ?? "";

const HEADERS = { "x-api-key": API_KEY };

async function hlFetch<T>(path: string, revalidate = 3600): Promise<T | null> {
  if (!API_KEY) return null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: HEADERS,
      next: { revalidate },
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Highlight {
  id:          string;
  title:       string;
  embed:       string;    // iframe embed URL
  url:         string;    // direct link
  thumbnail?:  string;
  date:        string;    // ISO date string
  competition: string;
  homeTeam:    string;
  awayTeam:    string;
  score?:      string;    // "2-1" format
}

interface HlHighlightRaw {
  id?:          string | number;
  title?:       string;
  embed?:       string;
  url?:         string;
  thumbnail?:   string;
  date?:        string;
  competition?: { name?: string } | string;
  homeTeam?:    { name?: string } | string;
  awayTeam?:    { name?: string } | string;
  score?:       string;
}

function parseHighlight(raw: HlHighlightRaw): Highlight {
  const competition =
    typeof raw.competition === "object"
      ? raw.competition?.name ?? ""
      : String(raw.competition ?? "");
  const homeTeam =
    typeof raw.homeTeam === "object"
      ? raw.homeTeam?.name ?? ""
      : String(raw.homeTeam ?? "");
  const awayTeam =
    typeof raw.awayTeam === "object"
      ? raw.awayTeam?.name ?? ""
      : String(raw.awayTeam ?? "");

  return {
    id:          String(raw.id ?? ""),
    title:       raw.title ?? `${homeTeam} vs ${awayTeam}`,
    embed:       raw.embed ?? "",
    url:         raw.url   ?? "",
    thumbnail:   raw.thumbnail,
    date:        raw.date  ?? new Date().toISOString(),
    competition,
    homeTeam,
    awayTeam,
    score:       raw.score,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the latest highlights (today / this week).
 */
export async function getLatestHighlights(limit = 20): Promise<Highlight[]> {
  const data = await hlFetch<{ data?: HlHighlightRaw[]; highlights?: HlHighlightRaw[] }>(
    `/highlights?limit=${limit}`,
  );
  const raw = data?.data ?? data?.highlights ?? [];
  return raw.map(parseHighlight).slice(0, limit);
}

/**
 * Search highlights by team name or competition name.
 */
export async function searchHighlights(
  query: string,
  limit = 10,
): Promise<Highlight[]> {
  const data = await hlFetch<{ data?: HlHighlightRaw[]; highlights?: HlHighlightRaw[] }>(
    `/highlights?search=${encodeURIComponent(query)}&limit=${limit}`,
  );
  const raw = data?.data ?? data?.highlights ?? [];
  return raw.map(parseHighlight).slice(0, limit);
}

/**
 * Fetch highlights for a specific match by home/away team names.
 */
export async function getMatchHighlights(
  homeTeam: string,
  awayTeam: string,
): Promise<Highlight[]> {
  const query = `${homeTeam} ${awayTeam}`;
  return searchHighlights(query, 5);
}

/**
 * Fetch highlights for a specific competition.
 */
export async function getCompetitionHighlights(
  competition: string,
  limit = 15,
): Promise<Highlight[]> {
  const data = await hlFetch<{ data?: HlHighlightRaw[]; highlights?: HlHighlightRaw[] }>(
    `/highlights?competition=${encodeURIComponent(competition)}&limit=${limit}`,
  );
  const raw = data?.data ?? data?.highlights ?? [];
  return raw.map(parseHighlight).slice(0, limit);
}
