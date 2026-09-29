/**
 * One-use migration helper for a Cloudflare D1 SQL export.
 *
 * It imports into a new file, validates the complete application schema, and
 * only then moves that file into the live SQLite path. The running services
 * keep using the same schema migrations on normal startup.
 */
import { access, mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

const exportPath = process.argv[2];
if (!exportPath) throw new Error("Usage: bun vps/import-d1-export.ts <export.sql>");

const targetPath = process.env.TRACKER_DB_PATH ?? "/var/lib/20q-tracker/20q.sqlite";
const temporaryPath = `${targetPath}.import-${process.pid}`;
const requiredTables = [
  "leaderboard_cache",
  "player_match_stats",
  "player_states",
  "ranked_matches",
  "match_lp_evidence",
  "rank_observations",
  "lp_reconciliation_candidates",
  "tracked_game_sessions",
  "player_sync_state",
  "player_history_coverage",
  "sync_leases",
] as const;

const migrationCount = (await readdir(new URL("../drizzle/", import.meta.url)))
  .filter((name) => name.endsWith(".sql"))
  .length;
await mkdir(dirname(targetPath), { recursive: true });

// Existence is probed with access(), never rm(): the old probe deleted the
// live database before refusing to overwrite it.
for (const path of [targetPath, temporaryPath]) {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing database file: ${path}`);
}

const database = new Database(temporaryPath, { create: true });
try {
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec(await readFile(exportPath, "utf8"));

  const tableNames = new Set(
    database
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>()
      .map((row) => row.name),
  );
  const missing = requiredTables.filter((table) => !tableNames.has(table));
  if (missing.length > 0) throw new Error(`D1 export is missing tables: ${missing.join(", ")}`);

  database.exec(`PRAGMA user_version = ${migrationCount}`);
  database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
} finally {
  database.close();
}

await rename(temporaryPath, targetPath);
console.log(JSON.stringify({
  event: "d1_export_imported",
  tables: requiredTables.length,
  migrations: migrationCount,
}));
