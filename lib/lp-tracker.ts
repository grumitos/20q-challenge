import { LP_RECONCILIATION_WINDOW_MS, reconcileRankedMatch } from "./lp-reconciliation.ts";
import { calculateGoldProgress, calculateWinRate, type Division, type RankTier } from "./leaderboard.ts";
import type { ActiveSoloQueueGame, TrackerMatch } from "./riot-tracker-api.ts";
import { createRiotTrackerApi } from "./riot-tracker-api.ts";
import { mapWithConcurrency, TRACKER_REQUEST_BUDGET, type RiotFetch } from "./riot-request.ts";
import type { LpTrackerStore } from "../db/lp-tracker-store.ts";
import { normalizeSoloQueueMatch, RIOT_PLAYERS } from "./riot-client.ts";
import { championsByNumericKey } from "./champion-catalog.ts";

/** Only used if a cached snapshot has not recorded a Data Dragon version yet. */
const FALLBACK_DATA_DRAGON_VERSION = "16.13.1";

export type TrackerPlayerState = {
  playerId: string;
  puuid: string;
  gameName: string;
  tagLine: string;
  recentMatchId: string | null;
};

export type TrackerObservation = {
  id: string;
  playerId: string;
  observedAt: number;
  tier: RankTier;
  division: Division;
  leaguePoints: number;
  wins: number;
  losses: number;
};

export type TrackedGameSession = {
  playerId: string;
  platformGameId: string;
  queueId: 420;
  baselineObservationId: string;
  gameStartedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  endedDetectedAt: number | null;
  matchId: string | null;
  status: "active" | "ended_waiting_match" | "linked" | "expired";
  /** Spectator detail so an active game can be rendered, not only detected. */
  championId: string | null;
  championName: string | null;
  participants: string | null;
  updatedAt: number;
};

export type ReconciliationCandidate = {
  playerId: string;
  matchId: string;
  state: "awaiting_match" | "awaiting_rank" | "confirming_zero" | "resolved" | "unavailable";
  baselineObservationId: string | null;
  matchStartedAt: number;
  matchEndedAt: number | null;
  matchWon: boolean | null;
  zeroCandidateObservationId: string | null;
  attempts: number;
  nextAttemptAt: number;
  expiresAt: number;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MatchLpEvidence = {
  playerId: string;
  matchId: string;
  status: "observed" | "unavailable";
  lpDelta: number | null;
  beforeObservationId: string | null;
  afterObservationId: string | null;
  failureReason: string | null;
  matchStartedAt: number;
  matchEndedAt: number | null;
  matchWon: boolean | null;
  createdAt: number;
  resolvedAt: number;
  updatedAt: number;
};

type AdvanceGameSessionsInput = {
  now: number;
  player: TrackerPlayerState;
  observation: TrackerObservation;
  sessions: TrackedGameSession[];
  activeGame: ActiveSoloQueueGame | null;
  /** Champion/roster detail for `activeGame`, already resolved to Data Dragon ids. */
  activeGameDetail?: { championId: string; championName: string; participants: string } | null;
};

type ReconcilePlayerMatchesInput = {
  now: number;
  player: TrackerPlayerState;
  observation: TrackerObservation;
  observations: TrackerObservation[];
  /** Already through `advanceGameSessions`. */
  sessions: TrackedGameSession[];
  candidates: ReconciliationCandidate[];
  recentMatches: TrackerMatch[];
};

type ProcessTrackerPlayerInput = AdvanceGameSessionsInput & ReconcilePlayerMatchesInput;

const SESSION_MATCH_TOLERANCE_MS = 10 * 60 * 1_000;
/** Caps the account lookups a single run spends catching up the roster, so a
    Riot ID that stays unresolvable cannot starve the polling budget. */
const MAX_ENROLMENTS_PER_RUN = 3;

/**
 * How many Match-V5 details one run may download and parse.
 *
 * This was `RIOT_PLAYERS.length`, one per player, on the reasoning that nine
 * players cannot finish more than that between two minute ticks. True, and
 * still beside the point: the binding limit is not how many games exist, it is
 * that a Worker on the free plan gets **10 ms of CPU per invocation**, and
 * parsing a match payload is the most expensive thing this run does.
 *
 * Measured, on a 50 KiB payload of match-v5's shape (ten participants with
 * their stats and `challenges`): 0.76 ms median, 1.85 ms worst, per payload.
 * Nine of them is 7.6 ms median and 11.0 ms worst — over the entire budget on
 * that step alone, before the eighteen rank and spectator parses, the
 * reconciliation, or the snapshot projection. Real payloads run larger than the
 * one measured, so that is the optimistic end.
 *
 * Two costs ~1.5 ms median and ~3.7 ms worst, which leaves the rest of the run
 * real headroom. Cloudflare absorbs an occasional overrun but terminates a
 * Worker that exceeds the limit *consistently* — and a run killed before it
 * persisted its candidates left the next run the same payloads to re-parse, so
 * "consistently" is exactly what the old cap produced once a backlog appeared.
 * That loop stalled the tracker for sixty-seven minutes on 2026-08-13.
 *
 * A backlog now drains two per tick — a nine-player roster in five minutes,
 * against ranked games that take fifteen — so the cap costs elapsed time, not
 * completeness.
 */
export const MATCH_DETAILS_PER_RUN = 2;

/**
 * How long a run may hold the lane before another may take it.
 *
 * This was 55s — just under the cron interval — which assumed a run always
 * finishes inside a minute. It does not: requests spaced for Riot's rate limit
 * take seconds on their own, and each 429 sleeps its Retry-After on top. Any run
 * that overran let the next tick run *concurrently*, doubling the Riot spend at
 * exactly the moment the key was already throttling.
 *
 * It was then four minutes, on the reasoning that nothing renews it so it is
 * really a crash bound, and a crash costs only a few skipped ticks. The cost of
 * that assumption showed up in production: a run killed for exceeding its CPU
 * budget never reaches its `finally`, so the lane stayed leased for the full
 * four minutes, and the tracker's effective cadence collapsed from one run a
 * minute to one every five. Measured in D1: rank observations 297–301s apart for
 * an hour at a stretch, and a live-game card that stayed on the board because no
 * run was allowed to close it.
 *
 * So it is renewed now, at each phase boundary. That decouples the two jobs the
 * number was doing: the TTL bounds how long a *dead* run holds the lane, while
 * renewal is what lets a live one take as long as it legitimately needs. Ninety
 * seconds means a killed run costs about one tick instead of four.
 *
 * The exposure this accepts: a run stalled on a Retry-After longer than the TTL
 * can lose the lane to the next tick. That is bounded elsewhere and on purpose —
 * a 429 makes the run call `blockLaneUntil`, so the lane is held shut for the
 * rate limit's own duration by a mechanism that does not depend on this at all.
 */
const LEASE_TTL_MS = 90_000;

/** One cron tick. Long enough that a public request cannot re-drive a run that
    wrote no cache, short enough that the scheduled tick is never the one held
    back. See where this is applied for what the loop actually was. */
const PROJECTION_GAP_COOLDOWN_MS = 60_000;

/** Comfortably past `LP_RECONCILIATION_WINDOW_MS`, so a sweep can never take an
    observation a pending reconciliation still needs. Rows older than this are
    unreachable: the load query keeps 32 per player and no lookup goes further
    back. Referenced ids are excluded by the delete itself regardless of age. */
const OBSERVATION_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Hourly. The sweep is cheap but pointless to run against 9 new rows. */
const OBSERVATION_SWEEP_EVERY_TICKS = 60;

function participantResult(match: TrackerMatch, puuid: string) {
  return match.participants.find((participant) => participant.puuid === puuid)?.won;
}

function fallbackBaseline(
  observations: readonly TrackerObservation[],
  current: TrackerObservation,
  match: TrackerMatch,
  won: boolean,
) {
  const eligible = observations
    .filter((candidate) => candidate.observedAt <= match.gameEndedAt)
    .sort((left, right) => right.observedAt - left.observedAt);
  return eligible.find((candidate) =>
    current.wins - candidate.wins === (won ? 1 : 0) &&
    current.losses - candidate.losses === (won ? 0 : 1)) ?? eligible[0] ?? null;
}

function nextAttempt(now: number, attempts: number) {
  const delays = [60_000, 120_000, 240_000, 300_000];
  return now + delays[Math.min(attempts, delays.length - 1)]!;
}

/**
 * Opens, refreshes and closes live-game sessions. Deliberately separate from the
 * match reconciliation below, because this half needs nothing but the spectator
 * answer the poll already has — no Match-V5 detail, no parsing, almost no CPU.
 *
 * That split is the whole point. Everything used to be persisted together, at
 * the end, behind the most expensive work in the run; a Worker killed for
 * exceeding its CPU budget had already written its rank observations and had
 * not yet written any of this, so a session stayed `active` with a frozen
 * `last_seen_at` until some later run survived long enough to close it. Papipu's
 * card advertised a finished game for sixty-seven minutes that way. Persisting
 * this first means a kill can no longer strand the board's live state.
 */
export function advanceGameSessions(input: AdvanceGameSessionsInput) {
  let sessions = input.sessions.map((session) => ({ ...session }));

  if (input.activeGame) {
    const active = sessions.find((session) =>
      session.platformGameId === input.activeGame?.platformGameId && session.status === "active");
    const detail = input.activeGameDetail ?? null;
    if (active) {
      active.lastSeenAt = input.now;
      active.updatedAt = input.now;
      if (detail) {
        active.championId = detail.championId;
        active.championName = detail.championName;
        active.participants = detail.participants;
      }
    } else {
      sessions.push({
        playerId: input.player.playerId,
        platformGameId: input.activeGame.platformGameId,
        queueId: 420,
        baselineObservationId: input.observation.id,
        gameStartedAt: input.activeGame.gameStartedAt,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        endedDetectedAt: null,
        matchId: null,
        status: "active",
        championId: detail?.championId ?? null,
        championName: detail?.championName ?? null,
        participants: detail?.participants ?? null,
        updatedAt: input.now,
      });
    }
  } else {
    sessions = sessions.map((session) => session.status === "active"
      ? { ...session, status: "ended_waiting_match" as const, endedDetectedAt: input.now, updatedAt: input.now }
      : session);
  }

  return sessions;
}

/** Links closed sessions to their Match-V5 detail and drives reconciliation.
    Everything here depends on `recentMatches`, so it can only run after the
    expensive half of the poll — see `advanceGameSessions` for why that matters. */
export function reconcilePlayerMatches(input: ReconcilePlayerMatchesInput) {
  const observations = [...input.observations, input.observation];
  const sessions = input.sessions.map((session) => ({ ...session }));
  let candidates = input.candidates.map((candidate) => ({ ...candidate }));
  const evidence: MatchLpEvidence[] = [];

  for (const session of sessions.filter((entry) => entry.status === "ended_waiting_match")) {
    const match = input.recentMatches.find((candidate) => {
      const won = participantResult(candidate, input.player.puuid);
      return won !== undefined &&
        Math.abs(candidate.gameStartedAt - session.gameStartedAt) <= SESSION_MATCH_TOLERANCE_MS;
    });
    if (!match) continue;
    const won = participantResult(match, input.player.puuid)!;
    session.status = "linked";
    session.matchId = match.matchId;
    session.updatedAt = input.now;
    if (match.remake) continue;
    if (!candidates.some((candidate) => candidate.matchId === match.matchId)) {
      candidates.push({
        playerId: input.player.playerId,
        matchId: match.matchId,
        state: "awaiting_rank",
        baselineObservationId: session.baselineObservationId,
        matchStartedAt: match.gameStartedAt,
        matchEndedAt: match.gameEndedAt,
        matchWon: won,
        zeroCandidateObservationId: null,
        attempts: 0,
        nextAttemptAt: input.now,
        expiresAt: match.gameEndedAt + LP_RECONCILIATION_WINDOW_MS,
        failureReason: null,
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
  }

  // A player's very first poll has no prior rank observation to bracket their
  // recent matches against, so every candidate raised here would resolve as
  // `unavailable / no_before_snapshot` on this same tick — stamping a permanent
  // "LP no disponible" on games played before anyone was watching. Their matches
  // start counting from the next run, once this tick's observation is history.
  const firstPollForPlayer = input.observations.length === 0;

  for (const match of firstPollForPlayer ? [] : input.recentMatches) {
    if (match.remake) continue;
    if (match.matchId === input.player.recentMatchId || candidates.some((candidate) => candidate.matchId === match.matchId)) continue;
    const won = participantResult(match, input.player.puuid);
    if (won === undefined) continue;
    const baseline = fallbackBaseline(input.observations, input.observation, match, won);
    candidates.push({
      playerId: input.player.playerId,
      matchId: match.matchId,
      state: "awaiting_rank",
      baselineObservationId: baseline?.id ?? null,
      matchStartedAt: match.gameStartedAt,
      matchEndedAt: match.gameEndedAt,
      matchWon: won,
      zeroCandidateObservationId: null,
      attempts: 0,
      nextAttemptAt: input.now,
      expiresAt: match.gameEndedAt + LP_RECONCILIATION_WINDOW_MS,
      failureReason: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  candidates = candidates.map((candidate) => {
    if (candidate.state === "resolved" || candidate.state === "unavailable") return candidate;
    const baseline = observations.find((observation) => observation.id === candidate.baselineObservationId);
    if (!baseline) {
      evidence.push({
        playerId: candidate.playerId,
        matchId: candidate.matchId,
        status: "unavailable",
        lpDelta: null,
        beforeObservationId: null,
        afterObservationId: input.observation.id,
        failureReason: "no_before_snapshot",
        matchStartedAt: candidate.matchStartedAt,
        matchEndedAt: candidate.matchEndedAt,
        matchWon: candidate.matchWon,
        createdAt: candidate.createdAt,
        resolvedAt: input.now,
        updatedAt: input.now,
      });
      return { ...candidate, state: "unavailable", failureReason: "no_before_snapshot", updatedAt: input.now };
    }
    if (candidate.nextAttemptAt > input.now) return candidate;
    if (candidate.matchWon === null) {
      return { ...candidate, attempts: candidate.attempts + 1, nextAttemptAt: nextAttempt(input.now, candidate.attempts), updatedAt: input.now };
    }
    const reconciliationDeadline = candidate.matchEndedAt === null
      ? candidate.expiresAt
      : Math.min(candidate.expiresAt, candidate.matchEndedAt + LP_RECONCILIATION_WINDOW_MS);
    if (input.now > reconciliationDeadline) {
      evidence.push({
        playerId: candidate.playerId,
        matchId: candidate.matchId,
        status: "unavailable",
        lpDelta: null,
        beforeObservationId: baseline.id,
        afterObservationId: input.observation.id,
        failureReason: "rank_update_timeout",
        matchStartedAt: candidate.matchStartedAt,
        matchEndedAt: candidate.matchEndedAt,
        matchWon: candidate.matchWon,
        createdAt: candidate.createdAt,
        resolvedAt: input.now,
        updatedAt: input.now,
      });
      return { ...candidate, state: "unavailable", failureReason: "rank_update_timeout", updatedAt: input.now };
    }

    const zeroConfirmed = candidate.state === "confirming_zero" &&
      candidate.zeroCandidateObservationId !== null &&
      candidate.zeroCandidateObservationId !== input.observation.id &&
      !input.recentMatches.some((match) => match.matchId !== candidate.matchId);
    const reconciliation = reconcileRankedMatch({
      before: baseline,
      after: input.observation,
      matchWon: candidate.matchWon,
      zeroDeltaConfirmed: zeroConfirmed,
    });
    if (reconciliation.status === "pending") {
      return {
        ...candidate,
        state: reconciliation.reason === "zero_delta_requires_confirmation" ? "confirming_zero" : "awaiting_rank",
        zeroCandidateObservationId: reconciliation.reason === "zero_delta_requires_confirmation"
          ? candidate.zeroCandidateObservationId ?? input.observation.id
          : candidate.zeroCandidateObservationId,
        attempts: candidate.attempts + 1,
        nextAttemptAt: reconciliation.reason === "zero_delta_requires_confirmation" ? input.now : nextAttempt(input.now, candidate.attempts),
        updatedAt: input.now,
      };
    }

    const unavailable = reconciliation.status === "unavailable";
    evidence.push({
      playerId: candidate.playerId,
      matchId: candidate.matchId,
      status: unavailable ? "unavailable" : "observed",
      lpDelta: unavailable ? null : reconciliation.delta,
      beforeObservationId: baseline.id,
      afterObservationId: input.observation.id,
      failureReason: unavailable ? reconciliation.reason : null,
      matchStartedAt: candidate.matchStartedAt,
      matchEndedAt: candidate.matchEndedAt,
      matchWon: candidate.matchWon,
      createdAt: candidate.createdAt,
      resolvedAt: input.now,
      updatedAt: input.now,
    });
    return {
      ...candidate,
      state: unavailable ? "unavailable" : "resolved",
      failureReason: unavailable ? reconciliation.reason : null,
      updatedAt: input.now,
    };
  });

  return { sessions, candidates, evidence };
}

/** Both halves in order, which is what a caller wants when it is not trying to
    persist between them. `runTemporalLpTracker` is the one that is. */
export function processTrackerPlayer(input: ProcessTrackerPlayerInput) {
  return reconcilePlayerMatches({ ...input, sessions: advanceGameSessions(input) });
}

export async function runTemporalLpTracker(options: {
  store: LpTrackerStore;
  apiKey: string;
  now: number;
  fetchImpl?: RiotFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  owner?: string;
}) {
  const startedAt = Date.now();
  const owner = options.owner ?? crypto.randomUUID();
  const leaseName = "lp-tracker";
  if (!await options.store.acquireLease(leaseName, owner, options.now, LEASE_TTL_MS)) {
    // A run that never starts used to leave no trace at all, which is
    // indistinguishable from the cron not firing. Say so.
    console.log(JSON.stringify({ event: "lp_tracker_run", runId: owner, lane: leaseName, scheduledTime: options.now, status: "skipped:lease_unavailable" }));
    return { status: "skipped" as const, reason: "lease_unavailable" as const, requestsUsed: 0 };
  }

  const api = createRiotTrackerApi({
    apiKey: options.apiKey,
    // Not `RIOT_PLAYERS.length * 5`: the ceiling belongs to Riot's two-minute
    // window, which this run shares with its own next tick — not to how many
    // players happen to be on the roster.
    maxRequests: TRACKER_REQUEST_BUDGET,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
  });
  let observationsInserted = 0;
  let sessionsUpdated = 0;
  let candidatesUpdated = 0;
  let evidenceWritten = 0;
  let outcome = "incomplete";
  let failure: string | null = null;
  /** Pushes the lane's expiry out, so the short TTL bounds how long a *dead* run
      holds it without bounding how long a live one may take. Best-effort: losing
      a renewal costs a skipped tick, and throwing here would cost the run. */
  const renewLease = async () => {
    try {
      await options.store.renewLease(leaseName, owner, Date.now() + LEASE_TTL_MS);
    } catch {
      // Nothing persisted depends on this.
    }
  };
  /** Labels how the run ended for the structured log, without touching what the
      caller receives. */
  const finish = <T>(label: string, result: T) => {
    outcome = label;
    return result;
  };

  try {
    const playerIds = RIOT_PLAYERS.map(({ id }) => id);
    const state = await options.store.loadTrackerState(playerIds);
    if (state.players.length === 0) {
      // Cold start. The roster is the authority on who should be tracked, not
      // the cached snapshot: enrolling only from the snapshot left anyone added
      // to RIOT_PLAYERS since it was written out of the table, and the catch-up
      // at the end of a normal run cannot help — this branch returns before it.
      if (!state.snapshot) return finish("skipped:no_cached_snapshot", { status: "skipped" as const, reason: "no_cached_snapshot" as const, requestsUsed: api.requestsUsed });
      const snapshotById = new Map(state.snapshot.players.map((player) => [player.id, player]));
      const players = await mapWithConcurrency(RIOT_PLAYERS, 3, async (identity) => {
        const player = snapshotById.get(identity.id);
        if (player?.puuid) return player;
        const account = await api.fetchAccountByRiotId(identity.gameName, identity.tagLine);
        const base = player ?? { ...identity, puuid: null, lastSoloQueueMatch: null };
        return account ? { ...base, ...account } : base;
      });
      const snapshot = { ...state.snapshot, players };
      await options.store.bootstrapPlayerSyncState(snapshot, options.now);

      const bootstrapped = await mapWithConcurrency(
        players.filter((player): player is typeof player & { puuid: string } => Boolean(player.puuid)),
        3,
        async (player) => {
          const [rank, matchIds] = await Promise.all([
            api.fetchSoloQueueEntryByPuuid(player.puuid),
            api.fetchRecentSoloQueueMatchIds(player.puuid, 1),
          ]);
          return { player, rank, matchId: matchIds[0] ?? null };
        },
      );
      const observations = bootstrapped.flatMap(({ player, rank }) => rank ? [{
        id: `${player.id}:${options.now}`,
        playerId: player.id,
        observedAt: options.now,
        ...rank,
      }] : []);
      await options.store.insertRankObservations(observations);
      await options.store.updateRecentCursors(bootstrapped.map(({ player, matchId }) => ({
        playerId: player.id,
        matchId,
        startedAt: null,
        now: options.now,
      })));
      return finish("bootstrapped", {
        status: "bootstrapped" as const,
        requestsUsed: api.requestsUsed,
        observationsInserted: observations.length,
        durationMs: Date.now() - startedAt,
      });
    }

    const tracked = state.players;

    const polled = await mapWithConcurrency(tracked, 3, async (player) => {
      const [rank, activeGame, matchIds] = await Promise.all([
        api.fetchSoloQueueEntryByPuuid(player.puuid),
        api.fetchActiveSoloQueueGameByPuuid(player.puuid, player),
        api.fetchRecentSoloQueueMatchIds(player.puuid, 3),
      ]);
      return { player, rank, activeGame, matchIds };
    });
    const observations = polled.flatMap(({ player, rank }) => rank ? [{
      id: `${player.playerId}:${options.now}`,
      playerId: player.playerId,
      observedAt: options.now,
      ...rank,
    }] : []);
    await options.store.insertRankObservations(observations);
    observationsInserted = observations.length;

    // Resolve spectator champion keys once per run so a live game can be shown
    // with its champion and roster instead of only being flagged as active.
    const liveDetails = new Map<string, { championId: string; championName: string; participants: string }>();
    if (polled.some((entry) => entry.activeGame)) {
      try {
        const catalog = await championsByNumericKey(state.snapshot?.dataDragonVersion ?? FALLBACK_DATA_DRAGON_VERSION);
        const identityByPuuid = new Map(tracked.map((player) => [player.puuid, player]));
        // Streamer mode blanks a participant's puuid, so a challenge member in a
        // teammate's live game would otherwise show up as a stranger.
        const identityByRiotId = new Map(tracked.map((player) =>
          [`${player.gameName}#${player.tagLine}`.toLowerCase(), player]));
        for (const entry of polled) {
          if (!entry.activeGame) continue;
          const { selfIndex } = entry.activeGame;
          const own = entry.activeGame.championId ? catalog.get(entry.activeGame.championId) : undefined;
          const participants = entry.activeGame.participants.map((participant, index) => {
            const champion = catalog.get(participant.championId);
            // Both identifiers are blank for anyone in streamer mode, so an
            // empty lookup key must never match: it would hand every anonymous
            // stranger the identity of whichever member happened to be keyed
            // under "". Only `selfIndex` may claim a blank participant.
            const peer = index === selfIndex
              ? entry.player
              : (participant.puuid ? identityByPuuid.get(participant.puuid) : undefined) ??
                (participant.riotId ? identityByRiotId.get(participant.riotId.toLowerCase()) : undefined);
            return {
              championId: champion?.id ?? "",
              championName: champion?.name ?? "",
              teamId: participant.teamId,
              rosterIndex: index,
              gameName: peer?.gameName ?? "",
              tagLine: peer?.tagLine ?? "",
              challengePlayerId: peer?.playerId ?? null,
            };
          });
          liveDetails.set(entry.player.playerId, {
            championId: own?.id ?? "",
            championName: own?.name ?? "",
            participants: JSON.stringify(participants),
          });
        }
      } catch {
        // A Data Dragon hiccup must not stop LP tracking; the live slot simply
        // falls back to the last finished match.
      }
    }

    // ── Cheap phase, persisted before anything expensive runs ──
    // Opening and closing live sessions needs only the spectator answer already
    // in `polled`. Writing it here, rather than with everything else at the end,
    // is what stops a Worker killed for CPU from leaving a finished game on the
    // board: the state the reader renders is durable before the run puts itself
    // at risk. See `advanceGameSessions`.
    const advanced = new Map<string, TrackedGameSession[]>();
    for (const entry of polled) {
      const observation = observations.find((candidate) => candidate.playerId === entry.player.playerId);
      if (!observation) continue;
      advanced.set(entry.player.playerId, advanceGameSessions({
        now: options.now,
        player: entry.player,
        observation,
        sessions: state.sessions.filter((candidate) => candidate.playerId === entry.player.playerId),
        activeGame: entry.activeGame,
        activeGameDetail: liveDetails.get(entry.player.playerId) ?? null,
      }));
    }
    const liveSessions = [...advanced.values()].flat();
    await options.store.upsertGameSessions(liveSessions);
    await renewLease();

    // ── Expensive phase ──
    const knownMatchIds = new Set([
      ...state.candidates.map((candidate) => candidate.matchId),
      ...state.sessions.flatMap((session) => session.matchId ? [session.matchId] : []),
    ]);
    const matchIdsByRecency = Array.from({ length: 3 }, (_, index) =>
      polled.flatMap((entry) => entry.matchIds[index] ? [entry.matchIds[index]] : []),
    ).flat();
    // `matchIdsByRecency` puts every player's newest first, so this cap always
    // takes newest-first across the roster and never a second before everyone
    // has had a first. The remainder is not lost: it is still unknown next tick.
    const requestedIds = [...new Set(matchIdsByRecency)]
      .filter((matchId) => !knownMatchIds.has(matchId))
      .slice(0, Math.min(MATCH_DETAILS_PER_RUN, api.requestsRemaining));
    const matches = (await mapWithConcurrency(requestedIds, 3, (matchId) => api.fetchMatchById(matchId)))
      .filter((match): match is TrackerMatch => match !== null);
    await renewLease();

    const allSessions: TrackedGameSession[] = [];
    const allCandidates: ReconciliationCandidate[] = [];
    const allEvidence: MatchLpEvidence[] = [];
    for (const entry of polled) {
      const observation = observations.find((candidate) => candidate.playerId === entry.player.playerId);
      const sessions = advanced.get(entry.player.playerId);
      if (!observation || !sessions) continue;
      const playerMatches = matches.filter((match) =>
        match.participants.some((participant) => participant.puuid === entry.player.puuid));
      const result = reconcilePlayerMatches({
        now: options.now,
        player: entry.player,
        observation,
        observations: state.observations.filter((candidate) => candidate.playerId === entry.player.playerId),
        sessions,
        candidates: state.candidates.filter((candidate) => candidate.playerId === entry.player.playerId),
        recentMatches: playerMatches,
      });
      allSessions.push(...result.sessions);
      allCandidates.push(...result.candidates);
      allEvidence.push(...result.evidence);
    }
    await options.store.upsertGameSessions(allSessions);
    await options.store.upsertCandidates(allCandidates);
    await options.store.writeTerminalEvidence(allEvidence);
    sessionsUpdated = allSessions.length;
    candidatesUpdated = allCandidates.length;
    evidenceWritten = allEvidence.length;

    await options.store.updateRecentCursors(polled.map((entry) => {
      const match = matches.find((candidate) => candidate.matchId === entry.matchIds[0]);
      return {
        playerId: entry.player.playerId,
        matchId: match?.matchId ?? null,
        startedAt: match?.gameStartedAt ?? null,
        now: options.now,
      };
    }));

    if (state.snapshot) {
      const challengePlayersByPuuid = new Map(tracked.map((player) => [player.puuid, player.playerId]));
      const rankedSnapshot = {
        ...state.snapshot,
        fetchedAt: new Date(options.now).toISOString(),
        players: state.snapshot.players.map((player) => {
          const observation = observations.find((candidate) => candidate.playerId === player.id);
          const syncPlayer = tracked.find((candidate) => candidate.playerId === player.id);
          const poll = polled.find((candidate) => candidate.player.playerId === player.id);
          const latestMatch = syncPlayer && poll
            ? matches.find((candidate) => candidate.matchId === poll.matchIds[0])
            : undefined;
          const normalizedMatch = syncPlayer && latestMatch?.raw
            ? normalizeSoloQueueMatch(latestMatch.matchId, latestMatch.raw, syncPlayer.puuid, challengePlayersByPuuid)
            : null;
          return observation ? {
            ...player,
            tier: observation.tier,
            division: observation.division,
            leaguePoints: observation.leaguePoints,
            wins: observation.wins,
            losses: observation.losses,
            winRate: calculateWinRate(observation.wins, observation.losses),
            progressToGold: calculateGoldProgress(observation.tier, observation.division, observation.leaguePoints),
            lastSoloQueueMatch: normalizedMatch ?? player.lastSoloQueueMatch,
          } : player;
        }),
      };
      const hydrated = await options.store.hydrateLatestMatchEvidence(rankedSnapshot);
      await options.store.writeLeaderboardProjection(hydrated, options.now);
    } else {
      // No cached snapshot to project onto, so this run leaves the cache empty —
      // and `/api/leaderboard` treats an empty cache as always stale. Public and
      // unauthenticated, that closed a loop with no exit: every inbound request
      // started a full run, which wrote no cache, so the next request started
      // another. Holding the lane for a tick bounds it to the cron's own rate.
      await options.store.blockLaneUntil(leaseName, options.now + PROJECTION_GAP_COOLDOWN_MS);
      console.log(JSON.stringify({
        event: "lp_tracker_no_projection",
        runId: owner,
        cooldownUntil: options.now + PROJECTION_GAP_COOLDOWN_MS,
      }));
    }

    // Retention. `loadTrackerState` keeps at most 32 observations per player
    // anyway, so anything past the reconciliation window is unreachable data
    // that the load query still has to rank on every single run.
    if (Math.floor(options.now / 60_000) % OBSERVATION_SWEEP_EVERY_TICKS === 0) {
      try {
        await options.store.pruneRankObservations(options.now - OBSERVATION_RETENTION_MS);
      } catch (error) {
        console.log(JSON.stringify({
          event: "lp_tracker_prune_failed",
          runId: owner,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    // Nothing else ever rewrites `player_sync_state`'s identity columns, so a
    // rename used to split the app in half: the tracker kept working, because a
    // puuid survives a rename, while `refreshLeaderboard` looked the account up
    // by the hardcoded Riot ID, got a 404, and showed the player as UNRANKED on
    // the board for good. One player per run, rotating, costs a single request
    // and brings the whole roster back in line inside ten minutes.
    const rotating = tracked[Math.floor(options.now / 60_000) % tracked.length];
    if (rotating && api.requestsRemaining > MAX_ENROLMENTS_PER_RUN) {
      try {
        const account = await api.fetchAccountByPuuid(rotating.puuid);
        if (account && (account.gameName !== rotating.gameName || account.tagLine !== rotating.tagLine)) {
          await options.store.bootstrapPlayerSyncState(
            { players: [{ ...account, id: rotating.playerId, lastSoloQueueMatch: null }] },
            options.now,
          );
          console.log(JSON.stringify({
            event: "lp_tracker_identity_changed",
            runId: owner,
            playerId: rotating.playerId,
            from: `${rotating.gameName}#${rotating.tagLine}`,
            to: `${account.gameName}#${account.tagLine}`,
          }));
        }
      } catch {
        // Best-effort, like the enrolment below: everything above is persisted.
      }
    }

    // `bootstrapPlayerSyncState` only runs on a cold start and skips anyone
    // without a puuid, so a roster member added later — like yvncv#0521 — never
    // lands in `player_sync_state` and the tracker ignores them forever. Catch
    // the stragglers up here, last, out of whatever budget the run did not
    // spend: they join the polling loop on the next tick a minute later, and a
    // Riot ID that stays unresolvable can never starve the tracking it funds.
    const enrolled = new Set(tracked.map((player) => player.playerId));
    const strays = RIOT_PLAYERS
      .filter((identity) => !enrolled.has(identity.id))
      .slice(0, Math.min(MAX_ENROLMENTS_PER_RUN, api.requestsRemaining));
    if (strays.length > 0) {
      // Best-effort, and it has to be. Everything above is already persisted by
      // this point, so letting a 429 or a 5xx here escape would mark a run that
      // wholly succeeded as `failed` — and, on the route that serves readers,
      // raise "Riot no respondió" over a board that had just refreshed fine.
      try {
        const accounts = (await mapWithConcurrency(strays, 3, async (identity) => {
          const account = await api.fetchAccountByRiotId(identity.gameName, identity.tagLine);
          return account ? { ...account, id: identity.id, lastSoloQueueMatch: null } : null;
        })).flatMap((account) => account ? [account] : []);
        if (accounts.length > 0) {
          await options.store.bootstrapPlayerSyncState({ players: accounts }, options.now);
          console.log(JSON.stringify({
            event: "lp_tracker_enrolled",
            runId: owner,
            playerIds: accounts.map((account) => account.id),
          }));
        }
      } catch (error) {
        console.log(JSON.stringify({
          event: "lp_tracker_enrol_failed",
          runId: owner,
          playerIds: strays.map((identity) => identity.id),
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    return finish("completed", {
      status: "completed" as const,
      requestsUsed: api.requestsUsed,
      observationsInserted,
      sessionsUpdated,
      candidatesUpdated,
      evidenceWritten,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    // The leaderboard route catches this so the board keeps serving its last
    // snapshot, and reports it to the reader as "Riot no respondió". That makes
    // this log line the only place a real failure — an unapplied migration, a
    // D1 error — can be told apart from a quiet Riot outage.
    failure = error instanceof Error ? error.message : String(error);
    outcome = "failed";
    throw error;
  } finally {
    if (api.lastBlockedUntil > options.now) await options.store.blockLaneUntil(leaseName, api.lastBlockedUntil);
    await options.store.releaseLease(leaseName, owner);
    console.log(JSON.stringify({
      event: "lp_tracker_run",
      runId: owner,
      lane: leaseName,
      scheduledTime: options.now,
      status: outcome,
      durationMs: Date.now() - startedAt,
      requestsUsed: api.requestsUsed,
      requestsRemaining: api.requestsRemaining,
      observationsInserted,
      sessionsUpdated,
      candidatesUpdated,
      evidenceWritten,
      ...(failure ? { error: failure } : {}),
    }));
  }
}
