import { db } from "@/db";
import { savedSlips } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const slips = await db
    .select()
    .from(savedSlips)
    .orderBy(desc(savedSlips.createdAt))
    .limit(20);
  return Response.json({ slips });
}

export async function POST(req: Request) {
  const body = await req.json() as {
    name?:         string;
    slipType?:     string;
    picks?:        Array<{ odds?: number; hitRate?: number }>;
    combinedOdds?: number;
    combinedProb?: number;
    stake?:        number | null;
  };

  const { name, picks, combinedOdds, combinedProb, stake } = body;

  if (!picks || !Array.isArray(picks) || picks.length < 2) {
    return Response.json({ error: "Need at least 2 picks" }, { status: 400 });
  }

  await db.insert(savedSlips).values({
    name:         name || `Custom ${picks.length}-Fold`,
    slipType:     body.slipType ?? "highhit",
    picks,
    combinedOdds: combinedOdds ?? picks.reduce((o, p) => o * (p.odds      ?? 1.5), 1),
    combinedProb: combinedProb ?? picks.reduce((p, pk) => p * (pk.hitRate  ?? 0.8), 1),
    stake:        stake ?? undefined,
    status:       "pending",
  });

  return Response.json({ success: true });
}

export async function PUT(req: Request) {
  const body = await req.json() as { id?: number; status?: string };
  const { id, status } = body;

  if (!id || !status) {
    return Response.json({ error: "Missing id or status" }, { status: 400 });
  }

  await db.update(savedSlips).set({ status }).where(eq(savedSlips.id, id));
  return Response.json({ success: true });
}
