import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ANALYTICS_HEARTBEAT_TTL_MS,
  ANALYTICS_INTERVAL_MS,
  analyticsPhaseDue,
} from "../vps/analytics-schedule.ts";

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

test("runs VPS analytics about every ten minutes however the timer's ticks drift", () => {
  // `getUTCMinutes() % 10 === 0` needed a tick inside one exact minute. The
  // systemd timer's ticks drift 60–70 s apart, which left ~130 runs a day
  // instead of ~144. The rule is elapsed time since the last successful run,
  // read back from the heartbeat that run stamped.
  const gaps = [61_000, 67_000, 70_000, 64_000, 69_000, 62_000, 66_000, 60_000, 68_000, 65_000];
  const start = Date.UTC(2026, 8, 29, 0, 0, 20);
  let heartbeat = null;
  const runs = [];
  let minuteRuleRuns = 0;
  for (let tick = 0, now = start; now < start + 24 * 60 * 60_000; now += gaps[tick % gaps.length], tick += 1) {
    if (new Date(now).getUTCMinutes() % 10 === 0) minuteRuleRuns += 1;
    if (!analyticsPhaseDue(now, heartbeat)) continue;
    runs.push(now);
    heartbeat = Math.max(heartbeat ?? 0, now + ANALYTICS_HEARTBEAT_TTL_MS);
  }

  // Never sooner than the interval and never more than one tick after it, so
  // the daily count follows the ticks (135–151) instead of losing windows.
  const spacing = runs.slice(1).map((at, index) => at - runs[index]);
  assert.ok(Math.min(...spacing) >= ANALYTICS_INTERVAL_MS, "never twice inside one interval");
  assert.ok(Math.max(...spacing) < ANALYTICS_INTERVAL_MS + 70_000, "never more than one tick late");
  assert.ok(
    runs.length > minuteRuleRuns,
    `${runs.length} runs a day, against ${minuteRuleRuns} for the minute rule under the same drift`,
  );
});

test("retries VPS analytics on the next tick until a run succeeds", () => {
  const lastSuccess = Date.UTC(2026, 8, 29, 12);
  const heartbeat = lastSuccess + ANALYTICS_HEARTBEAT_TTL_MS;
  assert.equal(analyticsPhaseDue(lastSuccess + 9 * 60_000, heartbeat), false);
  // A failed or skipped run stamps nothing, so every following tick is due.
  assert.equal(analyticsPhaseDue(lastSuccess + ANALYTICS_INTERVAL_MS, heartbeat), true);
  assert.equal(analyticsPhaseDue(lastSuccess + ANALYTICS_INTERVAL_MS + 65_000, heartbeat), true);
  // Nothing recorded yet means nothing has run.
  assert.equal(analyticsPhaseDue(lastSuccess, null), true);
});
