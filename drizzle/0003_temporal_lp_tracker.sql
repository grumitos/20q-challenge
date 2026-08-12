ALTER TABLE `rank_observations` ADD `source` text DEFAULT 'leaderboard_refresh' NOT NULL;
--> statement-breakpoint
ALTER TABLE `match_lp_evidence` ADD `match_started_at` integer;
--> statement-breakpoint
ALTER TABLE `match_lp_evidence` ADD `match_ended_at` integer;
--> statement-breakpoint
ALTER TABLE `match_lp_evidence` ADD `match_won` integer;
--> statement-breakpoint
ALTER TABLE `match_lp_evidence` ADD `created_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `match_lp_evidence` ADD `resolved_at` integer;
--> statement-breakpoint
CREATE TABLE `lp_reconciliation_candidates` (
  `player_id` text NOT NULL,
  `match_id` text NOT NULL,
  `state` text NOT NULL,
  `baseline_observation_id` text,
  `match_started_at` integer NOT NULL,
  `match_ended_at` integer,
  `match_won` integer,
  `zero_candidate_observation_id` text,
  `attempts` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `failure_reason` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`player_id`, `match_id`)
);
--> statement-breakpoint
CREATE INDEX `lp_reconciliation_candidates_due_idx`
  ON `lp_reconciliation_candidates` (`state`, `next_attempt_at`);
--> statement-breakpoint
CREATE TABLE `tracked_game_sessions` (
  `player_id` text NOT NULL,
  `platform_game_id` text NOT NULL,
  `queue_id` integer NOT NULL,
  `baseline_observation_id` text NOT NULL,
  `game_started_at` integer NOT NULL,
  `first_seen_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL,
  `ended_detected_at` integer,
  `match_id` text,
  `status` text NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`player_id`, `platform_game_id`)
);
--> statement-breakpoint
CREATE INDEX `tracked_game_sessions_status_idx`
  ON `tracked_game_sessions` (`status`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `player_sync_state` (
  `player_id` text PRIMARY KEY NOT NULL,
  `puuid` text NOT NULL,
  `game_name` text NOT NULL,
  `tag_line` text NOT NULL,
  `latest_observation_id` text,
  `recent_match_id` text,
  `recent_match_started_at` integer,
  `last_spectator_game_id` text,
  `last_tracker_at` integer,
  `recent_cursor_updated_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `player_history_coverage` (
  `player_id` text PRIMARY KEY NOT NULL,
  `season_started_at` integer NOT NULL,
  `earliest_match_at` integer,
  `latest_match_at` integer,
  `recent_cursor_match_id` text,
  `recent_cursor_started_at` integer,
  `backfill_before_at` integer,
  `backfill_status` text NOT NULL,
  `indexed_matches` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_leases` (
  `name` text PRIMARY KEY NOT NULL,
  `owner` text NOT NULL,
  `expires_at` integer NOT NULL,
  `blocked_until` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL
);
