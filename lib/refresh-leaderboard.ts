import { readLeaderboardCache, writeLeaderboardCache } from "../db/leaderboard-cache";
import { getLeaderboard } from "./leaderboard-service";
import {
  backfillSeasonAnalytics,
  fetchRiotLeaderboard,
  RiotApiError,
  type PersistedSoloQueueMatch,
} from "./riot-client";

export async function refreshLeaderboard(
  apiKey: string,
  now = Date.now(),
  forceRefresh = false,
  /** Set by the cron, which discards the payload and would otherwise never
      learn that the refresh it exists to perform did not happen. */
  rethrowRefreshFailure = false,
) {
  let matchesToPersist: PersistedSoloQueueMatch[] = [];
  return getLeaderboard({
    now,
    hasApiKey: apiKey.length > 0,
    readCache: apiKey ? readLeaderboardCache : async () => null,
    forceRefresh,
    rethrowRefreshFailure,
    writeCache: (snapshot) => writeLeaderboardCache(snapshot, matchesToPersist),
    fetchFresh: async (cached) => {
      try {
        return await fetchRiotLeaderboard(
          apiKey,
          fetch,
          new Date(now),
          cached,
          (matches) => {
            matchesToPersist = matches;
          },
        );
      } catch (error) {
        console.error("Riot leaderboard refresh failed.", {
          code: error instanceof RiotApiError ? error.code : "UNKNOWN",
          retryAfterSeconds: error instanceof RiotApiError ? error.retryAfterSeconds : null,
        });
        throw error;
      }
    },
  });
}

/**
 * The backfill lane. Reads the cached snapshot, advances the season history a
 * batch, and writes it back — no rank endpoints, so the invocation's whole
 * subrequest allowance goes to match details.
 */
export async function refreshSeasonBackfill(apiKey: string, now = Date.now()) {
  const cached = await readLeaderboardCache();
  if (!cached) return { status: "skipped" as const, reason: "no_cached_snapshot" as const };

  const result = await backfillSeasonAnalytics(cached.snapshot, apiKey, fetch, new Date(now));
  if (!result) return { status: "skipped" as const, reason: "nothing_to_backfill" as const };

  await writeLeaderboardCache(result.snapshot, result.persistedMatches);
  return { status: "completed" as const, matches: result.persistedMatches.length };
}
