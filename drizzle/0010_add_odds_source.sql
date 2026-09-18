ALTER TABLE va_tickets ADD COLUMN IF NOT EXISTS odds_source text;
ALTER TABLE va_legs    ADD COLUMN IF NOT EXISTS odds_source text;
