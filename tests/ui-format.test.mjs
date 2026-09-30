import assert from "node:assert/strict";
import test from "node:test";

import {
  bestChampionViews,
  championDisplayName,
  championIconUrl,
  championKey,
  championView,
  duoView,
  firstName,
  formSlots,
  formatAge,
  formatDuration,
  formatLimaTime,
  formatLpChange,
  kdaRatio,
  matchDetailsUrl,
  mostPlayedChampionViews,
  peerNames,
  perGameAverages,
  profileUrl,
  rankAsset,
  rankLabel,
  roleShares,
} from "../lib/ui-format.ts";

test("names ranks and crests the way the board prints them", () => {
  assert.equal(rankLabel({ tier: "PLATINUM", division: "IV" }), "Platino IV");
  assert.equal(rankLabel({ tier: "MASTER", division: "" }), "Maestro");
  assert.equal(rankAsset("GOLD"), "/ranks/gold.png");
  // Unranked borrows Iron's crest; the stylesheet drains it.
  assert.equal(rankAsset("UNRANKED"), "/ranks/iron.png");
});

test("calls a player by the first word of their Riot ID", () => {
  assert.equal(firstName("  INTI   VIRAC0NCHA "), "INTI");
  assert.equal(firstName("Mamimu"), "Mamimu");
});

test("formats ages, durations and Lima wall-clock time", () => {
  const now = Date.UTC(2026, 8, 29, 5, 0, 0);
  assert.equal(formatAge(now - 20_000, now), "ahora");
  assert.equal(formatAge(now - 57 * 60_000, now), "hace 57 min");
  assert.equal(formatAge(now - 5 * 3_600_000, now), "hace 5 h");
  assert.equal(formatAge(now - 30 * 86_400_000, now), "hace 30 d");
  assert.equal(formatDuration(2288), "38:08");
  // Lima is UTC-5 all year.
  assert.equal(formatLimaTime("2026-09-29T05:01:51.034Z"), "00:01");
});

test("writes PL changes with a real minus sign and admits when there is no evidence", () => {
  const observed = (value) => ({ status: "observed", value, source: "rank_snapshot_delta", beforeObservedAt: "", afterObservedAt: "" });
  assert.equal(formatLpChange(observed(17)), "+17 PL");
  assert.equal(formatLpChange(observed(-23)), "−23 PL");
  assert.equal(formatLpChange(observed(0)), "0 PL");
  assert.equal(formatLpChange({ status: "pending", reason: "league_state_not_updated" }), "Calculando…");
  assert.equal(formatLpChange({ status: "unavailable", reason: "no_before_snapshot" }), null);
  // A remake never moved the rank, whatever the evidence says.
  assert.equal(formatLpChange(observed(-18), true), "0 PL");
});

test("keeps five form slots, padding missing games as empty ones on the left", () => {
  assert.deepEqual(formSlots([]).slots, ["empty", "empty", "empty", "empty", "empty"]);
  assert.equal(formSlots([]).label, "Sin partidas recientes registradas");
  const partial = formSlots([false, false]);
  assert.deepEqual(partial.slots, ["empty", "empty", "empty", "loss", "loss"]);
  assert.equal(partial.text, "0V 2D");
  const full = formSlots([true, true, true, false, true, false]);
  assert.deepEqual(full.slots, ["win", "win", "loss", "win", "loss"]);
  assert.equal(full.label, "Últimas 5: 3 victorias y 2 derrotas");
});

test("orders champions by the Wilson bound and colours them by the rounded winrate", () => {
  const counts = {
    Nautilus: { id: "Nautilus", name: "Nautilus", games: 20, wins: 12 },
    Maokai: { id: "Maokai", name: "Maokai", games: 3, wins: 3 },
    MissFortune: { id: "MissFortune", name: "MissFortune", games: 28, wins: 14 },
    Yone: { id: "Yone", name: "Yone", games: 2, wins: 0 },
  };
  const best = bestChampionViews(counts, 3);
  assert.deepEqual(best.map((champion) => champion.id), ["Nautilus", "Maokai", "MissFortune"]);
  assert.equal(best[0].winRate, 60);
  assert.ok(best[0].adjusted < best[0].winRate, "the adjusted bar sits below the observed one");
  assert.equal(best[2].name, "Miss Fortune");

  assert.deepEqual(mostPlayedChampionViews(counts, 2).map((champion) => champion.id), ["MissFortune", "Nautilus"]);
  // 54.6% displays as 55% and must share its colour with 55%.
  assert.equal(championView({ id: "A", name: "A", games: 1000, wins: 546 }).tone, "strong");
  assert.equal(championView({ id: "B", name: "B", games: 100, wins: 48 }).tone, "even");
  assert.equal(championView({ id: "C", name: "C", games: 100, wins: 47 }).tone, "weak");
});

test("maps Match-V5 champion keys to names and Data Dragon assets", () => {
  assert.equal(championDisplayName({ id: "Chogath", name: "Chogath" }), "Cho'Gath");
  assert.equal(championDisplayName({ id: "MonkeyKing", name: "MonkeyKing" }), "Wukong");
  assert.equal(championDisplayName({ id: "Chogath", name: "Cho'Gath" }), "Cho'Gath");
  assert.equal(championKey("FiddleSticks"), "Fiddlesticks");
  assert.equal(championIconUrl("16.19.1", "FiddleSticks"), "https://ddragon.leagueoflegends.com/cdn/16.19.1/img/champion/Fiddlesticks.png");
});

test("links players and matches to League of Graphs", () => {
  assert.equal(profileUrl({ gameName: "INTI VIRAC0NCHA", tagLine: "20CM" }), "https://www.leagueofgraphs.com/summoner/las/INTI%20VIRAC0NCHA-20CM");
  assert.equal(matchDetailsUrl("LA2_1627286623"), "https://www.leagueofgraphs.com/match/las/1627286623");
  assert.equal(matchDetailsUrl("NA1_123"), null);
});

test("names match companions by their current Riot ID, not the one stored with the match", () => {
  const roster = [
    { id: "papipu", gameName: "Papipu" },
    { id: "wonder-boi", gameName: "regigig4s" },
    { id: "inti", gameName: "INTI VIRAC0NCHA" },
  ];
  const participant = (gameName, challengePlayerId) => ({ championId: "Lux", championName: "Lux", teamId: 100, gameName, tagLine: "x", challengePlayerId });
  const names = peerNames([
    participant("Papipu", "papipu"),
    participant("Wonder Boi", "wonder-boi"),
    participant("INTI VIRAC0NCHA", "inti"),
    participant("Stranger", null),
  ], "papipu", roster);
  assert.deepEqual(names, ["regigig4s", "INTI"]);
});

test("spreads roles most played first with bars relative to the main role", () => {
  const shares = roleShares({ MIDDLE: 205, BOTTOM: 150, UTILITY: 137, JUNGLE: 61, TOP: 57, UNKNOWN: 1 });
  assert.deepEqual(shares.map((entry) => entry.label), ["Mid", "ADC", "Support", "Jungla", "Top"]);
  assert.equal(shares[0].bar, 100);
  assert.equal(shares[0].share, 34);
  assert.equal(shares[1].bar, 73);
  assert.deepEqual(roleShares({}), []);
});

test("derives averages, KDA ratios and duo figures", () => {
  assert.equal(kdaRatio(6, 12, 8), "1.2");
  assert.equal(kdaRatio(3, 0, 5), "8.0");
  assert.equal(perGameAverages({ games: 611, kills: 3987, deaths: 4006, assists: 5332 }), "6.5 / 6.6 / 8.7");
  assert.equal(perGameAverages({ games: 0, kills: 0, deaths: 0, assists: 0 }), null);
  const duo = duoView({ games: 106, wins: 58, score: 0.423 });
  assert.equal(duo.losses, 48);
  assert.equal(duo.winRate.toFixed(1), "54.7");
  assert.equal(duo.adjusted.toFixed(1), "42.3");
  assert.equal(duo.tone, "even");
});
