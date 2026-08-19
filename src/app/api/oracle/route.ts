import { db } from "@/db";
import { predictions } from "@/db/schema";
import { runEngine } from "@/lib/engine";
import type { PredictInput } from "@/lib/engine/types";

export const dynamic = "force-dynamic";

function validate(body: Partial<PredictInput>): string | null {
  if (!body.match || !/\s+vs\s+/i.test(body.match)) {
    return "MATCH must be in the form '[TEAM] vs [TEAM]'.";
  }
  const [h, a] = body.match.split(/\s+vs\s+/i);
  if (!h?.trim() || !a?.trim()) return "Both team names are required.";
  if (!body.league?.trim())     return "LEAGUE is required.";
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return "DATE must be in YYYY-MM-DD format.";
  }
  return null;
}

export async function POST(req: Request) {
  let body: Partial<PredictInput>;
  try {
    body = await req.json() as Partial<PredictInput>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const err = validate(body);
  if (err) return Response.json({ error: err }, { status: 400 });

  const input: PredictInput = {
    auto:   body.auto ?? true,
    match:  body.match!.trim(),
    league: body.league!.trim(),
    date:   body.date!,
  };

  const result = runEngine(input);

  // Persist run — best-effort, never block the response on DB errors
  try {
    await db.insert(predictions).values({
      matchLabel:       input.match,
      homeTeam:         result.match.homeTeam ?? input.match.split(/\s+vs\s+/i)[0]?.trim() ?? "",
      awayTeam:         result.match.awayTeam ?? input.match.split(/\s+vs\s+/i)[1]?.trim() ?? "",
      league:           input.league,
      leagueSlug:       "manual",
      eventId:          `predict_${Date.now()}`,
      matchDate:        input.date,
      tournamentStage:  result.match.tournamentStage ?? "",
      topPick:          result.top1[0]?.name    ?? "N/A",
      topHitRate:       result.top1[0]?.hitRate ?? 0,
      totalMarkets:     result.totalMarkets,
      qualifiedMarkets: result.qualifiedMarkets,
      dataCompleteness: result.match.dataCompletenessScore,
      result,
    });
  } catch (e) {
    console.error("Failed to persist prediction:", e);
  }

  return Response.json(result);
}
