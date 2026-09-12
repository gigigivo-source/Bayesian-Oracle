// Value Accumulator — Ticket partitioner (independent)

export interface VaLeg {
  id?: number;
  scanId: string;
  eventId: string;
  matchLabel: string;
  homeTeam: string;
  awayTeam: string;
  leagueSlug: string;
  kickoff: Date | string;
  market: string;
  selection: string;
  statFamily: string; // goals, corners, cards, shots, other
  modelProbability: number;
  bookmakerOdds: number;
  bookmakerName: string;
  impliedProbability: number;
  ev: number;
  oddsAtBuild?: Date | string;
  scannedAt?: Date | string;
}

export interface VaTicketLeg {
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

export interface VaTicket {
  scanId: string;
  weekStart: string; // YYYY-MM-DD
  legs: VaTicketLeg[];
  combinedOdds: number;
  combinedProbability: number;
  combinedEv: number;
  kellyScore: number;
  stakePercent: number;
  isRecommended: boolean;
  isReferenceOnly: boolean;
}

function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d);
}

function getMondayCat(date: Date): string {
  // Convert to CAT (UTC+2) then get Monday
  // CAT = UTC+2, so add 2 hours to UTC to get CAT date
  const catMs = date.getTime() + 2 * 60 * 60 * 1000;
  const catDate = new Date(catMs);
  // get day of week (0 Sunday, 1 Monday)
  const day = catDate.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day; // days to Monday
  const monday = new Date(catDate);
  monday.setUTCDate(catDate.getUTCDate() + diff);
  monday.setUTCHours(0, 0, 0, 0);
  // Convert back to date string YYYY-MM-DD in CAT
  // Since monday is in CAT-adjusted time but using UTC methods, its YYYY-MM-DD is CAT Monday
  const y = monday.getUTCFullYear();
  const m = String(monday.getUTCMonth() + 1).padStart(2, "0");
  const d = String(monday.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getWeekStartForLegs(legs: VaLeg[]): string {
  if (legs.length === 0) {
    // default to current week's Monday CAT
    return getMondayCat(new Date());
  }
  // Find earliest kickoff
  const earliest = legs
    .map((l) => toDate(l.kickoff))
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return getMondayCat(earliest);
}

export function buildTickets(legs: VaLeg[]): VaTicket[] {
  if (legs.length < 3) {
    const best = legs.length === 0 ? 0 : legs.reduce((acc, l) => acc * l.bookmakerOdds, 1);
    // If we have <3 legs, best is still product but we cap display to 2 decimals
    // When legs <3, product of available legs is the best achievable; if 0 legs best is 0
    console.log(`[VA] No ticket built: ${legs.length} legs available, best combined odds ${best.toFixed(2)}`);
    return [];
  }

  // Sort legs by EV descending
  const sorted = [...legs].sort((a, b) => b.ev - a.ev);

  const tickets: VaTicket[] = [];
  const usedLegIndices = new Set<number>();

  function computeTicketStats(ticketLegs: VaLeg[]): {
    combinedOdds: number;
    combinedProbability: number;
    combinedEv: number;
    kellyScore: number;
    stakePercent: number;
  } {
    const combinedOdds = ticketLegs.reduce((acc, l) => acc * l.bookmakerOdds, 1);
    const combinedProbability = ticketLegs.reduce((acc, l) => acc * l.modelProbability, 1);
    const combinedEv = combinedProbability * combinedOdds - 1;
    const kellyScore = combinedOdds > 1 ? combinedEv / (combinedOdds - 1) : 0;
    const stakePercent = Math.min(0.5 * kellyScore * 100, 2);
    return {
      combinedOdds,
      combinedProbability,
      combinedEv,
      kellyScore,
      stakePercent,
    };
  }

  let bestCombinedOdds = 0;

  // Helper to count remaining legs
  const remainingCount = () => sorted.filter((_, idx) => !usedLegIndices.has(idx)).length;

  while (remainingCount() >= 3) {
    const currentTicket: VaLeg[] = [];
    let combinedOdds = 1;

    // Greedy fill from sorted EV order
    for (let i = 0; i < sorted.length && currentTicket.length < 4; i++) {
      if (usedLegIndices.has(i)) continue;
      const candidate = sorted[i];
      if (currentTicket.some((l) => l.eventId === candidate.eventId)) continue;

      const tentative = combinedOdds * candidate.bookmakerOdds;
      if (tentative > 4.5) {
        continue;
      }

      currentTicket.push(candidate);
      combinedOdds = tentative;

      // Stop when ticket has 3 legs and combined odds are >= 3.0
      if (currentTicket.length === 3 && combinedOdds >= 3.0) {
        break;
      }
      // If we have 4 legs, stop regardless (max 4)
      if (currentTicket.length === 4) {
        break;
      }
    }

    // If we couldn't fill at least 3 legs, no further tickets possible
    if (currentTicket.length < 3) {
      // Update best with whatever we managed (if 1-2 legs)
      if (currentTicket.length > 0) {
        const curBest = currentTicket.reduce((acc, l) => acc * l.bookmakerOdds, 1);
        if (curBest > bestCombinedOdds) bestCombinedOdds = curBest;
      }
      break;
    }

    const stats = computeTicketStats(currentTicket);
    if (stats.combinedOdds > bestCombinedOdds) bestCombinedOdds = stats.combinedOdds;

    // Must be within 3.0 - 4.5; otherwise this ticket cannot be committed
    if (stats.combinedOdds < 3.0 || stats.combinedOdds > 4.5) {
      // Combined odds never reach 3.0 (or exceeded) — cannot build more tickets with this greedy approach
      // If we have at least 3 legs but odds <3.0, we attempted to add a 4th within loop; if still <3.0, we break.
      // To avoid infinite loop, break outer loop. Any remaining legs would also fail similarly.
      // If tickets already built, we stop and log built; if none built, we log no ticket.
      break;
    }

    // Commit ticket
    const weekStart = getWeekStartForLegs(currentTicket);

    const ticketLegs: VaTicketLeg[] = currentTicket.map((l) => ({
      match: l.matchLabel,
      market: l.market,
      selection: l.selection,
      odds: l.bookmakerOdds,
      ev: l.ev,
      kickoff: toDate(l.kickoff).toISOString(),
      statFamily: l.statFamily,
      homeTeam: l.homeTeam,
      awayTeam: l.awayTeam,
      bookmaker: l.bookmakerName,
      eventId: l.eventId,
      modelProbability: l.modelProbability,
    }));

    tickets.push({
      scanId: currentTicket[0].scanId,
      weekStart,
      legs: ticketLegs,
      combinedOdds: stats.combinedOdds,
      combinedProbability: stats.combinedProbability,
      combinedEv: stats.combinedEv,
      kellyScore: stats.kellyScore,
      stakePercent: stats.stakePercent,
      isRecommended: false,
      isReferenceOnly: false,
    });

    // Mark legs as used
    for (const leg of currentTicket) {
      const idx = sorted.findIndex((l) => l === leg);
      if (idx !== -1) usedLegIndices.add(idx);
    }
  }

  if (tickets.length === 0) {
    // Compute best combined odds for logging if still 0
    if (bestCombinedOdds === 0) {
      // Fallback: best product of up to 3 distinct eventIds from sorted that doesn't exceed 4.5
      // Find the best achievable ticket-like combination respecting event_id uniqueness and <=4.5
      // Greedy best: take top distinct legs until product exceeds 4.5 or we have 3
      let fallbackOdds = 1;
      let distinctCount = 0;
      const seenEvents = new Set<string>();
      for (const leg of sorted) {
        if (seenEvents.has(leg.eventId)) continue;
        const tentative = fallbackOdds * leg.bookmakerOdds;
        if (tentative > 4.5) continue;
        fallbackOdds = tentative;
        seenEvents.add(leg.eventId);
        distinctCount++;
        if (distinctCount === 3) break;
      }
      // If we couldn't get 3 distinct within 4.5, just take product of first 3 distinct regardless of cap
      if (distinctCount < 3) {
        const distinct: VaLeg[] = [];
        const seen2 = new Set<string>();
        for (const leg of sorted) {
          if (seen2.has(leg.eventId)) continue;
          seen2.add(leg.eventId);
          distinct.push(leg);
          if (distinct.length === 3) break;
        }
        if (distinct.length > 0) {
          fallbackOdds = distinct.reduce((acc, l) => acc * l.bookmakerOdds, 1);
        } else {
          fallbackOdds = 0;
        }
      }
      // Also compare with product of top 3 distinct regardless — take max
      const distinct3: VaLeg[] = [];
      const seen3 = new Set<string>();
      for (const leg of sorted) {
        if (seen3.has(leg.eventId)) continue;
        seen3.add(leg.eventId);
        distinct3.push(leg);
        if (distinct3.length === 3) break;
      }
      if (distinct3.length === 3) {
        const prod = distinct3.reduce((acc, l) => acc * l.bookmakerOdds, 1);
        // Choose the larger of fallback and prod that is more representative of best attempt
        // But if prod <=4.5 and fallback was limited, keep fallback; otherwise use prod
        if (prod > fallbackOdds && prod <= 4.5) bestCombinedOdds = prod;
        else if (fallbackOdds > 0) bestCombinedOdds = fallbackOdds;
        else bestCombinedOdds = prod;
      } else if (distinct3.length > 0) {
        bestCombinedOdds = distinct3.reduce((acc, l) => acc * l.bookmakerOdds, 1);
      } else {
        bestCombinedOdds = fallbackOdds;
      }
    }
    console.log(`[VA] No ticket built: ${legs.length} legs available, best combined odds ${bestCombinedOdds.toFixed(2)}`);
    return [];
  }

  // Sort by kelly_score descending
  tickets.sort((a, b) => b.kellyScore - a.kellyScore);

  // Apply recommended flag and exposure cap
  if (tickets.length > 0) {
    tickets[0].isRecommended = true;
  }

  // Exposure cap: sum stake_percent, if >6% mark lowest kelly as reference only until <=6%
  let totalExposure = tickets.reduce((sum, t) => sum + t.stakePercent, 0);
  if (totalExposure > 6) {
    // Sort by kelly ascending for trimming, but keep top ticket always inside cap
    const sortedByKellyAsc = [...tickets].sort((a, b) => a.kellyScore - b.kellyScore);
    for (const ticket of sortedByKellyAsc) {
      if (ticket.isRecommended) continue; // top ticket never marked reference-only
      if (totalExposure <= 6) break;
      if (!ticket.isReferenceOnly) {
        ticket.isReferenceOnly = true;
        totalExposure -= ticket.stakePercent;
      }
    }
  }

  // Re-sort by kelly descending for final output
  tickets.sort((a, b) => b.kellyScore - a.kellyScore);

  console.log(`[VA] Built ${tickets.length} tickets from ${legs.length} qualified legs`);

  return tickets;
}
