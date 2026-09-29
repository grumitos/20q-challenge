import assert from "node:assert/strict";
import test from "node:test";

import { backfillSeasonAnalytics, currentDataDragonVersion, fetchRiotLeaderboard, fetchRiotPlayer, inferLeaguePointsChange, normalizePersistedSoloQueueMatch, normalizeSoloQueueMatch, RIOT_PLAYERS, RiotApiError } from "../lib/riot-client.ts";
import { championsByNumericKey, resetChampionCatalog } from "../lib/champion-catalog.ts";
import { createDemoSnapshot } from "../lib/leaderboard.ts";

const MAMIMU_PUUID = RIOT_PLAYERS.find(({ id }) => id === "mamimu").puuid;

function accountForPuuidUrl(url) {
  const puuid = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
  const identity = RIOT_PLAYERS.find((player) => player.puuid === puuid);
  return {
    puuid,
    gameName: identity?.gameName ?? "Player",
    tagLine: identity?.tagLine ?? "LAS",
  };
}

test("tracks all nine challenge Riot IDs", () => {
  assert.deepEqual(
    RIOT_PLAYERS.map(({ gameName, tagLine }) => `${gameName}#${tagLine}`),
    [
      "miqi#8745",
      "regigig4s#huhu",
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

test("keeps one persistent PUUID for every challenge player", () => {
  const puuids = RIOT_PLAYERS.map(({ puuid }) => puuid);
  assert.equal(new Set(puuids).size, RIOT_PLAYERS.length);
  assert.ok(puuids.every((puuid) => typeof puuid === "string" && puuid.length > 0));
});

test("loads a LAS SoloQ profile using its PUUID and full-season ranked totals", async () => {
  const requests = [];
  const fakeFetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, token: new Headers(init.headers).get("X-Riot-Token") });

    if (url.includes("/accounts/by-puuid/")) {
      return Response.json({ puuid: "puuid-1", gameName: "regigig4s", tagLine: "huhu" });
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
    { id: "wonder-boi", puuid: "puuid-1", gameName: "regigig4s", tagLine: "huhu" },
    "secret-key",
    fakeFetch,
  );

  assert.equal(player.gameName, "regigig4s");
  assert.equal(player.tagLine, "huhu");
  assert.equal(player.puuid, "puuid-1");
  assert.equal(player.tier, "SILVER");
  assert.equal(player.division, "I");
  assert.equal(player.winRate, 56.3);
  assert.equal(player.progressToGold, 97);
  assert.equal(player.profileIconId, 6543);
  assert.equal(player.riotIdFound, true);

  assert.equal(requests[0].url, "https://americas.api.riotgames.com/riot/account/v1/accounts/by-puuid/puuid-1");
  assert.ok(requests.every(({ url }) => !url.includes("/accounts/by-riot-id/")));
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

    if (url.includes("/accounts/by-puuid/")) {
      accountRequestsInFlight += 1;
      maxAccountRequestsInFlight = Math.max(maxAccountRequestsInFlight, accountRequestsInFlight);
      // Longer than the 50ms the requester spaces request starts by. Riot's
      // real latency is, too — but a fake that answers instantly would finish
      // each call before the next was allowed to start, and this assertion
      // would then be measuring the pacing rather than the concurrency.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const response = Response.json(accountForPuuidUrl(url));
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
    if (url.includes(`/matches/by-puuid/${MAMIMU_PUUID}/ids`)) {
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
            puuid: MAMIMU_PUUID,
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
  assert.ok(requestedUrls.some((url) => url.includes(`/matches/by-puuid/${MAMIMU_PUUID}/ids`)));
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
    if (url.includes("/accounts/by-puuid/")) {
      return Response.json(accountForPuuidUrl(url));
    }
    if (url.includes("/league/v4/entries/by-puuid/")) return Response.json([]);
    if (url.includes("/summoner/v4/summoners/by-puuid/")) return Response.json({ profileIconId: 4321 });
    if (url.includes(`/matches/by-puuid/${MAMIMU_PUUID}/ids`)) {
      const params = new URL(url).searchParams;
      if (!params.has("endTime")) return Response.json([]);
      // Honour the page size the caller asked for, so the batch constant is
      // what this test measures rather than a number baked into the fake.
      const pageSize = Number(params.get("count") ?? 10);
      const start = mamimuIdRequests * pageSize;
      const length = mamimuIdRequests === 0 ? pageSize : 1;
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
            puuid: MAMIMU_PUUID,
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

  // The forward lane enrols a new player for backfill but must not drain it:
  // carrying a batch of match payloads on top of its own scan is what put this
  // lane over the 10 ms CPU allowance and had it answering 1102 twice an hour,
  // with the kill landing before the cutoff advanced so the next run inherited
  // the identical batch. `backfillSeasonAnalytics` exists to own that work.
  const firstSnapshot = await fetchRiotLeaderboard("secret-key", fakeFetch, new Date("2026-07-19T01:00:00Z"), undefined, undefined, 500);
  const enrolled = firstSnapshot.players.find((player) => player.id === "mamimu");

  assert.ok(enrolled);
  assert.equal(mamimuMatchDetails, 0, "the forward lane must not download a backfill batch");
  assert.equal(enrolled.analytics.backfillStatus, "in_progress");

  const firstBatch = await backfillSeasonAnalytics(firstSnapshot, "secret-key", fakeFetch, new Date("2026-07-19T01:01:00Z"), 500);
  assert.ok(firstBatch);
  const mamimu = firstBatch.snapshot.players.find((player) => player.id === "mamimu");

  assert.ok(mamimu);
  assert.equal(mamimu.analytics.games, 3);
  assert.equal(mamimuMatchDetails, 3, "a batch is sized to fit the CPU allowance, not the id page");
  assert.equal(mamimu.analytics.backfillStatus, "in_progress");
  assert.equal(mamimu.analytics.backfillStartTimestamp, Date.UTC(2026, 0, 8, 15));
  assert.ok(mamimu.analytics.backfillBeforeTimestamp > Date.UTC(2026, 0, 8, 15));

  // A short page means the season is exhausted, so the next batch completes it.
  // Only one player is backfilled per run, picked by fewest games — mamimu now
  // has three, so the slot would rotate to someone else. Retire the others to
  // keep this test on its own subject: the batch size and the completion rule.
  mamimuMatchDetails = 0;
  const soloSnapshot = {
    ...firstBatch.snapshot,
    players: firstBatch.snapshot.players.map((player) => player.id === "mamimu" ? player : {
      ...player,
      analytics: { ...player.analytics, backfillStatus: "complete" },
    }),
  };
  const completedBatch = await backfillSeasonAnalytics(
    soloSnapshot,
    "secret-key",
    fakeFetch,
    new Date("2026-07-19T01:02:00Z"),
    500,
  );
  assert.ok(completedBatch);
  const completedMamimu = completedBatch.snapshot.players.find((player) => player.id === "mamimu");

  assert.ok(completedMamimu);
  assert.equal(mamimuMatchDetails, 1);
  assert.equal(completedMamimu.analytics.games, 4);
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
    if (url.includes("/accounts/by-puuid/")) {
      return Response.json(accountForPuuidUrl(url));
    }
    if (url.includes("/league/v4/entries/by-puuid/")) return Response.json([]);
    if (url.includes("/summoner/v4/summoners/by-puuid/")) return Response.json({ profileIconId: 1 });
    if (url.includes(`/matches/by-puuid/${MAMIMU_PUUID}/ids`)) {
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
  // This used to assert the backfill cursor ran here too. It did, and that was
  // the defect: the forward lane carried a batch of match payloads on top of
  // its own scan, over the 10 ms CPU allowance, and died before advancing the
  // cutoff so the next run inherited the same batch. The lanes are separate now
  // — this one enrols the player and `backfillSeasonAnalytics` drains them.
  assert.equal(
    requestedMamimuIdUrls.some((url) => new URL(url).searchParams.has("endTime")), false,
    "the forward lane must not run the backfill cursor",
  );
  assert.equal(mamimu.analytics.backfillStatus, "in_progress", "but it must still enrol the player");
});

test("boundary matches cannot crowd new games out of the detail cap", async () => {
  // Riot's `startTime` is inclusive, so every player's last-processed match
  // comes back on every forward scan. Those boundary ids are older than
  // anything new, so an oldest-first cap without a boundary filter spent all
  // its slots re-fetching them: details downloaded, discarded, no cutoff
  // moved, and the next run drew the identical list. Twenty-two consecutive
  // production runs ingested nothing while five fresh Jinx games sat waiting.
  const cached = createDemoSnapshot(new Date("2026-07-19T00:00:00Z"));
  for (const player of cached.players) {
    player.analytics.backfillStatus = "complete";
    player.analytics.backfillBeforeTimestamp = 0;
    // Every player's cutoff sits on an old boundary match Riot will re-return.
    player.analytics.lastGameStartTimestamp = Date.UTC(2026, 6, 10);
    player.analytics.lastMatchId = `LA2_100_${player.id}`;
    player.analytics.games = 1;
  }
  const detailRequests = [];

  const fakeFetch = async (input) => {
    const url = String(input);
    if (url.includes("/accounts/by-puuid/")) {
      return Response.json(accountForPuuidUrl(url));
    }
    if (url.includes("/league/v4/entries/by-puuid/")) return Response.json([]);
    if (url.includes("/summoner/v4/summoners/by-puuid/")) return Response.json({ profileIconId: 1 });
    if (url.includes("/ids")) {
      const puuid = decodeURIComponent(new URL(url).pathname.split("/").at(-2));
      const playerId = RIOT_PLAYERS.find((player) => player.puuid === puuid)?.id ?? "unknown";
      // The boundary comes back first; mamimu alone also has a genuinely new game.
      const ids = [`LA2_100_${playerId}`];
      if (playerId === "mamimu") ids.push("LA2_900_new");
      return Response.json(ids);
    }
    if (url.includes("/matches/LA2_")) {
      const matchId = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      detailRequests.push(matchId);
      const isNew = matchId === "LA2_900_new";
      return Response.json({
        info: {
          queueId: 420,
          gameStartTimestamp: isNew ? Date.UTC(2026, 6, 18) : Date.UTC(2026, 6, 10),
          gameDuration: 1_800,
          participants: [{
            puuid: MAMIMU_PUUID, championId: 222, championName: "Jinx", teamId: 100,
            kills: 5, deaths: 1, assists: 5, win: true, teamPosition: "BOTTOM",
            riotIdGameName: "Mamimu", riotIdTagline: "HOLA",
          }],
        },
      });
    }
    return new Response(null, { status: 404 });
  };

  const snapshot = await fetchRiotLeaderboard("secret-key", fakeFetch, new Date("2026-07-19T00:02:00Z"), cached, undefined, 500);
  const mamimu = snapshot.players.find((player) => player.id === "mamimu");

  assert.ok(detailRequests.includes("LA2_900_new"), "the genuinely new match must get a detail slot");
  assert.equal(
    detailRequests.some((matchId) => matchId.startsWith("LA2_100_")), false,
    "pure boundary re-returns must not consume detail requests",
  );
  assert.ok(mamimu);
  assert.equal(mamimu.analytics.games, 2, "the new game must be counted");
  assert.ok(mamimu.analytics.lastGameStartTimestamp > Date.UTC(2026, 6, 10), "the cutoff must advance");
});

/**
 * A roster whose analytics cutoffs all sit on LA2_1000, with mamimu
 * `pendingGames` games behind (LA2_1001, LA2_1002, ...). Riot lists ids newest
 * first and `startTime` is inclusive, so her boundary comes back every time.
 */
function mamimuBacklog(pendingGames) {
  const startOf = (n) => Date.UTC(2026, 6, 10) + n * 3_600_000;
  const snapshot = createDemoSnapshot(new Date("2026-07-19T00:00:00Z"));
  for (const player of snapshot.players) {
    // Cached puuids, so every run spends exactly two rank requests per player.
    player.puuid = RIOT_PLAYERS.find(({ id }) => id === player.id).puuid;
    player.analytics.backfillStatus = "complete";
    player.analytics.backfillBeforeTimestamp = 0;
    player.analytics.lastGameStartTimestamp = startOf(0);
    player.analytics.lastMatchId = "LA2_1000";
  }
  const log = { requests: 0, details: [] };
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "ddragon.leagueoflegends.com") return new Response(null, { status: 404 });
    log.requests += 1;
    if (url.pathname.includes("/accounts/by-puuid/")) return Response.json(accountForPuuidUrl(url));
    if (url.pathname.includes("/league/v4/entries/by-puuid/")) return Response.json([]);
    if (url.pathname.includes("/summoner/v4/summoners/by-puuid/")) return Response.json({ profileIconId: 1 });
    if (url.pathname.endsWith("/ids")) {
      if (decodeURIComponent(url.pathname.split("/").at(-2)) !== MAMIMU_PUUID) return Response.json([]);
      const since = Number(url.searchParams.get("startTime")) * 1_000;
      const start = Number(url.searchParams.get("start"));
      const count = Number(url.searchParams.get("count"));
      const listed = Array.from({ length: pendingGames + 1 }, (_, n) => n)
        .filter((n) => startOf(n) >= since)
        .reverse()
        .map((n) => `LA2_${1000 + n}`);
      return Response.json(listed.slice(start, start + count));
    }
    const matchId = decodeURIComponent(url.pathname.split("/").at(-1));
    log.details.push(matchId);
    return Response.json({
      info: {
        queueId: 420,
        gameStartTimestamp: startOf(Number(matchId.split("_").at(-1)) - 1000),
        gameDuration: 1_800,
        participants: [{
          puuid: MAMIMU_PUUID, championId: 222, championName: "Jinx", teamId: 100,
          kills: 5, deaths: 1, assists: 5, win: true, teamPosition: "BOTTOM",
          riotIdGameName: "Mamimu", riotIdTagline: "HOLA",
        }],
      },
    });
  };
  return { snapshot, fetchImpl, log };
}

test("a backlog larger than one run's budget drains across consecutive runs", async () => {
  // Twelve games behind, mamimu needs a second id page: 18 rank requests and
  // ten listings leave four of the 32 for five scheduled details. The fifth
  // threw, the run kept nothing, the cutoff never moved, and every later run
  // drew the identical list — the latent `leaderboard_analytics_capped` loop.
  const { snapshot: initial, fetchImpl, log } = mamimuBacklog(12);
  let snapshot = initial;
  const mamimu = () => snapshot.players.find(({ id }) => id === "mamimu");
  const startingGames = mamimu().analytics.games;
  const ingestedPerRun = [];
  const persisted = [];

  for (let run = 0; run < 3; run += 1) {
    const before = mamimu().analytics.games;
    log.requests = 0;
    snapshot = await fetchRiotLeaderboard(
      "secret-key", fetchImpl, new Date(Date.UTC(2026, 6, 19, 0, run * 10)), snapshot,
      (matches) => { persisted.push(...matches.map(({ matchId }) => matchId)); },
      32, 5,
    );
    assert.ok(log.requests <= 32, `run ${run + 1} spent ${log.requests} of 32 requests`);
    ingestedPerRun.push(mamimu().analytics.games - before);
  }

  assert.deepEqual(ingestedPerRun, [4, 5, 3], "each run keeps what its budget could fetch");
  assert.equal(mamimu().analytics.games, startingGames + 12);
  assert.equal(mamimu().analytics.lastMatchId, "LA2_1012");
  const everyGame = Array.from({ length: 12 }, (_, index) => `LA2_${1001 + index}`);
  assert.deepEqual(persisted, everyGame, "every pending game persisted once, oldest first, none skipped");
  assert.deepEqual(log.details, everyGame, "and no detail downloaded twice");
});

test("a listing the budget cuts short is listed again, never ingested from its newest end", async () => {
  // Riot lists ids newest first, so a first page with no budget left for the
  // second holds mamimu's ten newest games and neither of her two oldest.
  // Ingesting from it would move her cutoff past those two for good.
  const { snapshot: initial, fetchImpl, log } = mamimuBacklog(12);
  const mamimu = (snapshot) => snapshot.players.find(({ id }) => id === "mamimu");
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(line);
  let snapshot;
  try {
    // 18 rank requests and eight listings leave one request, which is held
    // back for a detail — so her second page is never asked for.
    snapshot = await fetchRiotLeaderboard(
      "secret-key", fetchImpl, new Date("2026-07-19T00:00:00Z"), initial, undefined, 27, 5,
    );
  } finally {
    console.log = realLog;
  }

  assert.equal(mamimu(snapshot).analytics.lastMatchId, "LA2_1000", "the cutoff must not pass games it never listed");
  assert.equal(mamimu(snapshot).analytics.games, mamimu(initial).analytics.games);
  assert.deepEqual(log.details, []);
  const capped = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "leaderboard_analytics_capped");
  assert.ok(capped?.truncatedPlayers >= 1, "a run the budget cut short must say so");

  // Given room for both pages, the same backlog drains from its oldest end.
  const next = await fetchRiotLeaderboard(
    "secret-key", fetchImpl, new Date("2026-07-19T00:10:00Z"), snapshot, undefined, 32, 5,
  );
  assert.equal(mamimu(next).analytics.lastMatchId, "LA2_1004");
  assert.deepEqual(log.details, ["LA2_1001", "LA2_1002", "LA2_1003", "LA2_1004"]);
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
    if (url.includes("/accounts/by-puuid/")) {
      return Response.json(accountForPuuidUrl(url));
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
    if (url.includes("/accounts/by-puuid/")) {
      return Response.json(accountForPuuidUrl(url));
    }
    return Response.json([]);
  };

  const snapshot = await fetchRiotLeaderboard(
    "secret-key", fakeFetch, new Date("2026-07-19T00:00:00Z"), cached, undefined, 500,
  );
  assert.equal(snapshot.dataDragonVersion, "16.13.1");
});

/**
 * A Data Dragon request that is accepted and never answered, until its signal
 * gives up. `AbortSignal.timeout` does not hold the event loop open, so the
 * interval does, or the test runner would end the test before the deadline.
 */
async function withHungDataDragon(run) {
  const keepAlive = setInterval(() => {}, 50);
  try {
    return await run((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
    }));
  } finally {
    clearInterval(keepAlive);
  }
}

test("gives up on a Data Dragon version lookup that hangs and keeps the version it had", { timeout: 5_000 }, async () => {
  // Without a deadline this waited on the OS, inside a tracker run the timer
  // kills at 90 seconds.
  const started = Date.now();
  const version = await withHungDataDragon((hung) => currentDataDragonVersion(hung, "16.13.1", 20));
  assert.equal(version, "16.13.1");
  assert.ok(Date.now() - started < 2_000);
});

test("gives up on a Data Dragon champion list that hangs", { timeout: 5_000 }, async () => {
  // The tracker catches this and shows the live game without its champion,
  // instead of the run hanging until the timer kills it.
  resetChampionCatalog();
  try {
    await withHungDataDragon((hung) =>
      assert.rejects(championsByNumericKey("16.15.1", hung, 20), { name: "TimeoutError" }));
  } finally {
    resetChampionCatalog();
  }
});

