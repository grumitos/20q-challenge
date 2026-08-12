import {
  CACHE_TTL_MS,
  createDemoSnapshot,
  shouldUseCache,
  type LeaderboardPayload,
  type LeaderboardSnapshot,
} from "./leaderboard.ts";

export type CacheRecord = {
  snapshot: LeaderboardSnapshot;
  fetchedAt: number;
};

type LeaderboardDependencies = {
  now?: number;
  hasApiKey: boolean;
  forceRefresh?: boolean;
  readCache: () => Promise<CacheRecord | null>;
  writeCache: (snapshot: LeaderboardSnapshot) => Promise<void>;
  fetchFresh: (cachedSnapshot?: LeaderboardSnapshot) => Promise<LeaderboardSnapshot>;
  /**
   * Degrading to the cached or demo snapshot is right when a reader is waiting:
   * a stale board beats a 500. It is wrong for the cron, which throws the
   * payload away — that is how a permanently broken analytics refresh managed to
   * look identical to a healthy one for as long as anyone cared to watch.
   */
  rethrowRefreshFailure?: boolean;
};

export async function getLeaderboard({
  now = Date.now(),
  hasApiKey,
  forceRefresh = false,
  readCache,
  writeCache,
  fetchFresh,
  rethrowRefreshFailure = false,
}: LeaderboardDependencies): Promise<LeaderboardPayload> {
  let cached: CacheRecord | null = null;
  try {
    cached = await readCache();
  } catch {
    cached = null;
  }

  if (!forceRefresh && cached && shouldUseCache(cached.fetchedAt, now)) {
    return {
      data: cached.snapshot,
      meta: {
        source: "cache",
        isStale: false,
        cacheTtlSeconds: CACHE_TTL_MS / 1000,
      },
    };
  }

  if (!hasApiKey) {
    if (cached) {
      return {
        data: cached.snapshot,
        meta: {
          source: "cache",
          isStale: true,
          cacheTtlSeconds: CACHE_TTL_MS / 1000,
          notice: "Se muestra la última actualización guardada; falta configurar la Riot API key.",
        },
      };
    }

    return {
      data: createDemoSnapshot(new Date(now)),
      meta: {
        source: "demo",
        isStale: false,
        cacheTtlSeconds: CACHE_TTL_MS / 1000,
        notice: "Datos de muestra hasta configurar la Riot API key.",
      },
    };
  }

  try {
    const fresh = await fetchFresh(cached?.snapshot);
    let notice: string | undefined;
    try {
      await writeCache(fresh);
    } catch {
      notice = "Los datos están actualizados, pero no pudieron guardarse en caché.";
    }

    return {
      data: fresh,
      meta: {
        source: "riot",
        isStale: false,
        cacheTtlSeconds: CACHE_TTL_MS / 1000,
        ...(notice ? { notice } : {}),
      },
    };
  } catch (error) {
    if (rethrowRefreshFailure) throw error;
    if (cached) {
      return {
        data: cached.snapshot,
        meta: {
          source: "cache",
          isStale: true,
          cacheTtlSeconds: CACHE_TTL_MS / 1000,
          notice: "Riot no respondió; se muestra la última actualización guardada.",
        },
      };
    }

    return {
      data: createDemoSnapshot(new Date(now)),
      meta: {
        source: "demo",
        isStale: true,
        cacheTtlSeconds: CACHE_TTL_MS / 1000,
        notice: "Riot no respondió y todavía no existe una actualización guardada.",
      },
    };
  }
}
