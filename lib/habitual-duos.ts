import { ROSTER_ROLE_ORDER } from "./leaderboard.ts";
import type { HabitualDuo, LastMatchParticipant, PlayerRole, PlayerSnapshot } from "./leaderboard.ts";

/** One pairing and how many distinct activities it appeared in, already tallied
    by D1. Counting used to happen here, over every windowed roster blob; see
    `readHabitualDuos` for why that had to move into the query. */
export type DuoTallyRow = {
  player_id: string;
  peer_id: string;
  games: number;
};

export function parseParticipants(raw: string | null): LastMatchParticipant[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.championId !== "string" || typeof record.championName !== "string") return [];
      const role = ROSTER_ROLE_ORDER.includes(record.role as PlayerRole) ? record.role as PlayerRole : undefined;
      const rosterIndex = typeof record.rosterIndex === "number" && Number.isInteger(record.rosterIndex) && record.rosterIndex >= 0 && record.rosterIndex < 10
        ? record.rosterIndex
        : undefined;
      return [{
        championId: record.championId,
        championName: record.championName,
        teamId: typeof record.teamId === "number" ? record.teamId : 0,
        gameName: typeof record.gameName === "string" ? record.gameName : "",
        tagLine: typeof record.tagLine === "string" ? record.tagLine : "",
        challengePlayerId: typeof record.challengePlayerId === "string" ? record.challengePlayerId : null,
        ...(role ? { role } : {}),
        ...(rosterIndex !== undefined ? { rosterIndex } : {}),
      }];
    }).slice(0, 10);
  } catch {
    return [];
  }
}

/**
 * Tallies how often each challenge member appears alongside every other member,
 * across both immutable match history and tracker-linked sessions.
 *
 * The SQL lives here, beside the function that consumes its rows, so the tests
 * can run the shipped statement against a real SQLite instead of a paraphrase
 * of it. The invariants worth protecting — one game counted once when it exists
 * in both sources, and the dedup happening inside the window rather than over
 * the whole season — are expressed in this query and nowhere else now.
 */
export const HABITUAL_DUO_QUERY =
    // One game reaches this from both sides once the backfill catches up with a
    // session the tracker watched live: indexed as a match, and still on record
    // as a session under the same id. `UNION ALL` counted it twice and inflated
    // every duo tally. Grouping collapses them, and MIN(source) makes the
    // indexed row win — SQLite carries the bare columns from the row that
    // produced the minimum, and that row has the fuller participant list.
    // The dedup groups the window, not the table: grouping outside the LIMIT
    // made SQLite collapse every indexed match before taking the most recent
    // few, so a reader's cost grew with the whole season's history.
    //
    // The tally itself is now done here rather than in the Worker. It used to
    // ship every windowed row's `participants` blob across and `JSON.parse`
    // each one: measured in production at 1,745 rows and **2.36 MiB per
    // request**, about 37 ms of parsing against a 10 ms CPU allowance, growing
    // with the season until it exceeded the budget on every single request and
    // answered 1102 to everyone. `json_each` does the same work inside D1,
    // where the cost is I/O rather than the Worker's CPU, and what crosses the
    // boundary is one small row per pairing instead of megabytes of rosters.
    `SELECT player_id, peer_id, COUNT(*) AS games
     FROM (
       SELECT activity.player_id,
              json_extract(participant.value, '$.challengePlayerId') AS peer_id
       FROM (
         SELECT player_id, activity_id, participants, MIN(source) AS source
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
         GROUP BY player_id, activity_id
       ) AS activity
       JOIN json_each(activity.participants) AS participant
     )
     WHERE peer_id IS NOT NULL
       AND peer_id <> player_id
       AND peer_id IN (SELECT value FROM json_each(?1))
     GROUP BY player_id, peer_id
     ORDER BY player_id, games DESC, peer_id`;

/**
 * Keeps each player's most frequent pairing out of the tallies D1 returns.
 *
 * The counting this used to do — deduplicating activities, parsing every
 * roster, accumulating per peer — is all in the query now. The same game can
 * arrive from both the immutable match history and the tracker session table,
 * so the query groups on the activity rather than counting each storage
 * projection as another game; what arrives here is already one row per pairing.
 *
 * Ties resolve to the alphabetically first peer, because the query orders by
 * `games DESC, peer_id` and this keeps the first it sees. Arbitrary, but stable:
 * a duo that flickered between two equally frequent partners on every refresh
 * would read as a bug.
 */
export function pickHabitualDuos(
  rows: readonly DuoTallyRow[],
  players: readonly Pick<PlayerSnapshot, "id" | "gameName">[],
) {
  const names = new Map(players.map((player) => [player.id, player.gameName]));
  const byPlayer = new Map<string, HabitualDuo>();

  for (const row of rows) {
    if (row.games <= 0 || !names.has(row.peer_id) || row.peer_id === row.player_id) continue;
    const best = byPlayer.get(row.player_id);
    if (best && best.games >= row.games) continue;
    byPlayer.set(row.player_id, {
      playerId: row.peer_id,
      gameName: names.get(row.peer_id) ?? row.peer_id,
      games: row.games,
    });
  }
  return byPlayer;
}
