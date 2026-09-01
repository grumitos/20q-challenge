import assert from "node:assert/strict";
import test from "node:test";

import { advanceGameSessions, processTrackerPlayer, recentMatchPollCount } from "../lib/lp-tracker.ts";

const baseline = {
  id: "p1:1000",
  playerId: "p1",
  observedAt: 1000,
  tier: "SILVER",
  division: "I",
  leaguePoints: 90,
  wins: 10,
  losses: 10,
};

test("keeps the post-spectator window alive across a transient miss", () => {
  const session = {
    playerId: "p1",
    platformGameId: "77",
    queueId: 420,
    baselineObservationId: baseline.id,
    gameStartedAt: 1_500,
    firstSeenAt: 2_000,
    lastSeenAt: 3_000,
    endedDetectedAt: 4_000,
    matchId: null,
    status: "ended_waiting_match",
    championId: null,
    championName: null,
    participants: null,
    updatedAt: 4_000,
  };
  const result = advanceGameSessions({
    now: 5_000,
    player: { playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null },
    observation: { ...baseline, id: "p1:5000", observedAt: 5_000 },
    sessions: [session],
    activeGame: {
      platformGameId: "77",
      gameStartedAt: 1_500,
      queueId: 420,
      championId: "82",
      selfIndex: 0,
      participants: [],
    },
  });

  assert.equal(result[0].status, "active");
  assert.equal(result[0].endedDetectedAt, null);
  assert.equal(result[0].lastSeenAt, 5_000);
});

test("polls full recent history for live/postgame work and rotates idle players", () => {
  assert.equal(recentMatchPollCount("p1", [{ playerId: "p1", status: "active" }], [], 4, 9, 0), 3);
  assert.equal(recentMatchPollCount("p1", [{ playerId: "p1", status: "ended_waiting_match" }], [], 4, 9, 0), 3);
  assert.equal(recentMatchPollCount("p1", [], [], 0, 9, 0), 3);
  assert.equal(recentMatchPollCount("p1", [], [], 4, 9, 0), 0);
  assert.equal(recentMatchPollCount("p1", [], [], 1, 9, 60_000), 3);
});

test("links an ended Spectator session and resolves one matching victory", () => {
  const result = processTrackerPlayer({
    now: 5_000,
    player: { playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null },
    observation: { ...baseline, id: "p1:5000", observedAt: 5_000, tier: "GOLD", division: "IV", leaguePoints: 12, wins: 11 },
    observations: [baseline],
    sessions: [{
      playerId: "p1",
      platformGameId: "77",
      queueId: 420,
      baselineObservationId: baseline.id,
      gameStartedAt: 1_500,
      firstSeenAt: 2_000,
      lastSeenAt: 3_000,
      endedDetectedAt: 4_000,
      matchId: null,
      status: "ended_waiting_match",
      updatedAt: 4_000,
    }],
    candidates: [],
    activeGame: null,
    recentMatches: [{ matchId: "LA2_77", gameStartedAt: 1_500, gameEndedAt: 4_000, queueId: 420, participants: [{ puuid: "puuid-1", won: true }] }],
  });

  assert.equal(result.sessions[0].status, "linked");
  assert.equal(result.sessions[0].matchId, "LA2_77");
  assert.deepEqual(result.evidence, [{
    playerId: "p1",
    matchId: "LA2_77",
    status: "observed",
    lpDelta: 22,
    beforeObservationId: "p1:1000",
    afterObservationId: "p1:5000",
    failureReason: null,
    matchStartedAt: 1_500,
    matchEndedAt: 4_000,
    matchWon: true,
    createdAt: 5_000,
    resolvedAt: 5_000,
    updatedAt: 5_000,
  }]);
});

test("keeps a zero delta pending until a second stable observation", () => {
  const candidate = {
    playerId: "p1",
    matchId: "LA2_77",
    state: "awaiting_rank",
    baselineObservationId: baseline.id,
    matchStartedAt: 1_500,
    matchEndedAt: 4_000,
    matchWon: true,
    zeroCandidateObservationId: null,
    attempts: 0,
    nextAttemptAt: 0,
    expiresAt: 100_000,
    failureReason: null,
    createdAt: 4_000,
    updatedAt: 4_000,
  };
  const first = processTrackerPlayer({
    now: 5_000,
    player: { playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: "LA2_77" },
    observation: { ...baseline, id: "p1:5000", observedAt: 5_000, wins: 11 },
    observations: [baseline], sessions: [], candidates: [candidate], activeGame: null, recentMatches: [],
  });
  assert.equal(first.candidates[0].state, "confirming_zero");
  assert.equal(first.evidence.length, 0);

  const second = processTrackerPlayer({
    now: 6_000,
    player: { playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: "LA2_77" },
    observation: { ...baseline, id: "p1:6000", observedAt: 6_000, wins: 11 },
    observations: [baseline, { ...baseline, id: "p1:5000", observedAt: 5_000, wins: 11 }],
    sessions: [], candidates: first.candidates, activeGame: null, recentMatches: [],
  });
  assert.equal(second.evidence[0].lpDelta, 0);
  assert.equal(second.candidates[0].state, "resolved");
});

test("marks a match without any pre-match observation unavailable instead of calculating forever", () => {
  const result = processTrackerPlayer({
    now: 8_000,
    player: { playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null },
    observation: { ...baseline, id: "p1:8000", observedAt: 8_000, leaguePoints: 20, wins: 11 },
    observations: [{ ...baseline, id: "p1:5000", observedAt: 5_000 }],
    sessions: [], candidates: [], activeGame: null,
    recentMatches: [{ matchId: "LA2_77", gameStartedAt: 1_500, gameEndedAt: 4_000, queueId: 420, participants: [{ puuid: "puuid-1", won: true }] }],
  });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].status, "unavailable");
  assert.equal(result.evidence[0].failureReason, "no_before_snapshot");
  assert.equal(result.candidates[0].baselineObservationId, null);
  assert.equal(result.candidates[0].state, "unavailable");
});

test("closes an irrecoverable candidate before its future retry time", () => {
  const result = processTrackerPlayer({
    now: 8_000,
    player: { playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: "LA2_77" },
    observation: { ...baseline, id: "p1:8000", observedAt: 8_000 },
    observations: [{ ...baseline, id: "p1:5000", observedAt: 5_000 }],
    sessions: [],
    candidates: [{
      playerId: "p1",
      matchId: "LA2_77",
      state: "awaiting_rank",
      baselineObservationId: null,
      matchStartedAt: 1_500,
      matchEndedAt: 4_000,
      matchWon: true,
      zeroCandidateObservationId: null,
      attempts: 3,
      nextAttemptAt: 100_000,
      expiresAt: 120_000,
      failureReason: null,
      createdAt: 5_000,
      updatedAt: 5_000,
    }],
    activeGame: null,
    recentMatches: [],
  });

  assert.equal(result.evidence[0].failureReason, "no_before_snapshot");
  assert.equal(result.candidates[0].state, "unavailable");
});

test("expires rank reconciliation two hours after the match ended, not after discovery", () => {
  const result = processTrackerPlayer({
    now: 7_205_000,
    player: { playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: "LA2_77" },
    observation: { ...baseline, id: "p1:7205000", observedAt: 7_205_000 },
    observations: [baseline],
    sessions: [],
    candidates: [{
      playerId: "p1",
      matchId: "LA2_77",
      state: "awaiting_rank",
      baselineObservationId: baseline.id,
      matchStartedAt: 1_500,
      matchEndedAt: 4_000,
      matchWon: true,
      zeroCandidateObservationId: null,
      attempts: 1,
      nextAttemptAt: 0,
      expiresAt: 20_000_000,
      failureReason: null,
      createdAt: 7_000_000,
      updatedAt: 7_000_000,
    }],
    activeGame: null,
    recentMatches: [],
  });

  assert.equal(result.evidence[0].failureReason, "rank_update_timeout");
  assert.equal(result.candidates[0].state, "unavailable");
});

test("keeps the latest pre-match observation while Riot rank data catches up", () => {
  const result = processTrackerPlayer({
    now: 5_000,
    player: { playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null },
    observation: { ...baseline, id: "p1:5000", observedAt: 5_000 },
    observations: [baseline],
    sessions: [], candidates: [], activeGame: null,
    recentMatches: [{ matchId: "LA2_77", gameStartedAt: 1_500, gameEndedAt: 4_000, queueId: 420, participants: [{ puuid: "puuid-1", won: true }] }],
  });

  assert.equal(result.evidence.length, 0);
  assert.equal(result.candidates[0].baselineObservationId, baseline.id);
  assert.equal(result.candidates[0].state, "awaiting_rank");
});

test("links a remake session without creating a PL reconciliation candidate", () => {
  const result = processTrackerPlayer({
    now: 5_000,
    player: { playerId: "p1", puuid: "puuid-1", gameName: "P1", tagLine: "LAS", recentMatchId: null },
    observation: { ...baseline, id: "p1:5000", observedAt: 5_000 },
    observations: [baseline],
    sessions: [{
      playerId: "p1",
      platformGameId: "77",
      queueId: 420,
      baselineObservationId: baseline.id,
      gameStartedAt: 1_500,
      firstSeenAt: 2_000,
      lastSeenAt: 3_000,
      endedDetectedAt: 4_000,
      matchId: null,
      status: "ended_waiting_match",
      championId: null,
      championName: null,
      participants: null,
      updatedAt: 4_000,
    }],
    candidates: [],
    activeGame: null,
    recentMatches: [{
      matchId: "LA2_REMAKE",
      gameStartedAt: 1_500,
      gameEndedAt: 4_000,
      queueId: 420,
      remake: true,
      participants: [{ puuid: "puuid-1", won: false }],
    }],
  });

  assert.equal(result.sessions[0].status, "linked");
  assert.equal(result.sessions[0].matchId, "LA2_REMAKE");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.evidence.length, 0);
});
