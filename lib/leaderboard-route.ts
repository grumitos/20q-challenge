import {
  CACHE_TTL_MS,
  CHALLENGE_MEMBER_COUNT,
  createDemoSnapshot,
  type LeaderboardPayload,
} from "./leaderboard.ts";
import type { CacheRecord } from "./leaderboard-service.ts";

type RequestLeaderboardDependencies = {
  now?: number;
  apiKey: string;
  readCache: () => Promise<CacheRecord | null>;
  refreshConfiguredPlayers?: () => Promise<unknown>;
  /**
   * Optional, and deliberately unset in production.
   *
   * The cache lasts 55s and the browser polls every 60s, so nearly every poll
   * found it stale and ran the whole temporal tracker inside the reader's own
   * request — dozens of Riot calls and a full snapshot rewrite, on the free
   * plan's per-invocation CPU allowance. It intermittently exceeded it: the
   * endpoint answered 1102 to real visitors, and the same work driven from the
   * cron failed about one run in nine.
   *
   * Refreshing is the cron's job; a reader's request should cost a read. Left
   * injectable because the tests exercise the stale path directly.
   */
  refreshRecent?: () => Promise<unknown>;
};

// Cloudflare cron delivery can drift by a few seconds. Refresh slightly before
// the public one-minute cache boundary so consecutive minute ticks are not skipped.
const REFRESH_AFTER_MS = CACHE_TTL_MS - 5_000;

export async function getLeaderboardForRequest({
  now = Date.now(),
  apiKey,
  readCache,
  refreshRecent,
  refreshConfiguredPlayers,
}: RequestLeaderboardDependencies): Promise<LeaderboardPayload> {
  let cached: CacheRecord | null = null;
  try {
    cached = await readCache();
  } catch {
    cached = null;
  }

  let refreshFailed = false;
  const rosterIncomplete = cached && cached.snapshot.players.length < CHALLENGE_MEMBER_COUNT;
  if (rosterIncomplete && apiKey.trim() && refreshConfiguredPlayers) {
    try {
      await refreshConfiguredPlayers();
      cached = await readCache();
    } catch {
      refreshFailed = true;
    }
  }

  const stale = !cached || now - cached.fetchedAt >= REFRESH_AFTER_MS;
  if (stale && apiKey.trim() && refreshRecent) {
    try {
      await refreshRecent();
      cached = await readCache();
    } catch {
      refreshFailed = true;
    }
  }

  if (cached) {
    const isStale = now - cached.fetchedAt >= CACHE_TTL_MS;
    return {
      data: cached.snapshot,
      meta: {
        source: "cache",
        isStale,
        cacheTtlSeconds: CACHE_TTL_MS / 1_000,
        ...(refreshFailed ? { notice: "Riot no respondió; se muestra la última actualización guardada." } : {}),
      },
    };
  }

  return {
    data: createDemoSnapshot(new Date(now)),
    meta: {
      source: "demo",
      isStale: true,
      cacheTtlSeconds: CACHE_TTL_MS / 1_000,
      notice: apiKey.trim()
        ? "La primera actualización automática todavía está en curso."
        : "Datos de muestra hasta configurar la Riot API key.",
    },
  };
}
