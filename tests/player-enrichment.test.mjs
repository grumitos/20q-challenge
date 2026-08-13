import assert from "node:assert/strict";
import test from "node:test";

import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { HABITUAL_DUO_QUERY, pickHabitualDuos } from "../lib/habitual-duos.ts";

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

/** The real schema, so the query under test runs against the shipped tables. */
async function migratedDatabase() {
  const drizzleDir = new URL("../drizzle/", import.meta.url);
  const db = new DatabaseSync(":memory:");
  for (const name of (await readdir(drizzleDir)).filter((entry) => entry.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(name, drizzleDir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((entry) => entry.trim()).filter(Boolean)) {
      db.exec(statement);
    }
  }
  return db;
}

test("counts linked tracker sessions and deduplicates them with match history", async () => {
  // This used to exercise a JavaScript tally. The counting moved into the query
  // because shipping every roster blob to the Worker to parse cost 2.36 MiB and
  // ~37 ms per request against a 10 ms allowance, so the invariants moved with
  // it — and a test that keeps asserting on JavaScript would now protect
  // nothing. It runs the shipped statement against the real migrations.
  const db = await migratedDatabase();

  // The same game in both sources: indexed as a match after the backfill, and
  // still on record as the session the tracker watched live. It must count once.
  db.exec(`INSERT INTO ranked_matches (match_id, game_start_timestamp, duration_seconds, participants, recorded_at)
           VALUES ('LA2_SHARED', 2000, 1800, '${participants()}', 2000)`);
  db.exec(`INSERT INTO player_match_stats (player_id, match_id, game_start_timestamp, champion_id, champion_name, kills, deaths, assists, won, role)
           VALUES ('inti', 'LA2_SHARED', 2000, '1', 'Annie', 1, 2, 3, 1, 'MIDDLE')`);
  db.exec(`INSERT INTO tracked_game_sessions
             (player_id, platform_game_id, queue_id, baseline_observation_id, game_started_at,
              first_seen_at, last_seen_at, match_id, status, participants, updated_at)
           VALUES ('inti', 'SHARED', 420, 'inti:1', 2000, 2000, 2000, 'LA2_SHARED', 'linked',
                   '${participants().replace("Annie", "Ahri")}', 2000)`);
  // A later game only the tracker has seen: before the dedup fix the public duo
  // stayed at the old count, so this is the half that must still be counted.
  db.exec(`INSERT INTO tracked_game_sessions
             (player_id, platform_game_id, queue_id, baseline_observation_id, game_started_at,
              first_seen_at, last_seen_at, status, participants, updated_at)
           VALUES ('inti', '4242', 420, 'inti:2', 3000, 3000, 3000, 'active',
                   '${participants()}', 3000)`);

  const rows = db.prepare(HABITUAL_DUO_QUERY).all(JSON.stringify(players.map((player) => player.id)), 400);

  assert.deepEqual(pickHabitualDuos(rows, players).get("inti"), { playerId: "miqi", gameName: "miqi", games: 2 });
});

test("a reader's duo tally crosses the worker boundary as counts, not rosters", async () => {
  // The outage itself: 1,745 rows carrying 2.36 MiB of `participants` reached
  // the Worker on every request and were parsed there, roughly 37 ms against a
  // 10 ms CPU allowance, and it grew with the season until every request
  // answered 1102. What comes back must be one small row per pairing.
  const db = await migratedDatabase();
  for (let index = 0; index < 200; index += 1) {
    db.exec(`INSERT INTO ranked_matches (match_id, game_start_timestamp, duration_seconds, participants, recorded_at)
             VALUES ('LA2_${index}', ${1000 + index}, 1800, '${participants()}', ${1000 + index})`);
    db.exec(`INSERT INTO player_match_stats (player_id, match_id, game_start_timestamp, champion_id, champion_name, kills, deaths, assists, won, role)
             VALUES ('inti', 'LA2_${index}', ${1000 + index}, '1', 'Annie', 1, 2, 3, 1, 'MIDDLE')`);
  }

  const rows = db.prepare(HABITUAL_DUO_QUERY).all(JSON.stringify(players.map((player) => player.id)), 400);

  assert.equal(rows.length, 1, "two hundred games must collapse to one pairing row");
  assert.deepEqual({ ...rows[0] }, { player_id: "inti", peer_id: "miqi", games: 200 });
  assert.equal(
    Object.keys(rows[0]).some((column) => column === "participants"), false,
    "roster blobs must not cross the worker boundary",
  );
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

  // The duo statement moved to lib/habitual-duos.ts so the tests could run it
  // against a real SQLite. It is still one of the reader's four queries, so it
  // is still bound by this, wherever it lives.
  const duo = (await readFile(new URL("../lib/habitual-duos.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  const inline = source.split("d1.prepare(").slice(1)
    .filter((query) => query.trimStart().startsWith("`") || query.includes("`SELECT"))
    .map((query) => query.slice(0, query.indexOf("`,", query.indexOf("`")) + 1));
  const duoSql = duo.slice(duo.indexOf("`SELECT player_id, peer_id"));
  const queries = [...inline, duoSql];
  assert.equal(queries.length, 4, "expected four enrichment queries");

  for (const query of queries) {
    const bounded = /\bLIMIT\b/.test(query) || /ROW_NUMBER\(\)/.test(query) || /_at > \?/.test(query);
    assert.ok(bounded, `an enrichment query has no bound on how much it reads:\n${query.slice(0, 160)}`);
  }

  // And the dedup must group the window, not the table: GROUP BY has to sit
  // outside the LIMIT's subquery, never around the unbounded join.
  assert.ok(
    duoSql.indexOf("LIMIT") < duoSql.indexOf("GROUP BY player_id, activity_id"),
    "GROUP BY must run on the limited window, not before it",
  );
  // And the rosters must be reduced to counts inside the query. Shipping them
  // out to be parsed in the Worker is what took the site down.
  assert.match(duoSql, /json_each\(activity\.participants\)/);
  assert.match(duoSql, /COUNT\(\*\) AS games/);
});
