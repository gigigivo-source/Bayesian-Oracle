// ĞIGI GIVØ — Tennis data layer (ATP / WTA).
//
// The second sport of the supercomputer, alongside football. Everything the
// tennis prediction engine consumes is normalised here:
//
//   · Completed matches (for the surface ELO replay and the serve/return
//     baselines) — fetched in strict priority order, first success wins:
//       1. Jeff Sackmann  — raw.githubusercontent.com/JeffSackmann/tennis_atp
//                           (resp. tennis_wta) `atp_matches_{year}.csv`.
//       2. Kadantte mirror — the same CSVs from Kadantte/tennis_atp
//                           (resp. tennis_wta), used when the canonical repos
//                           are unreachable.
//       3. tennis-data.co.uk — the odds layer + results copy
//                           (`{year}/{year}.csv`, `{year}w/{year}w.csv`).
//   · Upcoming fixtures — the ESPN tennis scoreboard (site.api.espn.com),
//     filtered to singles matches that have not finished yet.
//
// Integrity contract (identical to the football sources): every completed
// match is a real result from a real source — nothing is simulated. A source
// that fails is reported in `sources`, never silently replaced. Ratings and
// serve baselines that cannot be computed from real history are returned as
// `null`; the engine and the API then refuse to produce the dependent market
// rather than inventing a number (no TBD players, no ELO 1500, no 6-4 6-4).

import { fetchWithTimeout } from "../http";
import { resilientJson } from "@/lib/httpClient";
import { parseCsv } from "./githubDatasets";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TennisTour = "atp" | "wta";

/**
 * Normalised surfaces. Carpet (the pre-2009 indoor season) is folded into
 * `hard` — the closest modern equivalent — so the model never has to invent a
 * rating for a surface nobody plays on any more (see `normaliseSurface`).
 */
export type TennisSurface = "clay" | "grass" | "hard";

export const TENNIS_SURFACES: readonly TennisSurface[] = ["clay", "grass", "hard"] as const;

/** Where a normalised record came from. */
export type TennisDataSource = "sackmann" | "kadantte" | "tennis-data" | "espn";

/** How the match actually finished — drives which samples feed the model. */
export type TennisFinish = "completed" | "retired" | "walkover";

/** Per-player serve stats for one completed match (null = source lacks it). */
export interface TennisServeStats {
  aces: number | null;
  doubleFaults: number | null;
  /** Total points played on this player's serve (`w_svpt` / `l_svpt`). */
  servePoints: number | null;
  /** Points won on this player's serve (`w_1stWon + w_2ndWon`). */
  servePointsWon: number | null;
  serviceGames: number | null;
  bpSaved: number | null;
  bpFaced: number | null;
}

const EMPTY_SERVE_STATS: TennisServeStats = {
  aces: null,
  doubleFaults: null,
  servePoints: null,
  servePointsWon: null,
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
  /** [home/first-listed player, away player]. */
  players: [TennisPlayerRef, TennisPlayerRef];
}

export interface TennisPlayerRef {
  name: string;
  /** Country code / flag alt text when ESPN provides it. */
  country: string | null;
}

/** Per-surface split of a player's real serve/return sample. */
export interface TennisSurfaceSplit {
  /** Completed matches on the surface with serve-stat coverage. */
  matches: number;
  acesPerMatch: number | null;
  doubleFaultsPerMatch: number | null;
  bpFacedPerMatch: number | null;
  /** Points won on serve / points played on serve. */
  serveWinRate: number | null;
  /** Return points won / return points played. */
  returnWinRate: number | null;
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
  serveWinRate: number | null;
  returnWinRate: number | null;
  /** Surface-split averages (clay/grass/hard) with their sample sizes. */
  surface: Record<TennisSurface, TennisSurfaceSplit>;
}

export interface TennisSourceReport {
  tour: TennisTour;
  source: string;
  url: string;
  attempted: boolean;
  ok: boolean;
  /** Matches parsed from this source (before de-duplication). */
  parsed: number;
  /** Matches that survived de-duplication. */
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

/**
 * Canonicalise a surface string from any source.
 *
 *   Clay            → clay
 *   Grass           → grass
 *   Hard / I-Hard /
 *   O-Hard / Hardcourt → hard
 *   Carpet          → hard   (documented fallback — no carpet ratings exist)
 *
 * `null` when the surface is missing or unrecognised: the caller must then
 * refuse the fixture rather than assume a surface.
 */
export function normaliseSurface(raw: unknown): TennisSurface | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (!s) return null;
  if (s.startsWith("clay")) return "clay";
  if (s.startsWith("grass")) return "grass";
  if (s.includes("hard")) return "hard";
  if (s.startsWith("carpet")) return "hard"; // documented fallback
  return null;
}

/**
 * Static surface map for tournaments the ESPN feed names but does not
 * surface-tag. Grand Slams and the recurring tour events; anything else falls
 * through to inference from the historical dataset.
 */
const TOURNAMENT_SURFACE_HINTS: Array<[pattern: RegExp, surface: TennisSurface]> = [
  [/australian open/i, "hard"],
  [/roland garros|french open/i, "clay"],
  [/wimbledon/i, "grass"],
  [/us open/i, "hard"],
  [/indian wells/i, "hard"],
  [/^miami|miami open/i, "hard"],
  [/monte[- ]?carlo/i, "clay"],
  [/^madrid|madrid open/i, "clay"],
  [/italian open|^rome$/i, "clay"],
  [/hamburg/i, "clay"],
  [/cincinnati/i, "hard"],
  [/national bank open|canada|montreal|toronto/i, "hard"],
  [/shanghai/i, "hard"],
  [/paris masters|^paris$/i, "hard"],
  [/dubai|doha|abu dhabi/i, "hard"],
  [/rotterdam|marseille|open 13|delray|acapulco|dallas|montpellier/i, "hard"],
  [/estoril|casablanca|houston|barcelona|munich|umag|bastad|gstaad|kitzbuhel|kitzb[uü]hel|bucharest|santiago|buenos aires|rio de janeiro|cordoba|marrakech|geneva|lyon|belgrade|banja luka/i, "clay"],
  [/queen.?s|halle|eastbourne|mallorca|hertogenbosch|s.?hertogenbosch|stuttgart|newport|bois-le-duc/i, "grass"],
  [/vienna|basel|antwerp|tokyo|beijing|seoul|stockholm|almaty|astana|metz|sofia|tel aviv|san diego|seoul|chengdu|zhuhai|hangzhou|brisbane|auckland|adelaide|dallas/i, "hard"],
  [/atp finals|wta finals|tennis masters cup|year-end championships/i, "hard"],
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
  const norm = (s: string): string =>
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
 * (`atp_matches_YYYY.csv` / `wta_matches_YYYY.csv`, including the Kadantte and
 * every other mirror of the same layout).
 *
 * Columns used: tourney_id, tourney_name, surface, tourney_level, tourney_date
 * (YYYYMMDD), match_num, winner_name, loser_name, score, best_of, round,
 * w_ace, w_df, w_svpt, w_SvGms, w_bpSaved, w_bpFaced, l_* equivalents,
 * winner_rank, loser_rank.
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
  /** Points won on serve = first-serve points won + second-serve points won. */
  const pointsWon = (row: string[], first: number | undefined, second: number | undefined): number | null => {
    const a = num(row, first);
    const b = num(row, second);
    if (a === null || b === null) return null;
    return a + b;
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
          servePointsWon: pointsWon(row, idx("w_1stwon"), idx("w_2ndwon")),
          serviceGames: num(row, idx("w_svgms")),
          bpSaved: num(row, idx("w_bpsaved")),
          bpFaced: num(row, idx("w_bpfaced")),
        },
        loserStats: {
          aces: num(row, idx("l_ace")),
          doubleFaults: num(row, idx("l_df")),
          servePoints: num(row, idx("l_svpt")),
          servePointsWon: pointsWon(row, idx("l_1stwon"), idx("l_2ndwon")),
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
 * Parse one tennis-data.co.uk CSV
 * (`https://www.tennis-data.co.uk/{year}/{year}.csv`, or `{year}w/{year}w.csv`
 * for the WTA tour). This is the odds-bearing layer: AvgW/AvgL (Oddsportal
 * market average) are preferred, then Pinnacle, then Bet365.
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
        const bestOf: 3 | 5 = periods === 5 ? 5 : periods === 3 ? 3 : bestOfForTournament(tournament, tour);

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

function emptySurfaceSplit(): TennisSurfaceSplit {
  return {
    matches: 0,
    acesPerMatch: null,
    doubleFaultsPerMatch: null,
    bpFacedPerMatch: null,
    serveWinRate: null,
    returnWinRate: null,
  };
}

/**
 * Aggregate completed matches into per-player baselines. Only `completed`
 * matches contribute to serve averages (retirements and walkovers have
 * truncated stats); every finish counts for matches-played and the ELO replay.
 *
 * `serveWinRate` is (points won on serve / points played on serve) and
 * `returnWinRate` is (return points won / return points played) — both derived
 * from the opponent's serve columns, so no number is ever estimated.
 */
export function buildTennisPlayerProfiles(
  matches: TennisMatch[],
  tour: TennisTour,
): Map<string, TennisPlayerProfile> {
  interface Counters {
    aces: number; acesN: number;
    df: number; dfN: number;
    bpFaced: number; bpN: number;
    bpSaved: number; bpSavedN: number;
    servePoints: number; servePointsWon: number; serveN: number;
    returnPoints: number; returnPointsWon: number; returnN: number;
  }
  interface Acc {
    profile: TennisPlayerProfile;
    rankDate: string | null;
    career: Counters;
    surfaceStats: Record<TennisSurface, Counters>;
  }

  const emptyCounters = (): Counters => ({
    aces: 0, acesN: 0,
    df: 0, dfN: 0,
    bpFaced: 0, bpN: 0,
    bpSaved: 0, bpSavedN: 0,
    servePoints: 0, servePointsWon: 0, serveN: 0,
    returnPoints: 0, returnPointsWon: 0, returnN: 0,
  });

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
          serveWinRate: null,
          returnWinRate: null,
          surface: { clay: emptySurfaceSplit(), grass: emptySurfaceSplit(), hard: emptySurfaceSplit() },
        },
        rankDate: null,
        career: emptyCounters(),
        surfaceStats: { clay: emptyCounters(), grass: emptyCounters(), hard: emptyCounters() },
      };
      accs.set(key, acc);
    }
    return acc;
  };

  /**
   * Fold one player's side of a completed match. `own` is the player's serve
   * stats, `opponent` the other side's — the opponent's serve columns are
   * exactly this player's return sample.
   */
  const fold = (
    acc: Acc,
    own: TennisServeStats,
    opponent: TennisServeStats,
    surface: TennisSurface | null,
    won: boolean,
  ): void => {
    acc.profile.matchesPlayed++;
    if (won) acc.profile.wins++;
    const buckets = [acc.career, ...(surface ? [acc.surfaceStats[surface]] : [])];
    for (const bucket of buckets) {
      if (own.aces !== null) { bucket.aces += own.aces; bucket.acesN++; }
      if (own.doubleFaults !== null) { bucket.df += own.doubleFaults; bucket.dfN++; }
      if (own.bpFaced !== null) { bucket.bpFaced += own.bpFaced; bucket.bpN++; }
      if (own.bpSaved !== null) { bucket.bpSaved += own.bpSaved; bucket.bpSavedN++; }
      if (
        own.servePoints !== null && own.servePoints > 0 &&
        own.servePointsWon !== null
      ) {
        bucket.servePoints += own.servePoints;
        bucket.servePointsWon += own.servePointsWon;
        bucket.serveN++;
      }
      if (
        opponent.servePoints !== null && opponent.servePoints > 0 &&
        opponent.servePointsWon !== null
      ) {
        bucket.returnPoints += opponent.servePoints;
        bucket.returnPointsWon += opponent.servePoints - opponent.servePointsWon;
        bucket.returnN++;
      }
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

  const finalise = (counters: Counters): Omit<TennisSurfaceSplit, "matches"> & { matches: number } => ({
    matches: Math.max(counters.serveN, counters.returnN, counters.acesN, counters.dfN),
    acesPerMatch: counters.acesN > 0 ? counters.aces / counters.acesN : null,
    doubleFaultsPerMatch: counters.dfN > 0 ? counters.df / counters.dfN : null,
    bpFacedPerMatch: counters.bpN > 0 ? counters.bpFaced / counters.bpN : null,
    serveWinRate: counters.serveN > 0 ? counters.servePointsWon / counters.servePoints : null,
    returnWinRate: counters.returnN > 0 ? counters.returnPointsWon / counters.returnPoints : null,
  });

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
    // Only full-length matches contribute to serve/return baselines.
    if (match.finish === "completed") {
      fold(winnerAcc, match.winnerStats, match.loserStats, match.surface, true);
      fold(loserAcc, match.loserStats, match.winnerStats, match.surface, false);
    } else {
      winnerAcc.profile.matchesPlayed++;
      winnerAcc.profile.wins++;
      loserAcc.profile.matchesPlayed++;
    }
  }

  for (const acc of accs.values()) {
    const p = acc.profile;
    const career = finalise(acc.career);
    p.acesPerMatch = career.acesPerMatch;
    p.doubleFaultsPerMatch = career.doubleFaultsPerMatch;
    p.bpFacedPerMatch = career.bpFacedPerMatch;
    p.bpSavedPerMatch = acc.career.bpSavedN > 0 ? acc.career.bpSaved / acc.career.bpSavedN : null;
    p.serveWinRate = career.serveWinRate;
    p.returnWinRate = career.returnWinRate;
    for (const surface of TENNIS_SURFACES) {
      p.surface[surface] = finalise(acc.surfaceStats[surface]);
    }
  }

  const profiles = new Map<string, TennisPlayerProfile>();
  for (const [key, acc] of accs) profiles.set(key, acc.profile);
  return profiles;
}

/** The projection-relevant slice of a player's profile on one surface. */
export interface TennisServeBaseline {
  acesPerMatch: number | null;
  doubleFaultsPerMatch: number | null;
  bpFacedPerMatch: number | null;
  serveWinRate: number | null;
  returnWinRate: number | null;
  /** Which slice of real history produced these numbers. */
  source: "surface" | "overall" | "none";
  /** Sampled matches behind the split actually used. */
  matches: number;
}

/**
 * Surface-aware serve/return baseline: the surface split when the sample is
 * big enough, otherwise the career average. Never a synthetic number — every
 * field stays null when the player has no real sample for it.
 */
export function surfaceServeBaseline(
  profile: TennisPlayerProfile | null,
  surface: TennisSurface | null,
): TennisServeBaseline | null {
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
        serveWinRate: split.serveWinRate ?? profile.serveWinRate,
        returnWinRate: split.returnWinRate ?? profile.returnWinRate,
        source: "surface",
        matches: split.matches,
      };
    }
  }
  if (
    profile.acesPerMatch !== null ||
    profile.doubleFaultsPerMatch !== null ||
    profile.bpFacedPerMatch !== null ||
    profile.serveWinRate !== null ||
    profile.returnWinRate !== null
  ) {
    return {
      acesPerMatch: profile.acesPerMatch,
      doubleFaultsPerMatch: profile.doubleFaultsPerMatch,
      bpFacedPerMatch: profile.bpFacedPerMatch,
      serveWinRate: profile.serveWinRate,
      returnWinRate: profile.returnWinRate,
      source: "overall",
      matches: profile.matchesPlayed,
    };
  }
  return {
    acesPerMatch: null,
    doubleFaultsPerMatch: null,
    bpFacedPerMatch: null,
    serveWinRate: null,
    returnWinRate: null,
    source: "none",
    matches: 0,
  };
}

/** Tour-wide per-player-match base rates for the count markets. */
export interface TennisTourBaselines {
  acesPerMatch: number | null;
  doubleFaultsPerMatch: number | null;
  bpFacedPerMatch: number | null;
  /** Tour-average serve / return point win rates (real, from the dataset). */
  serveWinRate: number | null;
  returnWinRate: number | null;
  /** Completed player-matches with serve stats behind the averages. */
  matchesSampled: number;
  /** Completed matches (both players) that carried serve stats. */
  statMatches: number;
  /**
   * Real average total games per completed match in the dataset — the scale
   * factor that turns a per-match aces baseline into a best-of-5 expectation.
   */
  avgGamesPerMatch: number | null;
}

/**
 * Total games played in a completed match, parsed from its set score
 * ("6-4 6-3 7-6(4)" → 32). Returns `null` for retirements, walkovers and
 * unparseable strings.
 */
export function parseMatchGames(score: string): number | null {
  if (!score) return null;
  if (finishFromScore(score) !== "completed") return null;
  let total = 0;
  let sets = 0;
  for (const raw of score.split(/\s+/)) {
    const m = raw.match(/^(\d{1,2})-(\d{1,2})/);
    if (!m) return null;
    total += Number(m[1]) + Number(m[2]);
    sets++;
  }
  return sets > 0 ? total : null;
}

/**
 * Average aces / double faults / break points faced / serve & return point
 * rates per player-match across the loaded dataset. Returns `null` when the
 * dataset carries no serve stats at all — the engine must then fall back to
 * the pure-ELO path and label itself accordingly.
 */
export function computeTourBaselines(matches: TennisMatch[]): TennisTourBaselines | null {
  let aces = 0;
  let acesN = 0;
  let df = 0;
  let dfN = 0;
  let bp = 0;
  let bpN = 0;
  let servePoints = 0;
  let servePointsWon = 0;
  let returnPoints = 0;
  let returnPointsWon = 0;
  let pointN = 0;
  let statMatches = 0;
  let games = 0;
  let gamesN = 0;

  for (const match of matches) {
    if (match.finish !== "completed") continue;
    const matchGames = parseMatchGames(match.score);
    if (matchGames !== null) {
      games += matchGames;
      gamesN++;
    }
    let counted = false;
    for (const [own, opponent] of [
      [match.winnerStats, match.loserStats],
      [match.loserStats, match.winnerStats],
    ] as const) {
      if (own.aces !== null) {
        aces += own.aces;
        acesN++;
        counted = true;
      }
      if (own.doubleFaults !== null) {
        df += own.doubleFaults;
        dfN++;
        counted = true;
      }
      if (own.bpFaced !== null) {
        bp += own.bpFaced;
        bpN++;
        counted = true;
      }
      if (
        own.servePoints !== null && own.servePoints > 0 && own.servePointsWon !== null &&
        opponent.servePoints !== null && opponent.servePoints > 0 && opponent.servePointsWon !== null
      ) {
        servePoints += own.servePoints;
        servePointsWon += own.servePointsWon;
        returnPoints += opponent.servePoints;
        returnPointsWon += opponent.servePoints - opponent.servePointsWon;
        pointN++;
        counted = true;
      }
    }
    if (counted) statMatches++;
  }

  if (pointN === 0 && acesN === 0) return null;

  return {
    acesPerMatch: acesN > 0 ? aces / acesN : null,
    doubleFaultsPerMatch: dfN > 0 ? df / dfN : null,
    bpFacedPerMatch: bpN > 0 ? bp / bpN : null,
    serveWinRate: pointN > 0 ? servePointsWon / servePoints : null,
    returnWinRate: pointN > 0 ? returnPointsWon / returnPoints : null,
    matchesSampled: acesN,
    statMatches,
    avgGamesPerMatch: gamesN > 0 ? games / gamesN : null,
  };
}

// ─── Network: historical layers ───────────────────────────────────────────────

/**
 * The completed-match sources, in strict priority order. The first source that
 * answers for a given (tour, season) wins; the rest are not even requested
 * (unless `allSources` is set, which the diagnostics route uses).
 */
export interface TennisSourceSpec {
  id: TennisDataSource;
  /** Human name used in logs and the source report. */
  label: (tour: TennisTour) => string;
  /** URL template for a tour + season; null = source does not cover it. */
  url: (tour: TennisTour, year: number) => string | null;
  parse: (csv: string, tour: TennisTour) => TennisMatch[];
}

export const TENNIS_SOURCES: TennisSourceSpec[] = [
  {
    // 1 — Jeff Sackmann's canonical per-season match logs (results + aces,
    //     double faults, break points, serve points).
    id: "sackmann",
    label: (tour) => `JeffSackmann/tennis_${tour}`,
    url: (tour, year) =>
      `https://raw.githubusercontent.com/JeffSackmann/tennis_${tour}/master/${tour}_matches_${year}.csv`,
    parse: parseSackmannTennisCsv,
  },
  {
    // 2 — Kadantte's mirror of the same files: the fallback when the canonical
    //     repos are unreachable (they were for most of 2026).
    id: "kadantte",
    label: (tour) => `Kadantte/tennis_${tour}`,
    url: (tour, year) =>
      `https://raw.githubusercontent.com/Kadantte/tennis_${tour}/master/${tour}_matches_${year}.csv`,
    parse: parseSackmannTennisCsv,
  },
  {
    // 3 — tennis-data.co.uk: the odds layer (AvgW/AvgL, Pinnacle, Bet365) plus
    //     a second copy of the season's results. No serve stats.
    id: "tennis-data",
    label: () => "tennis-data.co.uk",
    url: (tour, year) =>
      tour === "wta"
        ? `https://www.tennis-data.co.uk/${year}w/${year}w.csv`
        : `https://www.tennis-data.co.uk/${year}/${year}.csv`,
    parse: parseTennisDataCsv,
  },
];

const TENNIS_SOURCE_TIMEOUT_MS = 45_000;
/** Rolling seasons loaded by default (current season + the two before it). */
export const DEFAULT_TENNIS_SEASONS = 3;

export interface LoadTennisMatchesOptions {
  /** Tour to load — `all` loads both (ATP and WTA pools never mix). */
  tour?: TennisTour | "all";
  /** Explicit seasons, newest first. Defaults to the last `seasons` years. */
  years?: number[];
  /** Optional surface filter (normalised before comparing). */
  surface?: string | null;
  /** Reference date for the default season window. */
  now?: Date;
  /** Number of rolling seasons when `years` is omitted (default 3, max 6). */
  seasons?: number;
  /** Log sink — defaults to console (tests inject a spy). */
  logger?: (message: string) => void;
}

export const TENNIS_DATA_UNAVAILABLE =
  "[tennis] CRITICAL: No data source reachable. Tennis predictions are unavailable.";

/** The API-level message returned with the 503 refusal (Part 4.1 of the spec). */
export const TENNIS_API_UNAVAILABLE_MESSAGE =
  "Tennis data unavailable — missing Elo or historical data.";

/**
 * Thrown when every source for the requested tour(s) failed. It carries the
 * attempt log so the API can report *why* the data is missing instead of a
 * bare refusal.
 */
export class TennisDataUnavailableError extends Error {
  readonly sources: TennisSourceReport[];

  constructor(sources: TennisSourceReport[] = []) {
    super(TENNIS_DATA_UNAVAILABLE);
    this.name = "TennisDataUnavailableError";
    this.sources = sources;
  }
}

function defaultYears(now: Date, seasons: number): number[] {
  const years: number[] = [];
  for (let i = 0; i < seasons; i++) years.push(now.getUTCFullYear() - i);
  return years;
}

/**
 * Load the completed-match dataset for one tour.
 *
 * Sources are tried in priority order per season and the first one that
 * answers wins, so a dead mirror cannot stall or poison the load. Every
 * attempt is logged (`[tennis] Loading {tour} matches from {source}...`) and
 * reported in the returned `sources` list.
 *
 * Throws `TENNIS_DATA_UNAVAILABLE` when no source for the requested tour
 * yields a single match — the caller (API route) must then surface the error
 * instead of predicting.
 */
async function loadTourDataset(
  tour: TennisTour,
  options: LoadTennisMatchesOptions,
): Promise<{ matches: TennisMatch[]; sources: TennisSourceReport[] }> {
  const now = options.now ?? new Date();
  const seasons = Math.max(1, Math.min(6, options.seasons ?? DEFAULT_TENNIS_SEASONS));
  const years = options.years && options.years.length > 0 ? options.years : defaultYears(now, seasons);
  const log = options.logger ?? ((message: string) => console.info(message));
  const surfaceFilter = normaliseSurface(options.surface ?? null);

  const sources: TennisSourceReport[] = [];
  const byId = new Map<string, TennisMatch>();
  const byPair = new Set<string>();
  const pairKey = (m: TennisMatch): string =>
    `${m.matchDate.slice(0, 10)}|${[tennisPlayerKey(m.winner), tennisPlayerKey(m.loser)].sort().join("~")}`;

  const addMatches = (list: TennisMatch[]): number => {
    let added = 0;
    for (const match of list) {
      if (surfaceFilter && match.surface !== surfaceFilter) continue;
      const pair = pairKey(match);
      if (byId.has(match.id) || byPair.has(pair)) continue;
      byId.set(match.id, match);
      byPair.add(pair);
      added++;
    }
    return added;
  };

  // Seasons are independent — load them in parallel, sources strictly ordered.
  await Promise.all(
    years.map(async (year) => {
      for (const spec of TENNIS_SOURCES) {
        const url = spec.url(tour, year);
        if (!url) continue;
        const label = spec.label(tour);
        log(`[tennis] Loading ${tour} matches from ${label}...`);
        const res = await fetchWithTimeout(url, { text: true, timeoutMs: TENNIS_SOURCE_TIMEOUT_MS });
        if (res.status !== "ok" || typeof res.data !== "string" || res.data.length < 100) {
          sources.push({
            tour,
            source: spec.id,
            url,
            attempted: true,
            ok: false,
            parsed: 0,
            added: 0,
            note: `${year}: ${describeFailure(res.status, res.httpStatus)}`,
          });
          log(`[tennis] ${label} (${year}) → ${res.status}${res.httpStatus !== null ? ` HTTP ${res.httpStatus}` : ""}`);
          continue; // next source in priority order
        }
        const parsed = spec.parse(res.data, tour);
        const added = addMatches(parsed);
        sources.push({
          tour,
          source: spec.id,
          url,
          attempted: true,
          ok: true,
          parsed: parsed.length,
          added,
          note: `${year}: ${parsed.length} parsed, ${added} new`,
        });
        log(`[tennis] ${label} (${year}) → ok: ${parsed.length} parsed, ${added} new matches`);
        break; // first successful source for this season wins
      }
    }),
  );

  const matches = [...byId.values()].sort((a, b) => a.matchDate.localeCompare(b.matchDate));
  return { matches, sources };
}

function describeFailure(status: string, httpStatus: number | null): string {
  return httpStatus !== null ? `${status} (HTTP ${httpStatus})` : status;
}

/**
 * Load completed matches (Part 1.4 of the tennis spec).
 *
 * Returns the normalised `TennisMatch[]` — players, surface, score, rankings,
 * serve stats and odds where the source carries them. Throws
 * `TENNIS_DATA_UNAVAILABLE` when every source fails.
 */
export async function loadTennisMatches(
  options: LoadTennisMatchesOptions = {},
): Promise<TennisMatch[]> {
  const dataset = await loadTennisDataset(options);
  return dataset.matches;
}

/**
 * Same load as `loadTennisMatches`, but with the per-source report the API
 * uses for its data-status badge and diagnostics payload.
 */
export async function loadTennisDataset(
  options: LoadTennisMatchesOptions = {},
): Promise<{
  matches: TennisMatch[];
  sources: TennisSourceReport[];
  /** Per-tour match counts, for the UI status badge. */
  tourCounts: Record<TennisTour, number>;
}> {
  const tour = options.tour ?? "all";
  const tours: TennisTour[] = tour === "all" ? ["atp", "wta"] : [tour];
  const log = options.logger ?? ((message: string) => console.info(message));

  const results = await Promise.all(tours.map((t) => loadTourDataset(t, options)));
  const matches: TennisMatch[] = [];
  const sources: TennisSourceReport[] = [];
  const tourCounts: Record<TennisTour, number> = { atp: 0, wta: 0 };

  results.forEach((result, i) => {
    matches.push(...result.matches);
    sources.push(...result.sources);
    tourCounts[tours[i]] = result.matches.length;
  });

  matches.sort((a, b) => a.matchDate.localeCompare(b.matchDate));

  if (matches.length === 0) {
    log(TENNIS_DATA_UNAVAILABLE);
    throw new TennisDataUnavailableError(sources);
  }

  log(
    `[tennis] Loaded ${matches.length} completed matches ` +
      (tours.length > 1
        ? `(ATP ${tourCounts.atp}, WTA ${tourCounts.wta})`
        : `(${tours[0].toUpperCase()})`),
  );
  return { matches, sources, tourCounts };
}

// ─── Network: ESPN upcoming fixtures ──────────────────────────────────────────

const ESPN_TENNIS_BASE = "https://site.api.espn.com/apis/site/v2/sports/tennis";

/**
 * Fetch the ESPN scoreboard for one day (YYYYMMDD).
 *
 * ESPN's tennis scoreboard ignores the `YYYYMMDD-YYYYMMDD` range form (it
 * returns an empty `events` array), so the window is walked one day at a time
 * and the results are de-duplicated by competition id: a day inside a slam
 * returns that event's whole draw, so this doubles as the "next few rounds"
 * fetch.
 */
async function fetchEspnTennisDay(
  tour: TennisTour,
  date: string,
  history: TennisMatch[],
): Promise<UpcomingTennisMatch[] | null> {
  const url = `${ESPN_TENNIS_BASE}/${tour}/scoreboard?dates=${date}`;
  const json = await resilientJson<unknown>(url, { cacheTtlMs: 120_000, retries: 1 });
  if (!json) return null;
  return parseEspnTennisScoreboard(json, tour, history);
}

/**
 * Fetch upcoming singles matches for one tour over the next `days` days
 * (starting yesterday so late-night sessions already underway are visible).
 * Returns `null` when ESPN is unreachable — the caller reports it honestly and
 * refuses to predict.
 */
export async function fetchUpcomingTennisMatches(
  tour: TennisTour,
  options: { days?: number; now?: Date; history?: TennisMatch[]; logger?: (message: string) => void } = {},
): Promise<UpcomingTennisMatch[] | null> {
  const now = options.now ?? new Date();
  const days = Math.max(1, Math.min(5, options.days ?? 3));
  const log = options.logger ?? ((message: string) => console.info(message));
  const fmt = (d: Date): string =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

  const dates: string[] = [];
  for (let i = -1; i < days; i++) {
    dates.push(fmt(new Date(now.getTime() + i * 24 * 60 * 60 * 1000)));
  }

  log(`[tennis] Loading ${tour} upcoming fixtures from ESPN (${dates.length} days)...`);
  const boards = await Promise.all(dates.map((date) => fetchEspnTennisDay(tour, date, options.history ?? [])));

  const seen = new Set<string>();
  const matches: UpcomingTennisMatch[] = [];
  let reachable = false;
  for (const board of boards) {
    if (board === null) continue;
    reachable = true;
    for (const match of board) {
      const key = `${match.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(match);
    }
  }
  if (!reachable) {
    log(`[tennis] ESPN ${tour} scoreboard unreachable`);
    return null;
  }

  matches.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  log(`[tennis] ESPN ${tour}: ${matches.length} singles fixtures`);
  return matches;
}
