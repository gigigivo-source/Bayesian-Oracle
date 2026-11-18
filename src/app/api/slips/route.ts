import { apiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { savedSlips } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { asNumber, asRecord } from "@/lib/data/sources/shared";

export const dynamic = "force-dynamic";

const SLIP_TYPES = new Set(["highhit", "value"]);
const SLIP_STATUSES = new Set(["pending", "won", "lost", "void"]);

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function serverError(label: string, err: unknown): Response {
  console.error(label, err);
  return apiError("Database query failed", err);
}

export async function GET() {
  try {
  try {
    const slips = await db
      .select()
      .from(savedSlips)
      .orderBy(desc(savedSlips.createdAt))
      .limit(20);
    return Response.json({ slips });
  } catch (err) {
    return serverError("Slips GET error:", err);
  }

  } catch (__routeError) {
    return apiError("GET /api/slips failed", __routeError);
  }
}

export async function POST(req: Request) {
  try {
  let body: unknown;
  try {
    body = await req.json();
  } catch (__caughtError) {
    console.error("[API] Swallowed upstream error at src/app/api/slips/route.ts:43", __caughtError);
    return badRequest("Invalid JSON body");
  }

  const data = asRecord(body);
  if (!data) return badRequest("Invalid request body");

  const picksRaw = data.picks;
  if (!Array.isArray(picksRaw) || picksRaw.length < 2) {
    return badRequest("Need at least 2 picks");
  }

  const picks: Array<Record<string, unknown>> = [];
  let combinedOddsFallback = 1;
  let combinedProbFallback = 1;

  for (const raw of picksRaw) {
    const pick = asRecord(raw);
    if (!pick) return badRequest("Invalid picks");

    // Accumulator picks use `fairOdds`; accept the older `odds` and
    // `marketOdds` spellings too, but never fall back to NaN/undefined math.
    const odds = asNumber(pick.odds) ?? asNumber(pick.fairOdds) ?? asNumber(pick.marketOdds);
    const hitRate = asNumber(pick.hitRate);
    if (odds === null || odds <= 0 || hitRate === null || hitRate < 0 || hitRate > 1) {
      return badRequest("Invalid picks");
    }

    combinedOddsFallback *= odds;
    combinedProbFallback *= hitRate;
    picks.push({ ...pick, odds, hitRate });
  }

  const providedCombinedOdds = data.combinedOdds === undefined ? null : asNumber(data.combinedOdds);
  const providedCombinedProb = data.combinedProb === undefined ? null : asNumber(data.combinedProb);
  if (data.combinedOdds !== undefined && (providedCombinedOdds === null || providedCombinedOdds <= 0)) {
    return badRequest("Invalid combinedOdds");
  }
  if (
    data.combinedProb !== undefined &&
    (providedCombinedProb === null || providedCombinedProb <= 0 || providedCombinedProb > 1)
  ) {
    return badRequest("Invalid combinedProb");
  }

  const combinedOdds = providedCombinedOdds ?? combinedOddsFallback;
  const combinedProb = providedCombinedProb ?? combinedProbFallback;
  if (
    !Number.isFinite(combinedOdds) || combinedOdds <= 0 ||
    !Number.isFinite(combinedProb) || combinedProb <= 0 || combinedProb > 1
  ) {
    return badRequest("Invalid combined values");
  }

  let name = `Custom ${picks.length}-Fold`;
  if (data.name !== undefined) {
    if (typeof data.name !== "string") return badRequest("Invalid name");
    name = data.name.trim() || name;
  }

  let slipType = "highhit";
  if (data.slipType !== undefined) {
    if (typeof data.slipType !== "string" || !SLIP_TYPES.has(data.slipType)) {
      return badRequest("Invalid slipType");
    }
    slipType = data.slipType;
  }

  let stake: number | null | undefined;
  if (data.stake !== undefined) {
    if (data.stake === null) {
      stake = null;
    } else {
      const parsed = asNumber(data.stake);
      if (parsed === null || parsed < 0) return badRequest("Invalid stake");
      stake = parsed;
    }
  }

  try {
    await db.insert(savedSlips).values({
      name,
      slipType,
      picks,
      combinedOdds,
      combinedProb,
      stake: stake === undefined ? undefined : stake,
      status: "pending",
    });
    return Response.json({ success: true });
  } catch (err) {
    return serverError("Slips POST error:", err);
  }

  } catch (__routeError) {
    return apiError("POST /api/slips failed", __routeError);
  }
}

export async function PUT(req: Request) {
  try {
  let body: unknown;
  try {
    body = await req.json();
  } catch (__caughtError) {
    console.error("[API] Swallowed upstream error at src/app/api/slips/route.ts:147", __caughtError);
    return badRequest("Invalid JSON body");
  }

  const data = asRecord(body);
  if (!data) return badRequest("Invalid request body");

  const id = asNumber(data.id);
  if (id === null || !Number.isInteger(id) || id <= 0) {
    return badRequest("Invalid id");
  }

  const updates: { status?: string; stake?: number | null } = {};

  if (data.status !== undefined) {
    if (typeof data.status !== "string" || !SLIP_STATUSES.has(data.status)) {
      return badRequest("Invalid status");
    }
    updates.status = data.status;
  }

  if (data.stake !== undefined) {
    if (data.stake === null) {
      updates.stake = null;
    } else {
      const parsed = asNumber(data.stake);
      if (parsed === null || parsed < 0) return badRequest("Invalid stake");
      updates.stake = parsed;
    }
  }

  if (Object.keys(updates).length === 0) {
    return badRequest("Missing status or stake");
  }

  try {
    await db.update(savedSlips).set(updates).where(eq(savedSlips.id, id));
    return Response.json({ success: true });
  } catch (err) {
    return serverError("Slips PUT error:", err);
  }

  } catch (__routeError) {
    return apiError("PUT /api/slips failed", __routeError);
  }
}
