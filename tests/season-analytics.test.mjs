import assert from "node:assert/strict";
import test from "node:test";

import seasonSeed from "../lib/season-analytics-seed.json" with { type: "json" };

import {
  addMatchToAnalytics,
  analyticsFromSeed,
  emptyAnalytics,
  finalizeAnalytics,
} from "../lib/season-analytics.ts";

test("aggregates KDA, main role and top champions across season matches", () => {
  const analytics = emptyAnalytics();
  addMatchToAnalytics(analytics, {
    championId: 103,
    championName: "Ahri",
    kills: 8,
    deaths: 4,
    assists: 10,
    win: true,
    teamPosition: "MIDDLE",
  }, "LA2_1", 1000);
  addMatchToAnalytics(analytics, {
    championId: 103,
    championName: "Ahri",
    kills: 4,
    deaths: 6,
    assists: 8,
    win: false,
    teamPosition: "MIDDLE",
  }, "LA2_2", 2000);

  const result = finalizeAnalytics(analytics);
  assert.equal(result.games, 2);
  assert.equal(result.kda, 3);
  assert.equal(result.mainRole, "MIDDLE");
  assert.equal(result.roleShare, 100);
  assert.deepEqual(result.topChampions[0], { id: "Ahri", name: "Ahri", games: 2, wins: 1 });
  assert.equal(result.lastMatchId, "LA2_2");
});

test("ranks best champions by win rate confidence instead of raw win rate or games alone", () => {
  const analytics = emptyAnalytics();
  analytics.games = 81;
  analytics.championCounts = {
    lucky: { id: "Lucky", name: "Lucky", games: 1, wins: 1 },
    reliable: { id: "Reliable", name: "Reliable", games: 10, wins: 7 },
    volume: { id: "Volume", name: "Volume", games: 50, wins: 30 },
    standout: { id: "Standout", name: "Standout", games: 20, wins: 15 },
    steady: { id: "Steady", name: "Steady", games: 12, wins: 6 },
  };

  const result = finalizeAnalytics(analytics);

  assert.deepEqual(result.topChampions.map((champion) => champion.id), [
    "Standout",
    "Volume",
    "Reliable",
    "Steady",
    "Lucky",
  ]);
});

test("keeps roles and champion pools on the same SoloQ 2026 match set", () => {
  assert.equal(seasonSeed.queue, "RANKED_SOLO_5x5");
  assert.equal(seasonSeed.season, "2026");

  for (const player of Object.values(seasonSeed.players)) {
    const analytics = analyticsFromSeed(player);
    const roleGames = Object.values(player.roles).reduce((sum, games) => sum + games, 0);
    const championGames = Object.values(player.champions).reduce((sum, champion) => sum + champion.games, 0);
    const [mostPlayedRole, mostPlayedRoleGames] = Object.entries(player.roles).sort((a, b) => b[1] - a[1])[0];

    assert.equal(roleGames, player.analyticsGames, `${player.gameName}: roles`);
    assert.equal(championGames, player.analyticsGames, `${player.gameName}: champions`);
    assert.equal(analytics.mainRole, mostPlayedRole, `${player.gameName}: main role`);
    assert.equal(analytics.roleShare, Math.round((mostPlayedRoleGames / roleGames) * 100), `${player.gameName}: role share`);
  }
});
