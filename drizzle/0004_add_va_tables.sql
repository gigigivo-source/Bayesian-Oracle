CREATE TABLE "va_legs" (
	"id" serial PRIMARY KEY NOT NULL,
	"scan_id" text NOT NULL,
	"event_id" text NOT NULL,
	"match_label" text NOT NULL,
	"home_team" text NOT NULL,
	"away_team" text NOT NULL,
	"league_slug" text NOT NULL,
	"kickoff" timestamp with time zone NOT NULL,
	"market" text NOT NULL,
	"selection" text NOT NULL,
	"stat_family" text NOT NULL,
	"model_probability" real NOT NULL,
	"bookmaker_odds" real NOT NULL,
	"bookmaker_name" text NOT NULL,
	"implied_probability" real NOT NULL,
	"ev" real NOT NULL,
	"odds_at_build" timestamp with time zone NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "va_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"scan_id" text NOT NULL,
	"week_start" date NOT NULL,
	"legs" jsonb NOT NULL,
	"combined_odds" real NOT NULL,
	"combined_probability" real NOT NULL,
	"combined_ev" real NOT NULL,
	"kelly_score" real NOT NULL,
	"stake_percent" real NOT NULL,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"is_reference_only" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "va_scan_lock" (
	"id" serial PRIMARY KEY NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scan_id" text NOT NULL
);
