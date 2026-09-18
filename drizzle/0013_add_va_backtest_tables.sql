CREATE TABLE IF NOT EXISTS va_backtest_runs (
  id serial PRIMARY KEY NOT NULL,
  run_id text NOT NULL UNIQUE,
  status text,
  started_at timestamp DEFAULT now() NOT NULL,
  completed_at timestamp,
  days_simulated integer NOT NULL DEFAULT 0,
  matches_processed integer NOT NULL DEFAULT 0,
  tickets_built integer NOT NULL DEFAULT 0,
  won integer NOT NULL DEFAULT 0,
  lost integer NOT NULL DEFAULT 0,
  pending integer NOT NULL DEFAULT 0,
  realised_rate numeric,
  claimed_average numeric,
  edge numeric,
  error text
);

CREATE TABLE IF NOT EXISTS va_backtest_tickets (
  id serial PRIMARY KEY NOT NULL,
  run_id text NOT NULL,
  simulated_day text NOT NULL,
  week_start text,
  legs jsonb NOT NULL,
  combined_odds numeric NOT NULL,
  combined_probability numeric NOT NULL,
  independent_probability numeric,
  combined_ev numeric,
  kelly_score numeric,
  stake_percent numeric,
  real_odds_count integer,
  status text NOT NULL,
  settled_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL
);
