/**
 * When the tracker runner also runs the analytics phase.
 *
 * It used to run on `getUTCMinutes() % 10 === 0`, which needs a tick inside one
 * exact minute. The systemd timer's ticks drift 60–70 s apart, so about one
 * window in twelve had no tick in its minute: ~130 runs a day instead of ~144.
 * The rule is elapsed time instead, measured from state the phase already
 * persists — the heartbeat lane it stamps after every successful run.
 *
 * Kept apart from `tracker-runner.ts` so it can be tested under Node: the
 * runner opens Bun SQLite at import time.
 */
import type { TrackerD1 } from "../db/lp-tracker-store.ts";

export const ANALYTICS_HEARTBEAT_LANE = "leaderboard-analytics-heartbeat";

/** A successful run blocks the heartbeat lane this far ahead. */
export const ANALYTICS_HEARTBEAT_TTL_MS = 12 * 60_000;

/** Due once the last successful run is this old: just under ten minutes, so
    the first tick at or after it lands on a ~10-minute cadence however the
    ticks drift. A skipped run leaves the heartbeat alone, so the next tick
    simply tries again; a failed one waits out `ANALYTICS_RETRY_DELAY_MS`. */
export const ANALYTICS_INTERVAL_MS = 9.5 * 60_000;

/** Blocked by the runner after an analytics run throws. */
export const ANALYTICS_RETRY_LANE = "leaderboard-analytics-retry";

/** The key allows 100 requests every two minutes, shared with tracker ticks
    that may spend 30 each; one analytics run may spend 32. A failure can come
    late in a run, after most of that is spent, and retrying on every tick
    through a Riot outage would fit two runs into one window — past the limit,
    into 429s that block the tracker's own lane. Anything over two minutes keeps
    it to one run per window. */
export const ANALYTICS_RETRY_DELAY_MS = 3 * 60_000;

export function analyticsPhaseDue(
  now: number,
  heartbeatBlockedUntil: number | null,
  retryBlockedUntil: number | null = null,
) {
  if (retryBlockedUntil !== null && retryBlockedUntil > now) return false;
  if (heartbeatBlockedUntil === null) return true;
  const lastSuccessAt = heartbeatBlockedUntil - ANALYTICS_HEARTBEAT_TTL_MS;
  return now - lastSuccessAt >= ANALYTICS_INTERVAL_MS;
}

async function readLaneBlockedUntil(d1: TrackerD1, name: string) {
  const row = await d1
    .prepare("SELECT blocked_until FROM sync_leases WHERE name = ? LIMIT 1")
    .bind(name)
    .first<{ blocked_until: number | null }>();
  return typeof row?.blocked_until === "number" ? row.blocked_until : null;
}

export function readAnalyticsHeartbeat(d1: TrackerD1) {
  return readLaneBlockedUntil(d1, ANALYTICS_HEARTBEAT_LANE);
}

export function readAnalyticsRetry(d1: TrackerD1) {
  return readLaneBlockedUntil(d1, ANALYTICS_RETRY_LANE);
}
