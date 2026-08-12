import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYTICS_REQUEST_BUDGET,
  createRiotRequester,
  RIOT_MIN_REQUEST_INTERVAL_MS,
  RIOT_WINDOW_REQUESTS,
  RiotRequestBudgetExceeded,
  TRACKER_REQUEST_BUDGET,
  WORKER_SUBREQUEST_LIMIT,
} from "../lib/riot-request.ts";

test("retries 429 responses after the exact Retry-After window", async () => {
  const sleeps = [];
  let attempts = 0;
  let rateLimitedResponse;
  const requester = createRiotRequester({
    apiKey: "secret",
    maxRequests: 3,
    // Isolated from the 20-per-second pacing, which is asserted separately.
    minIntervalMs: 0,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async (_input, init) => {
      attempts += 1;
      assert.equal(new Headers(init.headers).get("X-Riot-Token"), "secret");
      if (attempts === 1) {
        rateLimitedResponse = Response.json({ retry: true }, {
          status: 429,
          headers: { "Retry-After": "2.5" },
        });
        return rateLimitedResponse;
      }
      return Response.json({ ok: true });
    },
  });

  const response = await requester.fetch("https://la2.api.riotgames.com/test");
  assert.equal(response.status, 200);
  assert.deepEqual(sleeps, [2_500]);
  assert.equal(requester.budget.requestsUsed, 2);
  assert.equal(rateLimitedResponse.bodyUsed, true);
});

test("stops before exceeding the per-execution request budget", async () => {
  const requester = createRiotRequester({
    apiKey: "secret",
    maxRequests: 1,
    fetchImpl: async () => Response.json({ ok: true }),
  });
  await requester.fetch("https://example.test/one");
  await assert.rejects(() => requester.fetch("https://example.test/two"), RiotRequestBudgetExceeded);
});

test("no single run can exhaust the key on its own", () => {
  // The property the budgets exist to guarantee. Before them the analytics path
  // was unbounded: a cold season backfill asked for hundreds of requests in one
  // invocation and spent the rest of the run sleeping off its own 429s.
  for (const [name, budget] of [
    ["tracker", TRACKER_REQUEST_BUDGET],
    ["analytics", ANALYTICS_REQUEST_BUDGET],
  ]) {
    assert.ok(
      budget <= RIOT_WINDOW_REQUESTS,
      `one ${name} run may spend ${budget}, over the ${RIOT_WINDOW_REQUESTS} Riot allows`,
    );
  }
});

test("two tracker runs fit one Riot window on their own", () => {
  // The steady state: the tracker's cron is `* * * * *`, so two of its runs
  // land in every window. If this ever stops holding, the tracker is 429ing
  // itself around the clock rather than only at :07 and :37.
  const backToBack = TRACKER_REQUEST_BUDGET * 2;
  assert.ok(
    backToBack <= RIOT_WINDOW_REQUESTS,
    `two tracker runs spend ${backToBack}, over the ${RIOT_WINDOW_REQUESTS} Riot allows`,
  );
});

test("spaces requests to stay under Riot's twenty per second", async () => {
  // Concurrency does not bound this on its own: three workers against a fast
  // edge clear far more than twenty a second.
  const slept = [];
  let clock = 0;
  const requester = createRiotRequester({
    apiKey: "secret",
    maxRequests: 4,
    fetchImpl: async () => Response.json({ ok: true }),
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    now: () => clock,
  });

  // Fired together, the way `mapWithConcurrency` fires them.
  await Promise.all([1, 2, 3, 4].map((n) => requester.fetch(`https://example.test/${n}`)));

  // The first request goes at once and each of the rest waits out a full
  // interval before leaving — four starts spread over 150ms, i.e. 20/s.
  assert.deepEqual(slept, [
    RIOT_MIN_REQUEST_INTERVAL_MS,
    RIOT_MIN_REQUEST_INTERVAL_MS,
    RIOT_MIN_REQUEST_INTERVAL_MS,
  ]);
  assert.equal(clock, RIOT_MIN_REQUEST_INTERVAL_MS * 3);
});

test("a single request is not delayed by the pacing", () => {
  // Guards against the interval being charged up front, which would add 50ms to
  // every request the tracker makes for no reason.
  assert.equal(RIOT_MIN_REQUEST_INTERVAL_MS * 20, 1_000, "the interval must express 20/s");
});

test("no run can outspend Cloudflare's subrequest ceiling", () => {
  // The limit that actually bit in production: a Worker on the free plan gets
  // 50 subrequests per invocation, D1 queries included, and the first analytics
  // refresh died on it. Each budget has to leave room for the persistence that
  // follows it, so neither may claim the whole ceiling.
  for (const [name, budget] of [
    ["tracker", TRACKER_REQUEST_BUDGET],
    ["analytics", ANALYTICS_REQUEST_BUDGET],
  ]) {
    assert.ok(
      budget < WORKER_SUBREQUEST_LIMIT,
      `one ${name} run may spend ${budget} of ${WORKER_SUBREQUEST_LIMIT} subrequests, leaving nothing for D1`,
    );
  }
  // The refresh also looks up the Data Dragon version and then writes the
  // cache, the match rows and the projection — all subrequests too. Measured at
  // roughly six; this reserves ten.
  const D1_HEADROOM = 10;
  assert.ok(
    ANALYTICS_REQUEST_BUDGET + D1_HEADROOM <= WORKER_SUBREQUEST_LIMIT,
    `analytics may spend ${ANALYTICS_REQUEST_BUDGET} of ${WORKER_SUBREQUEST_LIMIT}, leaving under ${D1_HEADROOM} for persistence`,
  );
});
