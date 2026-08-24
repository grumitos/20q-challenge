import { readLeaderboardCache } from "../../../db/leaderboard-cache";
import { getD1 } from "../../../db";
import { createLpTrackerStore } from "../../../db/lp-tracker-store";
import { enrichPlayers } from "../../../db/player-enrichment";
import { rankScore } from "../../../lib/leaderboard";
import { getLeaderboardForRequest } from "../../../lib/leaderboard-route";
import { refreshLeaderboard } from "../../../lib/refresh-leaderboard";

/**
 * Reads. It does not refresh: the cron does that every minute, and doing it
 * here put a full tracker run inside a visitor's request, which exceeded the
 * free plan's CPU allowance often enough to answer 1102 to real people.
 */
export async function GET() {
  const now = Date.now();
  const apiKey = (process.env.RIOT_API_KEY ?? "").trim();
  const payload = await getLeaderboardForRequest({
    now,
    apiKey,
    readCache: readLeaderboardCache,
    refreshConfiguredPlayers: async () => {
      const store = createLpTrackerStore(await getD1());
      const owner = crypto.randomUUID();
      if (!await store.acquireLease("leaderboard-analytics", owner, now, 10 * 60_000)) throw new Error("Analytics refresh already running.");
      try {
        await refreshLeaderboard(apiKey, now, true);
      } finally {
        await store.releaseLease("leaderboard-analytics", owner);
      }
    },
  });

  // Recent form, habitual duo, place movement, any live game and the duo
  // ranking live in D1 rather than in the cached snapshot, so they are resolved
  // per request.
  const { players, duos } = await enrichPlayers(payload.data.players, rankScore, now);
  const enriched: typeof payload = {
    ...payload,
    data: { ...payload.data, players, duos },
  };

  return Response.json(enriched, {
    headers: {
      // Cacheable at the edge, which is what makes several viewers cost the same
      // as one. `private, no-store` meant every poll from every open tab invoked
      // the Worker: nine players on a one-minute refresh is one visitor's worth
      // of work, and the endpoint fell over once a handful of browsers had it
      // open at the same time. The data is public and identical for everyone,
      // and it only changes when the cron writes, so 30s of shared cache costs
      // nothing in freshness and collapses the fan-out.
      "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=60",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
