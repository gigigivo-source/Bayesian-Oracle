-- va_scan_lock doubles as the background-job record read by
-- GET /api/va/tickets/status (see src/lib/va/scanLock.ts).
--
-- All columns are nullable so rows written before this migration — and rows
-- written by a foreground scan, which still deletes its own row when it
-- finishes — stay valid. Readers treat a NULL status as "legacy row" and fall
-- back to locked_at.
--
-- scan_id already exists (0004_add_va_tables.sql); the statement is kept as an
-- idempotent guard so this file can be replayed on its own.
--
-- Hand-written migration (same convention as 0006/0007): not listed in
-- drizzle/meta/_journal.json.

ALTER TABLE va_scan_lock ADD COLUMN IF NOT EXISTS status text;
--> statement-breakpoint
ALTER TABLE va_scan_lock ADD COLUMN IF NOT EXISTS mode text;
--> statement-breakpoint
ALTER TABLE va_scan_lock ADD COLUMN IF NOT EXISTS started_at timestamp;
--> statement-breakpoint
ALTER TABLE va_scan_lock ADD COLUMN IF NOT EXISTS completed_at timestamp;
--> statement-breakpoint
ALTER TABLE va_scan_lock ADD COLUMN IF NOT EXISTS scan_id text;
--> statement-breakpoint
ALTER TABLE va_scan_lock ADD COLUMN IF NOT EXISTS error text;
