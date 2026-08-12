import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import cronWorker, { triggerCron } from "../cron-worker/index.ts";

const SITE = "https://20q-challenge.pages.dev";

test("carries the shared secret to the site's cron endpoint and releases the response", async () => {
  let request;
  let response;
  await triggerCron("lp-tracker", "s3cret", undefined, async (input, init) => {
    request = { input: String(input), method: init.method, secret: new Headers(init.headers).get("x-cron-secret") };
    response = new Response(null, { status: 204 });
    return response;
  });

  assert.deepEqual(request, {
    input: `${SITE}/api/cron/lp-tracker`,
    method: "POST",
    secret: "s3cret",
  });
});

test("targets the configured origin so a rename does not need a code change", async () => {
  let target;
  await triggerCron("leaderboard", "s3cret", "https://20q.example.com", async (input) => {
    target = String(input);
    return new Response(null, { status: 204 });
  });

  assert.equal(target, "https://20q.example.com/api/cron/leaderboard");
});

test("surfaces a rejected cron instead of reporting a silent success", async () => {
  // The endpoint runs the job inside the request, so a non-2xx here means the
  // run actually failed — not merely that it was not accepted.
  await assert.rejects(
    triggerCron("lp-tracker", "wrong", undefined, async () => new Response("nope", { status: 404 })),
    /Cron lp-tracker failed \(404\)/,
  );
  await assert.rejects(
    triggerCron("leaderboard", "s3cret", undefined, async () => new Response("boom", { status: 500 })),
    /Cron leaderboard failed \(500\)/,
  );
});

test("refuses to run at all when the shared secret is missing", async () => {
  await assert.rejects(
    cronWorker.scheduled({ cron: "* * * * *" }, {}),
    /CRON_SECRET is not configured/,
  );
});

test("drives only tracking each minute, and both lanes on the analytics tick", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), secret: new Headers(init.headers).get("x-cron-secret") });
    return new Response(null, { status: 204 });
  };

  try {
    await cronWorker.scheduled({ cron: "* * * * *", scheduledTime: Date.UTC(2026, 7, 11, 5, 1) }, { CRON_SECRET: "s3cret" });
    assert.deepEqual(calls.map(({ url }) => url), [`${SITE}/api/cron/lp-tracker`]);

    calls.length = 0;
    // The minute tick already drives tracking at :07, so the analytics trigger
    // only owns the refresh — running both here just duplicated work the lease
    // then had to turn away.
    await cronWorker.scheduled({ cron: "7,37 * * * *", scheduledTime: Date.UTC(2026, 7, 11, 5, 7) }, { CRON_SECRET: "s3cret" });
    assert.deepEqual(calls.map(({ url }) => url), [`${SITE}/api/cron/leaderboard`]);
    assert.deepEqual([...new Set(calls.map(({ secret }) => secret))], ["s3cret"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("one failing lane neither hides nor suppresses the other", async () => {
  // Sequenced awaits meant a rejected lane also skipped the rest of that
  // minute's work, and the Worker's log showed only the first failure.
  const reached = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    reached.push(url);
    return url.endsWith("/backfill")
      ? new Response("boom", { status: 500 })
      : new Response(null, { status: 204 });
  };

  try {
    await assert.rejects(
      cronWorker.scheduled(
        { cron: "* * * * *", scheduledTime: Date.UTC(2026, 7, 11, 5, 5) },
        { CRON_SECRET: "s3cret" },
      ),
      /Cron backfill failed \(500\)/,
    );
    assert.equal(
      reached.some((url) => url.endsWith("/lp-tracker")),
      true,
      "tracking must still be driven when the backfill lane fails",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the companion Worker is private and keeps only the triggers that fire", async () => {
  const config = await readFile(new URL("../cron-worker/wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"workers_dev"\s*:\s*false/);
  // A `*/5 * * * *` trigger was registered for the backfill and Cloudflare
  // never fired it — thirty minutes of logs showed the other two running and
  // that one absent every time. Its cadence comes from the minute tick instead.
  assert.match(config, /"crons"\s*:\s*\[\s*"\* \* \* \* \*",\s*"7,37 \* \* \* \*"\s*\]/);
  assert.doesNotMatch(config, /\*\/5/);
});

test("adds the backfill to every fifth minute of the tick that does fire", async () => {
  const at = async (minute) => {
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input) => { calls.push(String(input).split("/api/cron/")[1]); return new Response(null, { status: 204 }); };
    try {
      await cronWorker.scheduled(
        { cron: "* * * * *", scheduledTime: Date.UTC(2026, 7, 11, 5, minute) },
        { CRON_SECRET: "s3cret" },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    return calls.sort();
  };

  assert.deepEqual(await at(0), ["backfill", "lp-tracker"]);
  assert.deepEqual(await at(5), ["backfill", "lp-tracker"]);
  assert.deepEqual(await at(35), ["backfill", "lp-tracker"]);
  assert.deepEqual(await at(1), ["lp-tracker"]);
  assert.deepEqual(await at(37), ["lp-tracker"]);
});

test("still runs the backfill when the platform omits scheduledTime", async () => {
  // `new Date(undefined)` is an Invalid Date and `NaN % 5` is never 0, so a
  // missing field would have disabled the backfill silently and permanently.
  const calls = [];
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = async (input) => { calls.push(String(input).split("/api/cron/")[1]); return new Response(null, { status: 204 }); };
  Date.now = () => Date.UTC(2026, 7, 11, 6, 10);
  try {
    await cronWorker.scheduled({ cron: "* * * * *" }, { CRON_SECRET: "s3cret" });
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
  assert.deepEqual(calls.sort(), ["backfill", "lp-tracker"]);
});

test("drives the lanes one after another, never at the same time", async () => {
  // The tracker rewrites the whole cached snapshot from the copy it read when
  // it started. Run alongside it, a backfill batch was overwritten seconds
  // after being written — the counter stood still for twenty minutes while
  // every invocation reported success.
  const events = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const lane = String(input).split("/api/cron/")[1];
    events.push(`start:${lane}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push(`end:${lane}`);
    return new Response(null, { status: 204 });
  };
  try {
    await cronWorker.scheduled(
      { cron: "* * * * *", scheduledTime: Date.UTC(2026, 7, 11, 6, 5) },
      { CRON_SECRET: "s3cret" },
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  // Every lane closes before the next opens.
  for (let index = 0; index < events.length; index += 2) {
    assert.match(events[index], /^start:/);
    assert.match(events[index + 1], /^end:/);
    assert.equal(events[index].slice(6), events[index + 1].slice(4));
  }
  assert.equal(events.length, 4, "both lanes must run");
});
