export type RiotFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/* ─── RIOT RATE LIMITS ───
   A personal key allows 20 requests per second and 100 per two minutes. The
   second one binds: the tracker fires every minute, so two of its runs land
   inside any two-minute window, and the analytics refresh lands at most once
   (its cron is `7,37 * * * *`). The three must therefore fit under 100 together
   — `riot-request.test.mjs` asserts they do. Overshooting does not merely slow
   things down: 429s make each retry sleep its Retry-After, which used to burn
   the request's wall clock and get the run killed with its lease still held. */

/** 100 requests per 2 minutes, the ceiling every budget below is carved from. */
export const RIOT_WINDOW_REQUESTS = 100;

/** One tracker run: 27 for the fixed cost of polling nine players (rank,
    spectator and recent-match ids each), the rest for match details. Two of
    these fit a window on their own, which is the common case — the analytics
    cron only lands in the two windows an hour containing :07 and :37. */
export const TRACKER_REQUEST_BUDGET = 45;

/** One analytics refresh, sized against Cloudflare's subrequest ceiling rather
    than Riot's — 50 per invocation on the free plan, D1 included, and the
    tighter of the two. The arithmetic this has to satisfy, measured against a
    real refresh rather than guessed: 18 for league and summoner across nine
    players (the puuid is reused from cache), 9 more to scan each of them for
    new matches, and 11 for one backfill batch — an id page plus ten match
    details. Anything under 38 and the backfill can never fit, which is not
    slow but stuck: set to 32 it left five, and three consecutive refreshes
    moved `games` for a new player from 0 to 0.

    A cold cache pays 27 instead of 18 for the fixed part, which this also
    clears, so the very first refresh can complete. The backfill resumes across
    runs, so the cap costs elapsed time, not completeness.

    What this deliberately does *not* claim: that a Riot window holding two
    tracker runs *and* a refresh fits. It does not — 114 against an allowance of
    100, twice an hour at :07 and :37, absorbed by the requester's Retry-After
    retry rather than pretended away with a smaller number here. Closing that
    for real means slowing the tracker's cadence or shrinking the roster, which
    is a product decision and does not belong in a constant. */
export const ANALYTICS_REQUEST_BUDGET = 32;

/**
 * Cloudflare's own ceiling, and the one that actually binds: a Worker on the
 * free plan may make 50 subrequests per invocation, D1 queries included. Riot's
 * allowance is the looser of the two. The first production run of the analytics
 * refresh failed on exactly this — "Too many subrequests by single Worker
 * invocation" — which the budgets above are now sized under, leaving the
 * remainder for the persistence the refresh does at the end.
 */
export const WORKER_SUBREQUEST_LIMIT = 50;

/** 20 requests per second, expressed as the floor between two request starts.
    Concurrency alone does not bound this — three workers against a fast edge
    can clear sixty a second. */
export const RIOT_MIN_REQUEST_INTERVAL_MS = 50;

export class RiotRequestBudgetExceeded extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Riot request budget exhausted (${limit}).`);
    this.name = "RiotRequestBudgetExceeded";
    this.limit = limit;
  }
}

export class RiotRequestBudget {
  readonly limit: number;
  private used = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("Request budget must be a positive integer.");
    this.limit = limit;
  }

  consume() {
    if (this.used >= this.limit) throw new RiotRequestBudgetExceeded(this.limit);
    this.used += 1;
    return this.used;
  }

  get remaining() {
    return this.limit - this.used;
  }

  get requestsUsed() {
    return this.used;
  }
}

function retryAfterMilliseconds(response: Response) {
  const raw = response.headers.get("Retry-After")?.trim();
  if (!raw) return 1_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1_000;
}

async function discardResponseBody(response: Response) {
  if (response.body && !response.bodyUsed) await response.body.cancel();
}

export function createRiotRequester(options: {
  apiKey: string;
  maxRequests: number;
  fetchImpl?: RiotFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRateLimitRetries?: number;
  /** Floor between two request starts. Defaults to Riot's 20-per-second cap. */
  minIntervalMs?: number;
  now?: () => number;
}) {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new TypeError("Riot API key is required.");
  const budget = new RiotRequestBudget(options.maxRequests);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxRateLimitRetries = options.maxRateLimitRetries ?? 2;
  const minIntervalMs = options.minIntervalMs ?? RIOT_MIN_REQUEST_INTERVAL_MS;
  const now = options.now ?? Date.now;

  // Claimed before awaiting, so concurrent callers queue behind each other
  // instead of all reading the same "next free" instant and firing together.
  let nextSlotAt = 0;
  async function claimSlot() {
    if (minIntervalMs <= 0) return;
    const readyAt = Math.max(now(), nextSlotAt);
    nextSlotAt = readyAt + minIntervalMs;
    const wait = readyAt - now();
    if (wait > 0) await sleep(wait);
  }

  return {
    budget,
    async fetch(input: string | URL | Request, init?: RequestInit) {
      let rateLimitRetries = 0;
      for (;;) {
        budget.consume();
        await claimSlot();
        const headers = new Headers(init?.headers);
        headers.set("X-Riot-Token", apiKey);
        const response = await fetchImpl(input, { ...init, headers });
        if (response.status !== 429 || rateLimitRetries >= maxRateLimitRetries) return response;
        rateLimitRetries += 1;
        await discardResponseBody(response);
        await sleep(retryAfterMilliseconds(response));
      }
    },
  };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("Concurrency must be a positive integer.");
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!, index);
    }
  }));
  return results;
}
