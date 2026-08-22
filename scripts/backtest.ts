// scripts/backtest.ts
import { db } from '../src/db';
import { sql } from 'drizzle-orm';
import { runOracle } from '../src/lib/engine/oracle';
import { evaluateLeg, type LegOutcome, type MatchResult } from '../src/lib/settlement/evaluate';
import type { FixtureLite } from '../src/lib/espn';

// --- CONFIGURE THESE TO MATCH YOUR SCHEMA ---
const TABLE = 'predictions';
const COL_HOME_TEAM = 'home_team';
const COL_AWAY_TEAM = 'away_team';
const COL_LEAGUE = 'league_slug';
const COL_EVENT = 'event_id';
const COL_HOME_SCORE = 'home_score';
const COL_AWAY_SCORE = 'away_score';
const COL_DATE = 'date';
// --------------------------------------------

interface FixtureRow {
  leagueSlug: string;
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  date: string;
}

function parseRow(row: Record<string, unknown>): FixtureRow | null {
  const leagueSlug = row[COL_LEAGUE];
  const eventId = row[COL_EVENT];
  const homeTeam = row[COL_HOME_TEAM];
  const awayTeam = row[COL_AWAY_TEAM];
  const homeScore = Number(row[COL_HOME_SCORE]);
  const awayScore = Number(row[COL_AWAY_SCORE]);
  const date = row[COL_DATE];
  if (
    typeof leagueSlug !== 'string' || typeof homeTeam !== 'string' ||
    typeof awayTeam !== 'string' || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)
  ) {
    return null;
  }
  return {
    leagueSlug,
    eventId: String(eventId ?? ''),
    homeTeam,
    awayTeam,
    homeScore,
    awayScore,
    date: date instanceof Date ? date.toISOString() : String(date ?? ''),
  };
}

async function getFinishedFixtures(limit: number): Promise<FixtureRow[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT
      ${sql.identifier(COL_LEAGUE)},
      ${sql.identifier(COL_EVENT)},
      ${sql.identifier(COL_HOME_TEAM)},
      ${sql.identifier(COL_AWAY_TEAM)},
      ${sql.identifier(COL_HOME_SCORE)},
      ${sql.identifier(COL_AWAY_SCORE)},
      ${sql.identifier(COL_DATE)}
    FROM ${sql.identifier(TABLE)}
    WHERE 
      ${sql.identifier(COL_HOME_SCORE)} IS NOT NULL 
      AND ${sql.identifier(COL_AWAY_SCORE)} IS NOT NULL
    ORDER BY ${sql.identifier(COL_DATE)} DESC
    LIMIT ${limit}
  `);
  return result.rows
    .map((row) => parseRow(row as Record<string, unknown>))
    .filter((row): row is FixtureRow => row !== null);
}

/** Build a pre-match FixtureLite so the oracle predicts blind — the final
 * score must never leak into the prediction being backtested. */
function fixtureFrom(f: FixtureRow): FixtureLite {
  return {
    id: f.eventId,
    leagueSlug: f.leagueSlug,
    leagueName: f.leagueSlug,
    date: f.date,
    state: 'pre',
    statusDetail: 'Scheduled',
    venue: null,
    neutralSite: false,
    home: {
      id: '', name: f.homeTeam, shortName: f.homeTeam, abbrev: f.homeTeam.slice(0, 3),
      logo: null, color: null, score: null, homeAway: 'home',
    },
    away: {
      id: '', name: f.awayTeam, shortName: f.awayTeam, abbrev: f.awayTeam.slice(0, 3),
      logo: null, color: null, score: null, homeAway: 'away',
    },
    odds: null,
  };
}

async function backtest(limit: number = 50) {
  console.log(`🔍 Backtesting last ${limit} finished matches...`);

  const fixtures = await getFinishedFixtures(limit);
  if (!fixtures || fixtures.length === 0) {
    console.log('❌ No finished fixtures found.');
    return;
  }
  console.log(`📋 Found ${fixtures.length} fixtures.\n`);

  let total = 0, wins = 0, losses = 0, voids = 0, pending = 0;
  let skipped = 0;

  for (const f of fixtures) {
    const prediction = runOracle(fixtureFrom(f));
    const topPick = prediction.top1[0];

    if (!topPick) {
      skipped++;
      continue;
    }

    const result: MatchResult = {
      eventId: f.eventId,
      leagueSlug: f.leagueSlug,
      date: f.date,
      homeName: f.homeTeam,
      awayName: f.awayTeam,
      homeScore: f.homeScore,
      awayScore: f.awayScore,
    };

    const outcome: LegOutcome = evaluateLeg(
      { marketName: topPick.name, selection: topPick.selection },
      result,
    );

    total++;
    if (outcome === 'won') wins++;
    else if (outcome === 'lost') losses++;
    else if (outcome === 'void') voids++;
    else pending++;
  }

  console.log('\n📊 Backtest Summary:');
  console.log(`Total Evaluated: ${total}`);
  console.log(`Skipped (No Pick): ${skipped}`);
  console.log(`Wins: ${wins} (${total > 0 ? (wins/total*100).toFixed(1) : 0}%)`);
  console.log(`Losses: ${losses} (${total > 0 ? (losses/total*100).toFixed(1) : 0}%)`);
  console.log(`Voids: ${voids} (${total > 0 ? (voids/total*100).toFixed(1) : 0}%)`);
  console.log(`Pending: ${pending} (${total > 0 ? (pending/total*100).toFixed(1) : 0}%)`);
}

const limit = parseInt(process.argv[2]) || 50;
backtest(limit).catch(console.error);
