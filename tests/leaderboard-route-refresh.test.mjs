import assert from "node:assert/strict";
import test from "node:test";

import { getLeaderboardForRequest } from "../lib/leaderboard-route.ts";
import { createDemoSnapshot } from "../lib/leaderboard.ts";
import { handleApiRequest } from "../vps/api-handler.ts";

test("refreshes a stale cache through the lightweight tracker before responding", async () => {
  const now = Date.UTC(2026, 6, 26, 12);
  let cached = {
    snapshot: createDemoSnapshot(new Date(now - 86_400_000)),
    fetchedAt: now - 86_400_000,
  };
  let refreshes = 0;

  const payload = await getLeaderboardForRequest({
    now,
    apiKey: "production-secret",
    readCache: async () => cached,
    refreshRecent: async () => {
      refreshes += 1;
      cached = {
        snapshot: createDemoSnapshot(new Date(now)),
        fetchedAt: now,
      };
    },
  });

  assert.equal(refreshes, 1);
  assert.equal(payload.meta.isStale, false);
  assert.equal(payload.data.fetchedAt, new Date(now).toISOString());
});

test("does not call Riot while the cache is fresh", async () => {
  const now = Date.UTC(2026, 6, 26, 12);
  let refreshes = 0;
  const cached = {
    snapshot: createDemoSnapshot(new Date(now - 1_000)),
    fetchedAt: now - 1_000,
  };

  const payload = await getLeaderboardForRequest({
    now,
    apiKey: "production-secret",
    readCache: async () => cached,
    refreshRecent: async () => { refreshes += 1; },
  });

  assert.equal(refreshes, 0);
  assert.equal(payload.meta.isStale, false);
});

test("refreshes just before the one-minute boundary so the cloud cron does not skip a cycle", async () => {
  const now = Date.UTC(2026, 6, 26, 12);
  let refreshes = 0;
  let cached = {
    snapshot: createDemoSnapshot(new Date(now - 59_000)),
    fetchedAt: now - 59_000,
  };

  const payload = await getLeaderboardForRequest({
    now,
    apiKey: "production-secret",
    readCache: async () => cached,
    refreshRecent: async () => {
      refreshes += 1;
      cached = {
        snapshot: createDemoSnapshot(new Date(now)),
        fetchedAt: now,
      };
    },
  });

  assert.equal(refreshes, 1);
  assert.equal(payload.meta.isStale, false);
  assert.equal(payload.meta.cacheTtlSeconds, 60);
});

test("bootstraps a newly configured member before the lightweight refresh path", async () => {
  const now = Date.UTC(2026, 6, 27, 5);
  const legacy = createDemoSnapshot(new Date(now - 1_000));
  legacy.players = legacy.players.slice(0, -1);
  let cached = { snapshot: legacy, fetchedAt: now - 1_000 };
  let configuredRefreshes = 0;
  let recentRefreshes = 0;

  const payload = await getLeaderboardForRequest({
    now,
    apiKey: "production-secret",
    readCache: async () => cached,
    refreshConfiguredPlayers: async () => {
      configuredRefreshes += 1;
      const current = createDemoSnapshot(new Date(now));
      cached = { snapshot: current, fetchedAt: now };
    },
    refreshRecent: async () => { recentRefreshes += 1; },
  });

  assert.equal(configuredRefreshes, 1);
  assert.equal(recentRefreshes, 0);
  assert.equal(payload.data.players.length, 9);
});

test("serves stale cache safely when the Riot secret is absent", async () => {
  const now = Date.UTC(2026, 6, 26, 12);
  let refreshes = 0;
  const cached = {
    snapshot: createDemoSnapshot(new Date(now - 86_400_000)),
    fetchedAt: now - 86_400_000,
  };

  const payload = await getLeaderboardForRequest({
    now,
    apiKey: "",
    readCache: async () => cached,
    refreshRecent: async () => { refreshes += 1; },
  });

  assert.equal(refreshes, 0);
  assert.equal(payload.meta.isStale, true);
});

test("still serves demo data to local development when nothing is cached", async () => {
  // The VPS API answers 503 in this case (below); the shared route itself must
  // not change, because `app/api/leaderboard/route.ts` relies on it locally.
  const payload = await getLeaderboardForRequest({
    now: Date.UTC(2026, 8, 29, 12),
    apiKey: "",
    readCache: async () => null,
  });

  assert.equal(payload.meta.source, "demo");
  assert.ok(payload.data.players.length > 0);
});

const API_NOW = Date.UTC(2026, 8, 29, 12);

function apiDeps(overrides = {}) {
  return {
    publicWebOrigin: "https://20q-challenge.pages.dev",
    now: () => API_NOW,
    readCache: async () => ({ snapshot: createDemoSnapshot(new Date(API_NOW - 30_000)), fetchedAt: API_NOW - 30_000 }),
    enrich: async (players) => ({ players: [...players], duos: [{ enriched: true }] }),
    ...overrides,
  };
}

function apiRequest(path, init) {
  return new Request(`http://127.0.0.1:8200${path}`, init);
}

test("the VPS API grants CORS to the site and its Pages previews, and to nobody else", async () => {
  for (const origin of [
    "https://20q-challenge.pages.dev",
    "https://3f2a91c4.20q-challenge.pages.dev",
    "https://fix-backend-resilience.20q-challenge.pages.dev",
  ]) {
    const response = await handleApiRequest(apiRequest("/api/leaderboard", { headers: { Origin: origin } }), apiDeps());
    assert.equal(response.status, 200, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), origin, "the caller's own origin is echoed");
    assert.equal(response.headers.get("vary"), "Origin");
    assert.deepEqual((await response.json()).data.duos, [{ enriched: true }]);

    const preflight = await handleApiRequest(apiRequest("/api/leaderboard", { method: "OPTIONS", headers: { Origin: origin } }), apiDeps());
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  }

  for (const origin of [
    "https://evil.example",
    "http://20q-challenge.pages.dev",
    "https://20q-challenge.pages.dev.evil.example",
    "https://a.b.20q-challenge.pages.dev",
    "https://other-project.pages.dev",
    "null",
  ]) {
    const response = await handleApiRequest(apiRequest("/api/leaderboard", { headers: { Origin: origin } }), apiDeps());
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }

  // No Origin at all is not a cross-origin request: served, with no grant.
  const direct = await handleApiRequest(apiRequest("/api/leaderboard"), apiDeps());
  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get("access-control-allow-origin"), null);
  assert.equal(direct.headers.get("vary"), "Origin");
  assert.equal((await handleApiRequest(apiRequest("/nope"), apiDeps())).status, 404);
});

test("the VPS API answers 503 instead of passing demo players off as the board", async () => {
  const origin = "https://20q-challenge.pages.dev";
  const response = await handleApiRequest(
    apiRequest("/api/leaderboard", { headers: { Origin: origin } }),
    apiDeps({
      readCache: async () => null,
      enrich: async () => { throw new Error("there is nothing to enrich"); },
    }),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "no_snapshot" });
  assert.equal(response.headers.get("access-control-allow-origin"), origin, "the page must be able to read the error");
  assert.equal(response.headers.get("cache-control"), "no-store", "an empty board must not be cached");
});

test("healthz stays 200 and reports how old the snapshot is", async () => {
  const fresh = await handleApiRequest(apiRequest("/healthz"), apiDeps({
    readCache: async () => ({ snapshot: createDemoSnapshot(new Date(API_NOW - 42_500)), fetchedAt: API_NOW - 42_500 }),
  }));
  assert.equal(fresh.status, 200);
  assert.deepEqual(await fresh.json(), {
    ok: true,
    fetchedAt: new Date(API_NOW - 42_500).toISOString(),
    ageSeconds: 42,
  });
  assert.equal(fresh.headers.get("cache-control"), "no-store");

  for (const readCache of [async () => null, async () => { throw new Error("database is locked"); }]) {
    const empty = await handleApiRequest(apiRequest("/healthz"), apiDeps({ readCache }));
    assert.equal(empty.status, 200, "deploy smokes depend on it");
    assert.deepEqual(await empty.json(), { ok: true, fetchedAt: null, ageSeconds: null });
  }
});
