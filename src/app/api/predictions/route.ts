import { db } from "@/db";
import { predictions } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await db
      .select({
        id:               predictions.id,
        matchLabel:       predictions.matchLabel,
        league:           predictions.league,
        matchDate:        predictions.matchDate,
        tournamentStage:  predictions.tournamentStage,
        topPick:          predictions.topPick,
        topHitRate:       predictions.topHitRate,
        totalMarkets:     predictions.totalMarkets,
        qualifiedMarkets: predictions.qualifiedMarkets,
        dataCompleteness: predictions.dataCompleteness,
        createdAt:        predictions.createdAt,
      })
      .from(predictions)
      .orderBy(desc(predictions.createdAt))
      .limit(25);

    return Response.json({ predictions: rows });
  } catch {
    return Response.json({ predictions: [] });
  }
}
