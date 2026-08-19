import { db } from "@/db";
import { performanceLog } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Auto-verify PENDING markets by web-searching for the actual match stats.
 * Searches DuckDuckGo for "{HomeTeam} vs {AwayTeam} match statistics {statName}"
 * and tries to extract the actual number from search result snippets.
 * (Called by the Performance page with { performanceId }.)
 */
export async function POST(req: Request) {
  let body: { performanceId: number };
  try {
    body = await req.json() as { performanceId: number };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { performanceId } = body;

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
      name:      string;
      selection: string;
      hitRate:   number;
      outcome:   string;
      family:    string;
    }>;

    const results: Array<{
      index:       number;
      market:      string;
      searchQuery: string;
      found:       string | null;
      outcome:     string;
    }> = [];

    for (let i = 0; i < detail.length; i++) {
      const pick = detail[i];
      if (pick.outcome !== "PENDING") continue;

      const statKeyword = extractStatKeyword(pick.name);
      if (!statKeyword) {
        results.push({ index: i, market: pick.name, searchQuery: "", found: null, outcome: "PENDING" });
        continue;
      }

      const searchQuery = `${record.homeTeam} vs ${record.awayTeam} ${record.matchDate} match statistics ${statKeyword}`;

      try {
        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
        const res = await fetch(ddgUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });

        if (res.ok) {
          const html = await res.text();
          const actual = extractStatFromHtml(html, statKeyword);

          if (actual !== null) {
            const line   = parseFloat(pick.name.split("O/U ")[1]);
            const isOver = pick.selection.startsWith("Over");

            if (!isNaN(line)) {
              const outcome = (isOver ? actual > line : actual < line) ? "HIT" : "MISS";
              detail[i].outcome = outcome;
              results.push({ index: i, market: pick.name, searchQuery, found: String(actual), outcome });
            } else {
              results.push({ index: i, market: pick.name, searchQuery, found: String(actual), outcome: "PENDING" });
            }
          } else {
            results.push({ index: i, market: pick.name, searchQuery, found: null, outcome: "PENDING" });
          }
        }

        // Rate-limit between searches — be polite to DuckDuckGo
        await new Promise((r) => setTimeout(r, 1000));
      } catch {
        results.push({ index: i, market: pick.name, searchQuery, found: null, outcome: "PENDING" });
      }
    }

    // Recalculate aggregates and persist
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

    return Response.json({ results, hits, misses, pending, accuracy });
  } catch {
    return Response.json({ error: "Verification failed" }, { status: 500 });
  }
}

// ─── Stat keyword resolver ────────────────────────────────────────────────────

function extractStatKeyword(marketName: string): string | null {
  if (marketName.includes("Throw-in"))      return "throw-ins throw ins";
  if (marketName.includes("Goal Kick"))     return "goal kicks";
  if (marketName.includes("Aerial"))        return "aerial duels won";
  if (marketName.includes("Dribble"))       return "successful dribbles";
  if (marketName.includes("Interceptions")) return "interceptions";
  if (marketName.includes("Corners"))       return "corners";
  if (marketName.includes("Cards"))         return "yellow cards";
  if (marketName.includes("SOT") || marketName.includes("Shots on Target")) return "shots on target";
  if (marketName.includes("Shots"))         return "total shots";
  if (marketName.includes("Goals"))         return "goals";
  if (marketName.includes("Offsides"))      return "offsides";
  if (marketName.includes("Saves"))         return "saves";
  if (marketName.includes("Fouls"))         return "fouls";
  return null;
}

// ─── HTML stat extractor ──────────────────────────────────────────────────────

function extractStatFromHtml(html: string, statKeyword: string): number | null {
  // Pull DuckDuckGo result snippets
  const snippetRe = /class="result__snippet">([^<]+)/g;
  const snippets:   string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push(
      sm[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim(),
    );
  }

  // Fall back to stripped body text
  const bodyText = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");

  const allText = snippets.join(" ") + " " + bodyText;

  for (const kw of statKeyword.split(" ")) {
    if (kw.length < 3) continue;

    // "keyword: N" or "keyword N"
    const m1 = new RegExp(kw + "[:\\s]+(\\d+)", "i").exec(allText);
    if (m1) return parseInt(m1[1]);

    // "N keyword"
    const m2 = new RegExp("(\\d+)\\s+" + kw, "i").exec(allText);
    if (m2) return parseInt(m2[1]);

    // "N - N" near keyword → return total (home + away)
    const m3 = new RegExp(kw + "[^\\d]*(\\d+)\\s*[-–]\\s*(\\d+)", "i").exec(allText);
    if (m3) return parseInt(m3[1]) + parseInt(m3[2]);
  }

  return null;
}
