CREATE TABLE "accumulator_performance" (
	"id" serial PRIMARY KEY NOT NULL,
	"slip_id" integer NOT NULL,
	"name" text NOT NULL,
	"slip_type" text NOT NULL,
	"total_legs" integer NOT NULL,
	"won_legs" integer NOT NULL,
	"lost_legs" integer NOT NULL,
	"void_legs" integer DEFAULT 0 NOT NULL,
	"combined_odds" real NOT NULL,
	"stake" real DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"return_amount" real DEFAULT 0 NOT NULL,
	"pnl" real DEFAULT 0 NOT NULL,
	"leg_results" jsonb NOT NULL,
	"settled_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"pin" text NOT NULL,
	"display_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bankroll" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"amount" real NOT NULL,
	"balance" real NOT NULL,
	"description" text NOT NULL,
	"match_label" text,
	"odds" real,
	"stake" real,
	"profit" real,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_pick_performance" (
	"id" serial PRIMARY KEY NOT NULL,
	"daily_pick_id" integer NOT NULL,
	"pick_date" text NOT NULL,
	"event_id" text,
	"match" text NOT NULL,
	"league" text NOT NULL,
	"total_picks" integer NOT NULL,
	"hits" integer NOT NULL,
	"misses" integer NOT NULL,
	"voids" integer DEFAULT 0 NOT NULL,
	"accuracy" real NOT NULL,
	"home_score" integer NOT NULL,
	"away_score" integer NOT NULL,
	"pick_results" jsonb NOT NULL,
	"settled_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_picks" (
	"id" serial PRIMARY KEY NOT NULL,
	"pick_date" text NOT NULL,
	"match" text NOT NULL,
	"league" text NOT NULL,
	"league_slug" text,
	"event_id" text,
	"picks" jsonb NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"misses" integer DEFAULT 0 NOT NULL,
	"pending" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"level" text DEFAULT 'error' NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"context" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"match_label" text NOT NULL,
	"home_team" text NOT NULL,
	"away_team" text NOT NULL,
	"league" text NOT NULL,
	"league_slug" text,
	"competition_name" text,
	"match_date" text NOT NULL,
	"home_score" integer NOT NULL,
	"away_score" integer NOT NULL,
	"total_picks" integer NOT NULL,
	"hits" integer NOT NULL,
	"misses" integer NOT NULL,
	"pending" integer NOT NULL,
	"accuracy" real NOT NULL,
	"top10_detail" jsonb NOT NULL,
	"low_confidence" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_label" text NOT NULL,
	"home_team" text NOT NULL,
	"away_team" text NOT NULL,
	"league" text NOT NULL,
	"match_date" text NOT NULL,
	"league_slug" text,
	"event_id" text,
	"tournament_stage" text NOT NULL,
	"top_pick" text NOT NULL,
	"top_hit_rate" real NOT NULL,
	"total_markets" integer NOT NULL,
	"qualified_markets" integer NOT NULL,
	"data_completeness" integer NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referee_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cards_per_game" real DEFAULT 3.5 NOT NULL,
	"fouls_per_game" real DEFAULT 21 NOT NULL,
	"penalties_per_game" real DEFAULT 0.27 NOT NULL,
	"red_card_rate" real DEFAULT 0.08 NOT NULL,
	"strictness" real DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "referee_stats_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "saved_slips" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slip_type" text NOT NULL,
	"league_slug" text,
	"competition_name" text,
	"picks" jsonb NOT NULL,
	"combined_odds" real NOT NULL,
	"combined_prob" real NOT NULL,
	"stake" real,
	"status" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_key" text NOT NULL,
	"profile" jsonb NOT NULL,
	"providers" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "value_bet_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"league_slug" text NOT NULL,
	"competition_name" text,
	"match" text NOT NULL,
	"match_date" text NOT NULL,
	"market_name" text NOT NULL,
	"selection" text NOT NULL,
	"oracle_prob" real NOT NULL,
	"book_odds" real NOT NULL,
	"value_edge" real NOT NULL,
	"kelly_stake" real DEFAULT 0 NOT NULL,
	"stake" real DEFAULT 10 NOT NULL,
	"potential_return" real DEFAULT 0 NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"actual_return" real,
	"pnl" real,
	"low_confidence" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "value_bet_performance" (
	"id" serial PRIMARY KEY NOT NULL,
	"value_bet_id" integer NOT NULL,
	"event_id" text NOT NULL,
	"match" text NOT NULL,
	"market_name" text NOT NULL,
	"selection" text NOT NULL,
	"oracle_prob" real NOT NULL,
	"book_odds" real NOT NULL,
	"value_edge" real NOT NULL,
	"stake" real NOT NULL,
	"outcome" text NOT NULL,
	"actual_return" real NOT NULL,
	"pnl" real NOT NULL,
	"settled_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "accumulator_performance_slip_id_uidx" ON "accumulator_performance" USING btree ("slip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_pick_performance_daily_pick_id_uidx" ON "daily_pick_performance" USING btree ("daily_pick_id");--> statement-breakpoint
CREATE UNIQUE INDEX "value_bet_performance_value_bet_id_uidx" ON "value_bet_performance" USING btree ("value_bet_id");