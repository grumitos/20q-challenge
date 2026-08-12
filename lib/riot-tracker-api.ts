import { isRemakeMatch, normalizeSoloQueueEntry, type Division, type RankTier } from "./leaderboard.ts";
import { createRiotRequester, TRACKER_REQUEST_BUDGET, type RiotFetch } from "./riot-request.ts";

export type TrackerRank = {
  tier: RankTier;
  division: Division;
  leaguePoints: number;
  wins: number;
  losses: number;
};

/**
 * Spectator-v5 reports no position for anyone, and its participant order is not
 * the draft order either — a live lobby came back with the jungler third and the
 * support last. So a live roster carries no roles at all: `teamId` is the only
 * grouping Riot actually gives, and the grid uses exactly that.
 */
export type ActiveGameParticipant = {
  /** Blank when the player hides their identity: streamer mode withholds it. */
  puuid: string;
  /** `gameName#tagLine`, and blank under the same setting that blanks the puuid. */
  riotId: string;
  championId: string;
  teamId: number;
};

export type ActiveSoloQueueGame = {
  platformGameId: string;
  gameStartedAt: number;
  queueId: 420;
  /** Champion the tracked player is on, when the spectator payload exposes it. */
  championId: string | null;
  /** Index of the tracked player in `participants`, or null when unresolvable. */
  selfIndex: number | null;
  participants: ActiveGameParticipant[];
};

export type TrackerMatch = {
  matchId: string;
  gameStartedAt: number;
  gameEndedAt: number;
  queueId: 420;
  remake?: boolean;
  participants: Array<{ puuid: string; won: boolean }>;
  raw?: unknown;
};

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function json(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    throw new Error("Riot returned invalid JSON.");
  }
}

async function discardResponseBody(response: Response) {
  if (response.body && !response.bodyUsed) await response.body.cancel();
}

function retryAfterMs(response: Response) {
  const raw = response.headers.get("Retry-After")?.trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1_000;
}

/**
 * Finds the tracked player among the spectator participants.
 *
 * Streamer mode blanks both the puuid and the Riot ID of whoever enabled it, so
 * matching on the puuid alone loses the one participant we are certain is in the
 * game — the endpoint was queried by their puuid. Each fallback is narrower than
 * the last, and the search gives up rather than guessing between two anonymous
 * players.
 */
export function findTrackedParticipant(
  participants: readonly ActiveGameParticipant[],
  puuid: string,
  identity?: { gameName: string; tagLine: string },
): number | null {
  const byPuuid = participants.findIndex((participant) => participant.puuid === puuid);
  if (byPuuid >= 0) return byPuuid;

  if (identity) {
    const wanted = `${identity.gameName}#${identity.tagLine}`.toLowerCase();
    const byRiotId = participants.findIndex((participant) => participant.riotId.toLowerCase() === wanted);
    if (byRiotId >= 0) return byRiotId;
  }

  const anonymous = participants.flatMap((participant, index) =>
    !participant.puuid && !participant.riotId ? [index] : []);
  return anonymous.length === 1 ? anonymous[0] : null;
}

export function createRiotTrackerApi(options: {
  apiKey: string;
  maxRequests?: number;
  fetchImpl?: RiotFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Only set by tests that assert on exact sleeps and need the 20-per-second
      pacing out of the way. Production always wants the default. */
  minIntervalMs?: number;
}) {
  let lastBlockedUntil = 0;
  const rawFetch = options.fetchImpl ?? fetch;
  const requester = createRiotRequester({
    apiKey: options.apiKey,
    maxRequests: options.maxRequests ?? TRACKER_REQUEST_BUDGET,
    sleep: options.sleep,
    minIntervalMs: options.minIntervalMs,
    fetchImpl: async (input, init) => {
      const response = await rawFetch(input, init);
      if (response.status === 429) {
        lastBlockedUntil = Math.max(lastBlockedUntil, Date.now() + retryAfterMs(response));
      }
      return response;
    },
  });

  async function request(url: string, notFoundIsNull = false) {
    const response = await requester.fetch(url, { headers: { Accept: "application/json" } });
    if (notFoundIsNull && response.status === 404) {
      await discardResponseBody(response);
      return null;
    }
    let failure: Error | null = null;
    if (response.status === 401 || response.status === 403) failure = new Error("Riot authentication failed.");
    else if (response.status === 429) failure = new Error("Riot rate limit retry budget exhausted.");
    else if (response.status >= 500) failure = new Error("Riot is temporarily unavailable.");
    else if (!response.ok) failure = new Error(`Riot request failed (${response.status}).`);
    if (failure) {
      await discardResponseBody(response);
      throw failure;
    }
    return json(response);
  }

  return {
    get requestsUsed() {
      return requester.budget.requestsUsed;
    },
    get requestsRemaining() {
      return requester.budget.remaining;
    },
    get lastBlockedUntil() {
      return lastBlockedUntil;
    },
    async fetchAccountByRiotId(gameName: string, tagLine: string) {
      const value = await request(
        `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
        true,
      );
      const account = object(value);
      return account && typeof account.puuid === "string" && account.puuid.length > 0
        ? {
            puuid: account.puuid,
            gameName: typeof account.gameName === "string" ? account.gameName : gameName,
            tagLine: typeof account.tagLine === "string" ? account.tagLine : tagLine,
          }
        : null;
    },
    /** The puuid survives a rename; the Riot ID does not. This is how a stored
        identity is brought back in line after someone changes their name. */
    async fetchAccountByPuuid(puuid: string) {
      const value = await request(
        `https://americas.api.riotgames.com/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`,
        true,
      );
      const account = object(value);
      return account &&
        typeof account.gameName === "string" && account.gameName.length > 0 &&
        typeof account.tagLine === "string" && account.tagLine.length > 0
        ? { puuid, gameName: account.gameName, tagLine: account.tagLine }
        : null;
    },
    async fetchSoloQueueEntryByPuuid(puuid: string): Promise<TrackerRank | null> {
      const value = await request(`https://la2.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`);
      const rank = normalizeSoloQueueEntry(value);
      return rank.tier === "UNRANKED" ? null : rank;
    },
    async fetchActiveSoloQueueGameByPuuid(
      puuid: string,
      identity?: { gameName: string; tagLine: string },
    ): Promise<ActiveSoloQueueGame | null> {
      const value = await request(
        `https://la2.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`,
        true,
      );
      if (value === null) return null;
      const game = object(value);
      if (!game || game.gameQueueConfigId !== 420 ||
          (typeof game.gameId !== "number" && typeof game.gameId !== "string") ||
          typeof game.gameStartTime !== "number") return null;

      const participants = Array.isArray(game.participants)
        ? game.participants.flatMap((entry): ActiveGameParticipant[] => {
            const participant = object(entry);
            if (!participant) return [];
            const championId = participant.championId;
            if (typeof championId !== "number" && typeof championId !== "string") return [];
            return [{
              puuid: typeof participant.puuid === "string" ? participant.puuid : "",
              riotId: typeof participant.riotId === "string" ? participant.riotId : "",
              championId: String(championId),
              teamId: typeof participant.teamId === "number" ? participant.teamId : 0,
            }];
          }).slice(0, 10)
        : [];

      const selfIndex = findTrackedParticipant(participants, puuid, identity);
      return {
        platformGameId: String(game.gameId),
        gameStartedAt: Math.max(0, Math.trunc(game.gameStartTime)),
        queueId: 420,
        championId: selfIndex === null ? null : participants[selfIndex].championId,
        selfIndex,
        participants,
      };
    },
    async fetchRecentSoloQueueMatchIds(puuid: string, count = 3): Promise<string[]> {
      const safeCount = Math.max(1, Math.min(20, Math.trunc(count)));
      const value = await request(
        `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?queue=420&start=0&count=${safeCount}`,
      );
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
        throw new Error("Riot returned invalid match IDs.");
      }
      return value;
    },
    async fetchMatchById(matchId: string): Promise<TrackerMatch | null> {
      const value = await request(
        `https://americas.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`,
      );
      const match = object(value);
      const metadata = object(match?.metadata);
      const info = object(match?.info);
      if (!info || info.queueId !== 420 || !Array.isArray(info.participants)) return null;
      const participants = info.participants.flatMap((entry) => {
        const participant = object(entry);
        return participant && typeof participant.puuid === "string" && typeof participant.win === "boolean"
          ? [{ puuid: participant.puuid, won: participant.win }]
          : [];
      });
      const startedAt = typeof info.gameStartTimestamp === "number" ? Math.trunc(info.gameStartTimestamp) : 0;
      const durationSeconds = typeof info.gameDuration === "number" ? Math.max(0, Math.trunc(info.gameDuration)) : 0;
      const durationMs = durationSeconds * 1_000;
      const remake = isRemakeMatch({
        durationSeconds,
        remake: info.participants.some((entry) => object(entry)?.gameEndedInEarlySurrender === true),
      });
      const endedAt = typeof info.gameEndTimestamp === "number"
        ? Math.trunc(info.gameEndTimestamp)
        : startedAt + durationMs;
      const normalizedMatchId = typeof metadata?.matchId === "string" ? metadata.matchId : matchId;
      if (!normalizedMatchId || startedAt <= 0 || endedAt < startedAt) return null;
      return { matchId: normalizedMatchId, gameStartedAt: startedAt, gameEndedAt: endedAt, queueId: 420, remake, participants, raw: value };
    },
  };
}
