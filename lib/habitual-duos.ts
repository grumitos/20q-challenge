import { ROSTER_ROLE_ORDER } from "./leaderboard.ts";
import type { HabitualDuo, LastMatchParticipant, PlayerRole, PlayerSnapshot } from "./leaderboard.ts";

export type HabitualDuoRow = {
  player_id: string;
  activity_id: string;
  participants: string | null;
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
 * Counts challenge members who appear together in distinct activities. The
 * same game can arrive from both the immutable match history and the tracker
 * session table, so the activity key is part of the tally rather than counting
 * each storage projection as another game.
 */
export function aggregateHabitualDuos(
  rows: readonly HabitualDuoRow[],
  players: readonly Pick<PlayerSnapshot, "id" | "gameName">[],
) {
  const names = new Map(players.map((player) => [player.id, player.gameName]));
  const tally = new Map<string, Map<string, number>>();
  const seenActivities = new Set<string>();

  for (const row of rows) {
    const activityKey = `${row.player_id}:${row.activity_id}`;
    if (row.activity_id && seenActivities.has(activityKey)) continue;
    if (row.activity_id) seenActivities.add(activityKey);

    const peers = tally.get(row.player_id) ?? new Map<string, number>();
    for (const participant of parseParticipants(row.participants)) {
      const peerId = participant.challengePlayerId;
      if (!peerId || peerId === row.player_id || !names.has(peerId)) continue;
      peers.set(peerId, (peers.get(peerId) ?? 0) + 1);
    }
    tally.set(row.player_id, peers);
  }

  const byPlayer = new Map<string, HabitualDuo>();
  for (const [playerId, peers] of tally) {
    let best: HabitualDuo | null = null;
    for (const [peerId, games] of peers) {
      if (!best || games > best.games) best = { playerId: peerId, gameName: names.get(peerId) ?? peerId, games };
    }
    if (best && best.games > 0) byPlayer.set(playerId, best);
  }
  return byPlayer;
}
