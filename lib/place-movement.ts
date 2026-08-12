import type { PlayerSnapshot } from "./leaderboard.ts";

type RankablePlayer = Pick<PlayerSnapshot, "id" | "tier" | "division" | "leaguePoints">;

type PreviousRankObservation = {
  player_id: string;
  tier: string;
  division: string;
  league_points: number;
};

export function calculatePlaceDeltas(
  players: readonly RankablePlayer[],
  previous: readonly PreviousRankObservation[],
  rankScoreOf: (input: Pick<PlayerSnapshot, "tier" | "division" | "leaguePoints">) => number,
) {
  const scoreOfRow = (row: PreviousRankObservation) => rankScoreOf({
    tier: row.tier as PlayerSnapshot["tier"],
    division: row.division as PlayerSnapshot["division"],
    leaguePoints: row.league_points,
  });
  const previousOrder = [...previous]
    .sort((a, b) => scoreOfRow(b) - scoreOfRow(a))
    .map((row) => row.player_id);
  const currentOrder = [...players]
    .sort((a, b) => rankScoreOf(b) - rankScoreOf(a))
    .map((player) => player.id);

  const byPlayer = new Map<string, number>();
  currentOrder.forEach((playerId, currentIndex) => {
    const previousIndex = previousOrder.indexOf(playerId);
    if (previousIndex < 0) return;
    byPlayer.set(playerId, previousIndex - currentIndex);
  });
  return byPlayer;
}
