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
 * store, and this points it at `createRemoteLpTrackerStore`, so the logic stays
 * in one place and there is no second copy to drift. All this file owns is
 * configuration, a single run, and an exit code.
 *
 * Intended to run under a systemd timer, one run per tick, no daemon. It listens
 * on nothing and holds no port.
 */
import { runTemporalLpTracker } from "../lib/lp-tracker.ts";
import { createRemoteLpTrackerStore } from "../lib/remote-lp-tracker-store.ts";
import { fetchRiotLeaderboard, RIOT_PLAYERS } from "../lib/riot-client.ts";

/**
 * The Worker's defaults exist because of its 10 ms CPU ceiling; out here the
 * only limits that matter are Riot's, and the registered app key's are generous
 * (2,000 match details per 10 s, 3,000 spectator per 10 s, 20,000 rank reads
 * per 10 s). The request budget is still shared with analytics and Cloudflare's
 * fallback, so this runner deliberately uses the same 30-request ceiling as the
 * Worker even though the VPS itself has more CPU and Riot capacity.
 */
const RUNNER_MAX_REQUESTS = 30;
const RUNNER_MATCH_DETAILS_PER_RUN = 2;

/**
 * The analytics phase — champion and role ingestion — runs here too, on every
 * tenth minute. It lived only in the Worker, where the 10 ms CPU allowance
 * froze it for a month once the backlog outgrew one invocation; out here a
 * small bounded batch keeps normal games fresh without consuming the window
 * needed by the minute-by-minute tracker. The Worker's lane stays enabled as
 * the standby, same as the tracker's.
 */
const RUNNER_ANALYTICS_DETAILS_PER_RUN = 5;
const RUNNER_ANALYTICS_MAX_REQUESTS = 32;
const ANALYTICS_HEARTBEAT_TTL_MS = 12 * 60_000;

async function runAnalyticsPhase(
  store: ReturnType<typeof createRemoteLpTrackerStore>,
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
        "leaderboard-analytics-heartbeat",
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
    // missing secret would otherwise fill the journal with indistinguishable
    // 404s from the store endpoint refusing it.
    console.error(JSON.stringify({ event: "tracker_runner", status: "misconfigured", missing: name }));
    process.exit(78); // EX_CONFIG
  }
  return value;
}

async function main() {
  const origin = (process.env.SITE_ORIGIN ?? "https://20q-challenge.pages.dev").trim();
  const secret = required("CRON_SECRET");
  const apiKey = required("RIOT_API_KEY");
  const startedAt = Date.now();

  const store = createRemoteLpTrackerStore({ origin, secret });

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
    }));

    // Champion/role ingestion, every tenth minute — or on demand for a drain.
    if (new Date(startedAt).getUTCMinutes() % 10 === 0 || process.env.FORCE_ANALYTICS === "1") {
      const analyticsStartedAt = Date.now();
      try {
        const outcome = await runAnalyticsPhase(store, apiKey, analyticsStartedAt);
        console.log(JSON.stringify({
          event: "tracker_runner_analytics",
          status: outcome,
          durationMs: Date.now() - analyticsStartedAt,
        }));
      } catch (error) {
        // Analytics lag must not mark a tracker run that succeeded as failed.
        console.error(JSON.stringify({
          event: "tracker_runner_analytics",
          status: "failed",
          durationMs: Date.now() - analyticsStartedAt,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    // A skipped run is not a failure: another run holds the lane, which is the
    // lease doing its job. Only a thrown run is worth a non-zero exit, so the
    // timer's `OnFailure` and the journal mean what they say.
    process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({
      event: "tracker_runner",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}

await main();
