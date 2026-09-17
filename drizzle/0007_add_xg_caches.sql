-- Value Accumulator xG caches (see src/lib/va/xgFetcher.ts).
--
-- Invalidation is EVENT-DRIVEN, not TTL-driven:
--   team_xg_cache.next_match_at  — the row is valid while now() < next_match_at,
--                                  i.e. until the team actually plays again. A
--                                  NULL next_match_at is treated as stale and
--                                  forces a refetch.
--   match_xg_cache.is_finished   — full-time xG never changes, so those rows are
--                                  permanent; rows built from pre-full-time
--                                  estimates expire after 24h.
-- Rows are only written when Bzzoiro returned real numbers, so "no row" always
-- means "retry on the next scan" rather than "we know there is nothing".
--
-- Hand-written migration (same convention as 0006): applied with psql /
-- drizzle-kit migrate, not generated, so it is intentionally not listed in
-- drizzle/meta/_journal.json. Both statements are idempotent.

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
CREATE TABLE IF NOT EXISTS "match_xg_cache" (
	"event_id" text PRIMARY KEY NOT NULL,
	"home_xg" numeric NOT NULL,
	"away_xg" numeric NOT NULL,
	"is_finished" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
