-- Phase 3 (H7): explicitly named indexes for high-traffic API query columns.
-- Names are unique across the schema to avoid migration conflicts.

CREATE INDEX IF NOT EXISTS "accumulator_performance_status_settled_at_idx" ON "accumulator_performance" USING btree ("status", "settled_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bankroll_created_at_idx" ON "bankroll" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bankroll_type_created_at_idx" ON "bankroll" USING btree ("type", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_pick_performance_event_id_idx" ON "daily_pick_performance" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_pick_performance_pick_date_idx" ON "daily_pick_performance" USING btree ("pick_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_pick_performance_settled_at_idx" ON "daily_pick_performance" USING btree ("settled_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_picks_created_at_idx" ON "daily_picks" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_picks_pick_date_event_id_idx" ON "daily_picks" USING btree ("pick_date", "event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_picks_status_created_at_idx" ON "daily_picks" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "error_log_created_at_idx" ON "error_log" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "error_log_level_created_at_idx" ON "error_log" USING btree ("level", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "error_log_source_created_at_idx" ON "error_log" USING btree ("source", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "first5_cache_expires_at_idx" ON "first5_cache" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "league_odds_cache_expires_at_idx" ON "league_odds_cache" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_stats_family_idx" ON "market_stats" USING btree ("family");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_log_created_at_idx" ON "performance_log" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_log_event_id_idx" ON "performance_log" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_log_feature_outcome_idx" ON "performance_log" USING btree ("feature", "outcome");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_log_feature_outcome_match_date_idx" ON "performance_log" USING btree ("feature", "outcome", "match_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_log_league_slug_idx" ON "performance_log" USING btree ("league_slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_log_match_date_idx" ON "performance_log" USING btree ("match_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_log_outcome_pending_idx" ON "performance_log" USING btree ("outcome", "pending");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_log_ranking_mode_idx" ON "performance_log" USING btree ("ranking_mode");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "predictions_created_at_idx" ON "predictions" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "predictions_event_id_idx" ON "predictions" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "predictions_league_slug_idx" ON "predictions" USING btree ("league_slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "predictions_match_date_idx" ON "predictions" USING btree ("match_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_slips_created_at_idx" ON "saved_slips" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_slips_league_slug_idx" ON "saved_slips" USING btree ("league_slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_slips_name_idx" ON "saved_slips" USING btree ("name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_slips_ranking_mode_idx" ON "saved_slips" USING btree ("ranking_mode");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_slips_status_created_at_idx" ON "saved_slips" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_profiles_team_key_idx" ON "team_profiles" USING btree ("team_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_profiles_updated_at_idx" ON "team_profiles" USING btree ("updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_xg_cache_next_match_at_idx" ON "team_xg_cache" USING btree ("next_match_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v4_predictions_created_at_idx" ON "v4_predictions" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v4_predictions_matchweek_idx" ON "v4_predictions" USING btree ("matchweek");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_backtest_runs_started_at_idx" ON "va_backtest_runs" USING btree ("started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_backtest_runs_status_idx" ON "va_backtest_runs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_backtest_tickets_run_id_created_at_idx" ON "va_backtest_tickets" USING btree ("run_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_backtest_tickets_simulated_day_idx" ON "va_backtest_tickets" USING btree ("simulated_day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_backtest_tickets_status_idx" ON "va_backtest_tickets" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_legs_event_id_idx" ON "va_legs" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_legs_kickoff_idx" ON "va_legs" USING btree ("kickoff");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_legs_league_slug_idx" ON "va_legs" USING btree ("league_slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_legs_scan_id_idx" ON "va_legs" USING btree ("scan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_scan_lock_locked_at_idx" ON "va_scan_lock" USING btree ("locked_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_scan_lock_scan_id_idx" ON "va_scan_lock" USING btree ("scan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_tickets_created_at_idx" ON "va_tickets" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_tickets_scan_id_kelly_score_idx" ON "va_tickets" USING btree ("scan_id", "kelly_score");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_tickets_status_idx" ON "va_tickets" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "va_tickets_week_start_idx" ON "va_tickets" USING btree ("week_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "value_bet_log_created_at_idx" ON "value_bet_log" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "value_bet_log_event_id_idx" ON "value_bet_log" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "value_bet_log_league_slug_idx" ON "value_bet_log" USING btree ("league_slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "value_bet_log_market_selection_idx" ON "value_bet_log" USING btree ("market_name", "selection");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "value_bet_log_match_date_idx" ON "value_bet_log" USING btree ("match_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "value_bet_log_outcome_idx" ON "value_bet_log" USING btree ("outcome");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "value_bet_log_ranking_mode_idx" ON "value_bet_log" USING btree ("ranking_mode");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "value_bet_performance_event_id_idx" ON "value_bet_performance" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "value_bet_performance_settled_at_idx" ON "value_bet_performance" USING btree ("settled_at");
