import { desc } from "drizzle-orm";
import { v4Predictions } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { db } = await import("@/db");
    return Response.json(await db.select().from(v4Predictions).orderBy(desc(v4Predictions.createdAt)));
  } catch (error) {
    console.error("V4 history error", error);
    return Response.json({ error: "Unable to load history" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const data = await request.json();
    if (!data || typeof data.matchweek !== "string" || !data.matchweek.trim() || data.matchweek.length > 200 ||
        !Array.isArray(data.fixtures) || !Array.isArray(data.predictions) || data.fixtures.length === 0 || data.fixtures.length > 20 ||
        data.predictions.length !== data.fixtures.length ||
        !data.fixtures.every((f: unknown) => Array.isArray(f) && f.length === 2 && f.every((s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 200)) ||
        !data.predictions.every((p: unknown) => {
          if (!p || typeof p !== "object") return false;
          const row = p as Record<string, unknown>;
          return typeof row.Match === "string" && row.Match.length <= 405 && typeof row.Category === "string" && row.Category.length <= 200 &&
            typeof row.Prediction === "string" && /^\d+-\d+$/.test(row.Prediction) && row.Prediction.length <= 20 &&
            Number.isInteger(row.Target_Pts) && (row.Target_Pts as number) >= 0;
        }) ||
        (data.actuals != null && (!Array.isArray(data.actuals) || data.actuals.length !== data.fixtures.length ||
          !data.actuals.every((a: unknown) => Array.isArray(a) && a.length === 2 && a.every((n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0)))) ||
        (data.totalScore != null && (!Number.isInteger(data.totalScore) || data.totalScore < 0 || data.totalScore > 2147483647))) {
      return Response.json({ error: "Invalid prediction data" }, { status: 400 });
    }
    const { db } = await import("@/db");
    const [saved] = await db.insert(v4Predictions).values({
      matchweek: data.matchweek, fixtures: data.fixtures, predictions: data.predictions,
      actuals: data.actuals ?? null, totalScore: data.totalScore ?? null,
    }).returning({ id: v4Predictions.id });
    return Response.json({ ok: true, id: saved.id });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    console.error("V4 save error", error);
    return Response.json({ error: "Unable to save prediction" }, { status: 500 });
  }
}
