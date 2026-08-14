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
import { RIOT_PLAYERS } from "../lib/riot-client.ts";

/**
 * The Worker's defaults exist because of its 10 ms CPU ceiling; out here the
 * only limits that matter are Riot's, and the registered app key's are generous
 * (2,000 match details per 10 s, 3,000 spectator per 10 s, 20,000 rank reads
 * per 10 s). One detail per player per tick is all a minute can produce anyway
 * — nine players cannot finish more than nine games between ticks — so the cap
 * is the roster size, and the request budget just needs to never be the thing
 * that stops a run: fixed cost ~28 plus details plus enrolment leaves 120 as
 * "cannot bind" rather than a number to tune.
 */
const RUNNER_MAX_REQUESTS = 120;
const RUNNER_MATCH_DETAILS_PER_RUN = RIOT_PLAYERS.length;

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
