// Pages has no `scheduled` handler, so the site's two schedules live here and
// are driven over HTTP against `/api/cron/*`, which the shared secret gates.
const DEFAULT_SITE_ORIGIN = "https://20q-challenge.pages.dev";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface Env {
  CRON_SECRET?: string;
  /** Overrides the target origin, so a custom domain or a project rename does
      not need a code change to keep the schedules pointed at the live site. */
  SITE_ORIGIN?: string;
}

export type CronLane = "leaderboard" | "lp-tracker" | "backfill";

/** Wakes one of the site's cron endpoints and waits for the work to finish.
    The endpoint runs the job inside the request rather than deferring it, so a
    204 here means the run completed and a 500 means it threw. */
export async function triggerCron(
  lane: CronLane,
  secret: string,
  origin: string = DEFAULT_SITE_ORIGIN,
  fetchImpl: FetchLike = fetch,
) {
  const response = await fetchImpl(`${origin}/api/cron/${lane}`, {
    method: "POST",
    headers: { "x-cron-secret": secret },
  });
  const status = response.status;
  if (response.body && !response.bodyUsed) await response.body.cancel();
  if (!response.ok) throw new Error(`Cron ${lane} failed (${status}).`);
}

// Cloudflare module scheduled handler:
// https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
const cronWorker = {
  async scheduled(controller: { cron: string; scheduledTime?: number }, env: Env) {
    const secret = (env.CRON_SECRET ?? "").trim();
    if (!secret) throw new Error("CRON_SECRET is not configured.");
    const origin = (env.SITE_ORIGIN ?? "").trim() || DEFAULT_SITE_ORIGIN;

    // The backfill needs its own invocation — it cannot share one with the rank
    // refresh, because a Worker gets 50 subrequests and the two together want
    // more. It was given a `*/5 * * * *` trigger for that, and Cloudflare
    // accepted the schedule but never fired it: thirty minutes of logs showed
    // `* * * * *` and `7,37 * * * *` running and `*/5` absent every time,
    // presumably because its minutes are a subset of the every-minute trigger.
    // So the cadence is derived from the tick that demonstrably does fire.
    // Falling back rather than trusting the field: `new Date(undefined)` is an
    // Invalid Date, whose minutes are NaN, and `NaN % 5` is never 0 — the
    // backfill would simply never run, silently and forever.
    const scheduledAt = Number.isFinite(controller.scheduledTime)
      ? (controller.scheduledTime as number)
      : Date.now();
    const minute = new Date(scheduledAt).getUTCMinutes();
    const lanes: CronLane[] = controller.cron === "7,37 * * * *"
      ? ["leaderboard"]
      : minute % 5 === 0
        ? ["lp-tracker", "backfill"]
        : ["lp-tracker"];

    // Sequential, not concurrent. The tracker rewrites the whole cached
    // snapshot from the copy it read when it started, so a backfill batch
    // written while a tracker run was in flight was erased seconds later by
    // that run's own projection — the counter sat still for twenty minutes
    // while every invocation reported success. Each lane still reports its own
    // failure without suppressing the ones after it.
    const failures: string[] = [];
    for (const lane of lanes) {
      try {
        await triggerCron(lane, secret, origin);
      } catch (error) {
        failures.push(String(error));
      }
    }
    // Rethrowing is what puts the failure in this Worker's own logs; without it
    // a cron that never reaches the site looks identical to one that worked.
    if (failures.length > 0) throw new Error(failures.join("; "));
  },
};

export default cronWorker;
