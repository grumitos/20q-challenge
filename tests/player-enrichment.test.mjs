import assert from "node:assert/strict";
import test from "node:test";

import { aggregateHabitualDuos } from "../lib/habitual-duos.ts";
import { calculatePlaceDeltas } from "../lib/place-movement.ts";
import { rankScore } from "../lib/leaderboard.ts";

const players = [
  { id: "inti", gameName: "INTI VIRAC0NCHA" },
  { id: "miqi", gameName: "miqi" },
];

function participants() {
  return JSON.stringify([
    { championId: "1", championName: "Annie", teamId: 100, gameName: "INTI VIRAC0NCHA", tagLine: "20CM", challengePlayerId: "inti" },
    { championId: "2", championName: "Olaf", teamId: 100, gameName: "miqi", tagLine: "8745", challengePlayerId: "miqi" },
  ]);
}

test("counts linked tracker sessions and deduplicates them with match history", async () => {
  const rows = [
    // The same game is present in both sources after a full refresh and after
    // the lightweight tracker links the session. It must count once.
    { player_id: "inti", activity_id: "LA2_SHARED", participants: participants() },
    { player_id: "inti", activity_id: "LA2_SHARED", participants: participants().replace("Annie", "Ahri") },
    // A later game visible only to the tracker is the regression: before the
    // fix, the public duo stayed at the old count.
    { player_id: "inti", activity_id: "4242", participants: participants() },
  ];
  const result = aggregateHabitualDuos(rows, players);

  assert.deepEqual(result.get("inti"), { playerId: "miqi", gameName: "miqi", games: 2 });
});

test("calculates movement from the ranked current order", () => {
  const previous = [
    { player_id: "falling", tier: "GOLD", division: "II", league_points: 90 },
    { player_id: "rising", tier: "GOLD", division: "II", league_points: 10 },
    { player_id: "steady", tier: "GOLD", division: "IV", league_points: 90 },
  ];
  // The cache can arrive in a different order than the sorted leaderboard.
  const current = [
    { id: "falling", tier: "GOLD", division: "IV", leaguePoints: 10 },
    { id: "rising", tier: "GOLD", division: "II", leaguePoints: 30 },
    { id: "steady", tier: "GOLD", division: "IV", leaguePoints: 90 },
  ];

  const deltas = calculatePlaceDeltas(current, previous, rankScore);

  assert.equal(deltas.get("falling"), -2);
  assert.equal(deltas.get("rising"), 1);
});
