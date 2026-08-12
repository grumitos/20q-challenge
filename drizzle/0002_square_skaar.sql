CREATE TABLE `match_lp_evidence` (
	`player_id` text NOT NULL,
	`match_id` text NOT NULL,
	`status` text NOT NULL,
	`lp_delta` integer,
	`before_observation_id` text,
	`after_observation_id` text,
	`failure_reason` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`player_id`, `match_id`)
);
--> statement-breakpoint
CREATE INDEX `match_lp_evidence_status_idx` ON `match_lp_evidence` (`status`);--> statement-breakpoint
CREATE TABLE `rank_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`observed_at` integer NOT NULL,
	`tier` text NOT NULL,
	`division` text NOT NULL,
	`league_points` integer NOT NULL,
	`wins` integer NOT NULL,
	`losses` integer NOT NULL,
	`latest_solo_match_id` text,
	`latest_solo_match_timestamp` integer
);
--> statement-breakpoint
CREATE INDEX `rank_observations_player_observed_idx` ON `rank_observations` (`player_id`,`observed_at`);