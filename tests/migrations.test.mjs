import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const drizzleDir = new URL("../drizzle/", import.meta.url);

/**
 * Read the migration list from disk rather than from a hardcoded array. The
 * array silently stopped at 0003, so 0004 — the migration a deploy has to apply
 * before the live-game columns can be written — shipped with no coverage at all.
 */
async function migrationFiles() {
  const names = (await readdir(drizzleDir)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.length > 0, "no migrations found on disk");
  return names;
}

async function migration(name) {
  return readFile(new URL(name, drizzleDir), "utf8");
}

function apply(db, sql) {
  for (const statement of sql.split("--> statement-breakpoint").map((entry) => entry.trim()).filter(Boolean)) db.exec(statement);
}

async function applyAll(db, names) {
  for (const name of names) apply(db, await migration(name));
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

test("applies every migration on disk to a clean database", async () => {
  const db = new DatabaseSync(":memory:");
  await applyAll(db, await migrationFiles());
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const name of ["rank_observations", "match_lp_evidence", "lp_reconciliation_candidates", "tracked_game_sessions", "player_sync_state", "player_history_coverage", "sync_leases"]) {
    assert.ok(tables.includes(name), `missing table ${name}`);
  }
});

test("upgrades an existing 0000-0002 database without losing data", async () => {
  const names = await migrationFiles();
  const db = new DatabaseSync(":memory:");
  await applyAll(db, names.slice(0, 3));
  db.exec("INSERT INTO leaderboard_cache (key, payload, fetched_at) VALUES ('solo-queue-2026', '{}', 123)");
  db.exec("INSERT INTO rank_observations (id, player_id, observed_at, tier, division, league_points, wins, losses) VALUES ('p:1', 'p', 1, 'SILVER', 'I', 10, 1, 1)");
  await applyAll(db, names.slice(3));
  assert.equal(db.prepare("SELECT fetched_at FROM leaderboard_cache WHERE key = 'solo-queue-2026'").get().fetched_at, 123);
  assert.equal(db.prepare("SELECT source FROM rank_observations WHERE id = 'p:1'").get().source, "leaderboard_refresh");
});

test("adds the live-game columns the tracker writes on every run", async () => {
  // The session upsert names champion_id, champion_name and participants
  // unconditionally. Deploying the code without this migration does not fail
  // loudly: the route catches the write error and keeps serving the last cached
  // snapshot, so the board simply stops moving.
  const names = await migrationFiles();
  const db = new DatabaseSync(":memory:");
  await applyAll(db, names.slice(0, -1));
  const before = columnsOf(db, "tracked_game_sessions");
  for (const column of ["champion_id", "champion_name", "participants"]) {
    assert.equal(before.includes(column), false, `${column} exists before the migration that adds it`);
  }

  await applyAll(db, names.slice(-1));
  const after = columnsOf(db, "tracked_game_sessions");
  for (const column of ["champion_id", "champion_name", "participants"]) {
    assert.ok(after.includes(column), `migration did not add ${column}`);
  }

  // Every column the store's own upsert names must exist, read from the store
  // rather than copied here: a column list that drifts is exactly the failure
  // this test is meant to catch.
  const store = await readFile(new URL("../db/lp-tracker-store.ts", import.meta.url), "utf8");
  const upsert = store.match(/INSERT INTO tracked_game_sessions \(([\s\S]*?)\)\s*VALUES/);
  assert.ok(upsert, "could not find the tracked_game_sessions upsert in the store");
  const named = upsert[1].split(",").map((column) => column.trim()).filter(Boolean);
  assert.ok(named.length >= 14, `expected the full column list, parsed ${named.length}`);
  for (const column of named) {
    assert.ok(after.includes(column), `upsert writes ${column}, which no migration creates`);
  }

  db.exec(`INSERT INTO tracked_game_sessions (${named.join(", ")})
    VALUES ('p', 'LA2_1', 420, 'obs1', 1, 2, 3, NULL, NULL, 'active', 'Ryze', 'Ryze', '[]', 4)`);
  const row = db.prepare("SELECT champion_id, champion_name, participants FROM tracked_game_sessions WHERE player_id = 'p'").get();
  assert.deepEqual({ ...row }, { champion_id: "Ryze", champion_name: "Ryze", participants: "[]" });
});

test("keeps migrations append-only so an applied database is never rewritten", async () => {
  // Editing a migration production already ran leaves the two schemas silently
  // diverged: drizzle-kit records that a tag ran, never what it contained. The
  // test that used to live here asserted only that the numbering was gapless,
  // which is the one thing an edit does not disturb — so it could not fail for
  // the reason its own comment gave. These five are applied in production; a
  // change to any of them has to arrive as a new file, not as a correction.
  const APPLIED = {
    "0000_cold_photon.sql": "00b0af73b36b1dcf",
    "0001_worthless_beast.sql": "c7fb70b969bf81b0",
    "0002_square_skaar.sql": "f0a91ac1dfac3657",
    "0003_temporal_lp_tracker.sql": "91e22baa9eeeba41",
    "0004_live_game_detail.sql": "5a4e1552cd387f67",
  };

  const names = await migrationFiles();
  assert.deepEqual(
    names.map((name) => name.slice(0, 4)),
    names.map((_, index) => String(index).padStart(4, "0")),
    "migration numbering must be contiguous and gapless",
  );

  for (const [name, expected] of Object.entries(APPLIED)) {
    assert.ok(names.includes(name), `${name} has been applied and must not be deleted`);
    // Normalised, so a CRLF checkout is not mistaken for an edit.
    const sql = (await migration(name)).replace(/\r\n/g, "\n");
    const actual = createHash("sha256").update(sql).digest("hex").slice(0, 16);
    assert.equal(actual, expected, `${name} already ran in production — add a new migration instead of editing it`);
  }
});

test("the drizzle journal accounts for every migration on disk", async () => {
  // It listed only 0000-0002 while 0003 and 0004 sat beside it unrecorded, so
  // drizzle-kit diffed against the 0002 snapshot and the next `db:generate`
  // would have re-emitted both as a new migration — CREATE TABLE statements for
  // tables production already had.
  const journal = JSON.parse(
    await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  );
  const tags = journal.entries.map((entry) => entry.tag);
  const files = (await readdir(new URL("../drizzle/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.replace(/\.sql$/, ""))
    .sort();

  assert.deepEqual(tags, files);
  assert.deepEqual(journal.entries.map((entry) => entry.idx), files.map((_, index) => index));

  // Every entry needs its snapshot, and the chain has to be linked: two
  // snapshots naming the same parent is the collision drizzle-kit refuses.
  const snapshots = await Promise.all(tags.map(async (_, index) => JSON.parse(
    await readFile(new URL(`../drizzle/meta/000${index}_snapshot.json`, import.meta.url), "utf8"),
  )));
  const ids = snapshots.map((snapshot) => snapshot.id);
  assert.equal(new Set(ids).size, ids.length, "snapshot ids must be unique");
  for (let index = 1; index < snapshots.length; index += 1) {
    assert.equal(snapshots[index].prevId, ids[index - 1], `snapshot ${index} must follow ${index - 1}`);
  }
});
