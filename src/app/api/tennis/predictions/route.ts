// ĞIGI GIVØ — Tennis predictions API (ATP / WTA).
//
// GET /api/tennis/predictions
//   ?surface=clay|grass|hard|carpet   filter predictions to one surface
//   ?tour=atp|wta|both                (default both)
//   ?limit=N                          (default 24, max 100)
//   ?days=N                           scoreboard window (default 3, max 7)
//   ?includeLive=1                    also include in-progress matches
//
// Pipeline per tour: load the completed-match dataset (Sackmann mirrors on
// GitHub + the tennis-data.co.uk odds layer) → replay the surface-modified
// ELO table → aggregate per-player serve baselines → fetch the ESPN singles
// scoreboard → predict every upcoming match through the tennis market engine
// (Match Winner, Total Games, Set Winner, Aces, Double Faults, Break Points,
// projected scoreline). The heavy layers are cached in-process for an hour;
// a player with no replayed rating falls back to a clearly-labelled rank
// prior — never to an invented number.

import { apiError } from "@/lib/apiErrors";
import {
  buildTennisPlayerProfiles,
  computeTourBaselines,
  fetchUpcomingTennisMatches,
  loadTennisMatches,
  playerNamesMatch,
  surfaceServeBaseline,
  tennisPlayerKey,
  type TennisPlayerProfile,
  type TennisSurface,
  type TennisTour,
} from "@/lib/data/sources/tennis";
import {
  TENNIS_INITIAL_ELO,
  buildTennisEloTable,
  createTennisEloTable,
  findTennisEloEntry,
  tennisEloPriorFromRank,
  type TennisEloTable,
} from "@/lib/data/elo";
import {
  isTennisPlayableLock,
  predictTennisMatch,
  type TennisBestValueMarket,
  type TennisLockTier,
  type TennisPrediction,
} from "@/lib/engine/markets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ─── Cached model layers ──────────────────────────────────────────────────────

interface TennisTourModel {
  tour: TennisTour;
  elo: TennisEloTable;
  baselines: ReturnType<typeof computeTourBaselines>;
  /** Profile lookup keyed by normalised player name. */
  profiles: Map<string, TennisPlayerProfile>;
  matchesProcessed: number;
  /** Raw completed matches — backs tournament-surface inference. */
  matches: Awaited<ReturnType<typeof loadTennisMatches>>["matches"];
  sources: Awaited<ReturnType<typeof loadTennisMatches>>["sources"];
  generatedAt: string;
}

interface TennisModelCache {
  at: number;
  seasons: number;
  tours: Partial<Record<TennisTour, TennisTourModel>>;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // one hour
let cache: TennisModelCache | null = null;
let loading: Promise<TennisModelCache> | null = null;

/**
 * Build (or reuse) the per-tour ELO + baselines model. Both tours load in
 * parallel; a tour whose sources are all unreachable still resolves — with an
 * empty table — so the ESPN fixtures render with labelled priors.
 */
async function getTennisModel(seasons: number): Promise<TennisModelCache> {
  const now = Date.now();
  if (cache && cache.seasons === seasons && now - cache.at < CACHE_TTL_MS) return cache;
  if (loading) return loading;

  loading = (async (): Promise<TennisModelCache> => {
    const tours = await Promise.all(
      (["atp", "wta"] as const).map(async (tour): Promise<TennisTourModel> => {
        try {
          const dataset = await loadTennisMatches(tour, { seasons });
          const elo = buildTennisEloTable(dataset.matches);
          return {
            tour,
            elo,
            baselines: computeTourBaselines(dataset.matches),
            profiles: buildTennisPlayerProfiles(dataset.matches, tour),
            matchesProcessed: dataset.matches.length,
            matches: dataset.matches,
            sources: dataset.sources,
            generatedAt: new Date().toISOString(),
          };
        } catch (error) {
          const note = error instanceof Error ? error.message : String(error);
          console.warn(`[tennis] Failed to load ${tour} historical dataset: ${note}`);
          return {
            tour,
            elo: createTennisEloTable(),
            baselines: null,
            profiles: new Map(),
            matchesProcessed: 0,
            matches: [],
            sources: [{ source: `historical:${tour}`, attempted: true, added: 0, note }],
            generatedAt: new Date().toISOString(),
          };
        }
      }),
    );

    const built: TennisModelCache = {
      at: Date.now(),
      seasons,
      tours: { atp: tours[0], wta: tours[1] },
    };
    if (tours.some((t) => t.matchesProcessed > 0)) {
      cache = built;
    }
    return built;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Resolve a player's profile with a fuzzy fallback for provider spellings. */
function findProfile(model: TennisTourModel, player: string) {
  const exact = model.profiles.get(tennisPlayerKey(player));
  if (exact) return exact;
  for (const profile of model.profiles.values()) {
    if (playerNamesMatch(profile.player, player)) return profile;
  }
  return null;
}

// ─── Response shape ───────────────────────────────────────────────────────────

export interface TennisPredictedPlayer {
  name: string;
  country: string | null;
  /** Raw replayed/prior ELO rating used by the model. */
  rating: number;
  ratingSource: "elo" | "rank-prior" | "default";
  matchesPlayed: number | null;
  lastPlayed: string | null;
  rank: number | null;
  acesPerMatch: number | null;
  doubleFaultsPerMatch: number | null;
  bpFacedPerMatch: number | null;
  baselineSource: "surface" | "overall" | "tour-baseline" | "none";
}

export interface TennisPredictedMatch {
  id: string;
  tour: TennisTour;
  tournament: string;
  surface: TennisSurface | null;
  round: string | null;
  date: string;
  venue: string | null;
  status: "scheduled" | "live" | "complete";
  bestOf: 3 | 5;
  eloGap: number;
  lockTier: TennisLockTier;
  lockReasons: string[];
  bestValueMarket?: TennisBestValueMarket;
  players: [TennisPredictedPlayer, TennisPredictedPlayer];
  prediction: TennisPrediction;
}

export interface TennisValueAccumulatorLeg {
  matchId: string;
  tour: TennisTour;
  tournament: string;
  date: string;
  lockTier: TennisLockTier;
  matchup: string;
  favorite: string;
  matchWinnerOdds: number;
  market: string;
  selection: string;
  probability: number;
  fairOdds: number;
}

export interface TennisValueAccumulator {
  targetOdds: number;
  meetsTarget: boolean;
  legCount: number;
  combinedOdds: number;
  combinedProbability: number;
  matchWinnerCombinedOdds: number;
  legs: TennisValueAccumulatorLeg[];
}

function toModelPlayer(
  model: TennisTourModel,
  name: string,
  country: string | null,
  surface: TennisSurface | null,
): TennisPredictedPlayer {
  const entry = findTennisEloEntry(model.elo, name, model.tour);
  const profile = findProfile(model, name);

  const rankPrior = entry ? null : tennisEloPriorFromRank(profile?.rank ?? null);
  const rating = entry?.rating ?? rankPrior ?? TENNIS_INITIAL_ELO;
  const ratingSource: TennisPredictedPlayer["ratingSource"] = entry
    ? "elo"
    : rankPrior !== null
      ? "rank-prior"
      : "default";

  const baseline = surfaceServeBaseline(profile ?? null, surface);
  const tour = model.baselines;
  const useTour = baseline === null || baseline.source === "none";
  return {
    name,
    country,
    rating: Math.round(rating),
    ratingSource,
    matchesPlayed: entry?.matchesPlayed ?? profile?.matchesPlayed ?? null,
    lastPlayed: entry?.lastPlayed ?? profile?.lastPlayed ?? null,
    rank: profile?.rank ?? null,
    acesPerMatch: baseline?.acesPerMatch ?? null,
    doubleFaultsPerMatch: baseline?.doubleFaultsPerMatch ?? null,
    bpFacedPerMatch: baseline?.bpFacedPerMatch ?? null,
    baselineSource: useTour
      ? tour
        ? "tour-baseline"
        : "none"
      : baseline.source,
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────

const SURFACES = new Set(["clay", "grass", "hard", "carpet"]);

export async function GET(request: Request) {
  try {
  const url = new URL(request.url);
  const surfaceParam = (url.searchParams.get("surface") ?? "").toLowerCase();
  const surface = SURFACES.has(surfaceParam) ? (surfaceParam as TennisSurface) : null;
  const surfaceRequested = surfaceParam !== "" && surface === null;

  const tourParam = (url.searchParams.get("tour") ?? "both").toLowerCase();
  const tours: TennisTour[] =
    tourParam === "atp" ? ["atp"] : tourParam === "wta" ? ["wta"] : ["atp", "wta"];

  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 24) || 24));
  const days = Math.max(1, Math.min(7, Number(url.searchParams.get("days") ?? 3) || 3));
  const includeLive = ["1", "true", "yes"].includes(
    (url.searchParams.get("includeLive") ?? "").toLowerCase(),
  );
  const locksOnly = ["1", "true", "yes"].includes(
    (url.searchParams.get("locksOnly") ?? "").toLowerCase(),
  );

  if (surfaceRequested) {
    return Response.json(
      {
        error: `Unknown surface "${surfaceParam}" — expected one of clay, grass, hard, carpet.`,
      },
      { status: 400 },
    );
  }

  let model: TennisModelCache;
  try {
    model = await getTennisModel(2);
  } catch (error) {
    console.error(error);
    return Response.json(
      { error: "Tennis data unavailable — missing Elo or historical data.", details: error instanceof Error ? error.message : "Historical source failure" },
      { status: 503 },
    );
  }

  if (tours.every((tour) => (model.tours[tour]?.matchesProcessed ?? 0) === 0)) {
    const failedSources = tours.flatMap((tour) =>
      (model.tours[tour]?.sources ?? []).map((s) => ({ tour, ...s })),
    );
    return Response.json(
      {
        error: "Tennis data unavailable — missing Elo or historical data.",
        sources: failedSources,
      },
      { status: 503 },
    );
  }

  const matches: TennisPredictedMatch[] = [];
  const sources: Array<Record<string, unknown>> = [];

  const now = new Date();
  await Promise.all(
    tours.map(async (tour) => {
      const tourModel = model.tours[tour];
      if (!tourModel) return;

      const upcoming = await fetchUpcomingTennisMatches(tour, {
        days,
        now,
        // Surface inference falls back to the tournament's real history.
        history: tourModel.matches,
      });
      sources.push({
        tour,
        source: "espn-scoreboard",
        ok: upcoming !== null,
        note: upcoming === null ? "ESPN tennis scoreboard unreachable" : `${upcoming.length} matches parsed`,
      });
      for (const s of tourModel.sources) sources.push({ tour, ...s });

      if (upcoming === null) return;

      for (const fixture of upcoming) {
        if (fixture.status === "complete") continue;
        if (fixture.status === "live" && !includeLive) continue;
        if (surface && fixture.surface !== surface) continue;

        try {
          const playerA = toModelPlayer(tourModel, fixture.players[0].name, fixture.players[0].country, fixture.surface);
          const playerB = toModelPlayer(tourModel, fixture.players[1].name, fixture.players[1].country, fixture.surface);
          const tourBaselines = tourModel.baselines;

          const prediction = predictTennisMatch({
            tour,
            tournament: fixture.tournament,
            surface: fixture.surface,
            round: fixture.round,
            date: fixture.date,
            bestOf: fixture.bestOf,
            playerA: {
              name: playerA.name,
              elo: playerA.ratingSource === "elo" ? playerA.rating : null,
              ratingSource: playerA.ratingSource,
              matchesPlayed: playerA.matchesPlayed,
              lastPlayed: playerA.lastPlayed,
              rank: playerA.rank,
              acesPerMatch: playerA.acesPerMatch,
              doubleFaultsPerMatch: playerA.doubleFaultsPerMatch,
              bpFacedPerMatch: playerA.bpFacedPerMatch,
              baselineSource: playerA.baselineSource,
            },
            playerB: {
              name: playerB.name,
              elo: playerB.ratingSource === "elo" ? playerB.rating : null,
              ratingSource: playerB.ratingSource,
              matchesPlayed: playerB.matchesPlayed,
              lastPlayed: playerB.lastPlayed,
              rank: playerB.rank,
              acesPerMatch: playerB.acesPerMatch,
              doubleFaultsPerMatch: playerB.doubleFaultsPerMatch,
              bpFacedPerMatch: playerB.bpFacedPerMatch,
              baselineSource: playerB.baselineSource,
            },
            tourBaselines: tourBaselines
              ? {
                  acesPerMatch: tourBaselines.acesPerMatch,
                  doubleFaultsPerMatch: tourBaselines.doubleFaultsPerMatch,
                  bpFacedPerMatch: tourBaselines.bpFacedPerMatch,
                }
              : null,
          });

          const isPlayableLock = isTennisPlayableLock(prediction.lockTier);
          if (locksOnly && !isPlayableLock) continue;

          matches.push({
            id: `${tour}-${fixture.id}`,
            tour,
            tournament: fixture.tournament,
            surface: fixture.surface,
            round: fixture.round,
            date: fixture.date,
            venue: fixture.venue,
            status: fixture.status,
            bestOf: fixture.bestOf,
            eloGap: prediction.eloGap,
            lockTier: prediction.lockTier,
            lockReasons: prediction.lockReasons,
            ...(prediction.bestValueMarket ? { bestValueMarket: prediction.bestValueMarket } : {}),
            players: [playerA, playerB],
            prediction,
          });
        } catch (err) {
          console.warn(`[tennis] Skipping fixture ${tour}-${fixture.id}:`, err);
        }
      }
    }),
  );

  const lockRank = (tier: TennisLockTier): number => {
    if (tier === "PLATINUM_LOCK") return 0;
    if (tier === "GOLD_LOCK") return 1;
    if (tier === "SILVER_LOCK") return 2;
    if (tier === "BRONZE_LOCK") return 3;
    if (tier === "NONE") return 4;
    return 5;
  };

  matches.sort((a, b) =>
    locksOnly
      ? lockRank(a.lockTier) - lockRank(b.lockTier) ||
        b.eloGap - a.eloGap ||
        a.date.localeCompare(b.date) ||
        a.id.localeCompare(b.id)
      : a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );

  const locksSummary = {
    platinum: matches.filter((m) => m.lockTier === "PLATINUM_LOCK").length,
    gold: matches.filter((m) => m.lockTier === "GOLD_LOCK").length,
    silver: matches.filter((m) => m.lockTier === "SILVER_LOCK").length,
    bronze: matches.filter((m) => m.lockTier === "BRONZE_LOCK").length,
    avoid: matches.filter((m) => m.lockTier === "AVOID").length,
    total: matches.filter((m) => isTennisPlayableLock(m.lockTier)).length,
    valueMarketsCount: matches.filter((m) => m.bestValueMarket !== undefined).length,
  };

  const slicedMatches = matches.slice(0, limit);
  const valueAccumulator = buildValueAccumulator(slicedMatches, lockRank);

  const ratings: Record<string, unknown> = {};
  for (const tour of tours) {
    const tourModel = model.tours[tour];
    if (!tourModel) continue;
    ratings[tour] = {
      asOf: tourModel.elo.asOf,
      matchesProcessed: tourModel.matchesProcessed,
      playersRated: tourModel.elo.players.size,
      baselines: tourModel.baselines,
      generatedAt: tourModel.generatedAt,
    };
  }

  return Response.json({
    generatedAt: new Date().toISOString(),
    filters: { surface, tour: tourParam, limit, days, includeLive, locksOnly },
    locksSummary,
    valueAccumulator,
    ratings,
    sources,
    count: matches.length,
    matches: slicedMatches,
  });

  } catch (__routeError) {
    return apiError("GET /api/tennis/predictions failed", __routeError);
  }
}

const VALUE_ACCUMULATOR_TARGET_ODDS = 1.5;
const VALUE_ACCUMULATOR_MAX_LEGS = 4;

/**
 * Build a suggested > 1.50 accumulator from the top playable Lock Value
 * Markets in the returned match slice (ordered by lock tier, value market
 * probability, and ELO edge). Picks at least 2 legs when 2+ locks exist so
 * it forms a true accumulator, and adds legs up to 4 until combined odds
 * clear > 1.50.
 */
function buildValueAccumulator(
  matches: TennisPredictedMatch[],
  lockRank: (tier: TennisLockTier) => number,
): TennisValueAccumulator | null {
  const candidates = matches
    .filter(
      (m): m is TennisPredictedMatch & { bestValueMarket: TennisBestValueMarket } =>
        isTennisPlayableLock(m.lockTier) && m.bestValueMarket !== undefined,
    )
    .sort(
      (a, b) =>
        lockRank(a.lockTier) - lockRank(b.lockTier) ||
        b.bestValueMarket.probability - a.bestValueMarket.probability ||
        b.eloGap - a.eloGap ||
        a.date.localeCompare(b.date) ||
        a.id.localeCompare(b.id),
    );

  if (candidates.length === 0) return null;

  const minLegs = Math.min(2, candidates.length);
  const maxLegs = Math.min(VALUE_ACCUMULATOR_MAX_LEGS, candidates.length);
  const legs: TennisValueAccumulatorLeg[] = [];
  let combinedOdds = 1;
  let combinedProbability = 1;
  let matchWinnerCombinedOdds = 1;

  for (const match of candidates) {
    if (legs.length >= maxLegs) break;
    if (legs.length >= minLegs && combinedOdds > VALUE_ACCUMULATOR_TARGET_ODDS) break;

    const winner = match.prediction.matchWinner;
    const matchWinnerOdds =
      winner.probA >= winner.probB ? winner.fairOddsA : winner.fairOddsB;

    legs.push({
      matchId: match.id,
      tour: match.tour,
      tournament: match.tournament,
      date: match.date,
      lockTier: match.lockTier,
      matchup: `${match.players[0].name} vs ${match.players[1].name}`,
      favorite: winner.favorite,
      matchWinnerOdds,
      market: match.bestValueMarket.market,
      selection: match.bestValueMarket.selection,
      probability: match.bestValueMarket.probability,
      fairOdds: match.bestValueMarket.fairOdds,
    });

    combinedOdds *= match.bestValueMarket.fairOdds;
    combinedProbability *= match.bestValueMarket.probability;
    matchWinnerCombinedOdds *= matchWinnerOdds;
  }

  const roundedOdds = Math.round(combinedOdds * 100) / 100;
  return {
    targetOdds: VALUE_ACCUMULATOR_TARGET_ODDS,
    meetsTarget: roundedOdds > VALUE_ACCUMULATOR_TARGET_ODDS,
    legCount: legs.length,
    combinedOdds: roundedOdds,
    combinedProbability: Math.round(combinedProbability * 10000) / 10000,
    matchWinnerCombinedOdds: Math.round(matchWinnerCombinedOdds * 100) / 100,
    legs,
  };
}
