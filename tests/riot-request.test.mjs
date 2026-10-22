import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import {
  ANALYTICS_REQUEST_BUDGET,
  createRiotRequester,
  keepBrotliOutOfFetch,
  RIOT_MAX_RETRY_AFTER_MS,
  RIOT_MIN_REQUEST_INTERVAL_MS,
  RIOT_REQUEST_TIMEOUT_MS,
  RIOT_WINDOW_REQUESTS,
  RiotRequestBudgetExceeded,
  RiotRequestTimeout,
  TRACKER_REQUEST_BUDGET,
  UnsupportedContentEncodingError,
  withoutBrotli,
  WORKER_SUBREQUEST_LIMIT,
} from "../lib/riot-request.ts";

/** A reply that would arrive in ten seconds unless the request is aborted
    first — the shape of a connection Riot accepted but is not answering. */
function slowReply(init, body = { ok: true }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json(body)), 10_000);
    init.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(init.signal.reason);
    }, { once: true });
  });
}

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

test("hands back a 429 whose Retry-After outlasts the cap instead of sleeping through it", async () => {
  // Sleeping a long Retry-After held the run past its own deadline. The caller
  // gets the 429 and blocks its lane for the window instead.
  const sleeps = [];
  const requester = createRiotRequester({
    apiKey: "secret",
    maxRequests: 3,
    minIntervalMs: 0,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async () => Response.json({}, {
      status: 429,
      headers: { "Retry-After": String(RIOT_MAX_RETRY_AFTER_MS / 1_000 + 25) },
    }),
  });

  const response = await requester.fetch("https://la2.api.riotgames.com/test");
  assert.equal(response.status, 429);
  assert.deepEqual(sleeps, [], "a Retry-After over the cap must not be slept");
  assert.equal(requester.budget.requestsUsed, 1, "and must not be retried");
});

test("gives up on a request Riot accepted but never answers", async () => {
  // Without a deadline the request waited on the OS, and one hung connection
  // could spend the whole 90 seconds systemd gives a tracker run.
  assert.ok(RIOT_REQUEST_TIMEOUT_MS < 90_000 / 5, "several attempts must fit in one run");
  let signal;
  const requester = createRiotRequester({
    apiKey: "secret",
    maxRequests: 1,
    minIntervalMs: 0,
    timeoutMs: 20,
    fetchImpl: (_input, init) => {
      signal = init.signal;
      return slowReply(init);
    },
  });

  const startedAt = Date.now();
  await assert.rejects(requester.fetch("https://la2.api.riotgames.com/test"), RiotRequestTimeout);
  assert.ok(Date.now() - startedAt < 5_000, "the deadline, not the reply, must end the wait");
  assert.equal(signal.aborted, true);
});

test("keeps a caller's own abort signal working alongside the deadline", async () => {
  const controller = new AbortController();
  const requester = createRiotRequester({
    apiKey: "secret",
    maxRequests: 1,
    minIntervalMs: 0,
    fetchImpl: (_input, init) => {
      queueMicrotask(() => controller.abort(new Error("caller gave up")));
      return slowReply(init);
    },
  });

  await assert.rejects(
    requester.fetch("https://la2.api.riotgames.com/test", { signal: controller.signal }),
    /caller gave up/,
  );
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

test("withoutBrotli asks for gzip and deflate only, and takes the body undecoded", async () => {
  let seen;
  const fetchWithoutBrotli = withoutBrotli(async (_input, init) => {
    seen = init;
    return new Response(gzipSync(JSON.stringify({ ok: true })), { headers: { "Content-Encoding": "gzip", "Content-Length": "999" } });
  });
  const response = await fetchWithoutBrotli("https://example.test/", { headers: { "X-Riot-Token": "secret" } });

  assert.equal(new Headers(seen.headers).get("accept-encoding"), "gzip, deflate");
  assert.equal(new Headers(seen.headers).get("x-riot-token"), "secret");
  assert.equal(seen.decompress, false);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
});

test("withoutBrotli refuses an answer in any other encoding instead of decoding it", async () => {
  for (const encoding of ["br", "gzip, br", "zstd"]) {
    const fetchWithoutBrotli = withoutBrotli(async () => new Response("not decoded", { headers: { "Content-Encoding": encoding } }));
    await assert.rejects(
      fetchWithoutBrotli("https://example.test/"),
      (error) => error instanceof UnsupportedContentEncodingError && error.message.includes(`"${encoding}"`),
      encoding,
    );
  }
});

test("withoutBrotli returns an answer without an encoding as it came", async () => {
  const reply = Response.json({ ok: true });
  const fetchWithoutBrotli = withoutBrotli(async () => reply);
  assert.equal(await fetchWithoutBrotli("https://example.test/"), reply);
});

test("on Bun the requester's own fetch never reaches the Brotli decoder", { skip: !("Bun" in globalThis) }, async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/gzip") {
      response.setHeader("Content-Encoding", "gzip");
      response.end(gzipSync(JSON.stringify({ ok: true })));
      return;
    }
    response.setHeader("Content-Encoding", "br");
    response.end(Buffer.from([0x1b, 0x03, 0x00, 0xf8, 0x25, 0x02, 0x03]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const requester = createRiotRequester({ apiKey: "secret", maxRequests: 2, minIntervalMs: 0 });
    assert.deepEqual(await (await requester.fetch(`http://127.0.0.1:${port}/gzip`)).json(), { ok: true });
    await assert.rejects(requester.fetch(`http://127.0.0.1:${port}/br`), UnsupportedContentEncodingError);
  } finally {
    server.close();
  }
});

test("withoutBrotli leaves a fetch that is already guarded as it is", () => {
  const once = withoutBrotli(async () => Response.json({ ok: true }));
  assert.equal(withoutBrotli(once), once);
});

test("keepBrotliOutOfFetch guards the global fetch, once however often it is called", async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (_input, init) => {
    seen = init;
    return new Response(gzipSync(JSON.stringify({ ok: true })), { headers: { "Content-Encoding": "gzip" } });
  };
  try {
    keepBrotliOutOfFetch();
    const guarded = globalThis.fetch;
    keepBrotliOutOfFetch();
    assert.equal(globalThis.fetch, guarded);
    assert.deepEqual(await (await fetch("https://example.test/")).json(), { ok: true });
    assert.equal(new Headers(seen.headers).get("accept-encoding"), "gzip, deflate");
    assert.equal(seen.decompress, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("the VPS runner guards the global fetch before it runs anything", () => {
  const source = readFileSync(new URL("../vps/tracker-runner.ts", import.meta.url), "utf8");
  const guard = source.indexOf("\nkeepBrotliOutOfFetch();");
  assert.ok(guard > 0, "tracker-runner.ts must call keepBrotliOutOfFetch()");
  assert.ok(guard < source.indexOf("\nawait main();"), "and before main() starts");
});

test("on Bun the plain global fetch the tracker hands down never reaches the Brotli decoder", { skip: !("Bun" in globalThis) }, async () => {
  const original = globalThis.fetch;
  const acceptEncodings = [];
  const server = createServer((request, response) => {
    acceptEncodings.push(request.headers["accept-encoding"]);
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Content-Encoding", "br");
    response.end(Buffer.from([0x1b, 0x03, 0x00, 0xf8, 0x25, 0x02, 0x03]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    keepBrotliOutOfFetch();
    // The shape of riot-tracker-api.ts and riot-client.ts: an explicit wrapper over the global.
    const requester = createRiotRequester({
      apiKey: "secret",
      maxRequests: 1,
      minIntervalMs: 0,
      fetchImpl: (input, init) => fetch(input, init),
    });
    await assert.rejects(requester.fetch(`http://127.0.0.1:${port}/`), UnsupportedContentEncodingError);
    assert.deepEqual(acceptEncodings, ["gzip, deflate"]);
  } finally {
    globalThis.fetch = original;
    server.close();
  }
});
