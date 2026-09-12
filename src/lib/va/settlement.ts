// Value Accumulator — Settlement (independent but uses existing settlement evaluator)
import { db } from "@/db";
import { vaTickets } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  evaluateLegDetailed,
  statsGraceElapsed,
  type MatchResult,
} from "@/lib/settlement/evaluate";
import { getSettlementBoxscore } from "@/lib/settlement/results";
import { fetchScoreboard } from "@/lib/espn";

interface VaTicketLeg {
  match: string;
  market: string;
  selection: string;
  odds: number;
  ev: number;
  kickoff: string;
  statFamily: string;
  homeTeam: string;
  awayTeam: string;
  bookmaker: string;
  eventId: string;
  modelProbability: number;
}

function parseLegs(raw: unknown): VaTicketLeg[] {
  if (!Array.isArray(raw)) return [];
  return raw as VaTicketLeg[];
}

function fmtDateForEspn(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function lookupResultForLeg(leg: VaTicketLeg): Promise<MatchResult | null> {
  // Try ESPN scoreboard for the leg's date
  const dateKey = fmtDateForEspn(leg.kickoff);
  if (!dateKey) return null;
  try {
    const fixtures = await fetchScoreboard("all", dateKey);
    const found = fixtures.find((f) => f.id === leg.eventId);
    if (found && found.state === "post" && found.home.score !== null && found.away.score !== null) {
      const hs = Number(found.home.score);
      const as = Number(found.away.score);
      if (Number.isFinite(hs) && Number.isFinite(as)) {
        return {
          eventId: found.id,
          leagueSlug: found.leagueSlug,
          date: found.date.slice(0, 10),
          kickoffAt: found.date,
          homeName: found.home.name,
          awayName: found.away.name,
          homeScore: hs,
          awayScore: as,
        };
      }
    }
    // Fallback: match by label
    const byLabel = fixtures.find((f) => {
      const label = `${f.home.name} vs ${f.away.name}`.toLowerCase();
      return label === leg.match.toLowerCase() && f.state === "post";
    });
    if (byLabel && byLabel.home.score !== null && byLabel.away.score !== null) {
      const hs = Number(byLabel.home.score);
      const as = Number(byLabel.away.score);
      if (Number.isFinite(hs) && Number.isFinite(as)) {
        return {
          eventId: byLabel.id,
          leagueSlug: byLabel.leagueSlug,
          date: byLabel.date.slice(0, 10),
          kickoffAt: byLabel.date,
          homeName: byLabel.home.name,
          awayName: byLabel.away.name,
          homeScore: hs,
          awayScore: as,
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function settleVaTickets(): Promise<{ settled: number; win: number; loss: number; partial: number }> {
  const pendingTickets = await db.select().from(vaTickets).where(eq(vaTickets.status, "pending"));
  let settled = 0;
  let win = 0;
  let loss = 0;
  let partial = 0;

  if (pendingTickets.length === 0) {
    return { settled, win, loss, partial };
  }

  for (const ticket of pendingTickets) {
    const legs = parseLegs(ticket.legs);
    if (legs.length === 0) continue;

    const now = new Date();
    const allKickoffsPast = legs.every((l) => {
      const k = new Date(l.kickoff);
      return k.getTime() + 2 * 60 * 60 * 1000 < now.getTime();
    });
    if (!allKickoffsPast) continue;

    let hasLoss = false;
    let hasVoid = false;
    let hasPending = false;
    const legOutcomes: Array<"won" | "lost" | "void" | "pending"> = [];

    for (const leg of legs) {
      try {
        const result = await lookupResultForLeg(leg);

        if (!result) {
          // No result yet
          const mockForGrace: MatchResult = {
            eventId: leg.eventId,
            leagueSlug: "",
            date: leg.kickoff.slice(0, 10),
            kickoffAt: leg.kickoff,
            homeName: leg.homeTeam,
            awayName: leg.awayTeam,
            homeScore: 0,
            awayScore: 0,
          };
          if (statsGraceElapsed(mockForGrace)) {
            legOutcomes.push("void");
            hasVoid = true;
          } else {
            legOutcomes.push("pending");
            hasPending = true;
          }
          continue;
        }

        // Try to get boxscore
        let boxscore = null;
        try {
          const outcome = await getSettlementBoxscore(result);
          boxscore = outcome.stats;
        } catch {
          boxscore = null;
        }

        const evalRes = evaluateLegDetailed(
          {
            marketName: leg.market,
            selection: leg.selection,
          },
          result,
          boxscore
        );

        if (evalRes.outcome === "won") {
          legOutcomes.push("won");
        } else if (evalRes.outcome === "lost") {
          legOutcomes.push("lost");
          hasLoss = true;
        } else if (evalRes.outcome === "void") {
          legOutcomes.push("void");
          hasVoid = true;
        } else {
          if (statsGraceElapsed(result)) {
            legOutcomes.push("void");
            hasVoid = true;
          } else {
            legOutcomes.push("pending");
            hasPending = true;
          }
        }
      } catch {
        legOutcomes.push("pending");
        hasPending = true;
      }
    }

    if (hasPending) continue;

    let finalStatus: "win" | "loss" | "partial" | "void" = "pending" as any;
    if (hasLoss) {
      finalStatus = "loss";
      loss++;
    } else if (hasVoid) {
      finalStatus = "partial";
      partial++;
    } else {
      finalStatus = "win";
      win++;
    }

    try {
      await db
        .update(vaTickets)
        .set({
          status: finalStatus,
          settledAt: new Date(),
        })
        .where(eq(vaTickets.id, ticket.id));
      settled++;
      console.log(`[VA][Settle] Ticket ${ticket.id} settled as ${finalStatus} (${legOutcomes.join(",")})`);
    } catch (err) {
      console.error(`[VA][Settle] Failed to settle ticket ${ticket.id}`, err);
    }
  }

  console.log(`[VA][Settle] Settled ${settled} tickets (win ${win}, loss ${loss}, partial ${partial})`);
  return { settled, win, loss, partial };
}
