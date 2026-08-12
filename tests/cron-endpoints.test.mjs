import assert from "node:assert/strict";
import test from "node:test";

/**
 * Exercises the real built Worker. Every property below used to be "covered" by
 * a regex over `worker/index.ts` — which passes just as happily when the gate is
 * broken, as long as the source still contains the right-looking line.
 */
async function callCron(pathname, { method = "POST", secret, env = {} } = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  const headers = secret === undefined ? {} : { "x-cron-secret": secret };
  const deferred = [];
  const response = await worker.fetch(
    new Request(`http://localhost${pathname}`, { method, headers }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ...env },
    { waitUntil: (promise) => deferred.push(promise), passThroughOnException() {} },
  );
  return { response, deferred };
}

const LANES = ["/api/cron/lp-tracker", "/api/cron/leaderboard", "/api/cron/backfill"];

for (const lane of LANES) {
  test(`${lane} is invisible without the shared secret`, async () => {
    // 404 rather than 401: an unauthenticated caller must not be able to tell
    // the route exists at all.
    const { response } = await callCron(lane);
    assert.equal(response.status, 404);
  });

  test(`${lane} is invisible when the secret is wrong`, async () => {
    const { response } = await callCron(lane, { secret: "wrong", env: { CRON_SECRET: "right" } });
    assert.equal(response.status, 404);
  });

  test(`${lane} stays shut when no secret is configured`, async () => {
    // A missing binding must close the endpoint, not open it — otherwise a
    // forgotten secret silently publishes the tracker to the internet.
    const { response } = await callCron(lane, { secret: "anything" });
    assert.equal(response.status, 404);
  });

  test(`${lane} refuses a GET even with the right secret`, async () => {
    const { response } = await callCron(lane, {
      method: "GET",
      secret: "right",
      env: { CRON_SECRET: "right" },
    });
    assert.equal(response.status, 405);
  });
}

test("an authorised run does the work inside the request, not in waitUntil", async () => {
  // The endpoint returned 202 and deferred the job, which capped it at roughly
  // thirty seconds where the cron trigger it replaced had minutes. Nothing may
  // be left pending when the response resolves.
  const { response, deferred } = await callCron("/api/cron/lp-tracker", {
    secret: "right",
    env: { CRON_SECRET: "right" },
  });

  assert.equal(deferred.length, 0, "cron work must not be deferred to waitUntil");
  // No RIOT_API_KEY is configured here, so the run is a no-op and completes.
  assert.equal(response.status, 204);
});

test("a secret that differs only in length is still refused", async () => {
  const { response } = await callCron("/api/cron/lp-tracker", {
    secret: "right-but-longer",
    env: { CRON_SECRET: "right" },
  });
  assert.equal(response.status, 404);
});

test("the cron paths are not reachable through the app router", async () => {
  // The gate lives in `fetch` ahead of the router; if the router ever claimed
  // these paths they would answer without the secret being checked.
  const { response } = await callCron("/api/cron/lp-tracker", { method: "GET" });
  assert.equal(response.status, 404);
});
