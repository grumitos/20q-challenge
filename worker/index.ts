/** Cloudflare Worker entry point. */
import handler from "vinext/server/app-router-entry";
import { refreshLeaderboard, refreshSeasonBackfill } from "../lib/refresh-leaderboard";
import { getD1 } from "../db";
import { createLpTrackerStore } from "../db/lp-tracker-store";
import { runTemporalLpTracker } from "../lib/lp-tracker";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  RIOT_API_KEY?: string;
  /** Shared with the cron Worker, which drives the schedules over HTTP because
      Pages has no `scheduled` handler. Absent means the endpoints stay shut. */
  CRON_SECRET?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface CronController {
  scheduledTime: number;
  cron: string;
}

/** The work the `scheduled` handler used to own. Pages cannot run crons, so the
    cron Worker calls these over HTTP on the same two schedules. */
async function runLeaderboardRefresh(env: Env, now: number) {
  const apiKey = (env.RIOT_API_KEY ?? "").trim();
  if (!apiKey) return;
  const store = createLpTrackerStore(await getD1());
  const owner = crypto.randomUUID();
  // The lease is what keeps a public endpoint from being a way to make the
  // Worker hammer Riot: a second caller inside the window is turned away here.
  if (!await store.acquireLease("leaderboard-analytics", owner, now, 10 * 60_000)) return;
  try {
    // Strict: this caller drops the payload, so a swallowed failure here is a
    // refresh that silently stops happening. The endpoint turns it into a 500.
    await refreshLeaderboard(apiKey, now, true, true);
  } finally {
    await store.releaseLease("leaderboard-analytics", owner);
  }
}

/** Its own lane, and its own subrequest allowance — see `backfillSeasonAnalytics`
    for why this cannot share an invocation with the rank refresh. */
async function runSeasonBackfill(env: Env, now: number) {
  const apiKey = (env.RIOT_API_KEY ?? "").trim();
  if (!apiKey) return;
  const store = createLpTrackerStore(await getD1());
  const owner = crypto.randomUUID();
  // Deliberately the tracker's own lane, not one of its own: the tracker
  // rewrites the entire cached snapshot from the copy it read at the start of
  // its run, so a backfill that overlapped it had its batch overwritten. They
  // must never hold the cache at the same time.
  // Ninety seconds, matching the tracker's own TTL, because nothing renews this
  // one either. A backfill killed for exceeding its CPU budget never releases,
  // and it holds the *tracker's* lane while it sits there — two minutes of that
  // is two skipped tracker ticks every time, which is most of the four-minute
  // window the live-game card is allowed to go unconfirmed.
  if (!await store.acquireLease("lp-tracker", owner, now, 90_000)) return;
  try {
    await refreshSeasonBackfill(apiKey, now);
  } finally {
    await store.releaseLease("lp-tracker", owner);
  }
}

async function runLpTracker(env: Env, now: number) {
  const apiKey = (env.RIOT_API_KEY ?? "").trim();
  if (!apiKey) return;
  await runTemporalLpTracker({ store: createLpTrackerStore(await getD1()), apiKey, now });
}

/** Constant-time-ish compare so the shared secret cannot be probed byte by byte. */
function secretMatches(expected: string, received: string) {
  if (expected.length !== received.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  }
  return difference === 0;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/cron/leaderboard" || url.pathname === "/api/cron/lp-tracker" ||
        url.pathname === "/api/cron/backfill") {
      const secret = (env.CRON_SECRET ?? "").trim();
      const offered = request.headers.get("x-cron-secret") ?? "";
      // No secret configured means the endpoint is closed, not open: otherwise a
      // missing binding would silently publish the tracker to the internet.
      if (!secret || !secretMatches(secret, offered)) {
        return new Response("Not found", { status: 404 });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

      const lane = url.pathname.slice("/api/cron/".length);
      const startedAt = Date.now();
      // Awaited, not handed to `ctx.waitUntil`. That only extends execution about
      // thirty seconds past the response, where the cron trigger this replaced
      // had minutes — so a run slowed by Riot's Retry-After would be reaped in
      // flight, after writing observations and before releasing its lease. The
      // caller awaits this response, so the work lives as long as the request.
      try {
        if (lane === "leaderboard") await runLeaderboardRefresh(env, startedAt);
        else if (lane === "backfill") await runSeasonBackfill(env, startedAt);
        else await runLpTracker(env, startedAt);
      } catch (error) {
        // The caller only ever saw a 202, so a failure here used to be invisible
        // on both sides. Say it in the log and in the status code.
        console.log(JSON.stringify({
          event: "cron_endpoint",
          lane,
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }));
        return new Response("Cron run failed", { status: 500 });
      }
      console.log(JSON.stringify({
        event: "cron_endpoint",
        lane,
        status: "completed",
        durationMs: Date.now() - startedAt,
      }));
      return new Response(null, { status: 204 });
    }

    // Served from the Worker's own cache when it can be. A `Cache-Control` header
    // alone does not do this: Cloudflare does not cache dynamic responses off the
    // header, which the absence of `cf-cache-status` made plain. So every poll
    // from every open tab was reaching the enrichment — the failures tracked the
    // number of viewers rather than anything about the data, which is exactly
    // what the report of "several browsers" described.
    //
    // The payload is public, identical for everyone, and only changes when the
    // cron writes it, so one invocation per window can answer everyone.
    if (url.pathname === "/api/leaderboard" && request.method === "GET") {
      // Absent outside the Cloudflare runtime — the test harness runs this worker
      // under Node — and a cache is an optimisation, so its absence must not be
      // an error.
      const cache = typeof caches === "undefined" ? null : caches.default;
      const cached = await cache?.match(request);
      if (cached) return cached;
      const response = await handler.fetch(request, env, ctx);
      // Only a good answer is worth keeping, and `clone` because a body can be
      // read once: the reader gets one copy, the cache the other.
      if (cache && response.ok) ctx.waitUntil(cache.put(request, response.clone()));
      return response;
    }

    return handler.fetch(request, env, ctx);
  },
  // Kept for a Workers deployment, where crons run in-process. On Pages this
  // never fires and the cron Worker drives the same two paths over HTTP.
  async scheduled(controller: CronController, env: Env): Promise<void> {
    if (controller.cron === "7,37 * * * *") {
      await runLeaderboardRefresh(env, controller.scheduledTime);
      return;
    }
    await runLpTracker(env, controller.scheduledTime);
  },
};

export default worker;
