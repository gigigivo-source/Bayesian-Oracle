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
  /**
   * Product of per-leg model probabilities, assuming legs are independent.
   * Identical to `combinedProbability` today; kept as a separate field so the
   * independence assumption stays explicit if the combined figure ever becomes
   * correlation-aware.
   */
  independentProbability: number;
  /**
   * Alias of `combinedProbability`, populated identically today so the ticket
   * output shape does not change.
   */
  effectiveProbability: number;
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

/**
 * FAMILY CAP: at most this many legs from the same statFamily in one ticket.
 * Applied by the ticket assembler only — the leg pool is untouched.
 */
const FAMILY_CAP = 2;

function familyCapExceeded(legs: VaLeg[]): boolean {
  const counts = new Map<string, number>();
  for (const leg of legs) {
    counts.set(leg.statFamily, (counts.get(leg.statFamily) ?? 0) + 1);
  }
  return Array.from(counts.values()).some((n) => n > FAMILY_CAP);
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
  const seenTicketKeys = new Set<string>();
  // NEW: per-leg appearance cap — no single leg may appear in more than 2
  // tickets, so cross-ticket reuse stays controlled even with the old
  // per-leg exclusivity removed.
  const appearanceCount = new Map<VaLeg, number>();

  function computeTicketStats(ticketLegs: VaLeg[]): {
    combinedOdds: number;
    combinedProbability: number;
    combinedEv: number;
    independentProbability: number;
    effectiveProbability: number;
    kellyScore: number;
    stakePercent: number;
  } {
    const combinedOdds = ticketLegs.reduce((acc, l) => acc * l.bookmakerOdds, 1);
    const combinedProbability = ticketLegs.reduce((acc, l) => acc * l.modelProbability, 1);
    const combinedEv = combinedProbability * combinedOdds - 1;
    // Independence product of per-leg model probabilities (same maths as combinedProbability).
    const independentProbability = ticketLegs.reduce((acc, l) => acc * l.modelProbability, 1);
    // Alias of combinedProbability for now — identical value, no behavioural change.
    const effectiveProbability = combinedProbability;
    const kellyScore = combinedOdds > 1 ? combinedEv / (combinedOdds - 1) : 0;
    const stakePercent = Math.min(0.5 * kellyScore * 100, 2);
    return {
      combinedOdds,
      combinedProbability,
      combinedEv,
      independentProbability,
      effectiveProbability,
      kellyScore,
      stakePercent,
    };
  }

  let bestCombinedOdds = 0;

  const commitTicket = (ticketLegs: VaLeg[], recommended: boolean): boolean => {
    const key = Array.from(new Set(ticketLegs.map((l) => l.eventId)))
      .sort()
      .join("|");
    if (seenTicketKeys.has(key)) return false; // duplicate: same set of eventIds already built
    seenTicketKeys.add(key);

    const stats = computeTicketStats(ticketLegs);
    if (stats.combinedOdds > bestCombinedOdds) bestCombinedOdds = stats.combinedOdds;
    const weekStart = getWeekStartForLegs(ticketLegs);

    const ticketLegsOut: VaTicketLeg[] = ticketLegs.map((l) => ({
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
      scanId: ticketLegs[0].scanId,
      weekStart,
      legs: ticketLegsOut,
      combinedOdds: stats.combinedOdds,
      combinedProbability: stats.combinedProbability,
      combinedEv: stats.combinedEv,
      independentProbability: stats.independentProbability,
      effectiveProbability: stats.effectiveProbability,
      kellyScore: stats.kellyScore,
      stakePercent: stats.stakePercent,
      isRecommended: recommended,
      isReferenceOnly: false,
    });

    // Controlled reuse: bump each leg's appearance count; a leg is skipped by
    // later tickets once it has already been used in 2 tickets.
    for (const leg of ticketLegs) {
      appearanceCount.set(leg, (appearanceCount.get(leg) ?? 0) + 1);
    }
    return true;
  };

  // Seed-driven, multi-ticket assembly: iterate the top N legs (N = 12); each
  // seed starts a ticket and greedily adds other legs subject to the existing
  // constraints (distinct eventId per leg, ≤2 legs per family, odds window,
  // family/direction caps). Tickets are covered by the per-leg appearance cap
  // instead of the removed per-leg exclusivity, so legs can be shared across at
  // most 2 tickets.
  const SEED_COUNT = Math.min(sorted.length, 12);
  for (let seedIdx = 0; seedIdx < SEED_COUNT && tickets.length < 5; seedIdx++) {
    const seed = sorted[seedIdx];
    if ((appearanceCount.get(seed) ?? 0) >= 2) continue; // leg already at its 2-ticket cap
    const currentTicket: VaLeg[] = [seed];
    let combinedOdds = seed.bookmakerOdds;

    for (let i = 0; i < sorted.length && currentTicket.length < 4; i++) {
      if (i === seedIdx) continue;
      const candidate = sorted[i];
      if ((appearanceCount.get(candidate) ?? 0) >= 2) continue; // appear in ≤2 tickets total
      if (currentTicket.some((l) => l.eventId === candidate.eventId)) continue;
      // FAMILY CAP: at most 2 legs from the same statFamily in one ticket.
      if (currentTicket.filter((l) => l.statFamily === candidate.statFamily).length >= FAMILY_CAP) continue;

      const tentative = combinedOdds * candidate.bookmakerOdds;
      if (tentative > 4.5) continue;

      currentTicket.push(candidate);
      combinedOdds = tentative;

      if (currentTicket.length === 3 && combinedOdds >= 3.0) break;
      if (currentTicket.length === 4) break;
    }

    if (currentTicket.length < 3) continue; // seed could not grow into a valid ticket

    const stats = computeTicketStats(currentTicket);
    if (stats.combinedOdds < 3.0 || stats.combinedOdds > 4.5) continue; // outside odds window

    commitTicket(currentTicket, false);
  }

  if (tickets.length === 0) {
    // Fallback: best 3-leg combination across distinct events (product in 3.0–4.5)
    let bestFallbackLegs: VaLeg[] | null = null;
    let bestFallbackOdds = 0;
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].eventId === sorted[i].eventId) continue;
        for (let k = j + 1; k < sorted.length; k++) {
          const a = sorted[i];
          const b = sorted[j];
          const c = sorted[k];
          if (c.eventId === a.eventId || c.eventId === b.eventId) continue;
          if (familyCapExceeded([a, b, c])) continue; // FAMILY CAP
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
      // The fallback names the best achievable combination (marked recommended);
      // dedupe and the appearance cap still go through the shared commit path.
      commitTicket(bestFallbackLegs, true);
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
    independentProbability: number;
    effectiveProbability: number;
    kellyScore: number;
    stakePercent: number;
  } {
    const combinedOdds = ticketLegs.reduce((acc, l) => acc * l.bookmakerOdds, 1);
    const combinedProbability = ticketLegs.reduce((acc, l) => acc * l.modelProbability, 1);
    const combinedEv = combinedProbability * combinedOdds - 1;
    // Independence product of per-leg model probabilities (same maths as combinedProbability).
    const independentProbability = ticketLegs.reduce((acc, l) => acc * l.modelProbability, 1);
    // Alias of combinedProbability for now — identical value, no behavioural change.
    const effectiveProbability = combinedProbability;
    const kellyScore = combinedOdds > 1 ? combinedEv / (combinedOdds - 1) : 0;
    const stakePercent = Math.min(0.5 * kellyScore * 100, 1.0);
    return {
      combinedOdds,
      combinedProbability,
      combinedEv,
      independentProbability,
      effectiveProbability,
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
      independentProbability: stats.independentProbability,
      effectiveProbability: stats.effectiveProbability,
      kellyScore: stats.kellyScore,
      stakePercent: stats.stakePercent,
      isRecommended: recommended,
      isReferenceOnly: false,
    };
  }

  const usedStackIndices = new Set<number>();
  const tickets: VaTicket[] = [];

  const remainingStackCount = () => sorted.filter((_, idx) => !usedStackIndices.has(idx)).length;

  // Stack-mode shape rule: at most 1 leg per (eventId, statFamily) pair.
  const pairSeen = (ticket: VaLeg[], leg: VaLeg) =>
    ticket.some((l) => l.eventId === leg.eventId && l.statFamily === leg.statFamily);

  while (remainingStackCount() > 0) {
    const currentTicket: VaLeg[] = [];
    let combinedOdds = 1;

    for (let i = 0; i < sorted.length && currentTicket.length < 8; i++) {
      if (usedStackIndices.has(i)) continue;
      const candidate = sorted[i];
      if (pairSeen(currentTicket, candidate)) continue;
      // FAMILY CAP: at most 2 legs from the same statFamily in one ticket.
      if (currentTicket.filter((l) => l.statFamily === candidate.statFamily).length >= FAMILY_CAP) continue;

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
      if (idx !== -1) usedStackIndices.add(idx);
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
      const pairs = new Set<string>();
      for (const l of combo) {
        const key = `${l.eventId}|${l.statFamily}`;
        if (pairs.has(key)) return; // at most 1 leg per (eventId, statFamily) pair
        pairs.add(key);
      }
      if (familyCapExceeded(combo)) return; // FAMILY CAP
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
      if (pairSeen(greedy, candidate)) continue;
      if (greedy.filter((l) => l.statFamily === candidate.statFamily).length >= FAMILY_CAP) continue; // FAMILY CAP
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
