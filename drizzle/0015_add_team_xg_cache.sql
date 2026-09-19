CREATE TABLE IF NOT EXISTS team_xg_cache (
  team_id              integer primary key,
  xg_for               numeric not null,
  xg_against           numeric not null,
  samples              integer not null,
  based_on_through_at  timestamp not null,
  next_match_at        timestamp,
  updated_at           timestamp default now() not null
);
