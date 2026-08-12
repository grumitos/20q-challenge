import assert from "node:assert/strict";
import test from "node:test";
import {
  expirePendingLpEvidence,
  LP_RECONCILIATION_WINDOW_MS,
  preserveDefinitiveEvidence,
  rankedLpAxis,
  reconcileRankedMatch,
} from "../lib/lp-reconciliation.ts";

const rank = (overrides = {}) => ({
  tier: "GOLD",
  division: "II",
  leaguePoints: 50,
  wins: 20,
  losses: 10,
  ...overrides,
});

test("a new SoloQ match produces the correct numeric LP delta", () => {
  assert.deepEqual(reconcileRankedMatch({
    before: rank(),
    after: rank({ leaguePoints: 73, wins: 21 }),
    matchWon: true,
  }), { status: "resolved", delta: 23 });
});

test("zero new games stays pending and never synthesizes 0 LP", () => {
  assert.deepEqual(reconcileRankedMatch({ before: rank(), after: rank(), matchWon: true }), {
    status: "pending",
    reason: "league_state_not_updated",
  });
});

test("multiple games between rank snapshots are not attributed to one match", () => {
  assert.deepEqual(reconcileRankedMatch({
    before: rank(),
    after: rank({ leaguePoints: 88, wins: 22 }),
    matchWon: true,
  }), { status: "unavailable", reason: "multiple_games_between_snapshots" });
});

test("a victory and a defeat must match the corresponding League-V4 counter", () => {
  assert.deepEqual(reconcileRankedMatch({
    before: rank(),
    after: rank({ leaguePoints: 70, losses: 11 }),
    matchWon: true,
  }), { status: "unavailable", reason: "match_rank_mismatch" });
  assert.deepEqual(reconcileRankedMatch({
    before: rank(),
    after: rank({ leaguePoints: 30, wins: 21 }),
    matchWon: false,
  }), { status: "unavailable", reason: "match_rank_mismatch" });
});

test("ordinary promotions and demotions use a continuous LP axis", () => {
  assert.deepEqual(reconcileRankedMatch({
    before: rank({ division: "II", leaguePoints: 88 }),
    after: rank({ division: "I", leaguePoints: 12, wins: 21 }),
    matchWon: true,
  }), { status: "resolved", delta: 24 });
  assert.deepEqual(reconcileRankedMatch({
    before: rank({ division: "II", leaguePoints: 3 }),
    after: rank({ division: "III", leaguePoints: 79, losses: 11 }),
    matchWon: false,
  }), { status: "resolved", delta: -24 });
});

test("Master+ shares one LP axis and Diamond I to Master remains comparable", () => {
  assert.equal(rankedLpAxis(rank({ tier: "MASTER", division: "", leaguePoints: 40 })), 2840);
  assert.equal(rankedLpAxis(rank({ tier: "CHALLENGER", division: "", leaguePoints: 40 })), 2840);
  assert.deepEqual(reconcileRankedMatch({
    before: rank({ tier: "MASTER", division: "", leaguePoints: 40 }),
    after: rank({ tier: "GRANDMASTER", division: "", leaguePoints: 61, wins: 21 }),
    matchWon: true,
  }), { status: "resolved", delta: 21 });
  assert.deepEqual(reconcileRankedMatch({
    before: rank({ tier: "DIAMOND", division: "I", leaguePoints: 88 }),
    after: rank({ tier: "MASTER", division: "", leaguePoints: 12, wins: 21 }),
    matchWon: true,
  }), { status: "resolved", delta: 24 });
});

test("placements, resets and rank-only movement use safe rules", () => {
  assert.deepEqual(reconcileRankedMatch({
    before: rank({ tier: "UNRANKED", division: "", leaguePoints: 0, wins: 0, losses: 0 }),
    after: rank({ wins: 1, losses: 0 }),
    matchWon: true,
  }), { status: "unavailable", reason: "rank_not_comparable" });
  assert.deepEqual(reconcileRankedMatch({
    before: rank(),
    after: rank({ wins: 0, losses: 0 }),
    matchWon: true,
  }), { status: "unavailable", reason: "season_or_rank_reset" });
  assert.deepEqual(reconcileRankedMatch({
    before: rank(),
    after: rank({ leaguePoints: 49 }),
    matchWon: true,
  }), { status: "unavailable", reason: "rank_state_changed_without_match" });
});

test("0 PL needs a second stable observation after exactly one matching game", () => {
  const input = {
    before: rank(),
    after: rank({ wins: 21 }),
    matchWon: true,
  };
  assert.deepEqual(reconcileRankedMatch(input), {
    status: "pending",
    reason: "zero_delta_requires_confirmation",
  });
  assert.deepEqual(reconcileRankedMatch({ ...input, zeroDeltaConfirmed: true }), {
    status: "resolved",
    delta: 0,
  });
});

test("definitive evidence survives later pending refreshes", () => {
  const definitive = {
    status: "observed",
    value: 23,
    source: "rank_snapshot_delta",
    beforeObservedAt: "before",
    afterObservedAt: "after",
  };
  assert.deepEqual(preserveDefinitiveEvidence(definitive, {
    status: "pending",
    reason: "league_state_not_updated",
  }), definitive);
});

test("pending PL evidence expires two hours after the match ends", () => {
  const pending = { status: "pending", reason: "league_state_not_updated" };
  const matchEndedAt = Date.UTC(2026, 6, 26, 7, 0, 0);

  assert.deepEqual(expirePendingLpEvidence(
    pending,
    matchEndedAt,
    matchEndedAt + LP_RECONCILIATION_WINDOW_MS,
  ), pending);
  assert.deepEqual(expirePendingLpEvidence(
    pending,
    matchEndedAt,
    matchEndedAt + LP_RECONCILIATION_WINDOW_MS + 1,
  ), { status: "unavailable", reason: "rank_update_timeout" });
});
