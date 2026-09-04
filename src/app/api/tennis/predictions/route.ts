// ĞIGI GIVØ — Tennis predictions API (ATP / WTA).
//
// GET /api/tennis/predictions
//   ?surface=clay|grass|hard     filter predictions to one surface
//   ?tour=atp|wta|both           (default both)
//   ?limit=N                     (default 24, max 100)
//   ?days=N                      ESPN scoreboard window (default 3, max 5)
//   ?includeLive=1               also include in-progress matches
//   ?refresh=1                   bypass the in-process caches
//
// Pipeline per tour: load the completed-match dataset (Jeff Sackmann → Kadantte
// mirror → tennis-data.co.uk) → replay the surface-specific ELO tables
// (elo_clay / elo_grass / elo_hard) → aggregate per-player serve & return
// baselines → fetch the ESPN singles scoreboard → price every upcoming match
// through the tennis market engine.
//
// Refusal contract (no defaults, ever):
//   · a tour whose sources are all unreachable is reported, not faked;
//   · a fixture is predicted only when BOTH players have a real ELO on the
//     match surface and the surface itself is known — otherwise it lands in
//     `unavailable` with the reason;
//   · if nothing can be priced the endpoint answers 503 with
//     `{ error: "Tennis data unavailable — missing Elo or historical data." }`
//     and the UI shows its error state instead of placeholder matches.

import {
  buildTennisPlayerProfiles,
  computeTourBaselines,
  fetchUpcomingTennisMatches,
  loadTennisDataset,
  surfaceServeBaseline,
  tennisPlayerKey,
  TENNIS_API_UNAVAILABLE_MESSAGE,
  TENNIS_DATA_UNAVAILABLE,
  TennisDataUnavailableError,
  type TennisMatch,
  type TennisPlayerProfile,
  type TennisSourceReport,
  type TennisSurface,
  type TennisTour,
} from "@/lib/data/sources/tennis";
import {
  buildTennisEloTable,
  findTennisEloEntry,
  getTennisElo,
  type TennisEloTable,
} from "@/lib/data/elo";
import { predictTennisMatch, type TennisPrediction } from "@/lib/engine/markets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Rolling seasons of history replayed into the ELO tables. */
const TENNIS_SEASONS = 3;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 h — the ELO replay is expensive
const CACHE_FAIL_TTL_MS = 60 * 1000; // 1 min — let a dead source recover fast
const FIXTURES_TTL_MS = 5 * 60 * 1000;

// ─── Cached model layers ──────────────────────────────────────────────────────

interface TennisTourModel {
  tour: TennisTour;
  elo: TennisEloTable;
  baselines: ReturnType<typeof computeTourBaselines>;
  profiles: Map<string, TennisPlayerProfile>;
  /** Raw completed matches — backs tournament-surface inference. */
  matches: TennisMatch[];
  sources: TennisSourceReport[];
  generatedAt: string;
}

interface TourCacheEntry {
  at: number;
  model: TennisTourModel | null;
  error: string | null;
  /** Source attempts recorded even when the load failed outright. */
  sources: TennisSourceReport[];
}

const cache = new Map<TennisTour, TourCacheEntry>();
let loading: Promise<void> | null = null;

async function buildTourModel(tour: TennisTour): Promise<TennisTourModel> {
  const dataset = await loadTennisDataset({ tour, seasons: TENNIS_SEASONS });
  return {
    tour,
    elo: buildTennisEloTable(dataset.matches),
    baselines: computeTourBaselines(dataset.matches),
    profiles: buildTennisPlayerProfiles(dataset.matches, tour),
    matches: dataset.matches,
    sources: dataset.sources,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build (or reuse) the per-tour ELO + baselines model. A tour whose sources are
 * all unreachable is cached as an error for a short window so the UI reports
 * the failure instead of hammering the dead source.
 */
async function getTennisModel(tours: TennisTour[], refresh: boolean): Promise<Map<TennisTour, TourCacheEntry>> {
  const now = Date.now();
  const needed = tours.filter((tour) => {
    const entry = cache.get(tour);
    if (refresh || !entry) return true;
    const ttl = entry.model ? CACHE_TTL_MS : CACHE_FAIL_TTL_MS;
    return now - entry.at >= ttl;
  });

  if (needed.length > 0) {
    const build = Promise.all(
      needed.map(async (tour) => {
        try {
          const model = await buildTourModel(tour);
          cache.set(tour, { at: Date.now(), model, error: null, sources: model.sources });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[tennis] ${tour.toUpperCase()} model build failed: ${message}`);
          cache.set(tour, {
            at: Date.now(),
            model: null,
            error: message,
            sources: error instanceof TennisDataUnavailableError ? error.sources : [],
          });
        }
      }),
    ).then(() => undefined);
    loading = build;
    try {
      await build;
    } finally {
      if (loading === build) loading = null;
    }
  } else if (loading) {
    await loading;
  }

  const result = new Map<TennisTour, TourCacheEntry>();
  for (const tour of tours) {
    const entry = cache.get(tour);
    if (entry) result.set(tour, entry);
  }
  return result;
}

// ─── Cached fixtures ──────────────────────────────────────────────────────────

interface FixtureCacheEntry {
  at: number;
  matches: Awaited<ReturnType<typeof fetchUpcomingTennisMatches>>;
}
const fixtureCache = new Map<TennisTour, FixtureCacheEntry>();

async function getFixtures(
  tour: TennisTour,
  history: TennisMatch[],
  days: number,
  refresh: boolean,
): Promise<Awaited<ReturnType<typeof fetchUpcomingTennisMatches>>> {
  const cached = fixtureCache.get(tour);
  if (!refresh && cached && Date.now() - cached.at < FIXTURES_TTL_MS) return cached.matches;
  const matches = await fetchUpcomingTennisMatches(tour, { days, history });
  fixtureCache.set(tour, { at: Date.now(), matches });
  return matches;
}

// ─── Player resolution ────────────────────────────────────────────────────────

/** Resolve a player's profile with a fuzzy fallback for provider spellings. */
function findProfile(model: TennisTourModel, player: string): TennisPlayerProfile | null {
  const exact = model.profiles.get(tennisPlayerKey(player));
  if (exact) return exact;
  for (const profile of model.profiles.values()) {
    const surname = (name: string): string => name.trim().toLowerCase().split(" ").pop() ?? "";
    const initial = (name: string): string => (name.trim()[0] ?? "").toLowerCase();
    if (
      surname(profile.player) === surname(player) &&
      initial(profile.player) === initial(player)
    ) {
      return profile;
    }
  }
  return null;
}

export interface TennisPredictedPlayer {
  name: string;
  country: string | null;
  /** Surface-specific ELO used by the model (never a default). */
  elo: number;
  /** Ratings on every surface — null where the player has no history. */
  eloBySurface: Record<TennisSurface, number | null>;
  /** Rated matches on the match surface (sample size behind the ELO). */
  surfaceMatches: number;
  matchesPlayed: number | null;
  rank: number | null;
  serveWinRate: number | null;
  returnWinRate: number | null;
  acesPerMatch: number | null;
  doubleFaultsPerMatch: number | null;
  bpFacedPerMatch: number | null;
  baselineSource: "surface" | "overall" | "none";
}

export interface TennisPredictedMatch {
  id: string;
  tour: TennisTour;
  tournament: string;
  round: string | null;
  surface: TennisSurface;
  bestOf: 3 | 5;
  date: string;
  venue: string | null;
  status: "scheduled" | "live" | "complete";
  dataQuality: "real" | "mixed" | "synthetic";
  home: TennisPredictedPlayer;
  away: TennisPredictedPlayer;
  matchWinner: TennisPrediction["matchWinner"];
  totalGames: TennisPrediction["totalGames"];
  setWinner: TennisPrediction["setWinner"];
  scoreDistribution: TennisPrediction["scoreDistribution"];
  projectedScoreline: string;
  projectedScorelineHomeFirst: string;
  projectedWinner: string;
  topScorelines: TennisPrediction["topScorelines"];
  aces: TennisPrediction["aces"];
  doubleFaults: TennisPrediction["doubleFaults"];
  markets: TennisPrediction["markets"];
  model: TennisPrediction["model"];
  notes: string[];
}

interface UnavailableMatch {
  id: string;
  tour: TennisTour;
  tournament: string;
  surface: TennisSurface | null;
  home: string;
  away: string;
  eloHome: number | null;
  eloAway: number | null;
  reason: string;
}

interface ResolvedPlayer {
  player: TennisPredictedPlayer;
  /** `null` when the player has no real rating on this surface. */
  elo: number | null;
}

function toPlayer(
  model: TennisTourModel,
  name: string,
  country: string | null,
  surface: TennisSurface,
): ResolvedPlayer {
  const entry = findTennisEloEntry(model.elo, name, model.tour);
  const profile = findProfile(model, name);
  const elo = getTennisElo(model.elo, name, surface, model.tour);
  const baseline = surfaceServeBaseline(profile ?? null, surface);
  const player: TennisPredictedPlayer = {
    name,
    country,
    elo: elo === null ? 0 : Math.round(elo),
    eloBySurface: entry
      ? {
          clay: entry.ratings.clay === null ? null : Math.round(entry.ratings.clay),
          grass: entry.ratings.grass === null ? null : Math.round(entry.ratings.grass),
          hard: entry.ratings.hard === null ? null : Math.round(entry.ratings.hard),
        }
      : { clay: null, grass: null, hard: null },
    surfaceMatches: entry?.surfaceMatches[surface] ?? 0,
    matchesPlayed: entry?.matchesPlayed ?? profile?.matchesPlayed ?? null,
    rank: profile?.rank ?? null,
    serveWinRate: baseline?.serveWinRate ?? null,
    returnWinRate: baseline?.returnWinRate ?? null,
    acesPerMatch: baseline?.acesPerMatch ?? null,
    doubleFaultsPerMatch: baseline?.doubleFaultsPerMatch ?? null,
    bpFacedPerMatch: baseline?.bpFacedPerMatch ?? null,
    baselineSource: baseline?.source ?? "none",
  };
  return { player, elo };
}

// ─── Route ────────────────────────────────────────────────────────────────────

const SURFACES = new Set(["clay", "grass", "hard"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const surfaceParam = (url.searchParams.get("surface") ?? "").toLowerCase();
  const surface = SURFACES.has(surfaceParam) ? (surfaceParam as TennisSurface) : null;
  const surfaceRequested = surfaceParam !== "" && surface === null;

  const tourParam = (url.searchParams.get("tour") ?? "both").toLowerCase();
  const tours: TennisTour[] =
    tourParam === "atp" ? ["atp"] : tourParam === "wta" ? ["wta"] : ["atp", "wta"];

  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 24) || 24));
  const days = Math.max(1, Math.min(5, Number(url.searchParams.get("days") ?? 3) || 3));
  const includeLive = ["1", "true", "yes"].includes(
    (url.searchParams.get("includeLive") ?? "").toLowerCase(),
  );
  const refresh = ["1", "true", "yes"].includes(
    (url.searchParams.get("refresh") ?? "").toLowerCase(),
  );

  if (surfaceRequested) {
    return Response.json(
      {
        error: `Unknown surface "${surfaceParam}" — expected one of clay, grass, hard.`,
      },
      { status: 400 },
    );
  }

  const models = await getTennisModel(tours, refresh);
  const matches: TennisPredictedMatch[] = [];
  const unavailable: UnavailableMatch[] = [];
  const dataStatus: Record<string, unknown> = {};

  await Promise.all(
    tours.map(async (tour) => {
      const entry = models.get(tour);
      const sources = entry?.sources ?? [];
      const fixtures = await (async () => {
        if (!entry?.model) return null;
        return getFixtures(tour, entry.model.matches, days, refresh);
      })();

      dataStatus[tour] = {
        ok: Boolean(entry?.model) && fixtures !== null,
        matches: entry?.model?.matches.length ?? 0,
        playersRated: entry?.model?.elo.players.size ?? 0,
        matchesRated: entry?.model?.elo.matchesProcessed ?? 0,
        asOf: entry?.model?.elo.asOf ?? null,
        baselines: entry?.model?.baselines ?? null,
        generatedAt: entry?.model?.generatedAt ?? null,
        fixtures: fixtures === null ? null : fixtures.length,
        error: entry?.error ?? (fixtures === null ? "ESPN tennis scoreboard unreachable" : null),
        sources: sources.map((source) => ({
          source: source.source,
          url: source.url,
          ok: source.ok,
          parsed: source.parsed,
          added: source.added,
          note: source.note,
        })),
      };

      if (!entry?.model) return;
      if (fixtures === null) return;

      const model = entry.model;
      for (const fixture of fixtures) {
        if (fixture.status === "complete") continue;
        if (fixture.status === "live" && !includeLive) continue;
        if (surface && fixture.surface !== surface) continue;

        const matchSurface = fixture.surface;
        if (!matchSurface) {
          unavailable.push({
            id: fixture.id,
            tour,
            tournament: fixture.tournament,
            surface: null,
            home: fixture.players[0].name,
            away: fixture.players[1].name,
            eloHome: null,
            eloAway: null,
            reason: "unknown surface — cannot resolve a surface-specific Elo",
          });
          continue;
        }

        const homeResolved = toPlayer(
          model,
          fixture.players[0].name,
          fixture.players[0].country,
          matchSurface,
        );
        const awayResolved = toPlayer(
          model,
          fixture.players[1].name,
          fixture.players[1].country,
          matchSurface,
        );

        if (homeResolved.elo === null || awayResolved.elo === null) {
          const home = homeResolved.player;
          const away = awayResolved.player;
          unavailable.push({
            id: fixture.id,
            tour,
            tournament: fixture.tournament,
            surface: matchSurface,
            home: home.name,
            away: away.name,
            eloHome: homeResolved.elo === null ? null : Math.round(homeResolved.elo),
            eloAway: awayResolved.elo === null ? null : Math.round(awayResolved.elo),
            reason: `no Elo on ${matchSurface} in the loaded dataset`,
          });
          continue;
        }

        const home = homeResolved.player;
        const away = awayResolved.player;

        const prediction = predictTennisMatch({
          tour,
          tournament: fixture.tournament,
          surface: matchSurface,
          round: fixture.round,
          date: fixture.date,
          bestOf: fixture.bestOf,
          home: {
            name: home.name,
            country: home.country,
            elo: home.elo,
            rank: home.rank,
            matchesPlayed: home.matchesPlayed,
            surfaceMatches: home.surfaceMatches,
            acesPerMatch: home.acesPerMatch,
            doubleFaultsPerMatch: home.doubleFaultsPerMatch,
            bpFacedPerMatch: home.bpFacedPerMatch,
            serveWinRate: home.serveWinRate,
            returnWinRate: home.returnWinRate,
            baselineSource: home.baselineSource,
          },
          away: {
            name: away.name,
            country: away.country,
            elo: away.elo,
            rank: away.rank,
            matchesPlayed: away.matchesPlayed,
            surfaceMatches: away.surfaceMatches,
            acesPerMatch: away.acesPerMatch,
            doubleFaultsPerMatch: away.doubleFaultsPerMatch,
            bpFacedPerMatch: away.bpFacedPerMatch,
            serveWinRate: away.serveWinRate,
            returnWinRate: away.returnWinRate,
            baselineSource: away.baselineSource,
          },
          tourBaselines: model.baselines,
        });

        matches.push({
          id: `${tour}-${fixture.id}`,
          tour,
          tournament: fixture.tournament,
          round: fixture.round,
          surface: matchSurface,
          bestOf: fixture.bestOf,
          date: fixture.date,
          venue: fixture.venue,
          status: fixture.status,
          dataQuality: prediction.dataQuality,
          home,
          away,
          matchWinner: prediction.matchWinner,
          totalGames: prediction.totalGames,
          setWinner: prediction.setWinner,
          scoreDistribution: prediction.scoreDistribution,
          projectedScoreline: prediction.projectedScoreline,
          projectedScorelineHomeFirst: prediction.projectedScorelineHomeFirst,
          projectedWinner: prediction.projectedWinner,
          topScorelines: prediction.topScorelines,
          aces: prediction.aces,
          doubleFaults: prediction.doubleFaults,
          markets: prediction.markets,
          model: prediction.model,
          notes: prediction.notes,
        });
      }
    }),
  );

  matches.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const page = matches.slice(0, limit);

  // Hard refusal: nothing can be priced honestly → the UI shows its error state.
  if (page.length === 0) {
    const first = unavailable[0];
    const details = first
      ? `Players: ${first.home} (${first.eloHome ?? "no Elo"}) vs ${first.away} (${first.eloAway ?? "no Elo"}) — ${first.reason}`
      : tours
          .map((tour) => {
            const status = dataStatus[tour] as
              | { error?: string | null; fixtures?: number | null; ok?: boolean }
              | undefined;
            if (status?.error) return `${tour.toUpperCase()}: ${status.error}`;
            if (status?.fixtures === 0) {
              return `${tour.toUpperCase()}: no upcoming singles fixtures on the ESPN scoreboard`;
            }
            return `${tour.toUpperCase()}: ${TENNIS_DATA_UNAVAILABLE}`;
          })
          .join("; ");
    console.error(`[tennis] No predictable matches: ${details}`);
    return Response.json(
      {
        error: TENNIS_API_UNAVAILABLE_MESSAGE,
        details,
        generatedAt: new Date().toISOString(),
        dataStatus,
        unavailable: unavailable.slice(0, 20),
        count: 0,
        matches: [],
      },
      { status: 503 },
    );
  }

  return Response.json({
    generatedAt: new Date().toISOString(),
    filters: { surface, tour: tourParam, limit, days, includeLive },
    dataStatus,
    count: page.length,
    total: matches.length,
    matches: page,
    unavailable: unavailable.slice(0, 20),
    unavailableCount: unavailable.length,
  });
}
