import type { LpTrackerStore, TrackerStoreBatchOperation } from "../db/lp-tracker-store.ts";

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
 * Writes are grouped at phase boundaries, so a normal run uses only a handful
 * of authenticated round trips instead of one per D1 method. This must still
 * not be used from inside a Worker: even grouped calls would be subrequests
 * against its 50-request ceiling.
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

  async function callBatch(operations: readonly TrackerStoreBatchOperation[]) {
    if (operations.length === 0 || operations.length > 10) {
      throw new RangeError("Store batches must contain between 1 and 10 operations.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${origin}/api/cron/store`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": options.secret },
        body: JSON.stringify({ operations }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(response.status === 404
          ? "Store rejected the cron secret (batch)."
          : `Store batch failed (${response.status}).`);
      }
      const payload = await response.json() as { results?: unknown[] };
      return payload.results ?? [];
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
    loadTrackerState: (playerIds, now) =>
      call("loadTrackerState", [playerIds, now]) as ReturnType<LpTrackerStore["loadTrackerState"]>,
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
    batch: callBatch,
  };
}
