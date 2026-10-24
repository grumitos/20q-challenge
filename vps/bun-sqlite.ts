import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { TrackerD1 } from "../db/lp-tracker-store.ts";

type SqliteValue = string | number | bigint | Uint8Array | null;
type LocalStatement = {
  bind(...values: unknown[]): LocalStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
  runSync(): unknown;
};

function parameters(values: readonly unknown[]) {
  return values as SqliteValue[];
}

function localStatement(database: Database, sql: string, values: readonly unknown[] = []): LocalStatement {
  const execute = () => database.query(sql);
  return {
    bind(...nextValues) {
      return localStatement(database, sql, nextValues);
    },
    async first<T>() {
      return execute().get<T>(...parameters(values));
    },
    async all<T>() {
      return { results: execute().all<T>(...parameters(values)) };
    },
    async run() {
      return execute().run(...parameters(values));
    },
    runSync() {
      return execute().run(...parameters(values));
    },
  };
}

/** Adapts Bun's synchronous SQLite API to the small D1-shaped interface shared
    by the tracker store and the Cloudflare implementation. */
export function createBunTrackerD1(database: Database): TrackerD1 {
  return {
    prepare(sql) {
      return localStatement(database, sql);
    },
    async batch(statements) {
      const execute = database.transaction(() => statements.map((statement) => {
        const local = statement as unknown as LocalStatement;
        return local.runSync();
      }));
      return execute();
    },
  };
}

async function applyMigrations(database: Database, migrationsDirectory: URL) {
  const versionRow = database.query("PRAGMA user_version").get() as { user_version?: number } | null;
  const currentVersion = Number(versionRow?.user_version ?? 0);
  const names = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (let index = currentVersion; index < names.length; index += 1) {
    const sql = await readFile(new URL(names[index]!, migrationsDirectory), "utf8");
    const migrate = database.transaction(() => {
      for (const statement of sql.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed) database.exec(trimmed);
      }
      database.exec(`PRAGMA user_version = ${index + 1}`);
    });
    migrate();
  }
}

export async function openBunTrackerDatabase(options: {
  path?: string;
  migrationsDirectory?: URL;
} = {}) {
  const path = options.path ?? process.env.TRACKER_DB_PATH ?? "/var/lib/20q/20q.sqlite";
  await mkdir(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  await applyMigrations(database, options.migrationsDirectory ?? new URL("../drizzle/", import.meta.url));
  return { database, d1: createBunTrackerD1(database) };
}
