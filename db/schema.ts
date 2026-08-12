import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const leaderboardCache = sqliteTable("leaderboard_cache", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});

export const rankedMatches = sqliteTable("ranked_matches", {
  matchId: text("match_id").primaryKey(),
  gameStartTimestamp: integer("game_start_timestamp").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  participants: text("participants").notNull(),
  recordedAt: integer("recorded_at").notNull(),
}, (table) => [
  index("ranked_matches_started_at_idx").on(table.gameStartTimestamp),
]);

export const playerMatchStats = sqliteTable("player_match_stats", {
  playerId: text("player_id").notNull(),
  matchId: text("match_id").notNull(),
  gameStartTimestamp: integer("game_start_timestamp").notNull(),
  championId: text("champion_id").notNull(),
  championName: text("champion_name").notNull(),
  kills: integer("kills").notNull(),
  deaths: integer("deaths").notNull(),
  assists: integer("assists").notNull(),
  won: integer("won", { mode: "boolean" }).notNull(),
  role: text("role").notNull(),
}, (table) => [
  primaryKey({ columns: [table.playerId, table.matchId] }),
  index("player_match_stats_player_started_idx").on(table.playerId, table.gameStartTimestamp),
]);

export const playerStates = sqliteTable("player_states", {
  playerId: text("player_id").primaryKey(),
  payload: text("payload").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});

export const rankObservations = sqliteTable("rank_observations", {
  id: text("id").primaryKey(),
  playerId: text("player_id").notNull(),
  observedAt: integer("observed_at").notNull(),
  tier: text("tier").notNull(),
  division: text("division").notNull(),
  leaguePoints: integer("league_points").notNull(),
  wins: integer("wins").notNull(),
  losses: integer("losses").notNull(),
  latestSoloMatchId: text("latest_solo_match_id"),
  latestSoloMatchTimestamp: integer("latest_solo_match_timestamp"),
  source: text("source").notNull().default("leaderboard_refresh"),
}, (table) => [
  index("rank_observations_player_observed_idx").on(table.playerId, table.observedAt),
]);

export const matchLpEvidence = sqliteTable("match_lp_evidence", {
  playerId: text("player_id").notNull(),
  matchId: text("match_id").notNull(),
  status: text("status").notNull(),
  lpDelta: integer("lp_delta"),
  beforeObservationId: text("before_observation_id"),
  afterObservationId: text("after_observation_id"),
  failureReason: text("failure_reason"),
  matchStartedAt: integer("match_started_at"),
  matchEndedAt: integer("match_ended_at"),
  matchWon: integer("match_won", { mode: "boolean" }),
  createdAt: integer("created_at").notNull().default(0),
  resolvedAt: integer("resolved_at"),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.playerId, table.matchId] }),
  index("match_lp_evidence_status_idx").on(table.status),
]);


export const lpReconciliationCandidates = sqliteTable("lp_reconciliation_candidates", {
  playerId: text("player_id").notNull(),
  matchId: text("match_id").notNull(),
  state: text("state").notNull(),
  baselineObservationId: text("baseline_observation_id"),
  matchStartedAt: integer("match_started_at").notNull(),
  matchEndedAt: integer("match_ended_at"),
  matchWon: integer("match_won", { mode: "boolean" }),
  zeroCandidateObservationId: text("zero_candidate_observation_id"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  failureReason: text("failure_reason"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.playerId, table.matchId] }),
  index("lp_reconciliation_candidates_due_idx").on(table.state, table.nextAttemptAt),
]);

export const trackedGameSessions = sqliteTable("tracked_game_sessions", {
  playerId: text("player_id").notNull(),
  platformGameId: text("platform_game_id").notNull(),
  queueId: integer("queue_id").notNull(),
  baselineObservationId: text("baseline_observation_id").notNull(),
  gameStartedAt: integer("game_started_at").notNull(),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  endedDetectedAt: integer("ended_detected_at"),
  matchId: text("match_id"),
  status: text("status").notNull(),
  // Spectator detail kept so a live game can be rendered, not just detected.
  championId: text("champion_id"),
  championName: text("champion_name"),
  participants: text("participants"),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.playerId, table.platformGameId] }),
  index("tracked_game_sessions_status_idx").on(table.status, table.updatedAt),
]);

export const playerSyncState = sqliteTable("player_sync_state", {
  playerId: text("player_id").primaryKey(),
  puuid: text("puuid").notNull(),
  gameName: text("game_name").notNull(),
  tagLine: text("tag_line").notNull(),
  latestObservationId: text("latest_observation_id"),
  recentMatchId: text("recent_match_id"),
  recentMatchStartedAt: integer("recent_match_started_at"),
  lastSpectatorGameId: text("last_spectator_game_id"),
  lastTrackerAt: integer("last_tracker_at"),
  recentCursorUpdatedAt: integer("recent_cursor_updated_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const playerHistoryCoverage = sqliteTable("player_history_coverage", {
  playerId: text("player_id").primaryKey(),
  seasonStartedAt: integer("season_started_at").notNull(),
  earliestMatchAt: integer("earliest_match_at"),
  latestMatchAt: integer("latest_match_at"),
  recentCursorMatchId: text("recent_cursor_match_id"),
  recentCursorStartedAt: integer("recent_cursor_started_at"),
  backfillBeforeAt: integer("backfill_before_at"),
  backfillStatus: text("backfill_status").notNull(),
  indexedMatches: integer("indexed_matches").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const syncLeases = sqliteTable("sync_leases", {
  name: text("name").primaryKey(),
  owner: text("owner").notNull(),
  expiresAt: integer("expires_at").notNull(),
  blockedUntil: integer("blocked_until").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});
