/**
 * The temporal LP tracker, run outside Cloudflare.
 *
 * Why this exists: a Worker on the free plan gets 10 ms of CPU per invocation.
 * A tracker run parses nine spectator payloads, the Data Dragon champion
 * catalog and a couple of Match-V5 details, which measured together sit at or
 * over that ceiling whenever the roster is actually playing — so the board went
 * stale during exactly the hours it mattered. Cloudflare tolerates an
 * occasional overrun and terminates a Worker that exceeds the limit
 * consistently, which is what a busy evening produces.
 *
 * Nothing about the tracker itself changes here. `runTemporalLpTracker` takes a
 * store, and this points it at Bun SQLite, so the logic stays in one place while
 * the VPS owns Riot polling, analytics and persistence.
 *
 * Intended to run under a systemd timer, one run per tick, no daemon. It listens
 * on nothing and holds no port.
 */
import { runTemporalLpTracker } from "../lib/lp-tracker.ts";
import { createLpTrackerStore, type LpTrackerStore } from "../db/lp-tracker-store.ts";
import { openBunTrackerDatabase } from "./bun-sqlite.ts";
import { fetchRiotLeaderboard, RIOT_PLAYERS } from "../lib/riot-client.ts";
import {
  ANALYTICS_HEARTBEAT_LANE,
  ANALYTICS_HEARTBEAT_TTL_MS,
  ANALYTICS_RETRY_DELAY_MS,
  ANALYTICS_RETRY_LANE,
  analyticsPhaseDue,
  readAnalyticsHeartbeat,
  readAnalyticsRetry,
} from "./analytics-schedule.ts";

/**
 * The Worker's defaults exist because of its 10 ms CPU ceiling; out here the
 * only limits that matter are Riot's, and the registered app key's are generous
 * (2,000 match details per 10 s, 3,000 spectator per 10 s, 20,000 rank reads
 * per 10 s). The request budget is still shared with the analytics phase, so
 * this runner deliberately uses the same 30-request ceiling as the Worker
 * even though the VPS itself has more CPU and Riot capacity.
 */
const RUNNER_MAX_REQUESTS = 30;
const RUNNER_MATCH_DETAILS_PER_RUN = 2;

/**
 * The analytics phase — champion and role ingestion — runs here too, about
 * every ten minutes (see `analytics-schedule.ts`). It lived only in the Worker,
 * where the 10 ms CPU allowance froze it for a month once the backlog outgrew
 * one invocation; out here a small bounded batch keeps normal games fresh
 * without consuming the window needed by the minute-by-minute tracker. The VPS
 * timer is the only production scheduler after cutover; there is no Cloudflare
 * fallback lane.
 */
const RUNNER_ANALYTICS_DETAILS_PER_RUN = 5;
const RUNNER_ANALYTICS_MAX_REQUESTS = 32;

async function runAnalyticsPhase(
  store: LpTrackerStore,
  apiKey: string,
  now: number,
) {
  const owner = crypto.randomUUID();
  // Same two leases, same order, as the Worker's own analytics lane: one keeps
  // a second analytics run out, the other keeps the tracker's snapshot rewrite
  // from erasing this run's progress mid-write.
  if (!await store.acquireLease("leaderboard-analytics", owner, now, 10 * 60_000)) return "skipped";
  try {
    if (!await store.acquireLease("lp-tracker", owner, now, 90_000)) return "skipped";
    try {
      const state = await store.loadTrackerState(RIOT_PLAYERS.map(({ id }) => id), now);
      if (!state.snapshot) return "no_snapshot";
      // The callback only captures; snapshot and matches are persisted together
      // afterwards, exactly as `refreshLeaderboard` does it, so a run that dies
      // mid-fetch writes nothing rather than half of something.
      let matchesToPersist: Parameters<typeof store.persistLeaderboardSnapshot>[1] = [];
      const snapshot = await fetchRiotLeaderboard(
        apiKey,
        fetch,
        new Date(now),
        state.snapshot,
        (matches) => { matchesToPersist = matches; },
        RUNNER_ANALYTICS_MAX_REQUESTS,
        RUNNER_ANALYTICS_DETAILS_PER_RUN,
      );
      await store.persistLeaderboardSnapshot(snapshot, matchesToPersist);
      await store.blockLaneUntil(
        ANALYTICS_HEARTBEAT_LANE,
        now + ANALYTICS_HEARTBEAT_TTL_MS,
      );
      return "completed";
    } finally {
      await store.releaseLease("lp-tracker", owner);
    }
  } finally {
    await store.releaseLease("leaderboard-analytics", owner);
  }
}

function required(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    // Fail loudly and immediately: a tracker that runs every minute with a
    // missing upstream key should not fill the journal with retries.
    console.error(JSON.stringify({ event: "tracker_runner", status: "misconfigured", missing: name }));
    process.exit(78); // EX_CONFIG
  }
  return value;
}

async function main() {
  const apiKey = required("RIOT_API_KEY");
  const startedAt = Date.now();

  const { database, d1 } = await openBunTrackerDatabase();
  const store = createLpTrackerStore(d1);

  try {
    const result = await runTemporalLpTracker({
      store,
      apiKey,
      now: startedAt,
      maxRequests: RUNNER_MAX_REQUESTS,
      matchDetailsPerRun: RUNNER_MATCH_DETAILS_PER_RUN,
    });
    console.log(JSON.stringify({
      event: "tracker_runner",
      status: result.status,
      durationMs: Date.now() - startedAt,
      requestsUsed: result.requestsUsed,
      ...("observationsInserted" in result ? { observationsInserted: result.observationsInserted } : {}),
      ...("sessionsUpdated" in result ? { sessionsUpdated: result.sessionsUpdated } : {}),
      ...("playerErrors" in result ? { playerErrors: result.playerErrors } : {}),
      ...("matchErrors" in result ? { matchErrors: result.matchErrors } : {}),
    }));

    // Champion/role ingestion, once the last successful run is ~10 minutes
    // old and no failed run is backing off — or on demand for a drain.
    const analyticsStartedAt = Date.now();
    try {
      if (
        process.env.FORCE_ANALYTICS === "1" ||
        analyticsPhaseDue(analyticsStartedAt, await readAnalyticsHeartbeat(d1), await readAnalyticsRetry(d1))
      ) {
        const outcome = await runAnalyticsPhase(store, apiKey, analyticsStartedAt);
        console.log(JSON.stringify({
          event: "tracker_runner_analytics",
          status: outcome,
          durationMs: Date.now() - analyticsStartedAt,
        }));
      }
    } catch (error) {
      // Analytics lag must not mark a tracker run that succeeded as failed.
      console.error(JSON.stringify({
        event: "tracker_runner_analytics",
        status: "failed",
        durationMs: Date.now() - analyticsStartedAt,
        error: error instanceof Error ? error.message : String(error),
      }));
      // Back off before the next try; see `ANALYTICS_RETRY_DELAY_MS`.
      try {
        await store.blockLaneUntil(ANALYTICS_RETRY_LANE, analyticsStartedAt + ANALYTICS_RETRY_DELAY_MS);
      } catch {
        // Best-effort: losing it only means the next tick retries straight away.
      }
    }
    // A skipped run is not a failure: another run holds the lane, which is the
    // lease doing its job. Only a thrown run is worth a non-zero exit, so the
    // timer's `OnFailure` and the journal mean what they say.
  } catch (error) {
    console.error(JSON.stringify({
      event: "tracker_runner",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  } finally {
    database.close();
  }
}

await main();
