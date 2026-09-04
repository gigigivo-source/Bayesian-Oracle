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

import {
  buildTennisPlayerProfiles,
  computeTourBaselines,
  fetchUpcomingTennisMatches,
  loadTennisMatches,
  surfaceServeBaseline,
  tennisPlayerKey,
  type TennisPlayerProfile,
  type TennisSurface,
  type TennisTour,
} from "@/lib/data/sources/tennis";
import {
  buildTennisEloTable,
  findTennisEloEntry,
  tennisEloPriorFromRank,
  type TennisEloTable,
} from "@/lib/data/elo";
import { predictTennisMatch, type TennisPrediction } from "@/lib/engine/markets";

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
      }),
    );

    cache = {
      at: Date.now(),
      seasons,
      tours: { atp: tours[0], wta: tours[1] },
    };
    return cache;
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
    if (profile.key !== tennisPlayerKey(profile.player)) continue;
    // Cheap fuzzy pass: same first initial + surname.
    const surname = (name: string): string => name.trim().toLowerCase().split(" ").pop() ?? "";
    const initial = (name: string): string => (name.trim()[0] ?? "").toLowerCase();
    if (surname(profile.player) === surname(player) && initial(profile.player) === initial(player)) {
      return profile;
    }
  }
  return null;
}

// ─── Response shape ───────────────────────────────────────────────────────────

export interface TennisPredictedPlayer {
  name: string;
  country: string | null;
  /** Surface-adjusted effective ELO used by the model. */
  rating: number;
  ratingSource: "elo" | "rank-prior" | "default";
  matchesPlayed: number | null;
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
  players: [TennisPredictedPlayer, TennisPredictedPlayer];
  prediction: TennisPrediction;
}

function toModelPlayer(
  model: TennisTourModel,
  name: string,
  country: string | null,
  surface: TennisSurface | null,
): TennisPredictedPlayer {
  const entry = findTennisEloEntry(model.elo, name, model.tour);
  const profile = findProfile(model, name);

  let rating: number;
  let ratingSource: TennisPredictedPlayer["ratingSource"];
  if (entry && entry.matchesPlayed > 0) {
    rating = entry.rating;
    ratingSource = "elo";
  } else {
    const prior = tennisEloPriorFromRank(profile?.rank ?? null);
    if (prior !== null) {
      rating = prior;
      ratingSource = "rank-prior";
    } else {
      rating = 1500;
      ratingSource = "default";
    }
  }

  const baseline = surfaceServeBaseline(profile ?? null, surface);
  const tour = model.baselines;
  const useTour = baseline === null || baseline.source === "none";
  return {
    name,
    country,
    rating: Math.round(rating),
    ratingSource,
    matchesPlayed: entry?.matchesPlayed ?? profile?.matchesPlayed ?? null,
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

  if (surfaceRequested) {
    return Response.json(
      {
        error: `Unknown surface "${surfaceParam}" — expected one of clay, grass, hard, carpet.`,
      },
      { status: 400 },
    );
  }

  const model = await getTennisModel(2);
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
          players: [playerA, playerB],
          prediction,
        });
      }
    }),
  );

  matches.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

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
    filters: { surface, tour: tourParam, limit, days, includeLive },
    ratings,
    sources,
    count: matches.length,
    matches: matches.slice(0, limit),
  });
}
