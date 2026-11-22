-- ĞIGI GIVØ — Reconcile the performance/dashboard tables with src/db/schema.ts.
--
-- WHY THIS FILE EXISTS
-- The Drizzle journal stopped at 0005 while the repository kept hand-written
-- SQL files 0006, 0010-0016 (with a 0007-0009 numbering gap). `drizzle-kit
-- migrate` only ever reads journal entries, so those eight files were never
-- applied: a fresh deploy came up without first5_cache, league_odds_cache,
-- team_xg_cache, v4_predictions, va_backtest_retries/runs/tickets, and without
-- the va_tickets/va_legs columns added after 0005. `drizzle-kit generate`
-- produced exactly this file from the schema, and the snapshot in
-- meta/0006_snapshot.json is now the single source of truth again.
--
-- Everything is written to be safely re-runnable, because databases that were
-- bootstrapped OUT OF BAND (psql -f drizzle/00*.sql) already contain some of
-- these objects — the same reason the old hand-written files used
-- `IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`.
--
-- ROLLBACK: every statement is additive (new tables, new columns, new
-- indexes). To undo, DROP the five new tables and the three new indexes and
-- DROP the four added columns; no existing data is modified.

-- ─── Tables introduced by the orphaned 0011-0016 files ───────────────────────

CREATE TABLE IF NOT EXISTS "first5_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"cache_key" text NOT NULL,
	"response_json" jsonb NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "first5_cache_cache_key_unique" UNIQUE("cache_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "league_odds_cache" (
	"league_slug" text PRIMARY KEY NOT NULL,
	"sport_key" text NOT NULL,
	"response_json" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_xg_cache" (
	"team_id" integer PRIMARY KEY NOT NULL,
	"xg_for" numeric NOT NULL,
	"xg_against" numeric NOT NULL,
	"samples" integer NOT NULL,
	"based_on_through_at" timestamp NOT NULL,
	"next_match_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v4_predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"matchweek" text NOT NULL,
	"fixtures" jsonb NOT NULL,
	"predictions" jsonb NOT NULL,
	"actuals" jsonb,
	"total_score" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "va_backtest_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"status" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"days_simulated" integer DEFAULT 0 NOT NULL,
	"matches_processed" integer DEFAULT 0 NOT NULL,
	"tickets_built" integer DEFAULT 0 NOT NULL,
	"won" integer DEFAULT 0 NOT NULL,
	"lost" integer DEFAULT 0 NOT NULL,
	"pending" integer DEFAULT 0 NOT NULL,
	"realised_rate" numeric,
	"claimed_average" numeric,
	"edge" numeric,
	"error" text,
	CONSTRAINT "va_backtest_runs_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "va_backtest_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"simulated_day" text NOT NULL,
	"week_start" text,
	"legs" jsonb NOT NULL,
	"combined_odds" numeric NOT NULL,
	"combined_probability" numeric NOT NULL,
	"independent_probability" numeric,
	"combined_ev" numeric,
	"kelly_score" numeric,
	"stake_percent" numeric,
	"real_odds_count" integer,
	"status" text NOT NULL,
	"settled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ─── Columns added by the orphaned 0006/0010/0012 files ──────────────────────

ALTER TABLE "va_legs" ADD COLUMN IF NOT EXISTS "odds_source" text;--> statement-breakpoint
ALTER TABLE "va_tickets" ADD COLUMN IF NOT EXISTS "independent_probability" numeric;--> statement-breakpoint
ALTER TABLE "va_tickets" ADD COLUMN IF NOT EXISTS "odds_source" text;--> statement-breakpoint
ALTER TABLE "va_tickets" ADD COLUMN IF NOT EXISTS "real_odds_count" integer;--> statement-breakpoint

-- ─── De-duplicate before enforcing uniqueness ────────────────────────────────
--
-- `performance_log` had NO unique constraint and four different writers doing
-- check-then-insert (/api/cron, /api/cron/settle, /api/performance/save,
-- /api/match). Two overlapping cron runs — /api/cron and /api/cron/settle share
-- the `0 */2 * * *` schedule — could each see "no row yet" and each insert, so
-- production tables may already hold duplicate (event_id, ranking_mode) rows.
-- Creating the index without this step fails the whole migration.
--
-- Keep the OLDEST row of each duplicate group (the first verification of a
-- match is the one the dashboards have been showing) and delete the rest.
-- Feature rows are excluded — the partial index below never covers them.
DELETE FROM "performance_log" AS dup
USING "performance_log" AS keeper
WHERE dup."feature" IS NULL
  AND keeper."feature" IS NULL
  AND dup."event_id" = keeper."event_id"
  AND dup."ranking_mode" = keeper."ranking_mode"
  AND dup."id" > keeper."id";--> statement-breakpoint

-- ─── The real idempotency guard + the read indexes the table never had ───────

CREATE UNIQUE INDEX IF NOT EXISTS "performance_log_event_mode_idx"
  ON "performance_log" USING btree ("event_id", "ranking_mode")
  WHERE "feature" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_log_feature_outcome_idx"
  ON "performance_log" USING btree ("feature", "outcome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_log_mode_idx"
  ON "performance_log" USING btree ("ranking_mode");
