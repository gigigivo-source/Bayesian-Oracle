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

function hoursBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60);
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
  if (legs.length < 3) return [];

  // Sort legs by EV descending
  const sorted = [...legs].sort((a, b) => b.ev - a.ev);

  const tickets: VaTicket[] = [];
  const usedLegIndices = new Set<number>(); // indices in sorted array that have been used

  // Helper to check if a leg can be added to current ticket
  function canAddToTicket(ticketLegs: VaLeg[], candidate: VaLeg): boolean {
    // One leg per match — no duplicate event_id
    if (ticketLegs.some((l) => l.eventId === candidate.eventId)) return false;
    // No two legs from same stat_family
    if (ticketLegs.some((l) => l.statFamily === candidate.statFamily)) return false;
    // Team uniqueness — no team appears in more than one leg of same ticket
    const candidateTeams = [candidate.homeTeam.toLowerCase(), candidate.awayTeam.toLowerCase()];
    for (const existing of ticketLegs) {
      const existingTeams = [existing.homeTeam.toLowerCase(), existing.awayTeam.toLowerCase()];
      for (const ct of candidateTeams) {
        if (existingTeams.includes(ct)) return false;
      }
    }
    return true;
  }

  function kickoffSpreadOk(ticketLegs: VaLeg[]): boolean {
    if (ticketLegs.length < 2) return true; // need at least 2 to check, but final requirement is at least one leg 3h apart
    // Check if at least one leg is at least 3 hours apart from the others
    // Meaning: max - min >= 3h OR there exists a pair with >=3h gap
    const dates = ticketLegs.map((l) => toDate(l.kickoff));
    for (let i = 0; i < dates.length; i++) {
      for (let j = i + 1; j < dates.length; j++) {
        if (hoursBetween(dates[i], dates[j]) >= 3) return true;
      }
    }
    return false;
  }

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
    const stakePercent = Math.min(0.5 * kellyScore * 100, 2); // as percent, capped at 2%
    // Actually spec says stake_percent = 0.5 * kelly_score, capped at 2%
    // kelly_score is already a fraction, so 0.5*kelly_score is fraction, capped at 0.02 -> as percent 2%
    // We'll store as percent value (e.g. 1.5 means 1.5%)
    return {
      combinedOdds,
      combinedProbability,
      combinedEv,
      kellyScore,
      stakePercent,
    };
  }

  // Main building loop
  let remaining = sorted.filter((_, idx) => !usedLegIndices.has(idx));

  while (remaining.length >= 3) {
    const currentTicket: VaLeg[] = [];

    // Try to fill ticket up to 4 legs
    for (let i = 0; i < sorted.length && currentTicket.length < 4; i++) {
      if (usedLegIndices.has(i)) continue;
      const candidate = sorted[i];
      if (!canAddToTicket(currentTicket, candidate)) continue;

      // Tentatively add and check combined odds constraint
      const tentative = [...currentTicket, candidate];
      const stats = computeTicketStats(tentative);
      if (stats.combinedOdds > 4.5) {
        // If adding would exceed 4.5, skip unless we have less than 3 legs and this is the only option
        // For 3-leg preferred, we want target 3.0-4.5, prefer ~3.5
        // If currentTicket has 2 legs and adding this would exceed 4.5, we still might need to try other candidates
        continue;
      }

      // Add candidate
      currentTicket.push(candidate);
    }

    // Validate ticket
    if (currentTicket.length < 3) {
      // Cannot form valid ticket with remaining legs
      break;
    }

    // Check kickoff spread
    if (!kickoffSpreadOk(currentTicket)) {
      // Try to find replacement that satisfies spread
      // Look for an unused leg that would give spread
      let foundSpread = false;
      for (let i = 0; i < sorted.length; i++) {
        if (usedLegIndices.has(i)) continue;
        if (currentTicket.includes(sorted[i])) continue;
        const candidate = sorted[i];
        // Try replacing each leg in ticket with candidate
        for (let j = 0; j < currentTicket.length; j++) {
          const trial = [...currentTicket];
          trial[j] = candidate;
          // Check constraints for trial
          let valid = true;
          for (let k = 0; k < trial.length; k++) {
            for (let l = k + 1; l < trial.length; l++) {
              if (trial[k].eventId === trial[l].eventId) valid = false;
              if (trial[k].statFamily === trial[l].statFamily) valid = false;
              const teamsK = [trial[k].homeTeam.toLowerCase(), trial[k].awayTeam.toLowerCase()];
              const teamsL = [trial[l].homeTeam.toLowerCase(), trial[l].awayTeam.toLowerCase()];
              if (teamsK.some((t) => teamsL.includes(t))) valid = false;
            }
          }
          if (!valid) continue;
          if (kickoffSpreadOk(trial)) {
            // Accept replacement
            currentTicket[j] = candidate;
            foundSpread = true;
            break;
          }
        }
        if (foundSpread) break;
      }
      if (!foundSpread) {
        // If still no spread, discard this ticket attempt and break to avoid infinite loop
        // Mark current ticket's legs as used? No, we should try different combination
        // For simplicity, if spread fails, we break the outer loop after marking first leg as used to progress
        // But spec says "Kickoff spread — at least one leg must kick off at least 3 hours apart from the others"
        // So we must enforce. If we cannot enforce, we skip this ticket.
        // To avoid deadlock, remove the first leg from remaining and continue.
        const firstIdx = sorted.findIndex((l) => l === currentTicket[0]);
        if (firstIdx !== -1) usedLegIndices.add(firstIdx);
        remaining = sorted.filter((_, idx) => !usedLegIndices.has(idx));
        continue;
      }
    }

    // Compute final stats and check combined odds target 3.0-4.5
    const finalStats = computeTicketStats(currentTicket);
    if (finalStats.combinedOdds < 3.0) {
      // Try to add a 4th leg if under 3.0 and we have space
      if (currentTicket.length === 3) {
        for (let i = 0; i < sorted.length; i++) {
          if (usedLegIndices.has(i)) continue;
          if (currentTicket.includes(sorted[i])) continue;
          const candidate = sorted[i];
          if (!canAddToTicket(currentTicket, candidate)) continue;
          const tentative = [...currentTicket, candidate];
          if (!kickoffSpreadOk(tentative)) continue;
          const tentativeStats = computeTicketStats(tentative);
          if (tentativeStats.combinedOdds >= 3.0 && tentativeStats.combinedOdds <= 4.5) {
            currentTicket.push(candidate);
            break;
          }
        }
      }
      // Recompute after possible 4th leg
      const recomputed = computeTicketStats(currentTicket);
      if (recomputed.combinedOdds < 3.0) {
        // If still below 3.0, discard and mark first leg as used to move forward
        const firstIdx = sorted.findIndex((l) => l === currentTicket[0]);
        if (firstIdx !== -1) usedLegIndices.add(firstIdx);
        remaining = sorted.filter((_, idx) => !usedLegIndices.has(idx));
        continue;
      }
    }

    // Commit ticket
    const committedStats = computeTicketStats(currentTicket);
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
      combinedOdds: committedStats.combinedOdds,
      combinedProbability: committedStats.combinedProbability,
      combinedEv: committedStats.combinedEv,
      kellyScore: committedStats.kellyScore,
      stakePercent: committedStats.stakePercent,
      isRecommended: false,
      isReferenceOnly: false,
    });

    // Mark legs as used
    for (const leg of currentTicket) {
      const idx = sorted.findIndex((l) => l === leg);
      if (idx !== -1) usedLegIndices.add(idx);
    }

    remaining = sorted.filter((_, idx) => !usedLegIndices.has(idx));
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

  return tickets;
}
