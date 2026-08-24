import assert from "node:assert/strict";
import test from "node:test";

import {
  DUO_LEADERBOARD_MIN_GAMES,
  calculateGoalProgress,
  calculateGoldProgress,
  createDemoSnapshot,
  isRemakeMatch,
  normalizeSoloQueueEntry,
  orderLiveMatchRoster,
  orderMatchRoster,
  papipuRespawnSeconds,
  parseLeaderboardSnapshot,
  parseLeaderboardPayload,
  rankDuoRecords,
  shouldUseCache,
  wilsonLowerBound,
} from "../lib/leaderboard.ts";

const rosterEntry = (championId, teamId, over = {}) => ({
  championId,
  championName: championId,
  teamId,
  gameName: championId,
  tagLine: "LAS",
  challengePlayerId: null,
  ...over,
});

test("puts the tracked player's team first and one role per roster column", () => {
  // Riot hands these back in payload order, which is how a support ended up
  // under the top column.
  const participants = [
    rosterEntry("Jinx", 200, { role: "BOTTOM" }),
    rosterEntry("Leona", 100, { role: "UTILITY", challengePlayerId: "papipu" }),
    rosterEntry("Darius", 200, { role: "TOP" }),
    rosterEntry("LeeSin", 100, { role: "JUNGLE" }),
    rosterEntry("Ahri", 100, { role: "MIDDLE" }),
  ];

  const { allies, enemies } = orderMatchRoster(participants, "papipu");

  assert.deepEqual(allies.map((slot) => slot?.championId ?? null), [null, "LeeSin", "Ahri", null, "Leona"]);
  assert.deepEqual(enemies.map((slot) => slot?.championId ?? null), ["Darius", null, null, "Jinx", null]);
});

test("never drops a champion when Riot reports no position for it", () => {
  // A remake reports `individualPosition: "Invalid"` for everyone, and a
  // spectator lobby past the fifth slot has no position at all.
  const participants = [
    rosterEntry("Ahri", 100, { role: "MIDDLE", challengePlayerId: "rvn" }),
    rosterEntry("Sett", 100),
    rosterEntry("Nami", 100),
  ];

  const { allies } = orderMatchRoster(participants, "rvn");

  assert.deepEqual(allies.map((slot) => slot?.championId ?? null), ["Sett", "Nami", "Ahri", null, null]);
});

test("carries participant roles and the remake flag through the payload gate", () => {
  // The client re-validates whatever the API returns before rendering it, so a
  // field the gate does not know about is a field the grid never sees.
  const snapshot = createDemoSnapshot(new Date("2026-01-01T00:00:00.000Z"));
  const subject = snapshot.players.find((player) => player.lastSoloQueueMatch);
  subject.lastSoloQueueMatch.remake = true;
  subject.lastSoloQueueMatch.participants[0].role = "UTILITY";
  subject.lastSoloQueueMatch.participants[1].role = "JUNGLE";

  const parsed = parseLeaderboardPayload({
    data: snapshot,
    meta: { source: "riot", isStale: false, cacheTtlSeconds: 60 },
  });

  assert.ok(parsed, "the payload must still validate once roles are attached");
  const round = parsed.data.players.find((player) => player.id === subject.id).lastSoloQueueMatch;
  assert.equal(round.remake, true);
  assert.deepEqual(round.participants.slice(0, 2).map((p) => p.role), ["UTILITY", "JUNGLE"]);
  // The rest carry none, which is the shape of every payload cached before this
  // change — it has to keep validating.
  assert.equal(round.participants[2].role, undefined);
});

test("rejects a participant whose role is not a real position", () => {
  const snapshot = createDemoSnapshot(new Date("2026-01-01T00:00:00.000Z"));
  snapshot.players.find((player) => player.lastSoloQueueMatch)
    .lastSoloQueueMatch.participants[0].role = "SUPPORT";

  assert.equal(parseLeaderboardPayload({
    data: snapshot,
    meta: { source: "riot", isStale: false, cacheTtlSeconds: 60 },
  }), null);
});

test("falls back to the lowest team when the tracked player is anonymous", () => {
  // Streamer mode can leave the roster with no participant claiming the player.
  const participants = [rosterEntry("Ahri", 200, { role: "MIDDLE" }), rosterEntry("Sett", 100, { role: "TOP" })];

  const { allies, enemies } = orderMatchRoster(participants, "nobody");

  assert.equal(allies[0]?.championId, "Sett");
  assert.equal(enemies[2]?.championId, "Ahri");
});

test("keeps a live roster in Riot spectator order while grouping the two teams", () => {
  // Spectator-v5 has no lane. The persisted index is the only honest ordering
  // signal, and it must win over any stale role left by an older payload.
  const participants = [
    rosterEntry("enemy-support", 200, { rosterIndex: 6, role: "TOP" }),
    rosterEntry("ally-jungle", 100, { rosterIndex: 2, role: "BOTTOM", challengePlayerId: "papipu" }),
    rosterEntry("enemy-top", 200, { rosterIndex: 5, role: "UTILITY" }),
    rosterEntry("ally-top", 100, { rosterIndex: 0, role: "UTILITY" }),
    rosterEntry("ally-mid", 100, { rosterIndex: 4, role: "TOP" }),
    rosterEntry("enemy-jungle", 200, { rosterIndex: 8, role: "MIDDLE" }),
    rosterEntry("ally-bottom", 100, { rosterIndex: 1, role: "MIDDLE" }),
    rosterEntry("enemy-mid", 200, { rosterIndex: 9, role: "JUNGLE" }),
    rosterEntry("ally-support", 100, { rosterIndex: 3, role: "JUNGLE" }),
    rosterEntry("enemy-bottom", 200, { rosterIndex: 7, role: "BOTTOM" }),
  ];

  const { allies, enemies } = orderLiveMatchRoster(participants, "papipu");

  assert.deepEqual(allies.map((slot) => slot?.championId ?? null), [
    "ally-top", "ally-bottom", "ally-jungle", "ally-support", "ally-mid",
  ]);
  assert.deepEqual(enemies.map((slot) => slot?.championId ?? null), [
    "enemy-top", "enemy-support", "enemy-bottom", "enemy-jungle", "enemy-mid",
  ]);
});

test("recognizes explicit and legacy short remakes without classifying a normal match", () => {
  assert.equal(isRemakeMatch({ durationSeconds: 1_800, remake: true }), true);
  assert.equal(isRemakeMatch({ durationSeconds: 71 }), true);
  assert.equal(isRemakeMatch({ durationSeconds: 0 }), false);
  assert.equal(isRemakeMatch({ durationSeconds: 300 }), false);
});

test("keeps Papipu's respawn timer synchronized to 23:00–07:00 Peru time", () => {
  assert.equal(papipuRespawnSeconds(Date.UTC(2026, 6, 21, 3, 59, 59)), null);
  assert.equal(papipuRespawnSeconds(Date.UTC(2026, 6, 21, 4, 0, 0)), 28_800);
  assert.equal(papipuRespawnSeconds(Date.UTC(2026, 6, 21, 11, 0, 0)), 3_600);
  assert.equal(papipuRespawnSeconds(Date.UTC(2026, 6, 21, 11, 59, 59)), 1);
  assert.equal(papipuRespawnSeconds(Date.UTC(2026, 6, 21, 12, 0, 0)), null);
});

test("uses a cached snapshot only while it is inside the sixty-second window", () => {
  const now = Date.parse("2026-07-13T18:00:00.000Z");
  assert.equal(shouldUseCache(now - 59 * 1000, now), true);
  assert.equal(shouldUseCache(now - 60 * 1000, now), false);
  assert.equal(shouldUseCache(null, now), false);
});

test("normalizes the Solo/Duo league entry and ignores other queues", () => {
  const entry = normalizeSoloQueueEntry([
    { queueType: "RANKED_FLEX_SR", tier: "GOLD", rank: "IV", leaguePoints: 12, wins: 99, losses: 1 },
    { queueType: "RANKED_SOLO_5x5", tier: "SILVER", rank: "I", leaguePoints: 64, wins: 49, losses: 38 },
  ]);

  assert.deepEqual(entry, {
    tier: "SILVER",
    division: "I",
    leaguePoints: 64,
    wins: 49,
    losses: 38,
  });
});

test("returns an unranked entry when Solo/Duo data is absent", () => {
  assert.deepEqual(normalizeSoloQueueEntry([]), {
    tier: "UNRANKED",
    division: "",
    leaguePoints: 0,
    wins: 0,
    losses: 0,
  });
});

test("calculates progress toward Gold IV from the ranked ladder", () => {
  assert.equal(calculateGoldProgress("IRON", "IV", 0), 0);
  assert.equal(calculateGoldProgress("BRONZE", "I", 78), 65);
  assert.equal(calculateGoldProgress("SILVER", "I", 64), 97);
  assert.equal(calculateGoldProgress("SILVER", "I", 96), 99);
  assert.equal(calculateGoldProgress("GOLD", "IV", 0), 100);
  assert.equal(calculateGoldProgress("PLATINUM", "IV", 0), 100);
});

test("ranks duos by the same confidence bound that ranks champions", () => {
  // A perfect four-game pair must not outrank a long, genuinely strong one:
  // that is the entire reason the score is a lower bound and not a win rate.
  const ranked = rankDuoRecords([
    { playerIds: ["a", "b"], games: 4, wins: 4 },
    { playerIds: ["c", "d"], games: 30, wins: 21 },
  ]);

  assert.deepEqual(ranked.map((duo) => duo.playerIds[0]), ["c", "a"]);
  assert.equal(ranked[0].score, wilsonLowerBound(21, 30));
});

test("drops pairs that have not played enough together to be ranked", () => {
  const records = [
    { playerIds: ["a", "b"], games: DUO_LEADERBOARD_MIN_GAMES, wins: 2 },
    { playerIds: ["c", "d"], games: DUO_LEADERBOARD_MIN_GAMES - 1, wins: 3 },
  ];

  assert.deepEqual(rankDuoRecords(records).map((duo) => duo.playerIds), [["a", "b"]]);
});

test("separates duos the interval cannot on the sample that proved them", () => {
  // Same record, so the same bound: the pair with more games behind it wins,
  // and the ids keep the last step from reshuffling between refreshes.
  const ranked = rankDuoRecords([
    { playerIds: ["z", "y"], games: 8, wins: 4 },
    { playerIds: ["a", "b"], games: 16, wins: 8 },
  ]);

  assert.deepEqual(ranked.map((duo) => duo.games), [16, 8]);
});

test("recalculates progress against Platinum IV after the challenge goal advances", () => {
  assert.equal(calculateGoalProgress("GOLD", "IV", 0, "PLATINUM"), 75);
  assert.equal(calculateGoalProgress("GOLD", "I", 96, "PLATINUM"), 99);
  assert.equal(calculateGoalProgress("PLATINUM", "IV", 0, "PLATINUM"), 100);
});

test("accepts valid cached snapshots and rejects malformed cache data", async () => {
  const { createDemoSnapshot } = await import("../lib/leaderboard.ts");
  const demo = createDemoSnapshot(new Date("2026-07-13T18:00:00.000Z"));

  assert.deepEqual(parseLeaderboardSnapshot(JSON.stringify(demo)), demo);
  assert.equal(parseLeaderboardSnapshot('{"players":"not-an-array"}'), null);
  assert.equal(parseLeaderboardSnapshot("not-json"), null);
});
test("accepts the immediately previous member count during an atomic roster migration", async () => {
  const { createDemoSnapshot } = await import("../lib/leaderboard.ts");
  const legacy = createDemoSnapshot(new Date("2026-07-27T05:00:00.000Z"));
  legacy.players = legacy.players.slice(0, -1);

  assert.equal(parseLeaderboardSnapshot(JSON.stringify(legacy))?.players.length, 8);
});


test("recalculates goal progress when a cached snapshot contains a legacy value", async () => {
  const { createDemoSnapshot } = await import("../lib/leaderboard.ts");
  const cached = createDemoSnapshot(new Date("2026-07-13T18:00:00.000Z"));
  const papipu = cached.players.find((player) => player.gameName === "Papipu");
  assert.ok(papipu);
  papipu.progressToGold = 100;

  const parsed = parseLeaderboardSnapshot(JSON.stringify(cached));

  assert.equal(parsed?.players.find((player) => player.gameName === "Papipu")?.progressToGold, 99);
});

test("accepts legacy cache entries that predate latest-match details", async () => {
  const { createDemoSnapshot } = await import("../lib/leaderboard.ts");
  const cached = createDemoSnapshot(new Date("2026-07-13T18:00:00.000Z"));
  for (const player of cached.players) delete player.lastSoloQueueMatch;

  const parsed = parseLeaderboardSnapshot(JSON.stringify(cached));

  assert.ok(parsed);
  assert.ok(parsed.players.every((player) => player.lastSoloQueueMatch === null));
});

test("marks legacy latest matches as unverifiable instead of inventing a PL change", async () => {
  const { createDemoSnapshot } = await import("../lib/leaderboard.ts");
  const cached = createDemoSnapshot(new Date("2026-07-13T18:00:00.000Z"));
  delete cached.players[0].lastSoloQueueMatch.lpChangeEvidence;

  const parsed = parseLeaderboardSnapshot(JSON.stringify(cached));

  assert.ok(parsed);
  assert.deepEqual(parsed.players[0].lastSoloQueueMatch.lpChangeEvidence, {
    status: "unavailable",
    reason: "no_before_snapshot",
  });
});

test("recalculates best champions when cached top champions use the legacy games-only order", async () => {
  const { createDemoSnapshot } = await import("../lib/leaderboard.ts");
  const cached = createDemoSnapshot(new Date("2026-07-13T18:00:00.000Z"));
  const papipu = cached.players.find((player) => player.gameName === "Papipu");
  assert.ok(papipu);
  papipu.analytics.championCounts.Lucky = { id: "Lucky", name: "Lucky", games: 1, wins: 1 };
  papipu.analytics.topChampions = [{ id: "Lucky", name: "Lucky", games: 1, wins: 1 }];

  const parsed = parseLeaderboardSnapshot(JSON.stringify(cached));

  assert.notEqual(parsed?.players.find((player) => player.gameName === "Papipu")?.analytics.topChampions[0]?.id, "Lucky");
});

test("validates the browser payload before rendering API data", async () => {
  const { createDemoSnapshot } = await import("../lib/leaderboard.ts");
  const data = createDemoSnapshot(new Date("2026-07-13T18:00:00.000Z"));
  const payload = {
    data,
    meta: { source: "cache", isStale: false, cacheTtlSeconds: 300 },
  };

  assert.deepEqual(parseLeaderboardPayload(payload), payload);
  assert.equal(parseLeaderboardPayload({ ...payload, meta: { ...payload.meta, source: "unknown" } }), null);
  assert.equal(parseLeaderboardPayload({ data: {}, meta: payload.meta }), null);
  assert.equal(parseLeaderboardPayload({ data: { ...data, players: [] }, meta: payload.meta }), null);
});
