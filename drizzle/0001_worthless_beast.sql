CREATE TABLE `player_match_stats` (
	`player_id` text NOT NULL,
	`match_id` text NOT NULL,
	`game_start_timestamp` integer NOT NULL,
	`champion_id` text NOT NULL,
	`champion_name` text NOT NULL,
	`kills` integer NOT NULL,
	`deaths` integer NOT NULL,
	`assists` integer NOT NULL,
	`won` integer NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`player_id`, `match_id`)
);
--> statement-breakpoint
CREATE INDEX `player_match_stats_player_started_idx` ON `player_match_stats` (`player_id`,`game_start_timestamp`);--> statement-breakpoint
CREATE TABLE `player_states` (
	`player_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ranked_matches` (
	`match_id` text PRIMARY KEY NOT NULL,
	`game_start_timestamp` integer NOT NULL,
	`duration_seconds` integer NOT NULL,
	`participants` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ranked_matches_started_at_idx` ON `ranked_matches` (`game_start_timestamp`);