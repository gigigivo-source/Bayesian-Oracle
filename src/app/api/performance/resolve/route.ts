import { db } from "@/db";
import { performanceLog } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

interface ResolveBody {
  performanceId: number;
  pickIndex:     number;
  outcome:       "HIT" | "MISS";
}

/** User manually resolves a PENDING market as HIT or MISS */
export async function POST(req: Request) {
  let body: ResolveBody;
  try {
    body = await req.json() as ResolveBody;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { performanceId, pickIndex, outcome } = body;

  if (
    !performanceId ||
    pickIndex === undefined ||
    (outcome !== "HIT" && outcome !== "MISS")
  ) {
    return Response.json(
      { error: "Missing performanceId, pickIndex, or valid outcome (HIT/MISS)" },
      { status: 400 },
    );
  }

  try {
    const rows = await db
      .select()
      .from(performanceLog)
      .where(eq(performanceLog.id, performanceId))
      .limit(1);

    if (rows.length === 0) {
      return Response.json({ error: "Record not found" }, { status: 404 });
    }

    const record = rows[0];
    const detail = record.top10Detail as Array<{
      name: string;
      selection: string;
      hitRate: number;
      outcome: string;
      family: string;
    }>;

    if (pickIndex < 0 || pickIndex >= detail.length) {
      return Response.json({ error: "Invalid pickIndex" }, { status: 400 });
    }

    // Update the specific pick's outcome
    detail[pickIndex].outcome = outcome;

    // Recalculate aggregates
    let hits = 0, misses = 0, pending = 0;
    for (const pick of detail) {
      if      (pick.outcome === "HIT")  hits++;
      else if (pick.outcome === "MISS") misses++;
      else                              pending++;
    }
    const verified = hits + misses;
    const accuracy = verified > 0 ? hits / verified : 0;

    await db
      .update(performanceLog)
      .set({ top10Detail: detail, hits, misses, pending, accuracy })
      .where(eq(performanceLog.id, performanceId));

    return Response.json({ success: true, hits, misses, pending, accuracy });
  } catch (e) {
    console.error("resolve error", e);
    return Response.json({ error: "Failed to update" }, { status: 500 });
  }
}
