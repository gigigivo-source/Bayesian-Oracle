CREATE TABLE IF NOT EXISTS v4_predictions (
  id serial PRIMARY KEY,
  matchweek text NOT NULL,
  fixtures jsonb NOT NULL,
  predictions jsonb NOT NULL,
  actuals jsonb,
  total_score integer,
  created_at timestamp DEFAULT now() NOT NULL
);
