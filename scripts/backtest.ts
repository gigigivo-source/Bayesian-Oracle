// scripts/backtest.ts
import { db } from '../src/db';
import { sql } from 'drizzle-orm';
import { runOracle } from '../src/lib/engine/oracle';
import { evaluateLeg } from '../src/lib/settlement/evaluate';

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

async function getFinishedFixtures(limit: number) {
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
  return result.rows;
}

async function backtest(limit: number = 50) {
  console.log(`🔍 Backtesting last ${limit} finished matches...`);

  const fixtures = await getFinishedFixtures(limit);
  if (!fixtures || fixtures.length === 0) {
    console.log('❌ No finished fixtures found.');
    return;
  }
  console.log(`📋 Found ${fixtures.length} fixtures.\n`);

  let total = 0, wins = 0, losses = 0, pushes = 0, voids = 0;
  let skipped = 0;

  for (const f of fixtures) {
    const prediction = await runOracle({
      leagueSlug: f.league_slug,
      eventId: f.event_id,
      homeTeam: f.home_team,
      awayTeam: f.away_team
    });
    const topPick = prediction?.top1;

    if (!topPick) {
      skipped++;
      continue;
    }

    const outcome = evaluateLeg({
      market: topPick.market,
      outcome: topPick.outcome,
      homeScore: f.home_score,
      awayScore: f.away_score
    });

    total++;
    if (outcome === 'win') wins++;
    else if (outcome === 'loss') losses++;
    else if (outcome === 'push') pushes++;
    else if (outcome === 'void') voids++;
  }

  console.log('\n📊 Backtest Summary:');
  console.log(`Total Evaluated: ${total}`);
  console.log(`Skipped (No Pick): ${skipped}`);
  console.log(`Wins: ${wins} (${total > 0 ? (wins/total*100).toFixed(1) : 0}%)`);
  console.log(`Losses: ${losses} (${total > 0 ? (losses/total*100).toFixed(1) : 0}%)`);
  console.log(`Pushes: ${pushes} (${total > 0 ? (pushes/total*100).toFixed(1) : 0}%)`);
  console.log(`Voids: ${voids} (${total > 0 ? (voids/total*100).toFixed(1) : 0}%)`);
}

const limit = parseInt(process.argv[2]) || 50;
backtest(limit).catch(console.error);
