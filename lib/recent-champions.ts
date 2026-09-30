import { RECENT_CHAMPION_WINDOW_DAYS, type RecentChampionRecord } from "./leaderboard.ts";

/** How far back the query reaches, in milliseconds. */
export const RECENT_CHAMPION_LOOKBACK_MS = RECENT_CHAMPION_WINDOW_DAYS * 24 * 60 * 60 * 1_000;

/**
 * Each player's champions over the last month, as games and wins: the podium's
 * bars draw this over the season's record, so a champion running hot or cold
 * lately shows at a glance. The window rides the (player, start) index, so the
 * scan is a month of games however long the season runs, and what crosses to
 * the reader is one small row per player and champion.
 *
 * Binds: the player ids as a JSON array, then the window's start (epoch ms).
 */
export const RECENT_CHAMPION_QUERY =
    `SELECT player_id, champion_id, COUNT(*) AS games, SUM(CASE WHEN won THEN 1 ELSE 0 END) AS wins
     FROM player_match_stats
     WHERE player_id IN (SELECT value FROM json_each(?))
       AND game_start_timestamp > ?
     GROUP BY player_id, champion_id`;

export type RecentChampionRow = { player_id: string; champion_id: string; games: number; wins: number };

/** The query's rows as a map from player to their champions' records. */
export function foldRecentChampions(rows: readonly RecentChampionRow[]) {
  const byPlayer = new Map<string, Record<string, RecentChampionRecord>>();
  for (const row of rows) {
    const games = Number(row.games);
    if (!(games > 0) || !row.champion_id) continue;
    const champions = byPlayer.get(row.player_id) ?? {};
    champions[row.champion_id] = { games, wins: Math.min(games, Math.max(0, Number(row.wins) || 0)) };
    byPlayer.set(row.player_id, champions);
  }
  return byPlayer;
}
