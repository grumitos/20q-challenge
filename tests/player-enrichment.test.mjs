import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("bounds every enrichment query so a reader's cost cannot grow with history", async () => {
  // Each of these runs on every request to /api/leaderboard. One of them used to
  // select every row for the roster — 1,214 and climbing — sort them, ship them
  // across and then keep five per player; another grouped the whole season
  // before taking its window. Both had the endpoint answering 503, and both grew
  // worse every five minutes as the backfill ran. Nothing here may be unbounded.
  const source = (await readFile(new URL("../db/player-enrichment.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  const queries = source.split("d1.prepare(").slice(1);
  assert.equal(queries.length, 4, "expected four enrichment queries");

  for (const query of queries) {
    const sql = query.slice(0, query.indexOf("`,", query.indexOf("`")) + 1);
    const bounded = /\bLIMIT\b/.test(sql) || /ROW_NUMBER\(\)/.test(sql) || /_at > \?/.test(sql);
    assert.ok(bounded, `an enrichment query has no bound on how much it reads:\n${sql.slice(0, 160)}`);
  }

  // And the dedup must group the window, not the table: GROUP BY has to sit
  // outside the LIMIT's subquery, never around the unbounded join.
  const duo = queries.find((query) => query.includes("GROUP BY"));
  assert.ok(duo, "the duo query must still deduplicate");
  assert.ok(
    duo.indexOf("LIMIT") < duo.indexOf("GROUP BY"),
    "GROUP BY must run on the limited window, not before it",
  );
});
