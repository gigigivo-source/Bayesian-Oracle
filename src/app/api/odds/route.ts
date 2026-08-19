import { LEAGUE_MAP } from "@/lib/leagues";
import { searchFixture, getMultiBookOdds } from "@/lib/apiFootball";

export const dynamic = "force-dynamic";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

function mlToDecimal(ml: number): number {
  if (ml > 0) return ml / 100 + 1;
  return 100 / Math.abs(ml) + 1;
}

// ─── ESPN pickcenter types ────────────────────────────────────────────────────

interface EspnOddsEntry {
  odds:  string;
  line?: string;
}

interface EspnPickcenter {
  provider?:  { name?: string };
  overUnder?: number;
  moneyline?: {
    home?: { close?: EspnOddsEntry };
    draw?: { close?: EspnOddsEntry };
    away?: { close?: EspnOddsEntry };
  };
  total?: {
    over?:  { close?: EspnOddsEntry };
    under?: { close?: EspnOddsEntry };
  };
}

interface EspnSummaryPickcenter {
  pickcenter?: EspnPickcenter[];
}

// ─── Output types ─────────────────────────────────────────────────────────────

interface OddsLine {
  provider: string;
  homeOdds: number;
  drawOdds: number;
  awayOdds: number;
  overUnder?: number;
  overOdds?:  number;
  underOdds?: number;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const league  = searchParams.get("league");
  const eventId = searchParams.get("event");
  const home    = searchParams.get("home") ?? "";
  const away    = searchParams.get("away") ?? "";
  const date    = searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

  // Validate league if provided
  if (league && !LEAGUE_MAP[league]) {
    return Response.json({ error: "Unknown league slug." }, { status: 400 });
  }

  const lines: OddsLine[] = [];

  // ── Layer 1: ESPN pickcenter (DraftKings / partner book) ─────────────────────
  if (league && eventId) {
    try {
      const res = await fetch(`${ESPN_BASE}/${league}/summary?event=${eventId}`, {
        next: { revalidate: 300 },
      });
      if (res.ok) {
        const data = await res.json() as EspnSummaryPickcenter;
        const pc   = data.pickcenter?.[0];
        if (pc?.moneyline?.home?.close?.odds) {
          const ml    = pc.moneyline;
          const total = pc.total;
          lines.push({
            provider: pc.provider?.name ?? "DraftKings",
            homeOdds: mlToDecimal(Number(ml.home?.close?.odds)),
            drawOdds: ml?.draw?.close?.odds ? mlToDecimal(Number(ml.draw.close.odds)) : 0,
            awayOdds: ml?.away?.close?.odds ? mlToDecimal(Number(ml.away.close.odds)) : 0,
            overUnder: pc.overUnder,
            overOdds:  total?.over?.close?.odds  ? mlToDecimal(Number(total.over.close.odds))  : undefined,
            underOdds: total?.under?.close?.odds ? mlToDecimal(Number(total.under.close.odds)) : undefined,
          });
        }
      }
    } catch { /* skip — not all fixtures have pickcenter */ }
  }

  // ── Layer 2: API-Football — up to 11 bookmakers incl. Pinnacle, Betfair ──────
  if (home && away) {
    try {
      const fixtureId = await searchFixture(home, away, date);
      if (fixtureId) {
        const multiOdds = await getMultiBookOdds(fixtureId);
        if (multiOdds) {
          // Add 1X2 lines, skip providers already covered by ESPN
          for (const bm of multiOdds.bookmakers) {
            const alreadyHave = lines.some((l) =>
              l.provider.toLowerCase().includes(bm.bookmaker.toLowerCase().slice(0, 5)),
            );
            if (!alreadyHave) {
              lines.push({
                provider: bm.bookmaker,
                homeOdds: bm.homeOdds,
                drawOdds: bm.drawOdds,
                awayOdds: bm.awayOdds,
              });
            }
          }

          // Merge O/U lines into existing entries (up to 5 lines)
          for (const ou of multiOdds.overUnderLines.slice(0, 5)) {
            const existing = lines.find((l) => l.provider === ou.bookmaker);
            if (existing && !existing.overUnder) {
              existing.overUnder = parseFloat(ou.line);
              existing.overOdds  = ou.over;
              existing.underOdds = ou.under;
            }
          }
        }
      }
    } catch { /* API-Football is optional — never fail */ }
  }

  // ── Best available odds ───────────────────────────────────────────────────────
  const positiveHome = lines.map((l) => l.homeOdds).filter((o) => o > 1);
  const positiveDraw = lines.map((l) => l.drawOdds).filter((o) => o > 1);
  const positiveAway = lines.map((l) => l.awayOdds).filter((o) => o > 1);

  const bestHome = positiveHome.length > 0 ? Math.max(...positiveHome) : 0;
  const bestDraw = positiveDraw.length > 0 ? Math.max(...positiveDraw) : 0;
  const bestAway = positiveAway.length > 0 ? Math.max(...positiveAway) : 0;

  const providers = [...new Set(lines.map((l) => l.provider))];

  return Response.json({
    lines,
    bestOdds:             { home: bestHome, draw: bestDraw, away: bestAway },
    providers,
    count:                lines.length,
    hasMultipleProviders: providers.length > 1,
  });
}
