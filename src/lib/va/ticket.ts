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

export function buildTickets(legs: VaLeg[], mode: "value" | "stack" = "value"): VaTicket[] {
  if (mode === "stack") {
    return buildStackTickets(legs);
  }
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

  // Helpers for the required constraints
  const hasEventFamilyDup = (ticket: VaLeg[], cand: VaLeg) =>
    ticket.some((l) => l.eventId === cand.eventId && l.statFamily === cand.statFamily);
  const hasEventDup = (ticket: VaLeg[], cand: VaLeg) =>
    ticket.some((l) => l.eventId === cand.eventId);
  const hasFamilyDup = (ticket: VaLeg[], cand: VaLeg) =>
    ticket.some((l) => l.statFamily === cand.statFamily);
  const hasTeamDupDifferentEvent = (ticket: VaLeg[], cand: VaLeg) => {
    const candTeams = [cand.homeTeam.toLowerCase(), cand.awayTeam.toLowerCase()];
    for (const l of ticket) {
      if (l.eventId === cand.eventId) continue; // same event may share teams (different market family)
      const existing = [l.homeTeam.toLowerCase(), l.awayTeam.toLowerCase()];
      if (existing.some((t) => candTeams.includes(t))) return true;
    }
    return false;
  };

  while (remainingCount() >= 3) {
    const currentTicket: VaLeg[] = [];
    let combinedOdds = 1;

    // Greedy fill from sorted EV order
    // Enforces:
    //  - at most 1 leg per eventId per market family (goals, corners, cards) [task]
    //  - at most 1 leg per eventId (distinct events) to guarantee 3 distinct matches
    //  - stat-family diversity (unique family per ticket) [test 4]
    //  - team uniqueness across different events [test 5]
    for (let i = 0; i < sorted.length && currentTicket.length < 4; i++) {
      if (usedLegIndices.has(i)) continue;
      const candidate = sorted[i];
      // Task: at most 1 per eventId per market family
      if (hasEventFamilyDup(currentTicket, candidate)) continue;
      // Distinct eventId enforcement (stricter than task, guarantees 3 distinct events)
      if (hasEventDup(currentTicket, candidate)) continue;
      // Family diversity
      if (hasFamilyDup(currentTicket, candidate)) continue;
      // Team uniqueness across different events
      if (hasTeamDupDifferentEvent(currentTicket, candidate)) continue;

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
    // Fallback: best 3-leg combination respecting:
    // - at most 1 per eventId per family (task)
    // - distinct eventId (at least 3 distinct)
    // - unique family per ticket
    // - team uniqueness across different events
    let bestFallbackLegs: VaLeg[] | null = null;
    let bestFallbackOdds = 0;
    const isValidTriple = (a: VaLeg, b: VaLeg, c: VaLeg): boolean => {
      const arr = [a, b, c];
      // eventId+family uniqueness
      const ef = new Set(arr.map((l) => `${l.eventId}|${l.statFamily}`));
      if (ef.size !== 3) return false;
      // distinct eventId
      const ev = new Set(arr.map((l) => l.eventId));
      if (ev.size !== 3) return false;
      // family diversity
      const fam = new Set(arr.map((l) => l.statFamily));
      if (fam.size !== 3) return false;
      // team uniqueness across different events
      const teamsLower = arr.flatMap((l) => [l.homeTeam.toLowerCase(), l.awayTeam.toLowerCase()]);
      // Since eventIds are distinct, any team overlap is invalid
      if (new Set(teamsLower).size !== teamsLower.length) return false;
      return true;
    };
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].eventId === sorted[i].eventId) continue;
        if (sorted[j].statFamily === sorted[i].statFamily) continue;
        // team overlap check for pair
        {
          const a = sorted[i];
          const b = sorted[j];
          if (a.eventId !== b.eventId) {
            const teamsA = [a.homeTeam.toLowerCase(), a.awayTeam.toLowerCase()];
            const teamsB = [b.homeTeam.toLowerCase(), b.awayTeam.toLowerCase()];
            if (teamsA.some((t) => teamsB.includes(t))) continue;
          }
        }
        for (let k = j + 1; k < sorted.length; k++) {
          const a = sorted[i];
          const b = sorted[j];
          const c = sorted[k];
          if (!isValidTriple(a, b, c)) continue;
          const prod = a.bookmakerOdds * b.bookmakerOdds * c.bookmakerOdds;
          if (prod < 3.0 || prod > 4.5) continue;
          if (prod > bestFallbackOdds) {
            bestFallbackOdds = prod;
            bestFallbackLegs = [a, b, c];
          }
        }
      }
    }

    if (bestFallbackLegs && bestFallbackLegs.length === 3 && bestFallbackOdds >= 3.0) {
      const stats = computeTicketStats(bestFallbackLegs);
      const weekStart = getWeekStartForLegs(bestFallbackLegs);
      const ticketLegs: VaTicketLeg[] = bestFallbackLegs.map((l) => ({
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
        scanId: bestFallbackLegs[0].scanId,
        weekStart,
        legs: ticketLegs,
        combinedOdds: stats.combinedOdds,
        combinedProbability: stats.combinedProbability,
        combinedEv: stats.combinedEv,
        kellyScore: stats.kellyScore,
        stakePercent: stats.stakePercent,
        isRecommended: true,
        isReferenceOnly: false,
      });
    } else {
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

function buildStackTickets(legs: VaLeg[]): VaTicket[] {
  if (legs.length === 0) {
    console.log(`[VA] No ticket built: 0 legs available, best combined odds 0.00`);
    return [];
  }

  const sorted = [...legs].sort((a, b) => b.ev - a.ev);

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
    const stakePercent = Math.min(0.5 * kellyScore * 100, 1.0);
    return {
      combinedOdds,
      combinedProbability,
      combinedEv,
      kellyScore,
      stakePercent,
    };
  }

  function toTicket(ticketLegs: VaLeg[], recommended: boolean): VaTicket {
    const stats = computeTicketStats(ticketLegs);
    const weekStart = getWeekStartForLegs(ticketLegs);
    const mapped: VaTicketLeg[] = ticketLegs.map((l) => ({
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
    return {
      scanId: ticketLegs[0].scanId,
      weekStart,
      legs: mapped,
      combinedOdds: stats.combinedOdds,
      combinedProbability: stats.combinedProbability,
      combinedEv: stats.combinedEv,
      kellyScore: stats.kellyScore,
      stakePercent: stats.stakePercent,
      isRecommended: recommended,
      isReferenceOnly: false,
    };
  }

  const usedLegIndices = new Set<number>();
  const tickets: VaTicket[] = [];

  const remainingCount = () => sorted.filter((_, idx) => !usedLegIndices.has(idx)).length;

  const hasEventFamily = (ticket: VaLeg[], candidate: VaLeg) =>
    ticket.some((l) => l.eventId === candidate.eventId && l.statFamily === candidate.statFamily);

  while (remainingCount() > 0) {
    const currentTicket: VaLeg[] = [];
    let combinedOdds = 1;

    for (let i = 0; i < sorted.length && currentTicket.length < 8; i++) {
      if (usedLegIndices.has(i)) continue;
      const candidate = sorted[i];
      // At most 1 leg per eventId per market family (goals, corners, cards)
      if (hasEventFamily(currentTicket, candidate)) continue;

      const tentative = combinedOdds * candidate.bookmakerOdds;
      if (tentative > 7.5) continue;

      currentTicket.push(candidate);
      combinedOdds = tentative;

      if (currentTicket.length >= 6 && combinedOdds >= 4.5) {
        // Prefer stopping once we are inside the target window, unless we still have room
        // and adding more would stay in range — continue only if below 8.
        if (currentTicket.length >= 8) break;
        // If already in [4.5, 7.5] with 6–7, keep trying extra legs that stay <= 7.5.
      }
    }

    const inWindow =
      currentTicket.length >= 6 &&
      currentTicket.length <= 8 &&
      combinedOdds >= 4.5 &&
      combinedOdds <= 7.5;

    if (!inWindow) {
      break;
    }

    tickets.push(toTicket(currentTicket, false));
    for (const leg of currentTicket) {
      const idx = sorted.findIndex((l) => l === leg);
      if (idx !== -1) usedLegIndices.add(idx);
    }
  }

  if (tickets.length === 0) {
    // Fallback: best valid combo rather than returning [] (PR #117 analogue).
    const bestHolder: { legs: VaLeg[] } = { legs: [] };
    let bestScore = -Infinity;

    const n = Math.min(sorted.length, 12);
    const pool = sorted.slice(0, n);

    function consider(combo: VaLeg[]) {
      if (combo.length === 0 || combo.length > 8) return;
      // At most 1 leg per eventId per market family
      const seen = new Set<string>();
      for (const l of combo) {
        const key = `${l.eventId}|${l.statFamily}`;
        if (seen.has(key)) return;
        seen.add(key);
      }
      const prod = combo.reduce((acc, l) => acc * l.bookmakerOdds, 1);
      const inRange = prod >= 4.5 && prod <= 7.5;
      const sizeScore = combo.length;
      const rangeBonus = inRange ? 1000 : 0;
      const closeness = inRange ? 0 : -Math.min(Math.abs(prod - 4.5), Math.abs(prod - 7.5));
      const score = rangeBonus + sizeScore * 10 + prod + closeness;
      if (score > bestScore) {
        bestScore = score;
        bestHolder.legs = combo;
      }
    }

    // Greedy remaining fill ignoring the 4.5 floor (for short pools).
    const greedy: VaLeg[] = [];
    let gOdds = 1;
    for (const candidate of sorted) {
      if (greedy.length >= 8) break;
      if (greedy.some((l) => l.eventId === candidate.eventId && l.statFamily === candidate.statFamily)) continue;
      const tentative = gOdds * candidate.bookmakerOdds;
      if (tentative > 7.5) continue;
      greedy.push(candidate);
      gOdds = tentative;
    }
    consider(greedy);

    // Bounded search for 4–8 combos from the top pool.
    function rec(start: number, acc: VaLeg[]) {
      consider(acc);
      if (acc.length >= 8) return;
      for (let i = start; i < pool.length; i++) {
        rec(i + 1, [...acc, pool[i]]);
      }
    }
    rec(0, []);

    if (bestHolder.legs.length > 0) {
      tickets.push(toTicket(bestHolder.legs, true));
    } else {
      console.log(`[VA] No ticket built: ${legs.length} legs available, best combined odds 0.00`);
      return [];
    }
  }

  tickets.sort((a, b) => b.kellyScore - a.kellyScore);
  if (tickets.length > 0) {
    tickets[0].isRecommended = true;
  }

  let totalExposure = tickets.reduce((sum, t) => sum + t.stakePercent, 0);
  if (totalExposure > 6) {
    const sortedByKellyAsc = [...tickets].sort((a, b) => a.kellyScore - b.kellyScore);
    for (const ticket of sortedByKellyAsc) {
      if (ticket.isRecommended) continue;
      if (totalExposure <= 6) break;
      if (!ticket.isReferenceOnly) {
        ticket.isReferenceOnly = true;
        totalExposure -= ticket.stakePercent;
      }
    }
  }

  tickets.sort((a, b) => b.kellyScore - a.kellyScore);
  console.log(`[VA] Built ${tickets.length} tickets from ${legs.length} qualified legs`);
  return tickets;
}
