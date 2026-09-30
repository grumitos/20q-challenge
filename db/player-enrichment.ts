import { getD1 } from ".";
import {
  DUO_RECORD_QUERY,
  HABITUAL_DUO_QUERY,
  foldDuoRecords,
  parseParticipants,
  pickHabitualDuos,
  type DuoRecordRow,
  type DuoTallyRow,
} from "../lib/habitual-duos";
import { rankDuoRecords, type DuoRecord, type HabitualDuo, type LiveGame, type PlayerSnapshot } from "../lib/leaderboard";
import { calculatePlaceDeltas } from "../lib/place-movement";
import {
  RECENT_CHAMPION_LOOKBACK_MS,
  RECENT_CHAMPION_QUERY,
  foldRecentChampions,
  type RecentChampionRow,
} from "../lib/recent-champions";
import type { TrackerD1 } from "./lp-tracker-store";

/**
 * Resolves the signals the leaderboard payload already had the raw material for
 * but never exposed: recent form, the habitual challenge duo, place movement
 * since the previous ranking, any live SoloQ game, each champion's last month,
 * and the board-wide ranking of which pairs actually win together.
 *
 * Every query is best-effort — a missing migration or a slow read degrades the
 * card to its static state instead of failing the whole request.
 */

const RECENT_RESULT_COUNT = 5;
const DUO_LOOKBACK_MATCHES = 400;
/** A spectator session older than this is treated as finished but unlinked. */
const LIVE_SESSION_MAX_AGE_MS = 3 * 60 * 60 * 1_000;
/**
 * "Live" has to mean the tracker saw it live recently, not that something once
 * marked it active. A session whose row stops being written stays `active`
 * forever: Papipu's sat on the card for an hour after the game ended, its
 * `last_seen_at` frozen four minutes past kickoff. Why the writes stop is a
 * separate question; this is the guard that should have been here regardless,
 * because a card claiming a game that finished an hour ago is worse than no
 * card. The tracker confirms every minute, so a few of them is ample slack.
 */
const LIVE_SESSION_CONFIRMED_WITHIN_MS = 4 * 60 * 1_000;
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
async function readRecentResults(d1: TrackerD1, playerIds: readonly string[], now: number) {
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
       WHERE player_id IN (SELECT value FROM json_each(?))
         AND game_start_timestamp > ?
     )
     WHERE recency <= ?
     ORDER BY player_id, game_start_timestamp DESC`,
  ).bind(
    JSON.stringify(playerIds),
    now - RECENT_RESULT_LOOKBACK_MS,
    RECENT_RESULT_COUNT,
  ).all<RecentRow>();

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

/** Each player's champions over the last month (see `RECENT_CHAMPION_QUERY`). */
async function readRecentChampions(d1: TrackerD1, playerIds: readonly string[], now: number) {
  const rows = await d1.prepare(RECENT_CHAMPION_QUERY)
    .bind(JSON.stringify(playerIds), now - RECENT_CHAMPION_LOOKBACK_MS)
    .all<RecentChampionRow>();
  return foldRecentChampions(rows.results ?? []);
}

/** Most frequent challenge-member pairing per player. */
async function readHabitualDuos(
  d1: TrackerD1,
  players: readonly Pick<PlayerSnapshot, "id" | "gameName">[],
) {
  const rows = await d1.prepare(HABITUAL_DUO_QUERY)
    .bind(
      JSON.stringify(players.map((player) => player.id)),
      JSON.stringify(players.map((player) => player.id)),
      DUO_LOOKBACK_MATCHES * players.length * 2,
      JSON.stringify(players.map((player) => player.id)),
    )
    .all<DuoTallyRow>();

  return pickHabitualDuos(rows.results ?? [], players);
}

/**
 * Every same-team pairing on the board, ranked. Shares the habitual duo's
 * window: the two read the same rosters, and one bound for both keeps a
 * reader's cost tied to a fixed number of matches rather than to the season.
 */
async function readDuoRecords(
  d1: TrackerD1,
  playerIds: readonly string[],
) {
  const rows = await d1.prepare(DUO_RECORD_QUERY)
    .bind(
      JSON.stringify(playerIds),
      DUO_LOOKBACK_MATCHES * playerIds.length,
      JSON.stringify(playerIds),
    )
    .all<DuoRecordRow>();

  return rankDuoRecords(foldDuoRecords(rows.results ?? []));
}

/**
 * Place movement against the previous distinct ranking observation, so the
 * arrow reflects an actual position change rather than raw LP drift.
 */
async function readPlaceDeltas(
  d1: TrackerD1,
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
       WHERE observed_at > ?
         AND observed_at < (SELECT MAX(observed_at) FROM rank_observations WHERE observed_at > ?)
       GROUP BY player_id
     ) previous ON previous.player_id = o.player_id AND previous.observed_at = o.observed_at
     WHERE o.observed_at > ?`,
  ).bind(since, since, since).all<ObservationRow>();

  const previous = rows.results ?? [];
  if (previous.length < 2) return new Map<string, number>();

  return calculatePlaceDeltas(players, previous, rankScoreOf);
}

/** Active spectator sessions recorded by the temporal LP tracker. */
async function readLiveGames(d1: TrackerD1, playerIds: readonly string[], now: number) {
  const rows = await d1.prepare(
    `SELECT player_id, platform_game_id, game_started_at, champion_id, champion_name, participants
     FROM tracked_game_sessions
     WHERE status = 'active'
       AND player_id IN (SELECT value FROM json_each(?))
       AND game_started_at > ?
       AND last_seen_at > ?
     ORDER BY game_started_at ASC`,
  ).bind(
    JSON.stringify(playerIds),
    now - LIVE_SESSION_MAX_AGE_MS,
    now - LIVE_SESSION_CONFIRMED_WITHIN_MS,
  ).all<LiveRow>();

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
  database?: TrackerD1,
): Promise<{ players: PlayerSnapshot[]; duos: DuoRecord[] }> {
  let d1: TrackerD1;
  try {
    d1 = database ?? await getD1();
  } catch {
    return { players: [...players], duos: [] };
  }

  const playerIds = players.map((player) => player.id);
  const [recentResults, habitualDuos, placeDeltas, liveGames, duos, recentChampions] = await Promise.all([
    readRecentResults(d1, playerIds, now).catch(() => new Map<string, boolean[]>()),
    readHabitualDuos(d1, players).catch(() => new Map<string, HabitualDuo>()),
    readPlaceDeltas(d1, players, rankScoreOf, now).catch(() => new Map<string, number>()),
    readLiveGames(d1, playerIds, now).catch(() => new Map<string, LiveGame>()),
    readDuoRecords(d1, playerIds).catch(() => [] as DuoRecord[]),
    // A failed read leaves the field out rather than empty: empty would say
    // nobody played anything this month, and every bar would go grey.
    readRecentChampions(d1, playerIds, now).catch(() => null),
  ]);

  return {
    players: players.map((player) => ({
      ...player,
      recentResults: recentResults.get(player.id) ?? [],
      habitualDuo: habitualDuos.get(player.id) ?? null,
      placeDelta: placeDeltas.get(player.id) ?? 0,
      liveGame: liveGames.get(player.id) ?? null,
      ...(recentChampions ? { recentChampions: recentChampions.get(player.id) ?? {} } : {}),
    })),
    duos,
  };
}
