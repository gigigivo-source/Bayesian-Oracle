CREATE TABLE "market_stats" (
	"market_key" text PRIMARY KEY NOT NULL,
	"family" text NOT NULL,
	"n" integer NOT NULL,
	"claimed_sum" numeric NOT NULL,
	"realised_sum" numeric NOT NULL,
	"last_updated" timestamp DEFAULT now() NOT NULL
);
