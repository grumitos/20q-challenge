import {
  CACHE_KEY,
  parseLeaderboardSnapshot,
  type LeaderboardSnapshot,
  type LpChangeEvidence,
  type PlayerSnapshot,
} from "../lib/leaderboard.ts";
import { writeLeaderboardCache } from "./leaderboard-cache.ts";
import type { PersistedSoloQueueMatch } from "../lib/riot-client.ts";
import { expirePendingLpEvidence } from "../lib/lp-reconciliation.ts";
import type {
  MatchLpEvidence,
  ReconciliationCandidate,
  TrackedGameSession,
  TrackerObservation,
  TrackerPlayerState,
} from "../lib/lp-tracker.ts";

/** The slice of a snapshot `bootstrapPlayerSyncState` actually reads. Keeping it
    narrower than `LeaderboardSnapshot` lets the tracker enroll a single
    latecomer without fabricating a whole snapshot around them. */
type PlayerSyncSeedSource = {
  players: readonly Pick<
    PlayerSnapshot,
    "id" | "puuid" | "gameName" | "tagLine" | "lastSoloQueueMatch"
  >[];
};

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};

export type TrackerD1 = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
};

type SyncRow = {
  player_id: string;
  puuid: string;
  game_name: string;
  tag_line: string;
  recent_match_id: string | null;
};

type ObservationRow = {
  id: string;
  player_id: string;
  observed_at: number;
  tier: PlayerSnapshot["tier"];
  division: PlayerSnapshot["division"];
  league_points: number;
  wins: number;
  losses: number;
};

type SessionRow = {
  player_id: string;
  platform_game_id: string;
  queue_id: 420;
  baseline_observation_id: string;
  game_started_at: number;
  first_seen_at: number;
  last_seen_at: number;
  ended_detected_at: number | null;
  match_id: string | null;
  status: TrackedGameSession["status"];
  champion_id: string | null;
  champion_name: string | null;
  participants: string | null;
  updated_at: number;
};

type CandidateRow = {
  player_id: string;
  match_id: string;
  state: ReconciliationCandidate["state"];
  baseline_observation_id: string | null;
  match_started_at: number;
  match_ended_at: number | null;
  match_won: number | null;
  zero_candidate_observation_id: string | null;
  attempts: number;
  next_attempt_at: number;
  expires_at: number;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
};
function isRecoverableNoBaselineCandidate(row: CandidateRow) {
  return row.state === "unavailable" &&
    row.failure_reason === "no_before_snapshot" &&
    row.baseline_observation_id !== null;
}


async function inChunks<T>(
  values: readonly T[],
  worker: (chunk: readonly T[]) => Promise<void>,
) {
  for (let index = 0; index < values.length; index += 8) {
    await worker(values.slice(index, index + 8));
  }
}

export function createLpTrackerStore(db: TrackerD1) {
  return {
    async acquireLease(name: string, owner: string, now: number, ttlMs: number) {
      const expiresAt = now + ttlMs;
      await db.prepare(
        `INSERT INTO sync_leases (name, owner, expires_at, blocked_until, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4)
         ON CONFLICT(name) DO UPDATE SET
           owner = excluded.owner,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at
         WHERE (sync_leases.expires_at <= ?4 AND sync_leases.blocked_until <= ?4)
            OR sync_leases.owner = excluded.owner`,
      ).bind(name, owner, expiresAt, now).run();
      const lease = await db.prepare(
        "SELECT owner, expires_at, blocked_until FROM sync_leases WHERE name = ?1 LIMIT 1",
      ).bind(name).first<{ owner: string; expires_at: number; blocked_until: number }>();
      return lease?.owner === owner && lease.expires_at === expiresAt && lease.blocked_until <= now;
    },

    /** Extends the caller's own claim, and only its own: the `owner` guard means
        a run whose lease already lapsed and was taken cannot reclaim it and end
        up writing alongside the run that now holds it. */
    async renewLease(name: string, owner: string, expiresAt: number) {
      await db.prepare(
        "UPDATE sync_leases SET expires_at = ?3, updated_at = ?4 WHERE name = ?1 AND owner = ?2",
      ).bind(name, owner, expiresAt, Date.now()).run();
    },

    async releaseLease(name: string, owner: string) {
      await db.prepare(
        "UPDATE sync_leases SET owner = '', expires_at = 0, updated_at = ?3 WHERE name = ?1 AND owner = ?2",
      ).bind(name, owner, Date.now()).run();
    },

    async blockLaneUntil(name: string, timestamp: number) {
      await db.prepare(
        `INSERT INTO sync_leases (name, owner, expires_at, blocked_until, updated_at)
         VALUES (?1, 'rate-limit', 0, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET
           blocked_until = MAX(sync_leases.blocked_until, excluded.blocked_until),
           updated_at = excluded.updated_at`,
      ).bind(name, timestamp, Date.now()).run();
    },

    async loadTrackerState(playerIds: readonly string[]) {
      const placeholders = playerIds.map((_, index) => `?${index + 1}`).join(", ");
      if (!placeholders) return { players: [], observations: [], sessions: [], candidates: [], snapshot: null };
      const [sync, observations, sessions, candidates, cache] = await Promise.all([
        db.prepare(`SELECT player_id, puuid, game_name, tag_line, recent_match_id FROM player_sync_state WHERE player_id IN (${placeholders})`).bind(...playerIds).all<SyncRow>(),
        db.prepare(
          `SELECT id, player_id, observed_at, tier, division, league_points, wins, losses
           FROM (
             SELECT id, player_id, observed_at, tier, division, league_points, wins, losses,
                    ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY observed_at DESC) AS observation_rank
             FROM rank_observations
             WHERE player_id IN (${placeholders})
           )
           WHERE observation_rank <= 32
              OR id IN (
                SELECT baseline_observation_id FROM tracked_game_sessions
                WHERE player_id IN (${placeholders}) AND status IN ('active', 'ended_waiting_match', 'linked')
                UNION
                SELECT baseline_observation_id FROM lp_reconciliation_candidates
                WHERE player_id IN (${placeholders})
                  AND baseline_observation_id IS NOT NULL
                  AND (
                    state NOT IN ('resolved', 'unavailable') OR (
                      state = 'unavailable' AND failure_reason = 'no_before_snapshot'
                    )
                  )
              )
           ORDER BY player_id, observed_at DESC`,
        ).bind(...playerIds).all<ObservationRow>(),
        db.prepare(
          `SELECT player_id, platform_game_id, queue_id, baseline_observation_id,
                  game_started_at, first_seen_at, last_seen_at, ended_detected_at,
                  match_id, status, champion_id, champion_name, participants, updated_at
           FROM tracked_game_sessions
           WHERE player_id IN (${placeholders}) AND status IN ('active', 'ended_waiting_match', 'linked')`,
        ).bind(...playerIds).all<SessionRow>(),
        db.prepare(
          `SELECT player_id, match_id, state, baseline_observation_id, match_started_at,
                  match_ended_at, match_won, zero_candidate_observation_id, attempts,
                  next_attempt_at, expires_at, failure_reason, created_at, updated_at
           FROM lp_reconciliation_candidates AS candidate
           WHERE candidate.player_id IN (${placeholders}) AND (
             candidate.state NOT IN ('resolved', 'unavailable') OR (
               candidate.state = 'unavailable' AND
               candidate.failure_reason = 'no_before_snapshot' AND
               candidate.baseline_observation_id IS NOT NULL AND
               EXISTS (SELECT 1 FROM rank_observations AS observation
                       WHERE observation.id = candidate.baseline_observation_id)
             )
           )`,
        ).bind(...playerIds).all<CandidateRow>(),
        db.prepare("SELECT payload FROM leaderboard_cache WHERE key = ?1 LIMIT 1").bind(CACHE_KEY).first<{ payload: string }>(),
      ]);
      return {
        players: (sync.results ?? []).map((row): TrackerPlayerState => ({
          playerId: row.player_id,
          puuid: row.puuid,
          gameName: row.game_name,
          tagLine: row.tag_line,
          recentMatchId: row.recent_match_id,
        })),
        observations: (observations.results ?? []).map((row): TrackerObservation => ({
          id: row.id,
          playerId: row.player_id,
          observedAt: row.observed_at,
          tier: row.tier,
          division: row.division,
          leaguePoints: row.league_points,
          wins: row.wins,
          losses: row.losses,
        })),
        sessions: (sessions.results ?? []).map((row): TrackedGameSession => ({
          playerId: row.player_id,
          platformGameId: row.platform_game_id,
          queueId: row.queue_id,
          baselineObservationId: row.baseline_observation_id,
          gameStartedAt: row.game_started_at,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          endedDetectedAt: row.ended_detected_at,
          matchId: row.match_id,
          status: row.status,
          championId: row.champion_id,
          championName: row.champion_name,
          participants: row.participants,
          updatedAt: row.updated_at,
        })),
        candidates: (candidates.results ?? []).map((row): ReconciliationCandidate => ({
          playerId: row.player_id,
          matchId: row.match_id,
          state: isRecoverableNoBaselineCandidate(row) ? "awaiting_rank" : row.state,
          baselineObservationId: row.baseline_observation_id,
          matchStartedAt: row.match_started_at,
          matchEndedAt: row.match_ended_at,
          matchWon: row.match_won === null ? null : row.match_won === 1,
          zeroCandidateObservationId: row.zero_candidate_observation_id,
          attempts: row.attempts,
          nextAttemptAt: isRecoverableNoBaselineCandidate(row) ? 0 : row.next_attempt_at,
          expiresAt: row.expires_at,
          failureReason: isRecoverableNoBaselineCandidate(row) ? null : row.failure_reason,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        snapshot: cache?.payload ? parseLeaderboardSnapshot(cache.payload) : null,
      };
    },

    async bootstrapPlayerSyncState(snapshot: PlayerSyncSeedSource, now: number) {
      const statements = snapshot.players.flatMap((player) => player.puuid ? [db.prepare(
        `INSERT INTO player_sync_state (
           player_id, puuid, game_name, tag_line, recent_match_id,
           recent_match_started_at, last_tracker_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)
         ON CONFLICT(player_id) DO UPDATE SET
           puuid = excluded.puuid,
           game_name = excluded.game_name,
           tag_line = excluded.tag_line,
           updated_at = excluded.updated_at`,
      ).bind(
        player.id,
        player.puuid,
        player.gameName,
        player.tagLine,
        player.lastSoloQueueMatch?.matchId ?? null,
        player.lastSoloQueueMatch?.gameStartTimestamp ?? null,
        now,
      )] : []);
      await inChunks(statements, async (chunk) => { await db.batch([...chunk]); });
    },

    async insertRankObservations(observations: readonly TrackerObservation[]) {
      const statements = observations.map((observation) => db.prepare(
        `INSERT INTO rank_observations (
           id, player_id, observed_at, tier, division, league_points, wins, losses, source
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'temporal_tracker')
         ON CONFLICT(id) DO NOTHING`,
      ).bind(
        observation.id,
        observation.playerId,
        observation.observedAt,
        observation.tier,
        observation.division,
        observation.leaguePoints,
        observation.wins,
        observation.losses,
      ));
      await inChunks(statements, async (chunk) => { await db.batch([...chunk]); });
    },

    async upsertGameSessions(sessions: readonly TrackedGameSession[]) {
      const statements = sessions.map((session) => db.prepare(
        `INSERT INTO tracked_game_sessions (
           player_id, platform_game_id, queue_id, baseline_observation_id,
           game_started_at, first_seen_at, last_seen_at, ended_detected_at,
           match_id, status, champion_id, champion_name, participants, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(player_id, platform_game_id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           ended_detected_at = COALESCE(tracked_game_sessions.ended_detected_at, excluded.ended_detected_at),
           match_id = COALESCE(tracked_game_sessions.match_id, excluded.match_id),
           status = CASE WHEN tracked_game_sessions.status = 'linked' THEN tracked_game_sessions.status ELSE excluded.status END,
           champion_id = COALESCE(excluded.champion_id, tracked_game_sessions.champion_id),
           champion_name = COALESCE(excluded.champion_name, tracked_game_sessions.champion_name),
           participants = COALESCE(excluded.participants, tracked_game_sessions.participants),
           updated_at = excluded.updated_at`,
      ).bind(
        session.playerId, session.platformGameId, session.queueId, session.baselineObservationId,
        session.gameStartedAt, session.firstSeenAt, session.lastSeenAt, session.endedDetectedAt,
        session.matchId, session.status, session.championId, session.championName,
        session.participants, session.updatedAt,
      ));
      await inChunks(statements, async (chunk) => { await db.batch([...chunk]); });
    },

    async upsertCandidates(candidates: readonly ReconciliationCandidate[]) {
      const statements = candidates.map((candidate) => db.prepare(
        `INSERT INTO lp_reconciliation_candidates (
           player_id, match_id, state, baseline_observation_id, match_started_at,
           match_ended_at, match_won, zero_candidate_observation_id, attempts,
           next_attempt_at, expires_at, failure_reason, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(player_id, match_id) DO UPDATE SET
           state = excluded.state,
           baseline_observation_id = COALESCE(lp_reconciliation_candidates.baseline_observation_id, excluded.baseline_observation_id),
           match_ended_at = COALESCE(lp_reconciliation_candidates.match_ended_at, excluded.match_ended_at),
           match_won = COALESCE(lp_reconciliation_candidates.match_won, excluded.match_won),
           zero_candidate_observation_id = COALESCE(lp_reconciliation_candidates.zero_candidate_observation_id, excluded.zero_candidate_observation_id),
           attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at,
           expires_at = MAX(lp_reconciliation_candidates.expires_at, excluded.expires_at),
           failure_reason = excluded.failure_reason,
           updated_at = excluded.updated_at
         WHERE lp_reconciliation_candidates.state NOT IN ('resolved', 'unavailable') OR (
           lp_reconciliation_candidates.state = 'unavailable' AND
           lp_reconciliation_candidates.failure_reason = 'no_before_snapshot' AND
           lp_reconciliation_candidates.baseline_observation_id IS NOT NULL
         )`,
      ).bind(
        candidate.playerId, candidate.matchId, candidate.state, candidate.baselineObservationId,
        candidate.matchStartedAt, candidate.matchEndedAt, candidate.matchWon === null ? null : candidate.matchWon ? 1 : 0,
        candidate.zeroCandidateObservationId, candidate.attempts, candidate.nextAttemptAt,
        candidate.expiresAt, candidate.failureReason, candidate.createdAt, candidate.updatedAt,
      ));
      await inChunks(statements, async (chunk) => { await db.batch([...chunk]); });
    },

    async writeTerminalEvidence(evidence: readonly MatchLpEvidence[]) {
      const statements = evidence.map((entry) => db.prepare(
        `INSERT INTO match_lp_evidence (
           player_id, match_id, status, lp_delta, before_observation_id,
           after_observation_id, failure_reason, match_started_at, match_ended_at,
           match_won, created_at, resolved_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(player_id, match_id) DO UPDATE SET
           status = excluded.status,
           lp_delta = excluded.lp_delta,
           before_observation_id = excluded.before_observation_id,
           after_observation_id = excluded.after_observation_id,
           failure_reason = excluded.failure_reason,
           resolved_at = excluded.resolved_at,
           updated_at = excluded.updated_at
         WHERE match_lp_evidence.status NOT IN ('observed', 'unavailable') OR (
           match_lp_evidence.status = 'unavailable' AND
           match_lp_evidence.failure_reason = 'no_before_snapshot' AND
           match_lp_evidence.before_observation_id IS NULL AND excluded.before_observation_id IS NOT NULL
         )`,
      ).bind(
        entry.playerId, entry.matchId, entry.status, entry.lpDelta,
        entry.beforeObservationId, entry.afterObservationId, entry.failureReason,
        entry.matchStartedAt, entry.matchEndedAt, entry.matchWon === null ? null : entry.matchWon ? 1 : 0,
        entry.createdAt, entry.resolvedAt, entry.updatedAt,
      ));
      await inChunks(statements, async (chunk) => { await db.batch([...chunk]); });
    },

    async hydrateLatestMatchEvidence(snapshot: LeaderboardSnapshot) {
      const keys = snapshot.players.flatMap((player) => player.lastSoloQueueMatch
        ? [{ playerId: player.id, matchId: player.lastSoloQueueMatch.matchId }]
        : []);
      if (keys.length === 0) return snapshot;
      const clauses = keys.map((_, index) => `(player_id = ?${index * 2 + 1} AND match_id = ?${index * 2 + 2})`).join(" OR ");
      const rows = await db.prepare(
        `SELECT player_id, match_id, status, lp_delta, failure_reason,
                before_observation_id, after_observation_id
         FROM match_lp_evidence WHERE ${clauses}`,
      ).bind(...keys.flatMap((key) => [key.playerId, key.matchId])).all<{
        player_id: string;
        match_id: string;
        status: "observed" | "unavailable" | "pending";
        lp_delta: number | null;
        failure_reason: string | null;
        before_observation_id: string | null;
        after_observation_id: string | null;
      }>();
      const byKey = new Map((rows.results ?? []).map((row) => [`${row.player_id}:${row.match_id}`, row]));
      return {
        ...snapshot,
        players: snapshot.players.map((player) => {
          const match = player.lastSoloQueueMatch;
          if (!match) return player;
          const row = byKey.get(`${player.id}:${match.matchId}`);
          const persistedEvidence: LpChangeEvidence = row?.status === "observed" && row.lp_delta !== null
            ? {
                status: "observed" as const,
                value: row.lp_delta,
                source: "rank_snapshot_delta" as const,
                beforeObservedAt: snapshot.fetchedAt,
                afterObservedAt: snapshot.fetchedAt,
              }
            : row?.status === "unavailable"
              ? { status: "unavailable" as const, reason: (row.failure_reason ?? "rank_update_timeout") as "rank_update_timeout" }
              : row?.status === "pending"
                ? { status: "pending" as const, reason: "league_state_not_updated" as const }
                : match.lpChangeEvidence;
          const lpChangeEvidence = expirePendingLpEvidence(
            persistedEvidence,
            match.gameStartTimestamp + match.durationSeconds * 1_000,
            Date.parse(snapshot.fetchedAt),
          );
          return { ...player, lastSoloQueueMatch: { ...match, lpChangeEvidence } };
        }),
      };
    },

    async updateRecentCursors(cursors: ReadonlyArray<{ playerId: string; matchId: string | null; startedAt: number | null; now: number }>) {
      const statements = cursors.map((cursor) => db.prepare(
        `UPDATE player_sync_state SET
           recent_match_id = COALESCE(?2, recent_match_id),
           recent_match_started_at = COALESCE(?3, recent_match_started_at),
           recent_cursor_updated_at = ?4,
           last_tracker_at = ?4,
           updated_at = ?4
         WHERE player_id = ?1`,
      ).bind(cursor.playerId, cursor.matchId, cursor.startedAt, cursor.now));
      await inChunks(statements, async (chunk) => { await db.batch([...chunk]); });
    },

    /**
     * Nine rows a minute is 12,960 a day, and `loadTrackerState` ranks every
     * one of them for those players on every run — the window function cannot
     * exit early, so the read cost grew linearly and forever with no ceiling.
     *
     * Anything an open session or an unresolved candidate still points at is
     * kept regardless of age: those ids are the "before" half of an LP delta
     * that has not been attributed yet, and deleting one turns a pending
     * reconciliation into a permanent `no_before_snapshot`.
     */
    async pruneRankObservations(before: number) {
      const result = await db.prepare(
        `DELETE FROM rank_observations
          WHERE observed_at < ?1
            AND id NOT IN (
              SELECT baseline_observation_id FROM tracked_game_sessions
               WHERE baseline_observation_id IS NOT NULL
                 AND status IN ('active', 'ended_waiting_match', 'linked')
              UNION
              SELECT baseline_observation_id FROM lp_reconciliation_candidates
               WHERE baseline_observation_id IS NOT NULL
                 AND state NOT IN ('resolved', 'unavailable')
              UNION
              SELECT zero_candidate_observation_id FROM lp_reconciliation_candidates
               WHERE zero_candidate_observation_id IS NOT NULL
                 AND state NOT IN ('resolved', 'unavailable')
            )`,
      ).bind(before).run();
      return result;
    },

    /**
     * The analytics refresh's full write: snapshot cache plus the immutable
     * match and per-player stat rows. Exists on the store so the off-platform
     * runner can drive the analytics lane too — champion and role ingestion
     * lived only in the Worker, whose 10 ms CPU allowance froze it for a month
     * once the backlog outgrew what one invocation could parse.
     */
    async persistLeaderboardSnapshot(
      snapshot: LeaderboardSnapshot,
      matches: readonly PersistedSoloQueueMatch[],
    ) {
      await writeLeaderboardCache(snapshot, matches);
    },

    async writeLeaderboardProjection(snapshot: LeaderboardSnapshot, now: number) {
      await db.batch([
        db.prepare(
        `INSERT INTO leaderboard_cache (key, payload, fetched_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
        ).bind(CACHE_KEY, JSON.stringify(snapshot), now),
        ...snapshot.players.map((player) => db.prepare(
          `INSERT INTO player_states (player_id, payload, fetched_at)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(player_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
        ).bind(player.id, JSON.stringify(player), now)),
      ]);
    },
  };
}

export type LpTrackerStore = ReturnType<typeof createLpTrackerStore>;
