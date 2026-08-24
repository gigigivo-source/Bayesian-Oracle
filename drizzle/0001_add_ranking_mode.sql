ALTER TABLE "performance_log" ADD COLUMN "ranking_mode" text DEFAULT 'B' NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_slips" ADD COLUMN "ranking_mode" text;--> statement-breakpoint
ALTER TABLE "value_bet_log" ADD COLUMN "ranking_mode" text DEFAULT 'B' NOT NULL;