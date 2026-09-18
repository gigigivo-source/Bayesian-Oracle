CREATE TABLE IF NOT EXISTS league_odds_cache (
  league_slug   text primary key,
  sport_key     text not null,
  response_json jsonb not null,
  fetched_at    timestamp default now() not null,
  expires_at    timestamp not null
);
