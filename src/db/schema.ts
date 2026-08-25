import {
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  real,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Suppress unused-import warning
void (boolean as unknown);

// ─── Error monitoring ─────────────────────────────────────────────────────────
// Captured runtime errors + health events (Sentry-style, self-hosted).
// Read via /api/monitoring.
// ─── Referee Stats (empirical cards-per-game rate by referee name) ────────────
export const refereeStats = pgTable("referee_stats", {
  id:               serial("id").primaryKey(),
  name:             text("name").notNull().unique(),
  cardsPerGame:     real("cards_per_game").notNull().default(3.5),
  foulsPerGame:     real("fouls_per_game").notNull().default(21.0),
  penaltiesPerGame: real("penalties_per_game").notNull().default(0.27),
  redCardRate:      real("red_card_rate").notNull().default(0.08),
  strictness:       real("strictness").notNull().default(1.0), // vs league avg
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});

export const errorLog = pgTable("error_log", {
  id:        serial("id").primaryKey(),
  level:     text("level").notNull().default("error"), // error | warn | info
  source:    text("source").notNull(),                 // route / module that threw
  message:   text("message").notNull(),
  stack:     text("stack"),
  context:   jsonb("context"),                         // arbitrary metadata
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Daily Picks ──────────────────────────────────────────────────────────────
// Records each day's published picks so outcomes can be settled and reported.
export const dailyPicks = pgTable("daily_picks", {
  id:         serial("id").primaryKey(),
  pickDate:   text("pick_date").notNull(),  // YYYY-MM-DD
  match:      text("match").notNull(),
  league:     text("league").notNull(),
  leagueSlug: text("league_slug"),
  eventId:    text("event_id"),
  picks:      jsonb("picks").notNull(),     // top3 [{name, selection, hitRate, outcome}]
  hits:       integer("hits").notNull().default(0),
  misses:     integer("misses").notNull().default(0),
  pending:    integer("pending").notNull().default(0),
  status:     text("status").notNull().default("pending"), // pending | settled
  createdAt:  timestamp("created_at").defaultNow().notNull(),
});

// ─── Team Profiles ────────────────────────────────────────────────────────────
// Cached real per-team stat profiles (multi-provider data mesh).
// TTL-checked on read — avoids re-fetching ESPN on every prediction.
export const teamProfiles = pgTable("team_profiles", {
  id:        serial("id").primaryKey(),
  teamKey:   text("team_key").notNull(),    // normalised "slug|teamname"
  profile:   jsonb("profile").notNull(),    // full MeshProfile
  providers: jsonb("providers").notNull(),  // string[] of contributing sources
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Predictions ──────────────────────────────────────────────────────────────
// Stored ĞIGI GIVØ prediction runs (learning log).
export const predictions = pgTable("predictions", {
  id:               serial("id").primaryKey(),
  matchLabel:       text("match_label").notNull(),
  homeTeam:         text("home_team").notNull(),
  awayTeam:         text("away_team").notNull(),
  league:           text("league").notNull(),
  matchDate:        text("match_date").notNull(),
  leagueSlug:       text("league_slug"),
  eventId:          text("event_id"),
  tournamentStage:  text("tournament_stage").notNull(),
  topPick:          text("top_pick").notNull(),
  topHitRate:       real("top_hit_rate").notNull(),
  totalMarkets:     integer("total_markets").notNull(),
  qualifiedMarkets: integer("qualified_markets").notNull(),
  dataCompleteness: integer("data_completeness").notNull(),
  result:           jsonb("result").notNull(),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
});

export type PredictionRow = typeof predictions.$inferSelect;
export type NewPrediction  = typeof predictions.$inferInsert;

// ─── Performance Log ──────────────────────────────────────────────────────────
// Records every post-match Top-10 verification result.
export const performanceLog = pgTable("performance_log", {
  id:              serial("id").primaryKey(),
  eventId:         text("event_id").notNull(),
  matchLabel:      text("match_label").notNull(),
  homeTeam:        text("home_team").notNull(),
  awayTeam:        text("away_team").notNull(),
  league:          text("league").notNull(),
  leagueSlug:      text("league_slug"),
  competitionName: text("competition_name"),         // human-readable, e.g. "Premier League"
  matchDate:       text("match_date").notNull(),
  homeScore:       integer("home_score").notNull(),
  awayScore:       integer("away_score").notNull(),
  totalPicks:      integer("total_picks").notNull(),
  hits:            integer("hits").notNull(),
  misses:          integer("misses").notNull(),
  pending:         integer("pending").notNull(),
  accuracy:        real("accuracy").notNull(),       // hits / (hits+misses)
  top10Detail:     jsonb("top10_detail").notNull(),  // full top10 with outcomes
  lowConfidence:   boolean("low_confidence").notNull().default(false), // confidence gate flag
  rankingMode:     text("ranking_mode").notNull().default("B"),
  // ── Sure Bet Corners (rankingMode = 'S') verification fields ──────────────
  // One row per sure-bet corner pick. `outcome` drives the post-match
  // verification chip (/api/sure-corners/verify): 'pending' rows are
  // evaluated once the match finishes and stamped with WIN | LOSS | PUSH |
  // VOID plus `settledAt`. The remaining columns are nullable so rows
  // written by the other writers (modes A–D) are unaffected.
  market:          text("market"),                    // e.g. "Total Corners O/U 9.5"
  selection:       text("selection"),                 // e.g. "Over 9.5"
  outcome:         text("outcome").default("pending"),// pending | WIN | LOSS | PUSH | VOID
  hitRate:         real("hit_rate"),                  // predicted hit rate at pick time
  confidence:      text("confidence"),                // "HIGH" for sure-bet picks
  settledAt:       timestamp("settled_at"),           // set when the pick is verified
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});

export type PerformanceRow = typeof performanceLog.$inferSelect;
export type NewPerformance  = typeof performanceLog.$inferInsert;

// ─── User Settings ────────────────────────────────────────────────────────────
export const userSettings = pgTable("user_settings", {
  id:          serial("id").primaryKey(),
  pin:         text("pin").notNull(),
  displayName: text("display_name"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
});

// ─── Bankroll ─────────────────────────────────────────────────────────────────
export const bankroll = pgTable("bankroll", {
  id:          serial("id").primaryKey(),
  type:        text("type").notNull(),        // deposit | withdraw | bet | win
  amount:      real("amount").notNull(),      // positive = in, negative = out
  balance:     real("balance").notNull(),     // running balance after this entry
  description: text("description").notNull(),
  matchLabel:  text("match_label"),
  odds:        real("odds"),
  stake:       real("stake"),
  profit:      real("profit"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
});

export type BankrollRow = typeof bankroll.$inferSelect;

// ─── Accumulator Slips ────────────────────────────────────────────────────────
// ─── Value Bet Tracking ───────────────────────────────────────────────────────
export const valueBetLog = pgTable("value_bet_log", {
  id:              serial("id").primaryKey(),
  eventId:         text("event_id").notNull(),
  leagueSlug:      text("league_slug").notNull(),
  competitionName: text("competition_name"),     // human-readable, e.g. "La Liga"
  match:           text("match").notNull(),
  matchDate:       text("match_date").notNull(),
  marketName:      text("market_name").notNull(),
  selection:       text("selection").notNull(),
  oracleProb:      real("oracle_prob").notNull(),
  bookOdds:        real("book_odds").notNull(),
  valueEdge:       real("value_edge").notNull(),
  kellyStake:      real("kelly_stake").notNull().default(0),
  stake:           real("stake").notNull().default(10),
  potentialReturn: real("potential_return").notNull().default(0),
  outcome:         text("outcome").notNull().default("pending"), // pending | won | lost | void
  actualReturn:    real("actual_return"),
  pnl:             real("pnl"),
  lowConfidence:   boolean("low_confidence").notNull().default(false), // confidence gate flag
  rankingMode:     text("ranking_mode").notNull().default("B"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});

export const savedSlips = pgTable("saved_slips", {
  id:              serial("id").primaryKey(),
  name:            text("name").notNull(),
  slipType:        text("slip_type").notNull(),  // highhit | value
  leagueSlug:      text("league_slug"),
  competitionName: text("competition_name"),     // human-readable, e.g. "Champions League"
  picks:           jsonb("picks").notNull(),
  combinedOdds:    real("combined_odds").notNull(),
  combinedProb:    real("combined_prob").notNull(),
  stake:           real("stake"),
  status:          text("status").notNull(),     // pending | won | lost
  /** Ranking mode the slip was generated from. Nullable for slips saved before
   *  the column existed — the modes API falls back to `picks[0].rankingMode`. */
  rankingMode:     text("ranking_mode"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
});

// ─── Settlement performance ──────────────────────────────────────────────────
// Immutable, idempotent audit records written when each tracked product settles.
export const accumulatorPerformance = pgTable("accumulator_performance", {
  id:           serial("id").primaryKey(),
  slipId:       integer("slip_id").notNull(),
  name:         text("name").notNull(),
  slipType:     text("slip_type").notNull(),
  totalLegs:    integer("total_legs").notNull(),
  wonLegs:      integer("won_legs").notNull(),
  lostLegs:     integer("lost_legs").notNull(),
  voidLegs:     integer("void_legs").notNull().default(0),
  combinedOdds: real("combined_odds").notNull(),
  stake:        real("stake").notNull().default(0),
  status:       text("status").notNull(),
  returnAmount: real("return_amount").notNull().default(0),
  pnl:          real("pnl").notNull().default(0),
  legResults:   jsonb("leg_results").notNull(),
  settledAt:    timestamp("settled_at").defaultNow().notNull(),
}, (table) => [uniqueIndex("accumulator_performance_slip_id_uidx").on(table.slipId)]);

export const dailyPickPerformance = pgTable("daily_pick_performance", {
  id:          serial("id").primaryKey(),
  dailyPickId: integer("daily_pick_id").notNull(),
  pickDate:    text("pick_date").notNull(),
  eventId:     text("event_id"),
  match:       text("match").notNull(),
  league:      text("league").notNull(),
  totalPicks:  integer("total_picks").notNull(),
  hits:        integer("hits").notNull(),
  misses:      integer("misses").notNull(),
  voids:       integer("voids").notNull().default(0),
  accuracy:    real("accuracy").notNull(),
  homeScore:   integer("home_score").notNull(),
  awayScore:   integer("away_score").notNull(),
  pickResults: jsonb("pick_results").notNull(),
  settledAt:   timestamp("settled_at").defaultNow().notNull(),
}, (table) => [uniqueIndex("daily_pick_performance_daily_pick_id_uidx").on(table.dailyPickId)]);

export const valueBetPerformance = pgTable("value_bet_performance", {
  id:           serial("id").primaryKey(),
  valueBetId:   integer("value_bet_id").notNull(),
  eventId:      text("event_id").notNull(),
  match:        text("match").notNull(),
  marketName:   text("market_name").notNull(),
  selection:    text("selection").notNull(),
  oracleProb:   real("oracle_prob").notNull(),
  bookOdds:     real("book_odds").notNull(),
  valueEdge:    real("value_edge").notNull(),
  stake:        real("stake").notNull(),
  outcome:      text("outcome").notNull(),
  actualReturn: real("actual_return").notNull(),
  pnl:          real("pnl").notNull(),
  settledAt:    timestamp("settled_at").defaultNow().notNull(),
}, (table) => [uniqueIndex("value_bet_performance_value_bet_id_uidx").on(table.valueBetId)]);

export type AccumulatorPerformanceRow = typeof accumulatorPerformance.$inferSelect;
export type DailyPickPerformanceRow = typeof dailyPickPerformance.$inferSelect;
export type ValueBetPerformanceRow = typeof valueBetPerformance.$inferSelect;

// ─── Legacy aliases (kept for backward compat with older routes) ───────────────
/** @deprecated use `bankroll` */
export const bankrollEntries = bankroll;
/** @deprecated use `userSettings` */
export const authSettings = userSettings;
/** @deprecated use `performanceLog` */
export const performanceRecords = performanceLog;
