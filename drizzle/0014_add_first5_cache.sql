CREATE TABLE IF NOT EXISTS first5_cache (
  id            serial primary key,
  cache_key     text not null unique,
  response_json jsonb not null,
  generated_at  timestamp default now() not null,
  expires_at    timestamp not null
);
