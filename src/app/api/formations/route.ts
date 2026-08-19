import { analyseFormationMismatch, getFormationProfile } from "@/lib/engine/players";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const home = searchParams.get("home") ?? "4-3-3";
  const away = searchParams.get("away") ?? "4-4-2";

  const homeProfile = getFormationProfile(home);
  const awayProfile = getFormationProfile(away);
  const mismatch    = analyseFormationMismatch(home, away);

  return Response.json({ home: homeProfile, away: awayProfile, mismatch });
}
