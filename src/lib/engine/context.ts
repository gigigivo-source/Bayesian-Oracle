// ĞIGI GIVØ — L0/L1/L3 context: team profiles, venue, weather, referee, injuries.
import { hashString, seededRng, clamp } from "./stats";
import type { LockedMatchObject, PredictInput } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TeamProfile {
  name:        string;
  attack:      number; // ~1.0..2.4 expected goals baseline
  defense:     number; // 0.7..1.6 goals conceded factor
  discipline:  number; // cards tendency 1.4..3.2
  pressing:    number; // 0.8..1.4
  possession:  number; // 0.35..0.65 share
  aerial:      number; // 0.8..1.3
  form:        number; // -0.15..+0.15 momentum
  eloish:      number; // 1400..2000
}

// ─── Internal constants ───────────────────────────────────────────────────────

const REFEREES = [
  "M. Oliver",
  "D. Orsato",
  "S. Marciniak",
  "C. Turpin",
  "A. Taylor",
  "F. Zwayer",
  "I. Kovács",
  "J. Gil Manzano",
  "W. Kruzliak",
  "B. Dabanovic",
];

const WEATHER = [
  "Clear, 18°C, wind 8km/h",
  "Partly cloudy, 22°C, wind 12km/h",
  "Light rain, 15°C, wind 18km/h",
  "Heavy rain, 12°C, wind 24km/h",
  "Windy, 16°C, wind 34km/h",
  "Extreme heat, 33°C, wind 6km/h",
  "Overcast, 14°C, wind 10km/h",
];

const INJURY_POOL = [
  "Star striker doubtful (65% likely)",
  "Key playmaker out (confirmed)",
  "First-choice keeper doubtful (70% likely)",
  "Central defender suspended (confirmed)",
  "Winger returning from injury (fresh)",
  "No significant absences reported",
  "Captain rested (rotation risk)",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function profileFromName(name: string): TeamProfile {
  const seed    = hashString(name.toLowerCase().trim());
  const r       = seededRng(seed);
  const attack  = 0.95 + r() * 1.45;
  const defense = 0.70 + r() * 0.90;
  const eloish  = 1400 + Math.round((attack * 1.6 - defense + (0.85 + r() * 0.55)) * 180);
  return {
    name,
    attack,
    defense,
    discipline: 1.40 + r() * 1.80,
    pressing:   0.85 + r() * 0.55,
    possession: 0.40 + r() * 0.25,
    aerial:     0.85 + r() * 0.45,
    form:       (r() - 0.5) * 0.30,
    eloish:     clamp(eloish, 1380, 2050),
  };
}

function stageFor(league: string, r: () => number): string {
  const l = league.toUpperCase();
  if (l.includes("WORLD CUP") || l.includes("CUP")) {
    const stages = [
      "Group Stage",
      "Round of 32",
      "Round of 16",
      "Quarter-Final",
      "Semi-Final",
      "Final",
    ];
    return stages[Math.floor(r() * stages.length)];
  }
  return "League Match";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a fully enriched match context object from a PredictInput.
 * All values are derived deterministically from the fixture string + date,
 * so the same input always produces the same context (reproducible oracle runs).
 */
export function buildMatchContext(input: PredictInput): {
  match: LockedMatchObject;
  home:  TeamProfile;
  away:  TeamProfile;
} {
  const parts    = input.match.split(/\s+vs\s+/i);
  const homeName = (parts[0] ?? "Home").trim();
  const awayName = (parts[1] ?? "Away").trim();

  const seed = hashString(`${input.match}|${input.league}|${input.date}`);
  const r    = seededRng(seed);

  const home  = profileFromName(homeName);
  const away  = profileFromName(awayName);
  const stage = stageFor(input.league, r);

  const neutral =
    stage === "Final" ||
    stage === "Semi-Final" ||
    input.league.toUpperCase().includes("WORLD CUP");

  const completeness = Math.round(55 + r() * 44);
  const fallback     = completeness < 50;

  const injuries: string[] = [];
  const nInj = Math.floor(r() * 3);
  for (let i = 0; i < nInj; i++) {
    injuries.push(INJURY_POOL[Math.floor(r() * INJURY_POOL.length)]);
  }
  if (injuries.length === 0) injuries.push("No significant absences reported");

  const hourUtc = 12 + Math.floor(r() * 8);

  const match: LockedMatchObject = {
    homeTeam:              homeName,
    awayTeam:              awayName,
    venue:                 neutral ? "Neutral Venue" : `${homeName} Stadium`,
    venueType:             neutral ? "NEUTRAL" : "HOME",
    date:                  input.date,
    timeUtc:               `${String(hourUtc).padStart(2, "0")}:00 UTC`,
    tournamentStage:       stage,
    refereeName:           REFEREES[Math.floor(r() * REFEREES.length)],
    weatherForecast:       WEATHER[Math.floor(r() * WEATHER.length)],
    keyInjuryFlags:        injuries,
    dataCompletenessScore: completeness,
    fallbackMode:          fallback,
  };

  return { match, home, away };
}
