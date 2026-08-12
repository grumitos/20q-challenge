import assert from "node:assert/strict";
import test from "node:test";

import { getLeaderboardForRequest } from "../lib/leaderboard-route.ts";
import { createDemoSnapshot } from "../lib/leaderboard.ts";

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
