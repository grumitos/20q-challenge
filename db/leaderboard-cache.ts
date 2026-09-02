import { getD1 } from ".";
import {
  CACHE_KEY,
  parseLeaderboardSnapshot,
  type LeaderboardSnapshot,
  type PlayerSnapshot,
} from "../lib/leaderboard";
import seasonSeed from "../lib/season-analytics-seed.json" with { type: "json" };
import { inferLeaguePointsChange, type PersistedSoloQueueMatch } from "../lib/riot-client";
import type { CacheRecord } from "../lib/leaderboard-service";
import type { TrackerD1 } from "./lp-tracker-store";

type CacheRow = {
  payload: string;
  fetched_at: number;
};

type PlayerStateRow = {
  payload: string;
  fetched_at: number;
};

type RankObservationRow = {
  observed_at: number;
  tier: string;
  division: string;
  league_points: number;
  wins: number;
  losses: number;
};

function rankObservationId(playerId: string, observedAt: number) {
  return `${playerId}:${observedAt}`;
}

async function reconcilePendingLpEvidence(
  snapshot: LeaderboardSnapshot,
  d1: TrackerD1,
) {
  await Promise.all(snapshot.players.map(async (player) => {
    const match = player.lastSoloQueueMatch;
    if (!match || match.lpChangeEvidence.status !== "pending") return;
    try {
      const baseline = await d1.prepare(
        `SELECT observed_at, tier, division, league_points, wins, losses
         FROM rank_observations
         WHERE player_id = ?1 AND observed_at < ?2
         ORDER BY observed_at DESC
         LIMIT 1`,
      ).bind(player.id, match.gameStartTimestamp).first<RankObservationRow>();
      if (!baseline) return;

      match.lpChangeEvidence = inferLeaguePointsChange(
        {
          tier: baseline.tier as PlayerSnapshot["tier"],
          division: baseline.division as PlayerSnapshot["division"],
          leaguePoints: baseline.league_points,
          wins: baseline.wins,
          losses: baseline.losses,
          lastSoloQueueMatch: null,
        },
        player,
        new Date(baseline.observed_at).toISOString(),
        snapshot.fetchedAt,
      );
    } catch {
      // A missing migration or temporary D1 read error must not block a live refresh.
    }
  }));
}

export async function readLeaderboardCache(database?: TrackerD1): Promise<CacheRecord | null> {
  const d1 = database ?? await getD1();
  const row = await d1
    .prepare(
      "SELECT payload, fetched_at FROM leaderboard_cache WHERE key = ?1 LIMIT 1",
    )
    .bind(CACHE_KEY)
    .first<CacheRow>();
  if (row) {
    const snapshot = parseLeaderboardSnapshot(row.payload);
    if (snapshot && Number.isFinite(row.fetched_at)) {
      return { snapshot, fetchedAt: row.fetched_at };
    }
  }

  const playerStateResult = await d1
    .prepare("SELECT payload, fetched_at FROM player_states ORDER BY player_id")
    .all<PlayerStateRow>();
  const playerStates = playerStateResult.results ?? [];
  if (playerStates.length === 0) return null;

  try {
    const fetchedAt = Math.min(...playerStates.map((state) => state.fetched_at));
    const snapshot = parseLeaderboardSnapshot(JSON.stringify({
      region: "LAS",
      platform: "LA2",
      queue: "RANKED_SOLO_5x5",
      season: "2026",
      fetchedAt: new Date(fetchedAt).toISOString(),
      dataDragonVersion: seasonSeed.dataDragonVersion,
      players: playerStates.map((state) => JSON.parse(state.payload)),
    }));
    return snapshot ? { snapshot, fetchedAt } : null;
  } catch {
    return null;
  }
}

export async function writeLeaderboardCache(
  snapshot: LeaderboardSnapshot,
  matches: readonly PersistedSoloQueueMatch[] = [],
  /** Backfill reuses the cache writer but does not represent a new rank poll. */
  recordRankObservation = true,
  database?: TrackerD1,
) {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt)) throw new Error("Snapshot timestamp is invalid.");

  const d1 = database ?? await getD1();
  await reconcilePendingLpEvidence(snapshot, d1);
  const immutableStatements = matches.flatMap((match) => [
    d1.prepare(
      `INSERT INTO ranked_matches (
         match_id, game_start_timestamp, duration_seconds, participants, recorded_at
       ) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(match_id) DO NOTHING`,
    ).bind(
      match.matchId,
      match.gameStartTimestamp,
      match.durationSeconds,
      JSON.stringify(match.participants),
      fetchedAt,
    ),
    ...match.playerStats.map((stats) => d1.prepare(
      `INSERT INTO player_match_stats (
         player_id, match_id, game_start_timestamp, champion_id, champion_name,
         kills, deaths, assists, won, role
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(player_id, match_id) DO NOTHING`,
    ).bind(
      stats.playerId,
      match.matchId,
      match.gameStartTimestamp,
      stats.championId,
      stats.championName,
      stats.kills,
      stats.deaths,
      stats.assists,
      stats.won ? 1 : 0,
      stats.role,
    )),
  ]);

  for (let index = 0; index < immutableStatements.length; index += 50) {
    await d1.batch(immutableStatements.slice(index, index + 50));
  }

  const rankObservationStatements = recordRankObservation
    ? snapshot.players.map((player) => d1.prepare(
    `INSERT INTO rank_observations (
       id, player_id, observed_at, tier, division, league_points, wins, losses,
       latest_solo_match_id, latest_solo_match_timestamp, source
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    rankObservationId(player.id, fetchedAt),
    player.id,
    fetchedAt,
    player.tier,
    player.division,
    player.leaguePoints,
    player.wins,
    player.losses,
    player.lastSoloQueueMatch?.matchId ?? null,
    player.lastSoloQueueMatch?.gameStartTimestamp ?? null,
    "leaderboard_refresh",
  ))
    : [];

  const evidenceStatements = snapshot.players.flatMap((player) => {
    const match = player.lastSoloQueueMatch;
    if (!match) return [];
    const evidence = match.lpChangeEvidence;
    const beforeObservationId = evidence.status === "observed"
      ? rankObservationId(player.id, Date.parse(evidence.beforeObservedAt))
      : null;
    const afterObservationId = evidence.status === "observed"
      ? rankObservationId(player.id, Date.parse(evidence.afterObservedAt))
      : rankObservationId(player.id, fetchedAt);
    return [d1.prepare(
      `INSERT INTO match_lp_evidence (
         player_id, match_id, status, lp_delta, before_observation_id,
         after_observation_id, failure_reason, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(player_id, match_id) DO UPDATE SET
         status = excluded.status,
         lp_delta = excluded.lp_delta,
         before_observation_id = excluded.before_observation_id,
         after_observation_id = excluded.after_observation_id,
         failure_reason = excluded.failure_reason,
         updated_at = excluded.updated_at
       WHERE match_lp_evidence.status NOT IN ('observed', 'unavailable')`,
    ).bind(
      player.id,
      match.matchId,
      evidence.status,
      evidence.status === "observed" ? evidence.value : null,
      beforeObservationId,
      afterObservationId,
      evidence.status === "observed" ? null : evidence.reason,
      fetchedAt,
    )];
  });

  await d1.batch([
    ...rankObservationStatements,
    ...evidenceStatements,
    d1.prepare(
      `INSERT INTO leaderboard_cache (key, payload, fetched_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET
         payload = excluded.payload,
         fetched_at = excluded.fetched_at`,
    ).bind(CACHE_KEY, JSON.stringify(snapshot), fetchedAt),
    ...snapshot.players.map((player) => d1.prepare(
      `INSERT INTO player_states (player_id, payload, fetched_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(player_id) DO UPDATE SET
         payload = excluded.payload,
         fetched_at = excluded.fetched_at`,
    ).bind(player.id, JSON.stringify(player), fetchedAt)),
    ...snapshot.players.flatMap((player) => player.puuid ? [d1.prepare(
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
      fetchedAt,
    )] : []),
  ]);
}
