import { getD1 } from ".";
import { aggregateHabitualDuos, parseParticipants, type HabitualDuoRow } from "../lib/habitual-duos";
import type { HabitualDuo, LiveGame, PlayerSnapshot } from "../lib/leaderboard";
import { calculatePlaceDeltas } from "../lib/place-movement";

/**
 * Resolves the per-player signals the leaderboard payload already had the raw
 * material for but never exposed: recent form, the habitual challenge duo,
 * place movement since the previous ranking, and any live SoloQ game.
 *
 * Every query is best-effort — a missing migration or a slow read degrades the
 * card to its static state instead of failing the whole request.
 */

const RECENT_RESULT_COUNT = 5;
const DUO_LOOKBACK_MATCHES = 400;
/** A spectator session older than this is treated as finished but unlinked. */
const LIVE_SESSION_MAX_AGE_MS = 3 * 60 * 60 * 1_000;
/** Generous slack over the one-minute tick that writes these observations. */
const PLACE_DELTA_LOOKBACK_MS = 20 * 60 * 1_000;
/** Bounds the *scan*, not just the rows returned. Five matches back is days at
    most; without this the window function still sorted the whole table. */
const RECENT_RESULT_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1_000;

type RecentRow = { player_id: string; won: number; game_start_timestamp: number };
type ObservationRow = { player_id: string; tier: string; division: string; league_points: number };
type LiveRow = {
  player_id: string;
  platform_game_id: string;
  game_started_at: number;
  champion_id: string | null;
  champion_name: string | null;
  participants: string | null;
};

/** Last five ranked results per player, ordered oldest to newest. */
async function readRecentResults(d1: Awaited<ReturnType<typeof getD1>>, playerIds: readonly string[], now: number) {
  const byPlayer = new Map<string, boolean[]>();
  const rows = await d1.prepare(
    // Ranked inside the query rather than in the loop below. This used to select
    // every row for these players — 1,214 of them, growing with the season — sort
    // them, ship them all across, and then keep five per player. On a reader's
    // request, whose cost then rose with the whole history: the same shape that
    // had `/api/leaderboard` answering 503 twice in five.
    `SELECT player_id, won, game_start_timestamp
     FROM (
       SELECT player_id, won, game_start_timestamp,
              ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY game_start_timestamp DESC) AS recency
       FROM player_match_stats
       WHERE player_id IN (SELECT value FROM json_each(?1))
         AND game_start_timestamp > ?3
     )
     WHERE recency <= ?2
     ORDER BY player_id, game_start_timestamp DESC`,
  ).bind(JSON.stringify(playerIds), RECENT_RESULT_COUNT, now - RECENT_RESULT_LOOKBACK_MS).all<RecentRow>();

  for (const row of rows.results ?? []) {
    const current = byPlayer.get(row.player_id) ?? [];
    if (current.length >= RECENT_RESULT_COUNT) continue;
    current.push(row.won === 1);
    byPlayer.set(row.player_id, current);
  }
  // Collected newest-first above; the UI reads left-to-right as oldest-to-newest.
  for (const [playerId, results] of byPlayer) byPlayer.set(playerId, results.reverse());
  return byPlayer;
}

/**
 * Counts how often each challenge member appears alongside every other member
 * across both immutable match history and tracker-linked sessions, keeping the
 * most frequent pairing.
 */
async function readHabitualDuos(
  d1: Awaited<ReturnType<typeof getD1>>,
  players: readonly Pick<PlayerSnapshot, "id" | "gameName">[],
) {
  const rows = await d1.prepare(
    // One game reaches this from both sides once the backfill catches up with a
    // session the tracker watched live: indexed as a match, and still on record
    // as a session under the same id. `UNION ALL` counted it twice and inflated
    // every duo tally. Grouping collapses them, and MIN(source) makes the
    // indexed row win — SQLite carries the bare columns from the row that
    // produced the minimum, and that row has the fuller participant list.
    // The dedup groups the window, not the table. Grouping outside the LIMIT made
    // SQLite collapse every indexed match before taking the most recent few, so
    // the cost of a reader's request grew with the whole season's history — at
    // 875 matches it was exceeding the CPU allowance on two requests in five.
    `SELECT player_id, activity_id, participants, MIN(source) AS source
     FROM (
       SELECT player_id, activity_id, participants, source, activity_started_at
       FROM (
       SELECT s.player_id,
              m.match_id AS activity_id,
              m.participants,
              m.game_start_timestamp AS activity_started_at,
              0 AS source
       FROM player_match_stats s
       JOIN ranked_matches m ON m.match_id = s.match_id
       WHERE s.player_id IN (SELECT value FROM json_each(?1))

       UNION ALL

       SELECT t.player_id,
              COALESCE(t.match_id, t.platform_game_id) AS activity_id,
              t.participants,
              t.game_started_at AS activity_started_at,
              1 AS source
       FROM tracked_game_sessions t
       WHERE t.player_id IN (SELECT value FROM json_each(?1))
         AND t.status IN ('active', 'ended_waiting_match', 'linked')
         AND t.participants IS NOT NULL
       )
       ORDER BY activity_started_at DESC
       LIMIT ?2
     )
     GROUP BY player_id, activity_id`,
  ).bind(JSON.stringify(players.map((player) => player.id)), DUO_LOOKBACK_MATCHES * players.length * 2)
    .all<HabitualDuoRow>();

  return aggregateHabitualDuos(rows.results ?? [], players);
}

/**
 * Place movement against the previous distinct ranking observation, so the
 * arrow reflects an actual position change rather than raw LP drift.
 */
async function readPlaceDeltas(
  d1: Awaited<ReturnType<typeof getD1>>,
  players: readonly PlayerSnapshot[],
  rankScoreOf: (input: Pick<PlayerSnapshot, "tier" | "division" | "leaguePoints">) => number,
  now: number,
) {
  // Windowed, because this reads the fastest-growing table in the schema: the
  // tracker adds nine rows a minute, some thirteen thousand a day. Unbounded, it
  // scanned all of them twice — once for the MAX, once to group — on every
  // request to /api/leaderboard, so a reader's cost climbed all day. The
  // observation it wants is the previous tick's, minutes old; hours of slack is
  // already far more than it can need.
  const since = now - PLACE_DELTA_LOOKBACK_MS;
  const rows = await d1.prepare(
    `SELECT o.player_id, o.tier, o.division, o.league_points
     FROM rank_observations o
     JOIN (
       SELECT player_id, MAX(observed_at) AS observed_at
       FROM rank_observations
       WHERE observed_at > ?1
         AND observed_at < (SELECT MAX(observed_at) FROM rank_observations WHERE observed_at > ?1)
       GROUP BY player_id
     ) previous ON previous.player_id = o.player_id AND previous.observed_at = o.observed_at
     WHERE o.observed_at > ?1`,
  ).bind(since).all<ObservationRow>();

  const previous = rows.results ?? [];
  if (previous.length < 2) return new Map<string, number>();

  return calculatePlaceDeltas(players, previous, rankScoreOf);
}

/** Active spectator sessions recorded by the temporal LP tracker. */
async function readLiveGames(d1: Awaited<ReturnType<typeof getD1>>, playerIds: readonly string[], now: number) {
  const rows = await d1.prepare(
    `SELECT player_id, platform_game_id, game_started_at, champion_id, champion_name, participants
     FROM tracked_game_sessions
     WHERE status = 'active'
       AND player_id IN (SELECT value FROM json_each(?1))
       AND game_started_at > ?2
     ORDER BY game_started_at ASC`,
  ).bind(JSON.stringify(playerIds), now - LIVE_SESSION_MAX_AGE_MS).all<LiveRow>();

  // Ordered oldest first and overwritten as we go, so the newest session wins.
  // A run killed mid-flight leaves its session `active` — that happened for
  // hours while the cron was failing — and without an order the stale row could
  // beat the real one, putting a game from the previous night on the card with
  // a ten-hour clock on it.
  const byPlayer = new Map<string, LiveGame>();
  for (const row of rows.results ?? []) {
    byPlayer.set(row.player_id, {
      platformGameId: row.platform_game_id,
      gameStartedAt: row.game_started_at,
      championId: row.champion_id ?? "",
      championName: row.champion_name ?? "",
      participants: parseParticipants(row.participants),
    });
  }
  return byPlayer;
}

export async function enrichPlayers(
  players: readonly PlayerSnapshot[],
  rankScoreOf: (input: Pick<PlayerSnapshot, "tier" | "division" | "leaguePoints">) => number,
  now = Date.now(),
): Promise<PlayerSnapshot[]> {
  let d1: Awaited<ReturnType<typeof getD1>>;
  try {
    d1 = await getD1();
  } catch {
    return [...players];
  }

  const playerIds = players.map((player) => player.id);
  const [recentResults, habitualDuos, placeDeltas, liveGames] = await Promise.all([
    readRecentResults(d1, playerIds, now).catch(() => new Map<string, boolean[]>()),
    readHabitualDuos(d1, players).catch(() => new Map<string, HabitualDuo>()),
    readPlaceDeltas(d1, players, rankScoreOf, now).catch(() => new Map<string, number>()),
    readLiveGames(d1, playerIds, now).catch(() => new Map<string, LiveGame>()),
  ]);

  return players.map((player) => ({
    ...player,
    recentResults: recentResults.get(player.id) ?? [],
    habitualDuo: habitualDuos.get(player.id) ?? null,
    placeDelta: placeDeltas.get(player.id) ?? 0,
    liveGame: liveGames.get(player.id) ?? null,
  }));
}
