import assert from "node:assert/strict";
import test from "node:test";

import { fetchRiotLeaderboard, fetchRiotPlayer, inferLeaguePointsChange, normalizePersistedSoloQueueMatch, normalizeSoloQueueMatch, RIOT_PLAYERS, RiotApiError } from "../lib/riot-client.ts";
import { createDemoSnapshot } from "../lib/leaderboard.ts";

test("tracks all nine challenge Riot IDs", () => {
  assert.deepEqual(
    RIOT_PLAYERS.map(({ gameName, tagLine }) => `${gameName}#${tagLine}`),
    [
      "miqi#8745",
      "Wonder Boi#huhu",
      "RVN#2105",
      "INTI VIRAC0NCHA#20CM",
      "Papipu#HOLA",
      "TESTICrULoOS#2140",
      "PiperTwin#20CM",
      "Mamimu#HOLA",
      "yvncv#0521",
    ],
  );
});

test("loads a LAS SoloQ profile using Riot ID and full-season ranked totals", async () => {
  const requests = [];
  const fakeFetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, token: new Headers(init.headers).get("X-Riot-Token") });

    if (url.includes("/accounts/by-riot-id/")) {
      return Response.json({ puuid: "puuid-1", gameName: "Wonder Boi", tagLine: "huhu" });
    }
    if (url.includes("/league/v4/entries/by-puuid/")) {
      return Response.json([
        { queueType: "RANKED_SOLO_5x5", tier: "SILVER", rank: "I", leaguePoints: 64, wins: 49, losses: 38 },
      ]);
    }
    if (url.includes("/summoner/v4/summoners/by-puuid/")) {
      return Response.json({ profileIconId: 6543 });
    }
    return new Response(null, { status: 404 });
  };

  const player = await fetchRiotPlayer(
    { id: "wonder-boi", gameName: "Wonder Boi", tagLine: "huhu" },
    "secret-key",
    fakeFetch,
  );

  assert.equal(player.gameName, "Wonder Boi");
  assert.equal(player.tagLine, "huhu");
  assert.equal(player.puuid, "puuid-1");
  assert.equal(player.tier, "SILVER");
  assert.equal(player.division, "I");
  assert.equal(player.winRate, 56.3);
  assert.equal(player.progressToGold, 97);
  assert.equal(player.profileIconId, 6543);
  assert.equal(player.riotIdFound, true);

  assert.equal(requests[0].url, "https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Wonder%20Boi/huhu");
  assert.ok(requests.some(({ url }) => url === "https://la2.api.riotgames.com/lol/league/v4/entries/by-puuid/puuid-1"));
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ token }) => token === "secret-key"));
});

test("automatically bootstraps season analytics for a newly added Riot ID", async () => {
  const requestedUrls = [];
  let accountRequestsInFlight = 0;
  let maxAccountRequestsInFlight = 0;
  const fakeFetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);

    if (url.includes("/accounts/by-riot-id/")) {
      accountRequestsInFlight += 1;
      maxAccountRequestsInFlight = Math.max(maxAccountRequestsInFlight, accountRequestsInFlight);
      // Longer than the 50ms the requester spaces request starts by. Riot's
      // real latency is, too — but a fake that answers instantly would finish
      // each call before the next was allowed to start, and this assertion
      // would then be measuring the pacing rather than the concurrency.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const parts = new URL(url).pathname.split("/");
      const gameName = decodeURIComponent(parts.at(-2));
      const tagLine = decodeURIComponent(parts.at(-1));
      const response = Response.json({
        puuid: `puuid-${gameName.toLowerCase().replaceAll(" ", "-")}`,
        gameName,
        tagLine,
      });
      accountRequestsInFlight -= 1;
      return response;
    }
    if (url.includes("/league/v4/entries/by-puuid/")) {
      return Response.json([
        { queueType: "RANKED_SOLO_5x5", tier: "BRONZE", rank: "IV", leaguePoints: 20, wins: 1, losses: 0 },
      ]);
    }
    if (url.includes("/summoner/v4/summoners/by-puuid/")) {
      return Response.json({ profileIconId: 4321 });
    }
    if (url.includes("/matches/by-puuid/puuid-mamimu/ids")) {
      return Response.json(["LA2_MAMIMU_1"]);
    }
    if (url.includes("/matches/by-puuid/")) {
      return Response.json([]);
    }
    if (url.endsWith("/matches/LA2_MAMIMU_1")) {
      return Response.json({
        info: {
          queueId: 420,
          gameStartTimestamp: Date.UTC(2026, 0, 10),
          gameDuration: 1_800,
          participants: [{
            puuid: "puuid-mamimu",
            championId: 103,
            championName: "Ahri",
            teamId: 100,
            kills: 8,
            deaths: 2,
            assists: 7,
            win: true,
            teamPosition: "MIDDLE",
            riotIdGameName: "Mamimu",
            riotIdTagline: "HOLA",
          }],
        },
      });
    }
    return new Response(null, { status: 404 });
  };

  const snapshot = await fetchRiotLeaderboard("secret-key", fakeFetch, new Date("2026-07-19T00:00:00Z"), undefined, undefined, 500);
  const mamimu = snapshot.players.find((player) => player.id === "mamimu");

  assert.ok(mamimu);
  assert.equal(mamimu.profileIconId, 4321);
  assert.equal(mamimu.analytics.games, 1);
  assert.equal(mamimu.analytics.mainRole, "MIDDLE");
  assert.equal(mamimu.lastSoloQueueMatch?.matchId, "LA2_MAMIMU_1");
  assert.ok(requestedUrls.some((url) => url.includes("/matches/by-puuid/puuid-mamimu/ids")));
  assert.ok(requestedUrls
    .filter((url) => url.includes("/matches/by-puuid/"))
    .every((url) => new URL(url).searchParams.get("count") === "10"));
  assert.ok(maxAccountRequestsInFlight >= 2);
  assert.ok(maxAccountRequestsInFlight <= 3);
});

test("backfills a new player's season in rate-limit-safe batches", async () => {
  let mamimuMatchDetails = 0;
  let mamimuIdRequests = 0;
  const fakeFetch = async (input) => {
    const url = String(input);
    if (url.includes("/accounts/by-riot-id/")) {
      const parts = new URL(url).pathname.split("/");
      const gameName = decodeURIComponent(parts.at(-2));
      return Response.json({
        puuid: `puuid-${gameName.toLowerCase().replaceAll(" ", "-")}`,
        gameName,
        tagLine: decodeURIComponent(parts.at(-1)),
      });
    }
    if (url.includes("/league/v4/entries/by-puuid/")) return Response.json([]);
    if (url.includes("/summoner/v4/summoners/by-puuid/")) return Response.json({ profileIconId: 4321 });
    if (url.includes("/matches/by-puuid/puuid-mamimu/ids")) {
      const params = new URL(url).searchParams;
      if (!params.has("endTime")) return Response.json([]);
      const start = mamimuIdRequests * 10;
      const length = mamimuIdRequests === 0 ? 10 : 1;
      mamimuIdRequests += 1;
      return Response.json(Array.from({ length }, (_, index) => `LA2_MAMIMU_${start + index}`));
    }
    if (url.includes("/matches/by-puuid/")) return Response.json([]);
    if (url.includes("/matches/LA2_MAMIMU_")) {
      mamimuMatchDetails += 1;
      const matchIndex = Number(url.split("_").at(-1));
      return Response.json({
        info: {
          queueId: 420,
          gameStartTimestamp: Date.UTC(2026, 6, 19) - matchIndex * 60_000,
          gameDuration: 1_800,
          participants: [{
            puuid: "puuid-mamimu",
            championId: 103,
            championName: "Ahri",
            teamId: 100,
            kills: 8,
            deaths: 2,
            assists: 7,
            win: true,
            teamPosition: "MIDDLE",
            riotIdGameName: "Mamimu",
            riotIdTagline: "HOLA",
          }],
        },
      });
    }
    return new Response(null, { status: 404 });
  };

  const firstSnapshot = await fetchRiotLeaderboard("secret-key", fakeFetch, new Date("2026-07-19T01:00:00Z"), undefined, undefined, 500);
  const mamimu = firstSnapshot.players.find((player) => player.id === "mamimu");

  assert.ok(mamimu);
  assert.equal(mamimu.analytics.games, 10);
  assert.equal(mamimuMatchDetails, 10);
  assert.equal(mamimu.analytics.backfillStatus, "in_progress");
  assert.equal(mamimu.analytics.backfillStartTimestamp, Date.UTC(2026, 0, 8, 15));
  assert.ok(mamimu.analytics.backfillBeforeTimestamp > Date.UTC(2026, 0, 8, 15));

  mamimuMatchDetails = 0;
  const intermediateSnapshot = await fetchRiotLeaderboard(
    "secret-key",
    fakeFetch,
    new Date("2026-07-19T01:02:00Z"),
    firstSnapshot,
    undefined,
    500,
  );
  const completedSnapshot = await fetchRiotLeaderboard(
    "secret-key",
    fakeFetch,
    new Date("2026-07-19T01:04:00Z"),
    intermediateSnapshot,
    undefined,
    500,
  );
  const completedMamimu = completedSnapshot.players.find((player) => player.id === "mamimu");

  assert.ok(completedMamimu);
  assert.equal(completedMamimu.analytics.games, 11);
  assert.equal(completedMamimu.analytics.backfillStatus, "complete");
  assert.equal(completedMamimu.analytics.backfillStartTimestamp, undefined);
  assert.equal(completedMamimu.analytics.backfillBeforeTimestamp, 0);
  assert.equal(mamimuMatchDetails, 1);
});

test("maps Riot rate limits to a safe error without exposing the API key", async () => {
  const fakeFetch = async () => new Response(null, { status: 429, headers: { "Retry-After": "12" } });

  await assert.rejects(
    () => fetchRiotPlayer({ id: "miqi", gameName: "miqi", tagLine: "8745" }, "do-not-leak", fakeFetch),
    (error) => {
      assert.ok(error instanceof RiotApiError);
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.retryAfterSeconds, 12);
      assert.doesNotMatch(error.message, /do-not-leak/);
      return true;
    },
  );
});

test("normalizes the latest SoloQ match and identifies challenge peers", () => {
  const match = normalizeSoloQueueMatch(
    "LA2_123456789",
    {
      info: {
        queueId: 420,
        gameStartTimestamp: 1_752_700_000_000,
        gameDuration: 1_842,
        participants: [
          { puuid: "puuid-current", championName: "Ahri", teamId: 100, kills: 7, deaths: 2, assists: 9, win: true, riotIdGameName: "Wonder Boi", riotIdTagline: "huhu" },
          { puuid: "puuid-peer", championName: "Lux", teamId: 100, kills: 3, deaths: 4, assists: 12, win: true, riotIdGameName: "Papipu", riotIdTagline: "HOLA" },
          { puuid: "puuid-other", championName: "Darius", teamId: 200, kills: 4, deaths: 7, assists: 1, win: false, riotIdGameName: "Otro", riotIdTagline: "LAS" },
        ],
      },
    },
    "puuid-current",
    new Map([
      ["puuid-current", "wonder-boi"],
      ["puuid-peer", "papipu"],
    ]),
  );

  assert.ok(match);
  assert.equal(match.championId, "Ahri");
  assert.deepEqual([match.kills, match.deaths, match.assists, match.win], [7, 2, 9, true]);
  assert.equal(match.participants[0].challengePlayerId, "wonder-boi");
  assert.equal(match.participants[1].challengePlayerId, "papipu");
  assert.equal(match.participants[2].challengePlayerId, null);

  const fallbackMatch = normalizeSoloQueueMatch(
    "LA2_123456789",
    {
      info: {
        queueId: 420,
        gameStartTimestamp: 1_752_700_000_000,
        gameDuration: 1_842,
        participants: [
          { puuid: "puuid-current", championName: "Ahri", teamId: 100, kills: 7, deaths: 2, assists: 9, win: true, riotIdGameName: "Wonder Boi", riotIdTagline: "huhu" },
          { puuid: "puuid-not-mapped", championName: "Lux", teamId: 100, kills: 3, deaths: 4, assists: 12, win: true, riotIdGameName: "Papipu", riotIdTagline: "HOLA" },
        ],
      },
    },
    "puuid-current",
    new Map([
      ["puuid-current", "wonder-boi"],
      ["riot:papipu#hola", "papipu"],
    ]),
  );

  assert.equal(fallbackMatch?.participants[1].challengePlayerId, "papipu");
});

test("marks Match-V5 early surrenders and legacy short games as remakes", () => {
  const participant = {
    puuid: "puuid-current",
    championName: "Ahri",
    teamId: 100,
    kills: 0,
    deaths: 0,
    assists: 0,
    win: false,
  };
  const explicit = normalizeSoloQueueMatch(
    "LA2_REMAKE_1",
    { info: { queueId: 420, gameStartTimestamp: 1_000, gameDuration: 1_800, participants: [{ ...participant, gameEndedInEarlySurrender: true }] } },
    participant.puuid,
    new Map(),
  );
  const legacyShort = normalizeSoloQueueMatch(
    "LA2_REMAKE_2",
    { info: { queueId: 420, gameStartTimestamp: 2_000, gameDuration: 71, participants: [participant] } },
    participant.puuid,
    new Map(),
  );
  const persisted = normalizePersistedSoloQueueMatch(
    "LA2_REMAKE_2",
    { info: { queueId: 420, gameStartTimestamp: 2_000, gameDuration: 71, participants: [participant] } },
    new Map([[participant.puuid, "current"]]),
  );

  assert.equal(explicit?.remake, true);
  assert.equal(legacyShort?.remake, true);
  assert.deepEqual(persisted?.playerStats, []);
});

test("normalizes immutable match and per-player records for persistence", () => {
  const persisted = normalizePersistedSoloQueueMatch(
    "LA2_123456789",
    {
      info: {
        queueId: 420,
        gameStartTimestamp: 1_752_700_000_000,
        gameDuration: 1_842,
        participants: [
          { puuid: "puuid-current", championName: "Ahri", teamId: 100, kills: 7, deaths: 2, assists: 9, win: true, teamPosition: "MIDDLE", riotIdGameName: "Mamimu", riotIdTagline: "HOLA" },
          { puuid: "puuid-other", championName: "Lux", teamId: 200, kills: 3, deaths: 4, assists: 12, win: false, teamPosition: "UTILITY", riotIdGameName: "Otro", riotIdTagline: "LAS" },
        ],
      },
    },
    new Map([["puuid-current", "mamimu"]]),
  );

  assert.ok(persisted);
  assert.equal(persisted.matchId, "LA2_123456789");
  assert.equal(persisted.participants.length, 2);
  assert.deepEqual(persisted.playerStats, [{
    playerId: "mamimu",
    championId: "Ahri",
    championName: "Ahri",
    kills: 7,
    deaths: 2,
    assists: 9,
    won: true,
    role: "MIDDLE",
  }]);
});

test("rejects non-SoloQ or malformed match payloads", () => {
  assert.equal(normalizeSoloQueueMatch("LA2_1", { info: { queueId: 440, participants: [] } }, "puuid", new Map()), null);
  assert.equal(normalizeSoloQueueMatch("LA2_1", { info: { queueId: 420, participants: "invalid" } }, "puuid", new Map()), null);
});

test("attributes a PL change only when exactly one ranked game matches the result", () => {
  const previous = {
    tier: "SILVER",
    division: "I",
    leaguePoints: 41,
    wins: 10,
    losses: 8,
    lastSoloQueueMatch: { matchId: "LA2_1", win: false, lpChangeEvidence: { status: "pending", reason: "league_state_not_updated" } },
  };
  const current = {
    tier: "SILVER",
    division: "I",
    leaguePoints: 64,
    wins: 11,
    losses: 8,
    lastSoloQueueMatch: { matchId: "LA2_2", win: true, lpChangeEvidence: { status: "pending", reason: "league_state_not_updated" } },
  };

  assert.deepEqual(inferLeaguePointsChange(previous, current, "2026-07-19T00:00:00.000Z", "2026-07-19T00:01:00.000Z"), {
    status: "observed",
    value: 23,
    source: "rank_snapshot_delta",
    beforeObservedAt: "2026-07-19T00:00:00.000Z",
    afterObservedAt: "2026-07-19T00:01:00.000Z",
  });
  assert.equal(inferLeaguePointsChange(
    { ...previous, division: "II", leaguePoints: 88 },
    { ...current, division: "I", leaguePoints: 12 },
    "before", "after",
  ).value, 24);

  assert.deepEqual(inferLeaguePointsChange(previous, { ...current, wins: 12 }, "before", "after"), {
    status: "unavailable",
    reason: "multiple_games_between_snapshots",
  });
  assert.deepEqual(inferLeaguePointsChange(previous, { ...current, wins: 10 }, "before", "after"), {
    status: "unavailable",
    reason: "rank_state_changed_without_match",
  });
  assert.deepEqual(inferLeaguePointsChange(previous, { ...current, wins: 9 }, "before", "after"), {
    status: "unavailable",
    reason: "season_or_rank_reset",
  });
  assert.deepEqual(inferLeaguePointsChange(previous, { ...current, wins: 10, losses: 9 }, "before", "after"), {
    status: "unavailable",
    reason: "match_rank_mismatch",
  });
});

test("checks recent matches even when a cached player still needs historical backfill", async () => {
  const requestedMamimuIdUrls = [];
  const cached = createDemoSnapshot(new Date("2026-07-19T00:00:00Z"));
  const cachedMamimu = cached.players.find((player) => player.id === "mamimu");
  assert.ok(cachedMamimu);
  delete cachedMamimu.analytics.backfillStatus;
  delete cachedMamimu.analytics.backfillStartTimestamp;
  delete cachedMamimu.analytics.backfillBeforeTimestamp;
  cachedMamimu.analytics.games = 0;
  cachedMamimu.analytics.lastGameStartTimestamp = 0;
  cachedMamimu.analytics.lastMatchId = "";

  const fakeFetch = async (input) => {
    const url = String(input);
    if (url.includes("/accounts/by-riot-id/")) {
      const parts = new URL(url).pathname.split("/");
      const gameName = decodeURIComponent(parts.at(-2));
      return Response.json({ puuid: `puuid-${gameName.toLowerCase().replaceAll(" ", "-")}`, gameName, tagLine: decodeURIComponent(parts.at(-1)) });
    }
    if (url.includes("/league/v4/entries/by-puuid/")) return Response.json([]);
    if (url.includes("/summoner/v4/summoners/by-puuid/")) return Response.json({ profileIconId: 1 });
    if (url.includes("/matches/by-puuid/puuid-mamimu/ids")) {
      requestedMamimuIdUrls.push(url);
      return Response.json([]);
    }
    if (url.includes("/matches/by-puuid/")) return Response.json([]);
    return new Response(null, { status: 404 });
  };

  const snapshot = await fetchRiotLeaderboard("secret-key", fakeFetch, new Date("2026-07-19T00:02:00Z"), cached, undefined, 500);
  const mamimu = snapshot.players.find((player) => player.id === "mamimu");

  assert.ok(mamimu);
  assert.ok(requestedMamimuIdUrls.some((url) => !new URL(url).searchParams.has("endTime")), "forward cursor must always run");
  assert.ok(requestedMamimuIdUrls.some((url) => new URL(url).searchParams.has("endTime")), "backfill cursor must run independently");
  assert.equal(mamimu.analytics.backfillStatus, "complete");
});

test("keeps a same-match PL delta pending instead of persisting a synthetic zero", () => {
  const state = {
    tier: "SILVER",
    division: "I",
    leaguePoints: 64,
    wins: 11,
    losses: 8,
    lastSoloQueueMatch: { matchId: "LA2_2", win: true, lpChangeEvidence: { status: "pending", reason: "league_state_not_updated" } },
  };

  assert.deepEqual(inferLeaguePointsChange(state, state, "before", "after"), {
    status: "pending",
    reason: "league_state_not_updated",
  });
});

test("infers PL for Master+ on the shared apex axis and still requires a before observation", () => {
  const current = {
    tier: "MASTER",
    division: "I",
    leaguePoints: 120,
    wins: 30,
    losses: 20,
    lastSoloQueueMatch: { matchId: "LA2_3", win: true, lpChangeEvidence: { status: "pending", reason: "league_state_not_updated" } },
  };
  assert.deepEqual(inferLeaguePointsChange(undefined, current, "", "after"), {
    status: "unavailable",
    reason: "no_before_snapshot",
  });
  assert.deepEqual(inferLeaguePointsChange({ ...current, leaguePoints: 97, wins: 29, lastSoloQueueMatch: null }, current, "before", "after"), {
    status: "observed",
    value: 23,
    source: "rank_snapshot_delta",
    beforeObservedAt: "before",
    afterObservedAt: "after",
  });
});

test("follows Data Dragon's current version instead of the seed's", async () => {
  // The version was pinned to whatever the season seed shipped with and nothing
  // ever moved it, so every asset Riot added later 404'd — icon 7188, added for
  // LoL Classic, left a real player with no avatar at all.
  const cached = { ...createDemoSnapshot(new Date("2026-07-19T00:00:00Z")), dataDragonVersion: "16.13.1" };
  let versionsRequested = 0;

  const fakeFetch = async (input) => {
    const url = String(input);
    if (url.includes("ddragon.leagueoflegends.com/api/versions.json")) {
      versionsRequested += 1;
      return Response.json(["16.15.1", "16.15.0", "16.13.1"]);
    }
    if (url.includes("/league/v4/entries/by-puuid/")) return Response.json([]);
    if (url.includes("/summoner/v4/summoners/by-puuid/")) return Response.json({ profileIconId: 7188 });
    if (url.includes("/accounts/by-riot-id/")) {
      const parts = new URL(url).pathname.split("/");
      return Response.json({ puuid: "puuid-x", gameName: decodeURIComponent(parts.at(-2)), tagLine: decodeURIComponent(parts.at(-1)) });
    }
    return Response.json([]);
  };

  const snapshot = await fetchRiotLeaderboard(
    "secret-key", fakeFetch, new Date("2026-07-19T00:00:00Z"), cached, undefined, 500,
  );

  assert.equal(versionsRequested, 1, "the version must be looked up once per refresh, not per player");
  assert.equal(snapshot.dataDragonVersion, "16.15.1");
});

test("keeps the version it had when Data Dragon cannot be reached", async () => {
  // Best-effort: a failed lookup must leave the board exactly as it was, never
  // blank out the artwork for everyone.
  const cached = { ...createDemoSnapshot(new Date("2026-07-19T00:00:00Z")), dataDragonVersion: "16.13.1" };
  const fakeFetch = async (input) => {
    const url = String(input);
    if (url.includes("ddragon.leagueoflegends.com")) return new Response("nope", { status: 500 });
    if (url.includes("/league/v4/entries/by-puuid/")) return Response.json([]);
    if (url.includes("/summoner/v4/summoners/by-puuid/")) return Response.json({ profileIconId: 1 });
    if (url.includes("/accounts/by-riot-id/")) {
      const parts = new URL(url).pathname.split("/");
      return Response.json({ puuid: "puuid-x", gameName: decodeURIComponent(parts.at(-2)), tagLine: decodeURIComponent(parts.at(-1)) });
    }
    return Response.json([]);
  };

  const snapshot = await fetchRiotLeaderboard(
    "secret-key", fakeFetch, new Date("2026-07-19T00:00:00Z"), cached, undefined, 500,
  );
  assert.equal(snapshot.dataDragonVersion, "16.13.1");
});

