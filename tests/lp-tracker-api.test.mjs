import assert from "node:assert/strict";
import test from "node:test";

import { createRiotTrackerApi, findTrackedParticipant } from "../lib/riot-tracker-api.ts";

function response(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("uses the documented platform and regional routes for SoloQ tracking", async () => {
  const urls = [];
  let spectatorResponse;
  const api = createRiotTrackerApi({
    apiKey: "secret",
    fetchImpl: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/spectator/")) {
        spectatorResponse = response(404, { status: "not found" });
        return spectatorResponse;
      }
      if (url.includes("/ids?")) return response(200, ["LA2_123"]);
      if (url.includes("/matches/LA2_123")) return response(200, { metadata: { matchId: "LA2_123" }, info: { queueId: 420, gameStartTimestamp: 1, gameEndTimestamp: 2, participants: [] } });
      return response(200, [{ queueType: "RANKED_SOLO_5x5", tier: "SILVER", rank: "I", leaguePoints: 10, wins: 2, losses: 1 }]);
    },
  });

  const rank = await api.fetchSoloQueueEntryByPuuid("p u");
  const active = await api.fetchActiveSoloQueueGameByPuuid("p u");
  const ids = await api.fetchRecentSoloQueueMatchIds("p u", 1);
  const match = await api.fetchMatchById(ids[0]);

  assert.equal(rank?.leaguePoints, 10);
  assert.equal(active, null);
  assert.equal(spectatorResponse.bodyUsed, true);
  assert.equal(match?.matchId, "LA2_123");
  assert.match(urls[0], /^https:\/\/la2\.api\.riotgames\.com\/lol\/league\/v4\/entries\/by-puuid\/p%20u$/);
  assert.match(urls[1], /^https:\/\/la2\.api\.riotgames\.com\/lol\/spectator\/v5\/active-games\/by-summoner\/p%20u$/);
  assert.match(urls[2], /^https:\/\/americas\.api\.riotgames\.com\/lol\/match\/v5\/matches\/by-puuid\/p%20u\/ids\?queue=420&start=0&count=1$/);
  assert.match(urls[3], /^https:\/\/americas\.api\.riotgames\.com\/lol\/match\/v5\/matches\/LA2_123$/);
});

test("rejects malformed or non-SoloQ tracker responses", async () => {
  const bodies = [
    [{ queueType: "RANKED_FLEX_SR", tier: "GOLD", rank: "IV", leaguePoints: 1, wins: 1, losses: 1 }],
    { gameId: 7, gameQueueConfigId: 430, gameStartTime: 1 },
    ["LA2_1", 2],
    { metadata: { matchId: "LA2_1" }, info: { queueId: 430, participants: [] } },
  ];
  const api = createRiotTrackerApi({ apiKey: "secret", fetchImpl: async () => response(200, bodies.shift()) });

  assert.equal(await api.fetchSoloQueueEntryByPuuid("p"), null);
  assert.equal(await api.fetchActiveSoloQueueGameByPuuid("p"), null);
  await assert.rejects(() => api.fetchRecentSoloQueueMatchIds("p"), /invalid/i);
  assert.equal(await api.fetchMatchById("LA2_1"), null);
});

/**
 * Streamer mode blanks the puuid *and* the Riot ID of whoever enabled it. The
 * endpoint was queried by the tracked player's puuid, so they are certainly in
 * the game — losing them meant the live card had no champion to show.
 */
test("finds the tracked player even when streamer mode blanks their identity", () => {
  const identity = { gameName: "Wonder Boi", tagLine: "huhu" };
  const entry = (over) => ({ puuid: "", riotId: "", championId: "1", teamId: 100, ...over });

  const byPuuid = [entry({ puuid: "other", riotId: "Otro#LAS" }), entry({ puuid: "mine", riotId: "Wonder Boi#huhu" })];
  assert.equal(findTrackedParticipant(byPuuid, "mine", identity), 1);

  // Only the puuid withheld: the Riot ID still names them, in any casing.
  const byRiotId = [entry({ puuid: "other", riotId: "Otro#LAS" }), entry({ riotId: "wonder boi#HUHU" })];
  assert.equal(findTrackedParticipant(byRiotId, "mine", identity), 1);

  // Both withheld, and they are the only anonymous player in the lobby.
  const soleAnonymous = [entry({ puuid: "other", riotId: "Otro#LAS" }), entry({})];
  assert.equal(findTrackedParticipant(soleAnonymous, "mine", identity), 1);

  // Two anonymous players: guessing between them would put the wrong champion
  // on the card, so the search gives up instead.
  assert.equal(findTrackedParticipant([entry({}), entry({})], "mine", identity), null);
});

test("reads the live champion and the team slots out of a spectator payload", async () => {
  const participants = [
    { puuid: "", riotId: "", championId: 82, teamId: 100 },
    { puuid: "ally", riotId: "Ally#LAS", championId: 64, teamId: 100 },
    { puuid: "foe", riotId: "Foe#LAS", championId: 22, teamId: 200 },
  ];
  const api = createRiotTrackerApi({
    apiKey: "secret",
    fetchImpl: async () => response(200, { gameId: 77, gameQueueConfigId: 420, gameStartTime: 1_000, participants }),
  });

  const active = await api.fetchActiveSoloQueueGameByPuuid("hidden", { gameName: "Papipu", tagLine: "HOLA" });

  assert.equal(active?.selfIndex, 0);
  assert.equal(active?.championId, "82", "the champion is not what streamer mode hides");
  assert.deepEqual(active?.participants.map(({ riotId }) => riotId), ["", "Ally#LAS", "Foe#LAS"]);
  assert.deepEqual(active?.participants.map(({ teamId }) => teamId), [100, 100, 200]);
  // No role may be invented here. Spectator reports no position, and a real
  // lobby came back with the jungler third and the support last, so the slot
  // index is not the draft order either.
  assert.deepEqual(active?.participants.map((p) => "role" in p), [false, false, false]);
});

test("surfaces remakes from Match-V5 so the LP tracker can ignore them", async () => {
  const api = createRiotTrackerApi({
    apiKey: "secret",
    fetchImpl: async () => response(200, {
      metadata: { matchId: "LA2_REMAKE" },
      info: {
        queueId: 420,
        gameStartTimestamp: 1_000,
        gameEndTimestamp: 71_000,
        gameDuration: 70,
        participants: [{ puuid: "p", win: false, gameEndedInEarlySurrender: true }],
      },
    }),
  });

  const match = await api.fetchMatchById("LA2_REMAKE");
  assert.equal(match?.remake, true);
});

test("shares one bounded requester and exposes rate-limit blocking", async () => {
  const sleeps = [];
  let attempts = 0;
  const api = createRiotTrackerApi({
    apiKey: "secret",
    maxRequests: 3,
    // Isolated from the 20-per-second pacing, asserted in riot-request.test.mjs.
    minIntervalMs: 0,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1 ? response(429, {}, { "Retry-After": "2" }) : response(200, []);
    },
  });

  await api.fetchRecentSoloQueueMatchIds("p");
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(api.requestsUsed, 2);
  assert.equal(api.lastBlockedUntil > Date.now(), true);
});
