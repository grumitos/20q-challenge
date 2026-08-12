import type { Division, LpChangeEvidence, RankTier } from "./leaderboard.ts";

export type RankObservationState = {
  tier: RankTier;
  division: Division;
  leaguePoints: number;
  wins: number;
  losses: number;
};

export type ReconciliationFailureReason =
  | "no_before_snapshot"
  | "multiple_games_between_snapshots"
  | "match_rank_mismatch"
  | "season_or_rank_reset"
  | "historical_backfill"
  | "rank_not_comparable"
  | "rank_state_changed_without_match"
  | "rank_update_timeout";

export type ReconciliationResult =
  | { status: "pending"; reason: "league_state_not_updated" | "zero_delta_requires_confirmation" }
  | { status: "resolved"; delta: number }
  | { status: "unavailable"; reason: ReconciliationFailureReason };

export const LP_RECONCILIATION_WINDOW_MS = 2 * 60 * 60 * 1_000;

const ORDINARY_TIERS: RankTier[] = [
  "IRON",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "EMERALD",
  "DIAMOND",
];
const DIVISION_OFFSETS: Record<Exclude<Division, "">, number> = {
  IV: 0,
  III: 100,
  II: 200,
  I: 300,
};
const APEX_BASE = ORDINARY_TIERS.length * 400;

/**
 * Converts League-V4 rank coordinates to one continuous comparison axis.
 * Master, Grandmaster and Challenger deliberately share the same base because
 * movement between those labels is leaderboard membership, not an extra 400 PL.
 */
export function rankedLpAxis(state: Pick<RankObservationState, "tier" | "division" | "leaguePoints">) {
  if (!Number.isFinite(state.leaguePoints) || state.leaguePoints < 0 || state.tier === "UNRANKED") return null;
  if (state.tier === "MASTER" || state.tier === "GRANDMASTER" || state.tier === "CHALLENGER") {
    return APEX_BASE + Math.trunc(state.leaguePoints);
  }
  const tierIndex = ORDINARY_TIERS.indexOf(state.tier);
  if (tierIndex < 0 || !state.division || !(state.division in DIVISION_OFFSETS)) return null;
  return tierIndex * 400 + DIVISION_OFFSETS[state.division as Exclude<Division, "">] + Math.trunc(state.leaguePoints);
}

export function reconcileRankedMatch(input: {
  before?: RankObservationState | null;
  after: RankObservationState;
  matchWon: boolean;
  zeroDeltaConfirmed?: boolean;
}): ReconciliationResult {
  const before = input.before;
  if (!before) return { status: "unavailable", reason: "no_before_snapshot" };

  const winsAdded = input.after.wins - before.wins;
  const lossesAdded = input.after.losses - before.losses;
  const gamesAdded = winsAdded + lossesAdded;
  const beforeAxis = rankedLpAxis(before);
  const afterAxis = rankedLpAxis(input.after);

  if (winsAdded < 0 || lossesAdded < 0 || gamesAdded < 0) {
    return { status: "unavailable", reason: "season_or_rank_reset" };
  }
  if (beforeAxis === null || afterAxis === null) {
    return { status: "unavailable", reason: "rank_not_comparable" };
  }
  if (gamesAdded === 0) {
    return beforeAxis === afterAxis
      ? { status: "pending", reason: "league_state_not_updated" }
      : { status: "unavailable", reason: "rank_state_changed_without_match" };
  }
  if (gamesAdded > 1) {
    return { status: "unavailable", reason: "multiple_games_between_snapshots" };
  }
  if ((input.matchWon && (winsAdded !== 1 || lossesAdded !== 0)) ||
      (!input.matchWon && (winsAdded !== 0 || lossesAdded !== 1))) {
    return { status: "unavailable", reason: "match_rank_mismatch" };
  }

  const delta = afterAxis - beforeAxis;
  if (delta === 0 && input.zeroDeltaConfirmed !== true) {
    return { status: "pending", reason: "zero_delta_requires_confirmation" };
  }
  return { status: "resolved", delta };
}

export function toLpChangeEvidence(
  result: ReconciliationResult,
  beforeObservedAt: string,
  afterObservedAt: string,
): LpChangeEvidence {
  if (result.status === "resolved") {
    return {
      status: "observed",
      value: result.delta,
      source: "rank_snapshot_delta",
      beforeObservedAt,
      afterObservedAt,
    };
  }
  if (result.status === "pending") return { status: "pending", reason: result.reason };
  return { status: "unavailable", reason: result.reason };
}

export function preserveDefinitiveEvidence(
  previous: LpChangeEvidence | null | undefined,
  incoming: LpChangeEvidence,
): LpChangeEvidence {
  return previous?.status === "observed" ? previous : incoming;
}

export function expirePendingLpEvidence(
  evidence: LpChangeEvidence,
  matchEndedAt: number,
  observedAt: number,
): LpChangeEvidence {
  if (
    evidence.status === "pending" &&
    Number.isFinite(matchEndedAt) &&
    Number.isFinite(observedAt) &&
    observedAt > matchEndedAt + LP_RECONCILIATION_WINDOW_MS
  ) {
    return { status: "unavailable", reason: "rank_update_timeout" };
  }
  return evidence;
}
