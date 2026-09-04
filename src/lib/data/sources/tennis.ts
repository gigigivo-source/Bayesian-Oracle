// ĞIGI GIVØ — Tennis data layer (ATP / WTA).
//
// The second sport of the supercomputer, alongside football. Everything the
// tennis prediction engine consumes is normalised here:
//
//   · Completed matches (for the ELO replay and serve-stat baselines)
//       1. Jeff Sackmann's tennis_atp / tennis_wta CSVs on GitHub — the
//          canonical per-season match logs (surface, score, aces, double
//          faults, break points). The canonical repos went offline mid-2026,
//          so a list of actively-maintained forks is tried in order.
//       2. tennis-data.co.uk per-tournament CSVs — the odds layer (AvgW/AvgL,
//          Pinnacle, Bet365) plus a second copy of results by tournament.
//   · Upcoming fixtures — the ESPN tennis scoreboard (same public feed the
//     football half of the app already uses), filtered to singles matches
//     that have not started yet.
//
// Integrity contract (identical to the football sources): every completed
// match is a real result from a real source — nothing is simulated. A source
// that fails is reported in `sources`, never silently replaced. Ratings and
// serve baselines that cannot be computed from real history are returned as
// `null` and the engine falls back to clearly-labelled priors.

import { fetchWithTimeout } from "../http";
import { resilientJson } from "@/lib/httpClient";
import { parseCsv } from "./githubDatasets";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TennisTour = "atp" | "wta";

export type TennisSurface = "clay" | "grass" | "hard" | "carpet";

export type TennisDataSource = "sackmann" | "tennis-data" | "espn";

/** How the match actually finished — drives which samples feed the model. */
export type TennisFinish = "completed" | "retired" | "walkover";

/** Per-player serve stats for one completed match (null = source lacks it). */
export interface TennisServeStats {
  aces: number | null;
  doubleFaults: number | null;
  servePoints: number | null;
  serviceGames: number | null;
  bpSaved: number | null;
  bpFaced: number | null;
}

const EMPTY_SERVE_STATS: TennisServeStats = {
  aces: null,
  doubleFaults: null,
  servePoints: null,
  serviceGames: null,
  bpSaved: null,
  bpFaced: null,
};

/** A completed match, normalised from either historical source. */
export interface TennisMatch {
  /** De-duplication key: `${source}|${tour}|${date}|${winnerKey}|${loserKey}`. */
  id: string;
  tour: TennisTour;
  /** Tournament display name, e.g. "US Open" / "Roland Garros". */
  tournament: string;
  surface: TennisSurface | null;
  /** ISO date (YYYY-MM-DDT00:00:00Z). */
  matchDate: string;
  round: string | null;
  bestOf: 3 | 5 | null;
  winner: string;
  loser: string;
  /** Raw set-score string, winner first: "6-3 3-6 7-6(4)". */
  score: string;
  finish: TennisFinish;
  winnerStats: TennisServeStats;
  loserStats: TennisServeStats;
  /** Decimal pre-match odds (winner, loser) when the source carries them. */
  odds: { winner: number | null; loser: number | null; book: string } | null;
  /** ATP/WTA entry rank of each player at match time, when the source has it. */
  winnerRank: number | null;
  loserRank: number | null;
  source: TennisDataSource;
}

/** A scheduled or in-progress singles match from the ESPN scoreboard. */
export interface UpcomingTennisMatch {
  id: string;
  tour: TennisTour;
  tournament: string;
  surface: TennisSurface | null;
  round: string | null;
  date: string;
  venue: string | null;
  status: "scheduled" | "live" | "complete";
  /** 3 or 5 — from the ESPN format when present, else tournament rules. */
  bestOf: 3 | 5;
  /** [first listed player, second listed player] — order is cosmetic. */
  players: [TennisPlayerRef, TennisPlayerRef];
}

export interface TennisPlayerRef {
  name: string;
  /** Country code / flag alt text when ESPN provides it. */
  country: string | null;
}

/** Per-player baselines derived from the completed-match dataset. */
export interface TennisPlayerProfile {
  player: string;
  key: string;
  tour: TennisTour;
  matchesPlayed: number;
  wins: number;
  lastPlayed: string | null;
  /** Latest ATP/WTA rank seen in the dataset (entry rank at match time). */
  rank: number | null;
  /** Career per-match averages over completed matches with stat coverage. */
  acesPerMatch: number | null;
  doubleFaultsPerMatch: number | null;
  bpFacedPerMatch: number | null;
  bpSavedPerMatch: number | null;
  /** Surface-split averages (clay/grass/hard) with their sample sizes. */
  surface: Record<
    TennisSurface,
    {
      matches: number;
      acesPerMatch: number | null;
      doubleFaultsPerMatch: number | null;
      bpFacedPerMatch: number | null;
    }
  >;
}

export interface TennisSourceReport {
  source: string;
  attempted: boolean;
  added: number;
  note: string;
}

export interface TennisDataset {
  tour: TennisTour;
  matches: TennisMatch[];
  profiles: Map<string, TennisPlayerProfile>;
  sources: TennisSourceReport[];
  generatedAt: string;
}

// ─── Names & surfaces ─────────────────────────────────────────────────────────

/**
 * Normalise a player name for lookups: lowercase, strip diacritics and
 * punctuation, collapse whitespace. "Alex De Minaur" ≡ "alex de minaur".
 */
export function normalisePlayerName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable key for a player within a tour pool. */
export function tennisPlayerKey(player: string): string {
  return normalisePlayerName(player);
}

function surnameOf(name: string): string {
  const parts = normalisePlayerName(name).split(" ").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function initialsOf(name: string): string {
  return normalisePlayerName(name)
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("");
}

/**
 * Loose player-name equality across providers (ESPN ↔ Sackmann ↔
 * tennis-data.co.uk). Exact normalised match first, then surname + initial
 * overlap, so "F. Tiafoe" resolves to "Frances Tiafoe" but two different
 * players sharing a surname (M. Zverev / A. Zverev) do not collide.
 */
export function playerNamesMatch(a: string, b: string): boolean {
  const na = normalisePlayerName(a);
  const nb = normalisePlayerName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const sa = surnameOf(a);
  const sb = surnameOf(b);
  if (!sa || !sb || sa !== sb) return false;
  const ia = initialsOf(a);
  const ib = initialsOf(b);
  if (!ia || !ib) return false;
  return ia[0] === ib[0];
}

/** Canonicalise a surface string from any source; null when unrecognised. */
export function normaliseSurface(raw: unknown): TennisSurface | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("clay")) return "clay";
  if (s.startsWith("grass")) return "grass";
  if (s.startsWith("hard")) return "hard";
  if (s.startsWith("carpet")) return "carpet";
  return null;
}

/**
 * Static surface map for tournaments the ESPN feed names but does not
 * surface-tag. Grand Slams and the big combined events; anything else falls
 * through to inference from the historical dataset.
 */
const TOURNAMENT_SURFACE_HINTS: Array<[pattern: RegExp, surface: TennisSurface]> = [
  [/australian open/i, "hard"],
  [/roland garros|french open/i, "clay"],
  [/wimbledon/i, "grass"],
  [/us open/i, "hard"],
  [/indian wells/i, "hard"],
  [/miami open|^miami$/i, "hard"],
  [/monte[- ]carlo/i, "clay"],
  [/madrid open|^madrid$/i, "clay"],
  [/italian open|^rome$/i, "clay"],
  [/hamburg/i, "clay"],
  [/cincinnati/i, "hard"],
  [/canada|montreal|toronto/i, "hard"],
  [/shanghai/i, "hard"],
  [/paris masters|^paris$/i, "hard"],
  [/dubai/i, "hard"],
  [/doha/i, "hard"],
  [/abu dhabi/i, "hard"],
  [/rotterdam|iwtela/i, "hard"],
  [/marseille|open 13/i, "hard"],
  [/doha|dubai|delray|acapulco/i, "hard"],
  [/estoril|casablanca|houston|barcelona|estoril|munich|umag|bastad|gstaad|kitzbuhel|umag/i, "clay"],
  [/queen.?s|halle|eastbourne|mallorca|hertogenbosch|s.?hertogenbosch|stuttgart/i, "grass"],
  [/vienna|basel|antwerp|tokyo|beijing|seoul|stockholm|almaty|astana/i, "hard"],
];

/** Infer a tournament's surface from its name, with history as the tiebreak. */
export function inferSurface(
  tournament: string,
  history: TennisMatch[] = [],
): TennisSurface | null {
  for (const [pattern, surface] of TOURNAMENT_SURFACE_HINTS) {
    if (pattern.test(tournament)) return surface;
  }
  // Fall back to the most common surface this tournament was played on.
  const counts = new Map<TennisSurface, number>();
  for (const match of history) {
    if (match.surface && namesTournament(match.tournament, tournament)) {
      counts.set(match.surface, (counts.get(match.surface) ?? 0) + 1);
    }
  }
  let best: TennisSurface | null = null;
  let bestCount = 0;
  for (const [surface, count] of counts) {
    if (count > bestCount) {
      best = surface;
      bestCount = count;
    }
  }
  return best;
}

/** Loose tournament-name equality ("US Open" ≈ "US Open Championships"). */
function namesTournament(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

const GRAND_SLAM_PATTERN =
  /australian open|roland garros|french open|wimbledon|us open/i;

/** Best-of for a tournament: men's Grand Slams are best-of-5, all else 3. */
export function bestOfForTournament(tournament: string, tour: TennisTour): 3 | 5 {
  if (tour === "atp" && GRAND_SLAM_PATTERN.test(tournament)) return 5;
  return 3;
}

// ─── Sackmann CSV parser (pure) ───────────────────────────────────────────────

/**
 * Parse one Jeff Sackmann-format season file
 * (`atp_matches_YYYY.csv` / `wta_matches_YYYY.csv`).
 *
 * Columns used: tourney_id, tourney_name, surface, tourney_level, tourney_date
 * (YYYYMMDD), match_num, winner_name, loser_name, score, best_of, round,
 * w_ace, w_df, w_svpt, w_SvGms, w_bpSaved, w_bpFaced, l_* equivalents.
 */
export function parseSackmannTennisCsv(csvText: string, tour: TennisTour): TennisMatch[] {
  const rows = parseCsv(csvText, 20_000);
  if (rows.length < 2) return [];

  const header = rows[0];
  const col = new Map<string, number>();
  header.forEach((cell, i) => {
    const key = cell.trim().toLowerCase();
    if (!col.has(key)) col.set(key, i);
  });
  const idx = (name: string): number | undefined => col.get(name);

  const dateCol = idx("tourney_date");
  const nameCol = idx("tourney_name");
  const surfaceCol = idx("surface");
  const roundCol = idx("round");
  const bestOfCol = idx("best_of");
  const matchNumCol = idx("match_num");
  const winnerCol = idx("winner_name");
  const loserCol = idx("loser_name");
  const scoreCol = idx("score");
  if (winnerCol === undefined || loserCol === undefined || scoreCol === undefined) return [];

  const num = (row: string[], i: number | undefined): number | null => {
    if (i === undefined) return null;
    const raw = row[i]?.trim();
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const txt = (row: string[], i: number | undefined): string | null => {
    if (i === undefined) return null;
    const raw = row[i]?.trim();
    return raw ? raw : null;
  };

  const matches: Array<{ match: TennisMatch; order: number }> = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const winner = txt(row, winnerCol);
    const loser = txt(row, loserCol);
    const score = txt(row, scoreCol);
    if (!winner || !loser || !score) continue;
    if (tennisPlayerKey(winner) === tennisPlayerKey(loser)) continue;

    const dateRaw = num(row, dateCol);
    const matchDate = dateRaw && dateRaw >= 19000101
      ? `${String(dateRaw).slice(0, 4)}-${String(dateRaw).slice(4, 6)}-${String(dateRaw).slice(6, 8)}T00:00:00Z`
      : null;
    if (!matchDate) continue;

    const bestOfRaw = num(row, bestOfCol);
    const tournament = txt(row, nameCol) ?? "Tournament";

    matches.push({
      match: {
        id: `sackmann|${tour}|${matchDate.slice(0, 10)}|${tennisPlayerKey(winner)}|${tennisPlayerKey(loser)}`,
        tour,
        tournament,
        surface: normaliseSurface(txt(row, surfaceCol)),
        matchDate,
        round: txt(row, roundCol),
        bestOf: bestOfRaw === 5 ? 5 : bestOfRaw === 3 ? 3 : bestOfForTournament(tournament, tour),
        winner,
        loser,
        score,
        finish: finishFromScore(score),
        winnerStats: {
          aces: num(row, idx("w_ace")),
          doubleFaults: num(row, idx("w_df")),
          servePoints: num(row, idx("w_svpt")),
          serviceGames: num(row, idx("w_svgms")),
          bpSaved: num(row, idx("w_bpsaved")),
          bpFaced: num(row, idx("w_bpfaced")),
        },
        loserStats: {
          aces: num(row, idx("l_ace")),
          doubleFaults: num(row, idx("l_df")),
          servePoints: num(row, idx("l_svpt")),
          serviceGames: num(row, idx("l_svgms")),
          bpSaved: num(row, idx("l_bpsaved")),
          bpFaced: num(row, idx("l_bpfaced")),
        },
        odds: null, // Sackmann carries no odds — the tennis-data.co.uk layer adds them.
        winnerRank: num(row, idx("winner_rank")),
        loserRank: num(row, idx("loser_rank")),
        source: "sackmann",
      },
      // The season file lists finals first (descending match_num); ascending
      // match_num restores chronological order within a tournament week.
      order: num(row, matchNumCol) ?? Number.POSITIVE_INFINITY,
    });
  }

  matches.sort((a, b) => {
    const byDate = a.match.matchDate.localeCompare(b.match.matchDate);
    if (byDate !== 0) return byDate;
    return a.order - b.order;
  });
  return matches.map((entry) => entry.match);
}

/** Classify how a match finished from its score string. */
export function finishFromScore(score: string): TennisFinish {
  if (/w\/o|walkover|\bdef\b|\babd\b|\babn\b|\bbug\b|^walk/i.test(score)) return "walkover";
  if (/ret/i.test(score)) return "retired";
  return "completed";
}

// ─── tennis-data.co.uk CSV parser (pure) ──────────────────────────────────────

/**
 * Parse one tennis-data.co.uk per-tournament CSV
 * (`http://www.tennis-data.co.uk/{year}/{slug}.csv`, or `{year}w/` for the
 * WTA tour). This is the odds-bearing layer: AvgW/AvgL (Oddsportal market
 * average) are preferred, then Pinnacle, then Bet365.
 */
export function parseTennisDataCsv(csvText: string, tour: TennisTour): TennisMatch[] {
  const rows = parseCsv(csvText, 8_000);
  if (rows.length < 2) return [];

  const header = rows[0];
  const col = new Map<string, number>();
  header.forEach((cell, i) => {
    const key = cell.trim().toLowerCase().replace(/[^a-z0-9&]/g, "");
    if (!col.has(key)) col.set(key, i);
  });
  const idx = (name: string): number | undefined => col.get(name);

  const dateCol = idx("date");
  const tournamentCol = idx("tournament");
  const surfaceCol = idx("surface");
  const roundCol = idx("round");
  const bestOfCol = idx("bestof");
  const winnerCol = idx("winner");
  const loserCol = idx("loser");
  const commentCol = idx("comment");
  if (winnerCol === undefined || loserCol === undefined || dateCol === undefined) return [];

  const num = (row: string[], i: number | undefined): number | null => {
    if (i === undefined) return null;
    const raw = row[i]?.trim();
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  /** Odds/ranks must be positive — a blank or 0 cell is "no data". */
  const positive = (row: string[], i: number | undefined): number | null => {
    const n = num(row, i);
    return n !== null && n > 0 ? n : null;
  };
  const txt = (row: string[], i: number | undefined): string | null => {
    if (i === undefined) return null;
    const raw = row[i]?.trim();
    return raw ? raw : null;
  };

  const matches: TennisMatch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const winner = txt(row, winnerCol);
    const loser = txt(row, loserCol);
    const dateIso = parseTennisDataDate(txt(row, dateCol));
    if (!winner || !loser || !dateIso) continue;
    if (tennisPlayerKey(winner) === tennisPlayerKey(loser)) continue;

    const setScores: string[] = [];
    for (let s = 1; s <= 5; s++) {
      const w = num(row, idx(`w${s}`));
      const l = num(row, idx(`l${s}`));
      if (w !== null && l !== null) setScores.push(`${w}-${l}`);
    }
    const comment = txt(row, commentCol);
    const finish: TennisFinish = /retire/i.test(comment ?? "")
      ? "retired"
      : /walkover|w\/o/i.test(comment ?? "")
        ? "walkover"
        : finishFromScore(setScores.join(" "));
    const scoreSuffix = finish === "retired" ? " RET" : finish === "walkover" ? " W/O" : "";
    const tournament = txt(row, tournamentCol) ?? "Tournament";

    // Odds: market average first, then Pinnacle, then Bet365 — a consistent
    // (winner, loser) pair from the highest-priority book that has both.
    let oddsWinner: number | null = null;
    let oddsLoser: number | null = null;
    let oddsBook: string | null = null;
    for (const [book, wCol, lCol] of [
      ["Oddsportal average", "avgw", "avgl"],
      ["Pinnacle", "psw", "psl"],
      ["Bet365", "b365w", "b365l"],
    ] as const) {
      const w = positive(row, idx(wCol));
      const l = positive(row, idx(lCol));
      if (w !== null && l !== null) {
        oddsWinner = w;
        oddsLoser = l;
        oddsBook = book;
        break;
      }
    }

    matches.push({
      id: `tennis-data|${tour}|${dateIso.slice(0, 10)}|${tennisPlayerKey(winner)}|${tennisPlayerKey(loser)}`,
      tour,
      tournament,
      surface: normaliseSurface(txt(row, surfaceCol)),
      matchDate: dateIso,
      round: txt(row, roundCol),
      bestOf: (() => {
        const bo = num(row, bestOfCol);
        return bo === 5 ? 5 : bo === 3 ? 3 : bestOfForTournament(tournament, tour);
      })(),
      winner,
      loser,
      score: setScores.length > 0 ? setScores.join(" ") + scoreSuffix : (comment ?? ""),
      finish,
      // tennis-data.co.uk carries no serve stats — aces/DFs/BPs stay null.
      winnerStats: EMPTY_SERVE_STATS,
      loserStats: EMPTY_SERVE_STATS,
      odds: oddsWinner !== null && oddsLoser !== null
        ? { winner: oddsWinner, loser: oddsLoser, book: oddsBook ?? "" }
        : null,
      winnerRank: positive(row, idx("wrank")),
      loserRank: positive(row, idx("lrank")),
      source: "tennis-data",
    });
  }

  return matches.sort((a, b) => a.matchDate.localeCompare(b.matchDate));
}

/** tennis-data.co.uk dates: `dd/mm/yy` or `dd/mm/yyyy` → ISO. */
export function parseTennisDataDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (m[3].length === 2) year = year < 70 ? 2000 + year : 1900 + year; // dataset starts 2000
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00Z`;
}

// ─── ESPN upcoming-fixture parser (pure) ──────────────────────────────────────

interface EspnTennisScoreboard {
  events?: Array<{
    name?: string;
    groupings?: Array<{
      grouping?: { displayName?: string; slug?: string };
      competitions?: unknown[];
    }>;
  }>;
}

/**
 * Normalise an ESPN tennis scoreboard into upcoming singles matches. Only the
 * groupings for the tour's singles draw are kept (doubles, wheelchair and
 * legends exhibitions are dropped), and every match carries its own state so
 * the caller can filter scheduled / live / complete.
 */
export function parseEspnTennisScoreboard(
  json: unknown,
  tour: TennisTour,
  history: TennisMatch[] = [],
): UpcomingTennisMatch[] {
  const board = json as EspnTennisScoreboard | null;
  if (!board || typeof board !== "object") return [];

  const wantedSlug = tour === "atp" ? "mens-singles" : "womens-singles";
  const wantedName = tour === "atp" ? "men's singles" : "women's singles";
  const upcoming: UpcomingTennisMatch[] = [];

  for (const event of board.events ?? []) {
    const tournament = event.name ?? "Tennis";
    for (const grouping of event.groupings ?? []) {
      const slug = grouping.grouping?.slug ?? "";
      const groupName = (grouping.grouping?.displayName ?? "").toLowerCase();
      const isSingles = slug === wantedSlug || groupName === wantedName;
      if (!isSingles) continue;

      for (const rawComp of grouping.competitions ?? []) {
        const comp = rawComp as Record<string, unknown> | null;
        if (!comp || typeof comp !== "object") continue;

        const competitors = Array.isArray(comp.competitors) ? (comp.competitors as Record<string, unknown>[]) : [];
        if (competitors.length < 2) continue;

        const names = competitors.map((c) => {
          const athlete = c.athlete as Record<string, unknown> | undefined;
          return (athlete?.displayName ?? athlete?.fullName ?? null) as string | null;
        });
        if (!names[0] || !names[1]) continue;

        const statusType = ((comp.status as Record<string, unknown> | undefined)?.type ?? {}) as Record<string, unknown>;
        const state = typeof statusType.state === "string" ? statusType.state : "";
        const status: UpcomingTennisMatch["status"] =
          state === "pre" ? "scheduled" : state === "in" ? "live" : "complete";

        const venueObj = (comp.venue as Record<string, unknown> | undefined) ?? {};
        const venue = typeof venueObj.fullName === "string" ? venueObj.fullName : null;
        const roundObj = (comp.round as Record<string, unknown> | undefined) ?? {};
        const round = typeof roundObj.displayName === "string" ? roundObj.displayName : null;
        const date = typeof comp.date === "string" ? comp.date : null;
        if (!date) continue;

        const id = typeof comp.id === "string" ? comp.id : `${tour}-${date}-${names[0]}`;
        const flags = competitors.map((c) => {
          const athlete = c.athlete as Record<string, unknown> | undefined;
          const flag = athlete?.flag as Record<string, unknown> | undefined;
          return typeof flag?.alt === "string" ? (flag.alt as string) : null;
        });
        // Best-of: the scoreboard exposes the set count for slams; otherwise
        // the tournament rules decide (men's slams = best-of-5).
        const formatObj = (comp.format as Record<string, unknown> | undefined) ?? {};
        const regulation = (formatObj.regulation as Record<string, unknown> | undefined) ?? {};
        const periods = typeof regulation.periods === "number" ? regulation.periods : null;
        const bestOf: 3 | 5 = periods === 5 ? 5 : bestOfForTournament(tournament, tour);

        upcoming.push({
          id,
          tour,
          tournament,
          surface: inferSurface(tournament, history),
          round,
          date,
          venue,
          status,
          bestOf,
          players: [
            { name: names[0], country: flags[0] },
            { name: names[1], country: flags[1] },
          ],
        });
      }
    }
  }

  return upcoming;
}

// ─── Player profiles (aggregation, pure) ──────────────────────────────────────

function emptySurfaceSplit(): TennisPlayerProfile["surface"] {
  return {
    clay: { matches: 0, acesPerMatch: null, doubleFaultsPerMatch: null, bpFacedPerMatch: null },
    grass: { matches: 0, acesPerMatch: null, doubleFaultsPerMatch: null, bpFacedPerMatch: null },
    hard: { matches: 0, acesPerMatch: null, doubleFaultsPerMatch: null, bpFacedPerMatch: null },
    carpet: { matches: 0, acesPerMatch: null, doubleFaultsPerMatch: null, bpFacedPerMatch: null },
  };
}

/**
 * Aggregate completed matches into per-player baselines. Only `completed`
 * matches contribute to serve averages (retirements and walkovers have
 * truncated stats); every finish counts for matches-played and the ELO replay.
 */
export function buildTennisPlayerProfiles(
  matches: TennisMatch[],
  tour: TennisTour,
): Map<string, TennisPlayerProfile> {
  interface Acc {
    profile: TennisPlayerProfile;
    rankDate: string | null;
    aces: number; acesN: number;
    df: number; dfN: number;
    bpFaced: number; bpN: number;
    bpSaved: number; bpSavedN: number;
    surfaceStats: Record<
      TennisSurface,
      { aces: number; acesN: number; df: number; dfN: number; bpFaced: number; bpN: number }
    >;
  }

  const accs = new Map<string, Acc>();
  const accFor = (player: string): Acc => {
    const key = tennisPlayerKey(player);
    let acc = accs.get(key);
    if (!acc) {
      acc = {
        profile: {
          player,
          key,
          tour,
          matchesPlayed: 0,
          wins: 0,
          lastPlayed: null,
          rank: null,
          acesPerMatch: null,
          doubleFaultsPerMatch: null,
          bpFacedPerMatch: null,
          bpSavedPerMatch: null,
          surface: emptySurfaceSplit(),
        },
        rankDate: null,
        aces: 0, acesN: 0,
        df: 0, dfN: 0,
        bpFaced: 0, bpN: 0,
        bpSaved: 0, bpSavedN: 0,
        surfaceStats: {
          clay: { aces: 0, acesN: 0, df: 0, dfN: 0, bpFaced: 0, bpN: 0 },
          grass: { aces: 0, acesN: 0, df: 0, dfN: 0, bpFaced: 0, bpN: 0 },
          hard: { aces: 0, acesN: 0, df: 0, dfN: 0, bpFaced: 0, bpN: 0 },
          carpet: { aces: 0, acesN: 0, df: 0, dfN: 0, bpFaced: 0, bpN: 0 },
        },
      };
      accs.set(key, acc);
    }
    return acc;
  };

  const fold = (acc: Acc, stats: TennisServeStats, surface: TennisSurface | null, won: boolean): void => {
    acc.profile.matchesPlayed++;
    if (won) acc.profile.wins++;
    if (stats.aces !== null) { acc.aces += stats.aces; acc.acesN++; }
    if (stats.doubleFaults !== null) { acc.df += stats.doubleFaults; acc.dfN++; }
    if (stats.bpFaced !== null) { acc.bpFaced += stats.bpFaced; acc.bpN++; }
    if (stats.bpSaved !== null) { acc.bpSaved += stats.bpSaved; acc.bpSavedN++; }
    if (surface) {
      const s = acc.surfaceStats[surface];
      if (stats.aces !== null) { s.aces += stats.aces; s.acesN++; }
      if (stats.doubleFaults !== null) { s.df += stats.doubleFaults; s.dfN++; }
      if (stats.bpFaced !== null) { s.bpFaced += stats.bpFaced; s.bpN++; }
    }
  };

  /** Record the freshest entry rank seen for the player. */
  const noteRank = (acc: Acc, rank: number | null, matchDate: string): void => {
    if (rank === null) return;
    if (acc.rankDate === null || matchDate >= acc.rankDate) {
      acc.profile.rank = rank;
      acc.rankDate = matchDate;
    }
  };

  for (const match of matches) {
    const winnerAcc = accFor(match.winner);
    const loserAcc = accFor(match.loser);
    if (!winnerAcc.profile.lastPlayed || match.matchDate > winnerAcc.profile.lastPlayed) {
      winnerAcc.profile.lastPlayed = match.matchDate;
    }
    if (!loserAcc.profile.lastPlayed || match.matchDate > loserAcc.profile.lastPlayed) {
      loserAcc.profile.lastPlayed = match.matchDate;
    }
    noteRank(winnerAcc, match.winnerRank, match.matchDate);
    noteRank(loserAcc, match.loserRank, match.matchDate);
    // Only full-length matches contribute to serve baselines.
    if (match.finish === "completed") {
      fold(winnerAcc, match.winnerStats, match.surface, true);
      fold(loserAcc, match.loserStats, match.surface, false);
    } else {
      winnerAcc.profile.matchesPlayed++;
      winnerAcc.profile.wins++;
      loserAcc.profile.matchesPlayed++;
    }
  }

  for (const acc of accs.values()) {
    const p = acc.profile;
    p.acesPerMatch = acc.acesN > 0 ? acc.aces / acc.acesN : null;
    p.doubleFaultsPerMatch = acc.dfN > 0 ? acc.df / acc.dfN : null;
    p.bpFacedPerMatch = acc.bpN > 0 ? acc.bpFaced / acc.bpN : null;
    p.bpSavedPerMatch = acc.bpSavedN > 0 ? acc.bpSaved / acc.bpSavedN : null;
    for (const surface of ["clay", "grass", "hard", "carpet"] as const) {
      const s = acc.surfaceStats[surface];
      p.surface[surface] = {
        matches: s.acesN + s.dfN > 0 ? Math.max(s.acesN, s.dfN) : 0,
        acesPerMatch: s.acesN > 0 ? s.aces / s.acesN : null,
        doubleFaultsPerMatch: s.dfN > 0 ? s.df / s.dfN : null,
        bpFacedPerMatch: s.bpN > 0 ? s.bpFaced / s.bpN : null,
      };
    }
  }

  const profiles = new Map<string, TennisPlayerProfile>();
  for (const [key, acc] of accs) profiles.set(key, acc.profile);
  return profiles;
}

/** Surface-aware serve baseline: the surface split when the sample is big enough. */
export function surfaceServeBaseline(
  profile: TennisPlayerProfile | null,
  surface: TennisSurface | null,
):
  | {
      acesPerMatch: number | null;
      doubleFaultsPerMatch: number | null;
      bpFacedPerMatch: number | null;
      source: "surface" | "overall" | "none";
    }
  | null {
  if (!profile) return null;
  if (surface) {
    const split = profile.surface[surface];
    // Surface-specific rates are used once the player has ~5 sampled matches
    // on it; below that the career average is the better estimator.
    if (split.matches >= 5) {
      return {
        acesPerMatch: split.acesPerMatch ?? profile.acesPerMatch,
        doubleFaultsPerMatch: split.doubleFaultsPerMatch ?? profile.doubleFaultsPerMatch,
        bpFacedPerMatch: split.bpFacedPerMatch ?? profile.bpFacedPerMatch,
        source: "surface",
      };
    }
  }
  if (
    profile.acesPerMatch !== null ||
    profile.doubleFaultsPerMatch !== null ||
    profile.bpFacedPerMatch !== null
  ) {
    return {
      acesPerMatch: profile.acesPerMatch,
      doubleFaultsPerMatch: profile.doubleFaultsPerMatch,
      bpFacedPerMatch: profile.bpFacedPerMatch,
      source: "overall",
    };
  }
  return { acesPerMatch: null, doubleFaultsPerMatch: null, bpFacedPerMatch: null, source: "none" };
}

/** Tour-wide per-player-match base rates for the count markets. */
export interface TennisTourBaselines {
  acesPerMatch: number;
  doubleFaultsPerMatch: number;
  bpFacedPerMatch: number;
  /** Completed player-matches with serve stats behind the averages. */
  matchesSampled: number;
}

/**
 * Average aces / double faults / break points faced per player-match across
 * the loaded dataset — the labelled fallback for players without personal
 * history, and "no data" (null) when the dataset carries no serve stats.
 */
export function computeTourBaselines(matches: TennisMatch[]): TennisTourBaselines | null {
  let aces = 0;
  let acesN = 0;
  let df = 0;
  let dfN = 0;
  let bp = 0;
  let bpN = 0;
  for (const match of matches) {
    if (match.finish !== "completed") continue;
    for (const stats of [match.winnerStats, match.loserStats]) {
      if (stats.aces !== null) {
        aces += stats.aces;
        acesN++;
      }
      if (stats.doubleFaults !== null) {
        df += stats.doubleFaults;
        dfN++;
      }
      if (stats.bpFaced !== null) {
        bp += stats.bpFaced;
        bpN++;
      }
    }
  }
  if (acesN === 0 || dfN === 0 || bpN === 0) return null;
  return {
    acesPerMatch: aces / acesN,
    doubleFaultsPerMatch: df / dfN,
    bpFacedPerMatch: bp / bpN,
    matchesSampled: acesN,
  };
}

// ─── Network: historical layers ───────────────────────────────────────────────

/**
 * Candidate repos for the Sackmann season files, in priority order. The
 * canonical JeffSackmann repos disappeared from GitHub mid-2026; the forks
 * below are actively maintained mirrors of the same CSVs.
 */
const SACKMANN_REPOS: Record<TennisTour, string[]> = {
  atp: ["JeffSackmann/tennis_atp", "Kadantte/tennis_atp", "jasonmauss/tennis_atp"],
  wta: ["JeffSackmann/tennis_wta", "Kadantte/tennis_wta", "jasonmauss/tennis_wta"],
};

const SACKMANN_TIMEOUT_MS = 90_000;
export const DEFAULT_TENNIS_SEASONS = 2;

/**
 * tennis-data.co.uk per-tournament files — the odds layer. A curated set of
 * the tour's core events (Grand Slams + Masters/1000s + tour finals) keeps the
 * request count bounded; every file is optional and fails soft.
 */
const TENNIS_DATA_TOURNAMENTS = [
  "ausopen", "frenchopen", "wimbledon", "usopen",
  "indianwells", "miami", "montecarlo", "madrid", "rome",
  "cincinnati", "canada", "shanghai", "paris-tms", "masterscup",
  "barcelona", "hamburg", "vienna", "basel",
];

function seasonYears(now: Date, seasons: number): number[] {
  const years: number[] = [];
  for (let i = 0; i < seasons; i++) years.push(now.getUTCFullYear() - i);
  return years;
}

/**
 * Load the completed-match dataset for one tour. Layer 1 (Sackmann CSVs on
 * GitHub) provides results + serve stats; layer 2 (tennis-data.co.uk) adds the
 * odds-bearing copy of the same seasons. Matches are de-duplicated by id and
 * by (date, players) so the two layers never double-count a match.
 */
export async function loadTennisMatches(
  tour: TennisTour,
  options: { seasons?: number; now?: Date; tennisData?: boolean } = {},
): Promise<{ matches: TennisMatch[]; sources: TennisSourceReport[] }> {
  const now = options.now ?? new Date();
  const seasons = Math.max(1, Math.min(4, options.seasons ?? DEFAULT_TENNIS_SEASONS));
  const years = seasonYears(now, seasons);
  const sources: TennisSourceReport[] = [];
  const byId = new Map<string, TennisMatch>();
  const byPair = new Set<string>();
  const pairKey = (m: TennisMatch) =>
    `${m.matchDate.slice(0, 10)}|${[tennisPlayerKey(m.winner), tennisPlayerKey(m.loser)].sort().join("~")}`;

  const addMatches = (list: TennisMatch[]): number => {
    let added = 0;
    for (const match of list) {
      const pair = pairKey(match);
      if (byId.has(match.id) || byPair.has(pair)) continue;
      byId.set(match.id, match);
      byPair.add(pair);
      added++;
    }
    return added;
  };

  // Layer 1 — Sackmann season files (results + aces/DFs/BPs). Every mirror of
  // every season is fetched in parallel; per season the highest-priority
  // mirror that responds wins, so a slow mirror cannot stall the whole load.
  const sackmannAttempts = await Promise.all(
    years.map(async (year) => ({
      year,
      attempts: await Promise.all(
        SACKMANN_REPOS[tour].map(async (repo) => {
          const url = `https://raw.githubusercontent.com/${repo}/master/${tour}_matches_${year}.csv`;
          const res = await fetchWithTimeout(url, { text: true, timeoutMs: SACKMANN_TIMEOUT_MS });
          return { repo, res };
        }),
      ),
    })),
  );
  for (const { year, attempts } of sackmannAttempts) {
    let winnerRepo: string | null = null;
    let winnerCsv: string | null = null;
    for (const { repo, res } of attempts) {
      if (res.status === "ok" && typeof res.data === "string" && res.data.length > 100) {
        winnerRepo = repo;
        winnerCsv = res.data;
        break;
      }
    }
    if (winnerRepo !== null && winnerCsv !== null) {
      const matches = parseSackmannTennisCsv(winnerCsv, tour);
      const added = addMatches(matches);
      sources.push({
        source: `sackmann:${winnerRepo}`,
        attempted: true,
        added,
        note: `${year} season: ${matches.length} parsed, ${added} new (${attempts.length - 1} lower-priority mirror(s) skipped)`,
      });
    } else {
      sources.push({
        source: `sackmann:${tour}`,
        attempted: true,
        added: 0,
        note: `no mirror reachable for ${year}: ${attempts
          .map(({ repo, res }) => `${repo} → ${res.status}`)
          .join(", ")}`,
      });
    }
  }

  // Layer 2 — tennis-data.co.uk (odds). The per-tournament files are small and
  // independent, so they are fetched in parallel (bounded chunks) for the
  // current season only. Every file is optional and fails soft.
  if (options.tennisData !== false) {
    const year = years[0];
    const dir = tour === "wta" ? `${year}w` : `${year}`;
    const results = await Promise.all(
      TENNIS_DATA_TOURNAMENTS.map(async (slug) => {
        const url = `http://www.tennis-data.co.uk/${dir}/${slug}.csv`;
        const res = await fetchWithTimeout(url, { text: true, timeoutMs: 15_000 });
        return res.status === "ok" && typeof res.data === "string" && res.data.length > 100
          ? parseTennisDataCsv(res.data, tour)
          : null;
      }),
    );
    let added = 0;
    let fetched = 0;
    for (const list of results) {
      if (list === null) continue;
      fetched++;
      added += addMatches(list);
    }
    sources.push({
      source: "tennis-data.co.uk",
      attempted: true,
      added,
      note: `${fetched}/${TENNIS_DATA_TOURNAMENTS.length} tournament files for ${year} (odds layer)`,
    });
  }

  const matches = [...byId.values()].sort((a, b) => a.matchDate.localeCompare(b.matchDate));
  return { matches, sources };
}

// ─── Network: ESPN upcoming fixtures ──────────────────────────────────────────

const ESPN_TENNIS_BASE = "https://site.api.espn.com/apis/site/v2/sports/tennis";

/** Fetch the ESPN scoreboard for a date window (YYYYMMDD-YYYYMMDD). */
async function fetchEspnTennisBoard(
  tour: TennisTour,
  datesParam: string,
  history: TennisMatch[],
): Promise<UpcomingTennisMatch[] | null> {
  const url = `${ESPN_TENNIS_BASE}/${tour}/scoreboard?dates=${datesParam}&limit=1000`;
  const json = await resilientJson<unknown>(url, { cacheTtlMs: 120_000, retries: 1 });
  if (!json) return null;
  return parseEspnTennisScoreboard(json, tour, history);
}

/**
 * Fetch upcoming singles matches for one tour over the next `days` days
 * (starting yesterday so late-night sessions that are imminent are visible).
 * Returns `null` when ESPN is unreachable — the caller reports it honestly.
 */
export async function fetchUpcomingTennisMatches(
  tour: TennisTour,
  options: { days?: number; now?: Date; history?: TennisMatch[] } = {},
): Promise<UpcomingTennisMatch[] | null> {
  const now = options.now ?? new Date();
  const days = Math.max(1, Math.min(7, options.days ?? 3));
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date): string =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

  const matches = await fetchEspnTennisBoard(tour, `${fmt(start)}-${fmt(end)}`, options.history ?? []);
  if (!matches) return null;
  return matches;
}
