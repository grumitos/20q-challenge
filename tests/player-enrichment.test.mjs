import assert from "node:assert/strict";
import test from "node:test";

import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { DUO_RECORD_QUERY, HABITUAL_DUO_QUERY, foldDuoRecords, pickHabitualDuos } from "../lib/habitual-duos.ts";

import { calculatePlaceDeltas } from "../lib/place-movement.ts";
import { rankDuoRecords, rankScore } from "../lib/leaderboard.ts";
import { RECENT_CHAMPION_LOOKBACK_MS, RECENT_CHAMPION_QUERY, foldRecentChampions } from "../lib/recent-champions.ts";

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

  const ids = JSON.stringify(players.map((player) => player.id));
  const rows = db.prepare(HABITUAL_DUO_QUERY).all(ids, ids, 400, ids);

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

  const ids = JSON.stringify(players.map((player) => player.id));
  const rows = db.prepare(HABITUAL_DUO_QUERY).all(ids, ids, 400, ids);

  assert.equal(rows.length, 1, "two hundred games must collapse to one pairing row");
  assert.deepEqual({ ...rows[0] }, { player_id: "inti", peer_id: "miqi", games: 200 });
  assert.equal(
    Object.keys(rows[0]).some((column) => column === "participants"), false,
    "roster blobs must not cross the worker boundary",
  );
});

/** Two challenge members, on the teams given, in one game. */
function pairParticipants(teamOfMiqi = 100) {
  return JSON.stringify([
    { championId: "1", championName: "Annie", teamId: 100, gameName: "INTI VIRAC0NCHA", tagLine: "20CM", challengePlayerId: "inti" },
    { championId: "2", championName: "Olaf", teamId: teamOfMiqi, gameName: "miqi", tagLine: "8745", challengePlayerId: "miqi" },
  ]);
}

function insertRankedGame(db, matchId, at, teamOfMiqi, results) {
  db.exec(`INSERT INTO ranked_matches (match_id, game_start_timestamp, duration_seconds, participants, recorded_at)
           VALUES ('${matchId}', ${at}, 1800, '${pairParticipants(teamOfMiqi)}', ${at})`);
  for (const [playerId, won] of Object.entries(results)) {
    db.exec(`INSERT INTO player_match_stats (player_id, match_id, game_start_timestamp, champion_id, champion_name, kills, deaths, assists, won, role)
             VALUES ('${playerId}', '${matchId}', ${at}, '1', 'Annie', 1, 2, 3, ${won ? 1 : 0}, 'MIDDLE')`);
  }
}

test("counts a duo's record only from the games they actually played together", async () => {
  const db = await migratedDatabase();
  const ids = JSON.stringify(players.map((player) => player.id));

  // Two on the same side, one won and one lost; then a game the draw put them
  // on opposite sides of, which is a shared game and never a shared result.
  insertRankedGame(db, "LA2_WIN", 1000, 100, { inti: true, miqi: true });
  insertRankedGame(db, "LA2_LOSS", 2000, 100, { inti: false, miqi: false });
  insertRankedGame(db, "LA2_ENEMIES", 3000, 200, { inti: true, miqi: false });

  const rows = db.prepare(DUO_RECORD_QUERY).all(ids, 400, ids);
  const folded = foldDuoRecords(rows);

  assert.equal(folded.length, 1, "one unordered pair, not one row per side");
  assert.deepEqual(folded[0], { playerIds: ["inti", "miqi"], games: 2, wins: 1 });
});

test("keeps a pair readable while one of its members is still being backfilled", async () => {
  const db = await migratedDatabase();
  const ids = JSON.stringify(players.map((player) => player.id));

  // Only one side has its per-match rows yet, so only one direction reports.
  // The pair still has to appear, on the sample that does exist — enough games
  // to clear the minimum, so this tests the fold and not the threshold.
  const played = 12;
  for (let index = 0; index < played; index += 1) {
    insertRankedGame(db, `LA2_${index}`, 1000 + index, 100, { inti: index % 4 !== 0 });
  }

  const ranked = rankDuoRecords(foldDuoRecords(db.prepare(DUO_RECORD_QUERY).all(ids, 400, ids)));

  assert.equal(ranked.length, 1);
  assert.deepEqual({ games: ranked[0].games, wins: ranked[0].wins }, { games: 12, wins: 9 });
});

test("leaves a live tracker session out of a duo's record", async () => {
  // A game in progress has no outcome to fold in, so the record query reads the
  // immutable history only. Counting it would move the win rate on a result
  // nobody knows yet.
  const db = await migratedDatabase();
  const ids = JSON.stringify(players.map((player) => player.id));

  db.exec(`INSERT INTO tracked_game_sessions
             (player_id, platform_game_id, queue_id, baseline_observation_id, game_started_at,
              first_seen_at, last_seen_at, status, participants, updated_at)
           VALUES ('inti', '4242', 420, 'inti:1', 3000, 3000, 3000, 'active',
                   '${pairParticipants()}', 3000)`);

  assert.deepEqual(db.prepare(DUO_RECORD_QUERY).all(ids, 400, ids), []);
});

test("reads each champion's last month from the indexed games, one row per champion", async () => {
  // The podium's bars draw this over the season: it must count only the window,
  // count wins as wins, and come back as one small row per player and champion.
  const db = await migratedDatabase();
  const ids = JSON.stringify(players.map((player) => player.id));
  const day = 24 * 60 * 60 * 1_000;
  const now = 100 * day;
  const insert = (playerId, matchId, at, champion, won) => db.exec(
    `INSERT INTO player_match_stats (player_id, match_id, game_start_timestamp, champion_id, champion_name, kills, deaths, assists, won, role)
     VALUES ('${playerId}', '${matchId}', ${at}, '${champion}', '${champion}', 1, 2, 3, ${won ? 1 : 0}, 'MIDDLE')`,
  );
  // Two Ahri games and a Lux game inside the month, and an Ahri game before it.
  insert("inti", "LA2_1", now - 2 * day, "Ahri", true);
  insert("inti", "LA2_2", now - 3 * day, "Ahri", false);
  insert("inti", "LA2_3", now - 4 * day, "Lux", true);
  insert("inti", "LA2_OLD", now - RECENT_CHAMPION_LOOKBACK_MS - 1, "Ahri", true);
  insert("miqi", "LA2_4", now - day, "MonkeyKing", false);

  const rows = db.prepare(RECENT_CHAMPION_QUERY).all(ids, now - RECENT_CHAMPION_LOOKBACK_MS);
  const recent = foldRecentChampions(rows);

  assert.equal(rows.length, 3, "one row per player and champion");
  assert.deepEqual(recent.get("inti"), { Ahri: { games: 2, wins: 1 }, Lux: { games: 1, wins: 1 } });
  assert.deepEqual(recent.get("miqi"), { MonkeyKing: { games: 1, wins: 0 } });
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
  const constant = (name) => {
    const start = duo.indexOf("`SELECT", duo.indexOf(`export const ${name} =`));
    return duo.slice(start, duo.indexOf("`;", start));
  };
  const duoSql = constant("HABITUAL_DUO_QUERY");
  const duoRecordSql = constant("DUO_RECORD_QUERY");
  // The recent-champion statement lives in lib/recent-champions.ts for the same reason.
  const recent = (await readFile(new URL("../lib/recent-champions.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const recentStart = recent.indexOf("`SELECT", recent.indexOf("export const RECENT_CHAMPION_QUERY ="));
  const recentSql = recent.slice(recentStart, recent.indexOf("`;", recentStart));
  assert.match(source, /d1\.prepare\(RECENT_CHAMPION_QUERY\)/);
  const queries = [...inline, duoSql, duoRecordSql, recentSql];
  assert.equal(queries.length, 6, "expected six enrichment queries");

  for (const query of queries) {
    const bounded = /\bLIMIT\b/.test(query) || /ROW_NUMBER\(\)/.test(query) || /_at > \?/.test(query) ||
      /game_start_timestamp > \?/.test(query);
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
  // Same for the record query: its window is bounded and its rosters are
  // reduced to a tally inside D1, not shipped out to be parsed.
  assert.match(duoRecordSql, /json_each\(mine\.participants\)/);
  assert.match(duoRecordSql, /COUNT\(\*\) AS games, SUM\(won\) AS wins/);
});
