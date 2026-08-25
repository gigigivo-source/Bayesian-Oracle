ALTER TABLE "performance_log" ADD COLUMN "market" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "selection" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "outcome" text DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "hit_rate" real;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "settled_at" timestamp;