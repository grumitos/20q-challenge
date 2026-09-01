import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createLpTrackerStore } from "../db/lp-tracker-store.ts";

function d1Adapter(database) {
  function statement(sql, values = []) {
    return {
      bind(...nextValues) { return statement(sql, nextValues); },
      async first() { return database.prepare(sql).get(...values) ?? null; },
      async all() { return { results: database.prepare(sql).all(...values) }; },
      async run() { return database.prepare(sql).run(...values); },
    };
  }

  return {
    prepare(sql) { return statement(sql); },
    async batch(statements) { return Promise.all(statements.map((entry) => entry.run())); },
  };
}

async function applyMigrations(database) {
  const migrationNames = (await readdir(new URL("../drizzle/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrationNames) {
    const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((entry) => entry.trim()).filter(Boolean)) {
      database.exec(statement);
    }
  }
}

test("persists observations and protects definitive per-match PL evidence", async () => {
  const [schema, cache] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/leaderboard-cache.ts", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /rankObservations/);
  assert.match(schema, /matchLpEvidence/);
  assert.match(schema, /lpReconciliationCandidates/);
  assert.match(schema, /trackedGameSessions/);
  assert.match(schema, /playerSyncState/);
  assert.match(schema, /playerHistoryCoverage/);
  assert.match(schema, /syncLeases/);
  assert.match(cache, /INSERT INTO rank_observations/);
  assert.match(cache, /INSERT INTO match_lp_evidence/);
  assert.match(cache, /WHERE match_lp_evidence\.status NOT IN \('observed', 'unavailable'\)/);
  assert.match(cache, /INSERT INTO player_sync_state/);
});

test("ships the complete D1 migration for temporal LP tracking", async () => {
  const migrationNames = (await readdir(new URL("../drizzle/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"));
  const migrations = await Promise.all(migrationNames.map((name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")));
  const sql = migrations.join("\n");

  for (const table of [
    "rank_observations",
    "match_lp_evidence",
    "lp_reconciliation_candidates",
    "tracked_game_sessions",
    "player_sync_state",
    "player_history_coverage",
    "sync_leases",
  ]) assert.match(sql, new RegExp(table));
});

test("keeps the evidence upsert idempotent and its batches chunked", async () => {
  // What used to be here was a loop asserting `async <name>` for twelve store
  // methods — which proves the file still has methods, not that any of them
  // work, and which kept a dead `updateHistoryCoverage` alive by naming it.
  // Behaviour lives in the two SQLite tests below; these are the SQL details
  // those tests cannot reach from the outside.
  const store = await readFile(new URL("../db/lp-tracker-store.ts", import.meta.url), "utf8");
  assert.match(store, /ON CONFLICT\(player_id, match_id\)/);
  assert.match(store, /WHERE match_lp_evidence\.status NOT IN \('observed', 'unavailable'\)/);
  assert.match(store, /slice\(index, index \+ 8\)/);
});

test("loads recent rank observations fairly for every tracked player", async () => {
  const database = new DatabaseSync(":memory:");
  await applyMigrations(database);
  database.exec(`
    INSERT INTO player_sync_state (player_id, puuid, game_name, tag_line, created_at, updated_at) VALUES
      ('p1', 'puuid-1', 'P1', 'LAS', 1, 1), ('p2', 'puuid-2', 'P2', 'LAS', 1, 1),
      ('p3', 'puuid-3', 'P3', 'LAS', 1, 1), ('p4', 'puuid-4', 'P4', 'LAS', 1, 1),
      ('p5', 'puuid-5', 'P5', 'LAS', 1, 1), ('p6', 'puuid-6', 'P6', 'LAS', 1, 1),
      ('p7', 'puuid-7', 'P7', 'LAS', 1, 1), ('p8', 'puuid-8', 'P8', 'LAS', 1, 1),
      ('p9', 'puuid-9', 'P9', 'LAS', 1, 1)
  `);
  const insert = database.prepare(`
    INSERT INTO rank_observations
      (id, player_id, observed_at, tier, division, league_points, wins, losses, source)
    VALUES (?, ?, ?, 'GOLD', 'IV', 10, 10, 10, 'temporal_tracker')
  `);
  for (let index = 1; index <= 300; index += 1) insert.run(`p1:${index}`, "p1", index);
  for (let player = 2; player <= 9; player += 1) {
    for (let index = 1; index <= 32; index += 1) insert.run(`p${player}:${index}`, `p${player}`, index);
  }

  const playerIds = Array.from({ length: 9 }, (_, index) => `p${index + 1}`);
  const state = await createLpTrackerStore(d1Adapter(database)).loadTrackerState(playerIds, 300_000);
  assert.equal(state.observations.filter(({ playerId }) => playerId === "p1").length, 32);
  for (const playerId of playerIds) {
    assert.equal(state.observations.filter((observation) => observation.playerId === playerId).length, 32);
  }
});

test("keeps and repairs referenced baselines beyond the 32-observation window", async () => {
  const database = new DatabaseSync(":memory:");
  await applyMigrations(database);
  database.exec(`
    INSERT INTO player_sync_state (player_id, puuid, game_name, tag_line, created_at, updated_at) VALUES
      ('long-game', 'puuid-long', 'Long Game', 'LAS', 1, 1),
      ('delayed-rank', 'puuid-delay', 'Delayed Rank', 'LAS', 1, 1);
    INSERT INTO tracked_game_sessions (
      player_id, platform_game_id, queue_id, baseline_observation_id, game_started_at,
      first_seen_at, last_seen_at, status, updated_at
    ) VALUES ('long-game', 'game-1', 420, 'long-game:1', 1, 1, 40, 'active', 40);
    INSERT INTO lp_reconciliation_candidates (
      player_id, match_id, state, baseline_observation_id, match_started_at, match_ended_at,
      match_won, attempts, next_attempt_at, expires_at, failure_reason, created_at, updated_at
    ) VALUES ('delayed-rank', 'match-1', 'unavailable', 'delayed-rank:1', 1, 2, 1, 0, 0, 999, 'no_before_snapshot', 1, 1);
    INSERT INTO match_lp_evidence (
      player_id, match_id, status, failure_reason, updated_at
    ) VALUES ('delayed-rank', 'match-1', 'unavailable', 'no_before_snapshot', 1);
  `);
  const insert = database.prepare(`
    INSERT INTO rank_observations
      (id, player_id, observed_at, tier, division, league_points, wins, losses, source)
    VALUES (?, ?, ?, 'GOLD', 'IV', 10, 10, 10, 'temporal_tracker')
  `);
  for (const playerId of ["long-game", "delayed-rank"]) {
    for (let index = 1; index <= 40; index += 1) insert.run(playerId + ":" + index, playerId, index);
  }

  const store = createLpTrackerStore(d1Adapter(database));
  const state = await store.loadTrackerState(["long-game", "delayed-rank"], 1_000);
  for (const playerId of ["long-game", "delayed-rank"]) {
    const observations = state.observations.filter((observation) => observation.playerId === playerId);
    assert.equal(observations.length, 33);
    assert.ok(observations.some((observation) => observation.id === playerId + ":1"));
  }
  assert.equal(state.candidates.length, 1);
  assert.equal(state.candidates[0].state, "awaiting_rank");

  await store.upsertCandidates([{ ...state.candidates[0], state: "resolved", failureReason: null, updatedAt: 50 }]);
  await store.writeTerminalEvidence([{
    playerId: "delayed-rank",
    matchId: "match-1",
    status: "observed",
    lpDelta: 20,
    beforeObservationId: "delayed-rank:1",
    afterObservationId: "delayed-rank:40",
    failureReason: null,
    matchStartedAt: 1,
    matchEndedAt: 2,
    matchWon: true,
    createdAt: 1,
    resolvedAt: 50,
    updatedAt: 50,
  }]);
  assert.equal(database.prepare("SELECT state FROM lp_reconciliation_candidates WHERE player_id = 'delayed-rank'").get().state, "resolved");
  const evidence = database.prepare("SELECT status, lp_delta FROM match_lp_evidence WHERE player_id = 'delayed-rank'").get();
  assert.equal(evidence.status, "observed");
  assert.equal(evidence.lp_delta, 20);
});

test("the lease admits one owner and turns the rest away", async () => {
  // The single mechanism bounding Riot spend on a publicly reachable endpoint,
  // and every other test in the suite stubs it to `return true`.
  const database = new DatabaseSync(":memory:");
  await applyMigrations(database);
  const store = createLpTrackerStore(d1Adapter(database));
  const now = 1_000_000;

  assert.equal(await store.acquireLease("lp-tracker", "first", now, 60_000), true);
  assert.equal(await store.acquireLease("lp-tracker", "second", now, 60_000), false);
  // Re-entry by the holder is allowed; a retry inside one run must not deadlock.
  assert.equal(await store.acquireLease("lp-tracker", "first", now, 60_000), true);
  // A different lane is independent.
  assert.equal(await store.acquireLease("leaderboard-analytics", "second", now, 60_000), true);

  // Releasing hands the lane over — and only the holder may release it.
  await store.releaseLease("lp-tracker", "impostor");
  assert.equal(await store.acquireLease("lp-tracker", "second", now, 60_000), false);
  await store.releaseLease("lp-tracker", "first");
  assert.equal(await store.acquireLease("lp-tracker", "second", now, 60_000), true);

  database.close();
});

test("an expired lease is reclaimed, a blocked lane is not", async () => {
  const database = new DatabaseSync(":memory:");
  await applyMigrations(database);
  const store = createLpTrackerStore(d1Adapter(database));
  const now = 2_000_000;

  // A run killed outright never releases, so the TTL is what frees the lane.
  assert.equal(await store.acquireLease("lp-tracker", "crashed", now, 60_000), true);
  assert.equal(await store.acquireLease("lp-tracker", "next", now + 59_000, 60_000), false);
  assert.equal(await store.acquireLease("lp-tracker", "next", now + 61_000, 60_000), true);

  // Riot's Retry-After blocks the lane past its own expiry: an available lease
  // must not override a rate limit the previous run already paid for.
  await store.blockLaneUntil("lp-tracker", now + 300_000);
  await store.releaseLease("lp-tracker", "next");
  assert.equal(await store.acquireLease("lp-tracker", "third", now + 100_000, 60_000), false);
  assert.equal(await store.acquireLease("lp-tracker", "third", now + 301_000, 60_000), true);

  database.close();
});

test("the sweep drops stale observations but never one still being reconciled", async () => {
  // Deleting a referenced baseline turns a pending LP delta into a permanent
  // `no_before_snapshot` — the failure mode is silent and unrecoverable, which
  // is why the delete excludes them by reference rather than by age alone.
  const database = new DatabaseSync(":memory:");
  await applyMigrations(database);
  const store = createLpTrackerStore(d1Adapter(database));
  const now = 10_000_000;
  const old = now - 30 * 24 * 60 * 60_000;

  const insert = (id, observedAt) => database.prepare(
    `INSERT INTO rank_observations (id, player_id, observed_at, tier, division, league_points, wins, losses, source)
     VALUES (?, 'p1', ?, 'SILVER', 'I', 90, 10, 10, 'temporal_tracker')`,
  ).run(id, observedAt);

  insert("stale-unreferenced", old);
  insert("stale-session-baseline", old);
  insert("stale-candidate-baseline", old);
  insert("stale-zero-candidate", old);
  insert("stale-resolved-candidate", old);
  insert("recent", now - 1_000);

  database.prepare(
    `INSERT INTO tracked_game_sessions (player_id, platform_game_id, queue_id, baseline_observation_id,
       game_started_at, first_seen_at, last_seen_at, status, updated_at)
     VALUES ('p1', '1', 420, 'stale-session-baseline', ?, ?, ?, 'ended_waiting_match', ?)`,
  ).run(old, old, old, old);

  const candidate = (matchId, baseline, zero, state) => database.prepare(
    `INSERT INTO lp_reconciliation_candidates (player_id, match_id, state, baseline_observation_id,
       zero_candidate_observation_id, match_started_at, attempts, next_attempt_at, expires_at, created_at, updated_at)
     VALUES ('p1', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(matchId, state, baseline, zero, old, old, now + 60_000, old, old);

  candidate("m-open", "stale-candidate-baseline", "stale-zero-candidate", "awaiting_rank");
  candidate("m-done", "stale-resolved-candidate", null, "resolved");

  await store.pruneRankObservations(now - 7 * 24 * 60 * 60_000);

  const kept = database.prepare("SELECT id FROM rank_observations ORDER BY id").all().map((row) => row.id);
  assert.deepEqual(kept, [
    "recent",
    "stale-candidate-baseline",
    "stale-session-baseline",
    "stale-zero-candidate",
  ]);
  // A resolved candidate's baseline has done its job and is free to go.
  assert.equal(kept.includes("stale-resolved-candidate"), false);
  assert.equal(kept.includes("stale-unreferenced"), false);

  database.close();
});
