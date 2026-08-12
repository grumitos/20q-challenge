import assert from "node:assert/strict";
import test from "node:test";

import { createDemoSnapshot } from "../lib/leaderboard.ts";
import { getLeaderboard } from "../lib/leaderboard-service.ts";

test("returns a cache younger than sixty seconds without calling Riot", async () => {
  const now = Date.parse("2026-07-13T18:00:00.000Z");
  const cached = createDemoSnapshot(new Date(now - 59 * 1000));
  let refreshCalls = 0;

  const payload = await getLeaderboard({
    now,
    hasApiKey: true,
    readCache: async () => ({ snapshot: cached, fetchedAt: now - 59 * 1000 }),
    writeCache: async () => {},
    fetchFresh: async () => { refreshCalls += 1; return createDemoSnapshot(new Date(now)); },
  });

  assert.equal(payload.meta.source, "cache");
  assert.equal(payload.meta.isStale, false);
  assert.equal(refreshCalls, 0);
});

test("refreshes live rank data once the cache is sixty seconds old", async () => {
test("forces a configured-member refresh while preserving the fresh cache as baseline", async () => {
  const now = Date.parse("2026-07-27T05:00:00.000Z");
  const cached = createDemoSnapshot(new Date(now - 1_000));
  let receivedBaseline = null;

  const payload = await getLeaderboard({
    now,
    hasApiKey: true,
    forceRefresh: true,
    readCache: async () => ({ snapshot: cached, fetchedAt: now - 1_000 }),
    writeCache: async () => {},
    fetchFresh: async (baseline) => {
      receivedBaseline = baseline;
      return createDemoSnapshot(new Date(now));
    },
  });

  assert.equal(payload.meta.source, "riot");
  assert.equal(receivedBaseline, cached);
});

  const now = Date.parse("2026-07-13T18:00:00.000Z");
  const cached = createDemoSnapshot(new Date(now - 60 * 1000));
  const fresh = createDemoSnapshot(new Date(now));
  const freshPiper = fresh.players.find((player) => player.gameName === "PiperTwin");
  assert.ok(freshPiper);
  freshPiper.leaguePoints = 4;

  const payload = await getLeaderboard({
    now,
    hasApiKey: true,
    readCache: async () => ({ snapshot: cached, fetchedAt: now - 60 * 1000 }),
    writeCache: async () => {},
    fetchFresh: async () => fresh,
  });

  assert.equal(payload.meta.source, "riot");
  assert.equal(payload.data.players.find((player) => player.gameName === "PiperTwin")?.leaguePoints, 4);
});

test("refreshes a stale cache and persists the new Riot snapshot", async () => {
  const now = Date.parse("2026-07-13T18:00:00.000Z");
  const stale = createDemoSnapshot(new Date(now - 2 * 60 * 60 * 1000));
  const fresh = createDemoSnapshot(new Date(now));
  let written = null;

  const payload = await getLeaderboard({
    now,
    hasApiKey: true,
    readCache: async () => ({ snapshot: stale, fetchedAt: now - 2 * 60 * 60 * 1000 }),
    writeCache: async (snapshot) => { written = snapshot; },
    fetchFresh: async () => fresh,
  });

  assert.equal(payload.meta.source, "riot");
  assert.equal(payload.meta.isStale, false);
  assert.equal(written, fresh);
});

test("serves stale cache data when Riot is temporarily unavailable", async () => {
  const now = Date.parse("2026-07-13T18:00:00.000Z");
  const stale = createDemoSnapshot(new Date(now - 2 * 60 * 60 * 1000));

  const payload = await getLeaderboard({
    now,
    hasApiKey: true,
    readCache: async () => ({ snapshot: stale, fetchedAt: now - 2 * 60 * 60 * 1000 }),
    writeCache: async () => {},
    fetchFresh: async () => { throw new Error("temporary failure"); },
  });

  assert.equal(payload.meta.source, "cache");
  assert.equal(payload.meta.isStale, true);
  assert.match(payload.meta.notice, /última actualización/i);
});

test("uses demo data when the API key has not been configured", async () => {
  const now = Date.parse("2026-07-13T18:00:00.000Z");
  const payload = await getLeaderboard({
    now,
    hasApiKey: false,
    readCache: async () => null,
    writeCache: async () => {},
    fetchFresh: async () => { throw new Error("must not run"); },
  });

  assert.equal(payload.meta.source, "demo");
  assert.equal(payload.meta.isStale, false);
  assert.match(payload.meta.notice, /Riot API key/i);
});
