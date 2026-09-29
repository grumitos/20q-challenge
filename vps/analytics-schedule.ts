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
    ticks drift. A failed or skipped run leaves the heartbeat alone, so the
    next tick simply tries again. */
export const ANALYTICS_INTERVAL_MS = 9.5 * 60_000;

export function analyticsPhaseDue(now: number, heartbeatBlockedUntil: number | null) {
  if (heartbeatBlockedUntil === null) return true;
  const lastSuccessAt = heartbeatBlockedUntil - ANALYTICS_HEARTBEAT_TTL_MS;
  return now - lastSuccessAt >= ANALYTICS_INTERVAL_MS;
}

export async function readAnalyticsHeartbeat(d1: TrackerD1) {
  const row = await d1
    .prepare("SELECT blocked_until FROM sync_leases WHERE name = ? LIMIT 1")
    .bind(ANALYTICS_HEARTBEAT_LANE)
    .first<{ blocked_until: number | null }>();
  return typeof row?.blocked_until === "number" ? row.blocked_until : null;
}
