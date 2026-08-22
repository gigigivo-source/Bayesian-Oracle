// scripts/backtest.ts
import { db } from "../src/db";
import { sql } from "drizzle-orm";
import { runOracle } from "../src/lib/engine/oracle";
import { evaluateLeg } from "../src/lib/settlement/evaluate";
import type { FixtureLite, TeamLite } from "../src/lib/espn";

const TABLE = "predictions";
const COL_HOME_TEAM = "home_team";
const COL_AWAY_TEAM = "away_team";
const COL_LEAGUE = "league_slug";
const COL_EVENT = "event_id";
const COL_HOME_SCORE = "home_score";
const COL_AWAY_SCORE = "away_score";
const COL_DATE = "date";

interface FinishedFixtureRow {
  league_slug: string;
  event_id: string;
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
  date: string | Date;
}

async function getFinishedFixtures(limit: number): Promise<FinishedFixtureRow[]> {
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
  return result.rows as unknown as FinishedFixtureRow[];
}

function team(name: string, score: number, homeAway: "home" | "away"): TeamLite {
  return {
    id: name,
    name,
    shortName: name,
    abbrev: name.slice(0, 3).toUpperCase(),
    logo: null,
    color: null,
    score: String(score),
    homeAway,
  };
}

function toFixture(row: FinishedFixtureRow): FixtureLite {
  return {
    id: row.event_id,
    leagueSlug: row.league_slug,
    leagueName: row.league_slug,
    date: new Date(row.date).toISOString(),
    state: "post",
    statusDetail: "Full Time",
    venue: null,
    home: team(row.home_team, row.home_score, "home"),
    away: team(row.away_team, row.away_score, "away"),
    neutralSite: false,
  };
}

async function backtest(limit = 50) {
  console.log(`🔍 Backtesting last ${limit} finished matches...`);

  const fixtures = await getFinishedFixtures(limit);
  if (fixtures.length === 0) {
    console.log("❌ No finished fixtures found.");
    return;
  }
  console.log(`📋 Found ${fixtures.length} fixtures.\n`);

  let total = 0, wins = 0, losses = 0, voids = 0, pending = 0;
  let skipped = 0;

  for (const row of fixtures) {
    const fixture = toFixture(row);
    const prediction = runOracle(fixture);
    const topPick = prediction.top1[0];

    if (!topPick) {
      skipped++;
      continue;
    }

    const outcome = evaluateLeg(
      { marketName: topPick.name, selection: topPick.selection },
      {
        eventId: fixture.id,
        leagueSlug: fixture.leagueSlug,
        date: fixture.date,
        homeName: fixture.home.name,
        awayName: fixture.away.name,
        homeScore: row.home_score,
        awayScore: row.away_score,
      },
    );

    total++;
    if (outcome === "won") wins++;
    else if (outcome === "lost") losses++;
    else if (outcome === "void") voids++;
    else pending++;
  }

  console.log("\n📊 Backtest Summary:");
  console.log(`Total Evaluated: ${total}`);
  console.log(`Skipped (No Pick): ${skipped}`);
  console.log(`Wins: ${wins} (${total > 0 ? (wins / total * 100).toFixed(1) : 0}%)`);
  console.log(`Losses: ${losses} (${total > 0 ? (losses / total * 100).toFixed(1) : 0}%)`);
  console.log(`Voids: ${voids} (${total > 0 ? (voids / total * 100).toFixed(1) : 0}%)`);
  console.log(`Pending: ${pending} (${total > 0 ? (pending / total * 100).toFixed(1) : 0}%)`);
}

const limit = parseInt(process.argv[2], 10) || 50;
backtest(limit).catch(console.error);
