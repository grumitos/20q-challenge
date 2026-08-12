import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = async (path) =>
  (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

const [viteConfig, worker, cronConfig] = await Promise.all([
  readSource("../vite.config.ts"),
  readSource("../worker/index.ts"),
  readSource("../cron-worker/wrangler.jsonc"),
]);

test("runs temporal tracking every minute and separates analytics backfill", () => {
  // Pages has no `scheduled` handler, so `cron-worker` owns both schedules and
  // drives the site over HTTP. `vite.config.ts` keeps them only for local dev.
  assert.match(cronConfig, /"crons"\s*:\s*\[\s*"\* \* \* \* \*",\s*"7,37 \* \* \* \*"\s*\]/);
  assert.match(viteConfig, /triggers:\s*\{\s*crons:\s*\["\* \* \* \* \*",\s*"7,37 \* \* \* \*"\]/);
});

test("the reader route reads, and leaves refreshing to the cron", async () => {
  // The cache lasts 55s and the browser polls every 60s, so nearly every poll
  // found it stale and ran the whole temporal tracker inside the visitor's own
  // request. On the free plan's per-invocation CPU allowance that intermittently
  // exceeded the limit: real visitors got 1102, and the same work driven from
  // the cron failed about one run in nine.
  const route = await readSource("../app/api/leaderboard/route.ts");
  assert.match(route, /readLeaderboardCache/);
  assert.match(route, /enrichPlayers/);
  assert.doesNotMatch(route, /runTemporalLpTracker/);
  assert.doesNotMatch(route, /refreshRecent/);
});

test("keeps the worker request-driven", () => {
  assert.match(worker, /async fetch\s*\(/);
  assert.match(worker, /return handler\.fetch\(request, env, ctx\)/);
});

// The cron endpoints' behaviour — the 404 gate, the method check, and the work
// running inside the request rather than in `waitUntil` — is exercised against
// the built Worker in `cron-endpoints.test.mjs`. Asserting the same properties
// as regexes over this file only ever proved the source still looked right.

test("one compatibility date, not three", async () => {
  // Local dev, the cron Worker and the Pages dashboard each carried their own
  // before this. The dashboard's cannot be asserted from here, so the README
  // records it and these two must at least agree with each other.
  const dates = [
    viteConfig.match(/compatibility_date:\s*"([\d-]+)"/)?.[1],
    cronConfig.match(/"compatibility_date"\s*:\s*"([\d-]+)"/)?.[1],
  ];
  assert.equal(dates[0], dates[1], "vite.config.ts and cron-worker must agree");
  const readme = await readSource("../README.md");
  assert.ok(
    readme.includes(dates[0]),
    `the README must record the compatibility date in use (${dates[0]})`,
  );
});
