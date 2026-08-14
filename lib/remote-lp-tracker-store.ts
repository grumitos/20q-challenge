import type { LpTrackerStore } from "../db/lp-tracker-store.ts";

/**
 * `LpTrackerStore` implemented over HTTP against the Worker's `/api/cron/store`
 * endpoint, so the tracker can run somewhere without a per-invocation CPU
 * ceiling while its logic stays in exactly one place.
 *
 * This is the whole point of the shape: `runTemporalLpTracker` takes a store,
 * so pointing it at this one moves every Riot request, every match payload and
 * the Data Dragon catalog off the Worker without a second implementation of the
 * tracker to keep in step. What is left on the Worker is a D1 read or write per
 * call — a couple of milliseconds against a 10 ms allowance, and constant
 * rather than growing with how many games the roster just played.
 *
 * The cost this accepts is a network round trip per store call, roughly eight
 * per run. That is seconds on a minute cadence and irrelevant next to the Riot
 * polling the same run does, but it is why this must not be used from inside a
 * Worker, where the calls would be subrequests against a 50 request ceiling.
 */
export function createRemoteLpTrackerStore(options: {
  origin: string;
  secret: string;
  fetchImpl?: typeof fetch;
  /** Bounds a hung call so one stuck request cannot outlive the tick. */
  timeoutMs?: number;
}): LpTrackerStore {
  const origin = options.origin.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!options.secret.trim()) throw new TypeError("A cron secret is required to reach the store.");

  async function call(method: string, args: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${origin}/api/cron/store`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": options.secret },
        body: JSON.stringify({ method, args }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // A 404 here is the endpoint refusing the secret, not a missing route:
        // saying so is the difference between chasing a deploy and fixing a
        // mismatched secret.
        throw new Error(response.status === 404
          ? `Store rejected the cron secret (${method}).`
          : `Store call ${method} failed (${response.status}).`);
      }
      const payload = await response.json() as { result?: unknown };
      return payload?.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    acquireLease: (name, owner, now, ttlMs) =>
      call("acquireLease", [name, owner, now, ttlMs]) as Promise<boolean>,
    renewLease: (name, owner, expiresAt) =>
      call("renewLease", [name, owner, expiresAt]) as Promise<void>,
    releaseLease: (name, owner) => call("releaseLease", [name, owner]) as Promise<void>,
    blockLaneUntil: (name, timestamp) => call("blockLaneUntil", [name, timestamp]) as Promise<void>,
    loadTrackerState: (playerIds) =>
      call("loadTrackerState", [playerIds]) as ReturnType<LpTrackerStore["loadTrackerState"]>,
    bootstrapPlayerSyncState: (snapshot, now) =>
      call("bootstrapPlayerSyncState", [snapshot, now]) as Promise<void>,
    insertRankObservations: (observations) =>
      call("insertRankObservations", [observations]) as Promise<void>,
    upsertGameSessions: (sessions) => call("upsertGameSessions", [sessions]) as Promise<void>,
    upsertCandidates: (candidates) => call("upsertCandidates", [candidates]) as Promise<void>,
    writeTerminalEvidence: (evidence) => call("writeTerminalEvidence", [evidence]) as Promise<void>,
    hydrateLatestMatchEvidence: (snapshot) =>
      call("hydrateLatestMatchEvidence", [snapshot]) as ReturnType<LpTrackerStore["hydrateLatestMatchEvidence"]>,
    updateRecentCursors: (cursors) => call("updateRecentCursors", [cursors]) as Promise<void>,
    pruneRankObservations: (before) => call("pruneRankObservations", [before]) as Promise<unknown>,
    writeLeaderboardProjection: (snapshot, now) =>
      call("writeLeaderboardProjection", [snapshot, now]) as Promise<void>,
    persistLeaderboardSnapshot: (snapshot, matches) =>
      call("persistLeaderboardSnapshot", [snapshot, matches]) as Promise<void>,
  };
}
