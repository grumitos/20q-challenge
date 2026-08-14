import {
  calculateGoldProgress,
  calculateWinRate,
  isRemakeMatch,
  normalizeSoloQueueEntry,
  sortLeaderboard,
  type LastMatchParticipant,
  type LastSoloQueueMatch,
  type LpChangeEvidence,
  type LeaderboardSnapshot,
  type PlayerRole,
  type PlayerSnapshot,
} from "./leaderboard.ts";
import {
  ANALYTICS_REQUEST_BUDGET,
  createRiotRequester,
  RiotRequestBudgetExceeded,
} from "./riot-request.ts";
import seasonSeedJson from "./season-analytics-seed.json" with { type: "json" };
import { preserveDefinitiveEvidence, reconcileRankedMatch, toLpChangeEvidence } from "./lp-reconciliation.ts";
import {
  addMatchToAnalytics,
  analyticsFromSeed,
  cloneAnalytics,
  emptyAnalytics,
  finalizeAnalytics,
  type SeasonSeed,
} from "./season-analytics.ts";

type PlayerIdentity = {
  id: string;
  gameName: string;
  tagLine: string;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const RIOT_REQUEST_CONCURRENCY = 3;
const SEASON_START_TIMESTAMP_MS = Date.UTC(2026, 0, 8, 15);
const FORWARD_MATCH_BATCH_SIZE = 10;
/** Ten payloads is 7.6 ms of parsing at the rate measured for this runtime
    (0.76 ms per 50 KiB), on a 10 ms per-invocation CPU allowance — over budget
    before the lane's own snapshot rewrite. Three is 2.3 ms median and 5.6 ms
    worst, which leaves room for the rest of the run. The batch resumes across
    runs, so this costs elapsed time and not completeness; `backfillIds.size <
    BACKFILL_BATCH_SIZE` below reads it as "a short page means we are done", so
    the two uses stay consistent when this moves. */
const BACKFILL_BATCH_SIZE = 3;
const BACKFILL_PLAYERS_PER_REFRESH = 1;
/** Match details one analytics run may download and parse, oldest first. Five
    is 3.8 ms median of parsing at the measured rate, which with the snapshot
    rewrite keeps the lane inside the Worker's 10 ms allowance. Must stay at or
    above `BACKFILL_BATCH_SIZE`, whose batch must never be capped out of its own
    run. The remainder is newer than the cutoff and picked up next run. */
const ANALYTICS_MATCH_DETAILS_PER_RUN = 5;

export const RIOT_PLAYERS: PlayerIdentity[] = [
  { id: "miqi", gameName: "miqi", tagLine: "8745" },
  { id: "wonder-boi", gameName: "Wonder Boi", tagLine: "huhu" },
  { id: "rvn", gameName: "RVN", tagLine: "2105" },
  { id: "inti", gameName: "INTI VIRAC0NCHA", tagLine: "20CM" },
  { id: "papipu", gameName: "Papipu", tagLine: "HOLA" },
  { id: "testiculos", gameName: "TESTICrULoOS", tagLine: "2140" },
  { id: "piper-twin", gameName: "PiperTwin", tagLine: "20CM" },
  { id: "mamimu", gameName: "Mamimu", tagLine: "HOLA" },
  { id: "yvncv", gameName: "yvncv", tagLine: "0521" },
];

const seasonSeed = seasonSeedJson as SeasonSeed;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

export type RiotApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE";

export class RiotApiError extends Error {
  readonly code: RiotApiErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: RiotApiErrorCode,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "RiotApiError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type PersistedPlayerMatchStats = {
  playerId: string;
  championId: string;
  championName: string;
  kills: number;
  deaths: number;
  assists: number;
  won: boolean;
  role: PlayerRole;
};

export type PersistedSoloQueueMatch = {
  matchId: string;
  gameStartTimestamp: number;
  durationSeconds: number;
  participants: LastMatchParticipant[];
  playerStats: PersistedPlayerMatchStats[];
};

async function fetchRiotJson(
  url: string,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "X-Riot-Token": apiKey,
    },
  });

  if (!response.ok) {
    const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
    if (response.status === 401) throw new RiotApiError("UNAUTHORIZED", "Riot rechazó la autenticación.");
    if (response.status === 403) throw new RiotApiError("FORBIDDEN", "La Riot API key no es válida o no tiene acceso.");
    if (response.status === 404) throw new RiotApiError("NOT_FOUND", "No se encontró el Riot ID solicitado.");
    if (response.status === 429) {
      throw new RiotApiError(
        "RATE_LIMITED",
        "Riot ha limitado temporalmente las consultas.",
        Number.isFinite(retryAfter) ? retryAfter : null,
      );
    }
    throw new RiotApiError("UPSTREAM_ERROR", "Riot no pudo completar la consulta.");
  }

  try {
    return await response.json();
  } catch {
    throw new RiotApiError("INVALID_RESPONSE", "Riot devolvió una respuesta no válida.");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeText(value: unknown, fallback = "", maxLength = 64) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function safeNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function safeRole(value: unknown): PlayerRole {
  return value === "TOP" || value === "JUNGLE" || value === "MIDDLE" ||
    value === "BOTTOM" || value === "UTILITY"
    ? value
    : "UNKNOWN";
}

/**
 * Advances the season backfill and nothing else, from the snapshot already in
 * cache. It never touches league or summoner endpoints, so the whole invocation
 * — and the whole 50-subrequest allowance a Worker gets — belongs to history.
 *
 * This exists because the two jobs do not fit together. The full refresh spends
 * 18 subrequests on ranks and up to 18 more scanning every player for new
 * matches, which left fewer than the 11 a backfill batch needs; sized to fit
 * the batch instead, the refresh blew the ceiling and failed outright. Giving
 * the backfill its own invocation is what makes both able to finish.
 *
 * Returns null when there is nothing cached to build on, or nobody left to
 * backfill — the caller treats that as a no-op, not a failure.
 */
export async function backfillSeasonAnalytics(
  cachedSnapshot: LeaderboardSnapshot,
  apiKey: string,
  rawFetch: FetchLike = fetch,
  now = new Date(),
  maxRequests = ANALYTICS_REQUEST_BUDGET,
): Promise<{ snapshot: LeaderboardSnapshot; persistedMatches: PersistedSoloQueueMatch[] } | null> {
  const pending = cachedSnapshot.players.some((player) =>
    player.puuid && player.analytics.backfillStatus === "in_progress");
  if (!pending) return null;

  const requester = createRiotRequester({ apiKey, maxRequests, fetchImpl: rawFetch });
  const fetchImpl: FetchLike = (input, init) => requester.fetch(input, init);
  const players = cachedSnapshot.players.map((player) => ({
    ...player,
    analytics: cloneAnalytics(player.analytics),
  }));

  let persistedMatches: PersistedSoloQueueMatch[] = [];
  try {
    persistedMatches = await refreshSeasonAnalytics(players, apiKey, fetchImpl, "backfill");
  } catch (error) {
    // Running out mid-batch is ordinary: whatever was gathered is kept and the
    // rest waits for the next tick.
    if (!(error instanceof RiotRequestBudgetExceeded)) throw error;
  }

  console.log(JSON.stringify({
    event: "season_backfill",
    requestsUsed: requester.budget.requestsUsed,
    matches: persistedMatches.length,
    remaining: players.filter((player) => player.analytics.backfillStatus === "in_progress").length,
  }));

  return {
    snapshot: {
      ...cachedSnapshot,
      fetchedAt: now.toISOString(),
      players: sortLeaderboard(players),
    },
    persistedMatches,
  };
}

/**
 * The position the roster grid sorts by. Left undefined rather than "UNKNOWN"
 * when Riot reports none — a remake, or `individualPosition: "Invalid"` — so the
 * grid can tell "no position" apart from a position it failed to read.
 */
function assignedRole(participant: Record<string, unknown>): PlayerRole | undefined {
  const role = safeRole(participant.teamPosition || participant.individualPosition);
  return role === "UNKNOWN" ? undefined : role;
}

function normalizedIdentityPart(value: unknown) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function challengePlayerIdForParticipant(
  participant: Record<string, unknown>,
  challengePlayers: ReadonlyMap<string, string>,
) {
  const byPuuid = typeof participant.puuid === "string" ? challengePlayers.get(participant.puuid) : undefined;
  if (byPuuid) return byPuuid;

  const gameName = normalizedIdentityPart(participant.riotIdGameName ?? participant.summonerName);
  const tagLine = normalizedIdentityPart(participant.riotIdTagline ?? participant.riotIdTagLine);
  if (!gameName) return null;

  return challengePlayers.get(`riot:${gameName}#${tagLine}`) ??
    (tagLine ? null : challengePlayers.get(`name:${gameName}`)) ??
    null;
}

export function normalizePersistedSoloQueueMatch(
  matchId: string,
  value: unknown,
  challengePlayersByPuuid: ReadonlyMap<string, string>,
): PersistedSoloQueueMatch | null {
  const match = record(value);
  const info = record(match?.info);
  if (!info || info.queueId !== 420 || !Array.isArray(info.participants)) return null;
  const durationSeconds = safeNonNegativeInteger(info.gameDuration);
  const remake = isRemakeMatch({
    durationSeconds,
    remake: info.participants.some((entry) => record(entry)?.gameEndedInEarlySurrender === true),
  });

  const participants: LastMatchParticipant[] = [];
  const playerStats: PersistedPlayerMatchStats[] = [];
  for (const rawParticipant of info.participants.slice(0, 10)) {
    const participant = record(rawParticipant);
    if (!participant || typeof participant.puuid !== "string" || typeof participant.championName !== "string") continue;
    const championId = safeText(participant.championName, "Unknown", 32);
    const playerId = challengePlayerIdForParticipant(participant, challengePlayersByPuuid);
    const role = assignedRole(participant);
    participants.push({
      championId,
      championName: championId,
      teamId: safeNonNegativeInteger(participant.teamId),
      gameName: safeText(participant.riotIdGameName, safeText(participant.summonerName, "Jugador")),
      tagLine: safeText(participant.riotIdTagline),
      challengePlayerId: playerId,
      ...(role ? { role } : {}),
    });
    if (playerId && !remake) {
      playerStats.push({
        playerId,
        championId,
        championName: championId,
        kills: safeNonNegativeInteger(participant.kills),
        deaths: safeNonNegativeInteger(participant.deaths),
        assists: safeNonNegativeInteger(participant.assists),
        won: participant.win === true,
        role: safeRole(participant.teamPosition || participant.individualPosition),
      });
    }
  }
  if (participants.length === 0) return null;

  return {
    matchId: safeText(matchId, "", 64),
    gameStartTimestamp: safeNonNegativeInteger(info.gameStartTimestamp),
    durationSeconds,
    participants,
    playerStats,
  };
}

export function normalizeSoloQueueMatch(
  matchId: string,
  value: unknown,
  playerPuuid: string,
  challengePlayersByPuuid: ReadonlyMap<string, string>,
): LastSoloQueueMatch | null {
  const match = record(value);
  const info = record(match?.info);
  if (!info || info.queueId !== 420 || !Array.isArray(info.participants)) return null;
  const durationSeconds = safeNonNegativeInteger(info.gameDuration);
  const remake = isRemakeMatch({
    durationSeconds,
    remake: info.participants.some((entry) => record(entry)?.gameEndedInEarlySurrender === true),
  });

  const subject = info.participants.map(record).find((participant) => participant?.puuid === playerPuuid);
  if (!subject || typeof subject.championName !== "string" || typeof subject.win !== "boolean") return null;

  const participants: LastMatchParticipant[] = [];
  for (const rawParticipant of info.participants.slice(0, 10)) {
    const participant = record(rawParticipant);
    if (!participant || typeof participant.puuid !== "string" || typeof participant.championName !== "string") continue;
    const championId = safeText(participant.championName, "Unknown", 32);
    const role = assignedRole(participant);
    participants.push({
      championId,
      championName: championId,
      teamId: safeNonNegativeInteger(participant.teamId),
      gameName: safeText(participant.riotIdGameName, safeText(participant.summonerName, "Jugador")),
      tagLine: safeText(participant.riotIdTagline),
      challengePlayerId: challengePlayerIdForParticipant(participant, challengePlayersByPuuid),
      ...(role ? { role } : {}),
    });
  }
  if (participants.length === 0) return null;

  const championId = safeText(subject.championName, "Unknown", 32);
  return {
    matchId: safeText(matchId, "", 64),
    gameStartTimestamp: safeNonNegativeInteger(info.gameStartTimestamp),
    durationSeconds,
    remake,
    championId,
    championName: championId,
    kills: safeNonNegativeInteger(subject.kills),
    deaths: safeNonNegativeInteger(subject.deaths),
    assists: safeNonNegativeInteger(subject.assists),
    win: subject.win,
    ...(subject.gameEndedInEarlySurrender === true ? { remake: true } : {}),
    lpChangeEvidence: { status: "pending", reason: "league_state_not_updated" },
    participants,
  };
}

type LeaguePointsState = Pick<PlayerSnapshot, "tier" | "division" | "leaguePoints" | "wins" | "losses"> & {
  lastSoloQueueMatch: Pick<LastSoloQueueMatch, "matchId" | "win" | "lpChangeEvidence"> | null;
};

export function inferLeaguePointsChange(
  previous: LeaguePointsState | undefined,
  current: LeaguePointsState,
  beforeObservedAt: string,
  afterObservedAt: string,
): LpChangeEvidence {
  const currentMatch = current.lastSoloQueueMatch;
  if (!currentMatch || !previous) return { status: "unavailable", reason: "no_before_snapshot" };

  const sameMatchEvidence = previous.lastSoloQueueMatch?.matchId === currentMatch.matchId
    ? previous.lastSoloQueueMatch.lpChangeEvidence
    : null;
  const result = reconcileRankedMatch({
    before: previous,
    after: current,
    matchWon: currentMatch.win,
  });
  return preserveDefinitiveEvidence(
    currentMatch.lpChangeEvidence.status === "observed"
      ? currentMatch.lpChangeEvidence
      : sameMatchEvidence,
    toLpChangeEvidence(result, beforeObservedAt, afterObservedAt),
  );
}

export async function fetchRiotPlayer(
  identity: PlayerIdentity,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  baseline?: Pick<PlayerSnapshot, "profileIconId" | "analytics" | "lastSoloQueueMatch" | "puuid">,
): Promise<PlayerSnapshot> {
  // A puuid is permanent, so resolving one we already hold buys nothing and
  // costs a request per player per refresh. On the free plan a Worker gets 50
  // subrequests per invocation — D1 included — and this path was spending nine
  // of them re-answering a question whose answer cannot change. The tracker
  // keeps the stored identity current, so a rename does not strand this.
  const cachedPuuid = typeof baseline?.puuid === "string" && baseline.puuid.length > 0
    ? baseline.puuid
    : null;
  const account = cachedPuuid ? null : record(
    await fetchRiotJson(
      `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(identity.gameName)}/${encodeURIComponent(identity.tagLine)}`,
      apiKey,
      fetchImpl,
    ),
  );
  if (!cachedPuuid && (!account || typeof account.puuid !== "string" || account.puuid.length === 0)) {
    throw new RiotApiError("INVALID_RESPONSE", "Riot no devolvió un PUUID válido.");
  }

  const puuid = cachedPuuid ?? (account!.puuid as string);
  const [entries, summonerValue] = await Promise.all([
    fetchRiotJson(
      `https://la2.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
      apiKey,
      fetchImpl,
    ),
    fetchRiotJson(
      `https://la2.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`,
      apiKey,
      fetchImpl,
    ),
  ]);
  const summoner = record(summonerValue);
  const league = normalizeSoloQueueEntry(entries);

  return {
    id: identity.id,
    gameName: typeof account?.gameName === "string" && account.gameName ? account.gameName : identity.gameName,
    tagLine: typeof account?.tagLine === "string" && account.tagLine ? account.tagLine : identity.tagLine,
    puuid,
    tier: league.tier,
    division: league.division,
    leaguePoints: league.leaguePoints,
    wins: league.wins,
    losses: league.losses,
    winRate: calculateWinRate(league.wins, league.losses),
    progressToGold: calculateGoldProgress(league.tier, league.division, league.leaguePoints),
    profileIconId: typeof summoner?.profileIconId === "number"
      ? summoner.profileIconId
      : baseline?.profileIconId ?? 0,
    riotIdFound: true,
    lastSoloQueueMatch: baseline?.lastSoloQueueMatch ?? null,
    analytics: baseline ? cloneAnalytics(baseline.analytics) : emptyAnalytics(),
  };
}

function unavailablePlayer(
  identity: PlayerIdentity,
  baseline?: Pick<PlayerSnapshot, "profileIconId" | "analytics" | "lastSoloQueueMatch">,
): PlayerSnapshot {
  return {
    ...identity,
    puuid: null,
    tier: "UNRANKED",
    division: "",
    leaguePoints: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    progressToGold: 0,
    profileIconId: baseline?.profileIconId ?? 0,
    riotIdFound: false,
    lastSoloQueueMatch: baseline?.lastSoloQueueMatch ?? null,
    analytics: baseline ? cloneAnalytics(baseline.analytics) : emptyAnalytics(),
  };
}

async function fetchSeasonMatchIds(
  puuid: string,
  startTime: number,
  apiKey: string,
  fetchImpl: FetchLike,
  options: { count?: number; endTime?: number; maxPages?: number } = {},
) {
  const count = options.count ?? 100;
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  const matchIds: string[] = [];
  let start = 0;
  let page = 0;
  for (;;) {
    const endTime = options.endTime === undefined ? "" : `&endTime=${options.endTime}`;
    const value = await fetchRiotJson(
      `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?queue=420&startTime=${startTime}${endTime}&start=${start}&count=${count}`,
      apiKey,
      fetchImpl,
    );
    if (!Array.isArray(value) || !value.every((matchId) => typeof matchId === "string")) {
      throw new RiotApiError("INVALID_RESPONSE", "Riot no devolvió IDs de partidas válidos.");
    }
    matchIds.push(...value);
    page += 1;
    if (value.length < count || page >= maxPages) break;
    start += count;
  }
  return matchIds;
}

async function refreshSeasonAnalytics(
  players: PlayerSnapshot[],
  apiKey: string,
  fetchImpl: FetchLike,
  /**
   * `forward` scans every player for new matches and squeezes a backfill batch
   * in behind it; `backfill` skips the scan entirely and spends the whole
   * invocation on history.
   *
   * They are separated because they cannot share one invocation. A Worker gets
   * 50 subrequests; the forward scan alone costs up to 18 (two pages each for
   * nine players) on top of 18 for ranks, leaving less than the 11 a backfill
   * batch needs. Tuned as one number this was either a refresh that completed
   * without ever advancing the backfill, or one that exceeded the ceiling and
   * failed outright — the split is what makes both possible.
   */
  mode: "forward" | "backfill" = "forward",
) {
  const cutoffs = new Map(players.map((player) => [player.id, {
    timestamp: player.analytics.lastGameStartTimestamp,
    matchId: player.analytics.lastMatchId,
  }]));
  const matchIds = new Set<string>();
  const requestedMatchesByPlayer = new Map<string, { forwardIds: Set<string>; backfillIds: Set<string> }>();
  const challengePlayersByPuuid = new Map<string, string>();
  for (const player of players) {
    if (player.puuid) challengePlayersByPuuid.set(player.puuid, player.id);
    const gameName = normalizedIdentityPart(player.gameName);
    const tagLine = normalizedIdentityPart(player.tagLine);
    if (gameName && tagLine) challengePlayersByPuuid.set(`riot:${gameName}#${tagLine}`, player.id);
    if (gameName) challengePlayersByPuuid.set(`name:${gameName}`, player.id);
  }

  const playersWithAccounts = players.filter(
    (player): player is PlayerSnapshot & { puuid: string } => Boolean(player.puuid),
  );
  const backfillPlayerIds = new Set(
    playersWithAccounts
      .filter((player) => player.analytics.backfillStatus === "in_progress")
      .sort((a, b) => a.analytics.games - b.analytics.games || a.id.localeCompare(b.id))
      .slice(0, BACKFILL_PLAYERS_PER_REFRESH)
      .map((player) => player.id),
  );
  const playerMatchIds = await mapWithConcurrency(
    playersWithAccounts,
    RIOT_REQUEST_CONCURRENCY,
    async (player) => {
      const cutoff = cutoffs.get(player.id);
      const backfillStart = player.analytics.backfillStartTimestamp;
      const backfillBefore = player.analytics.backfillBeforeTimestamp;
      // Only the backfill lane backfills. The forward lane used to do it too —
      // `mode` gated the forward scan but never this — so the twice-hourly
      // analytics refresh quietly carried a batch of ten extra match payloads
      // on top of its own work. Ten payloads is 7.6 ms of parsing at the rate
      // measured for this runtime, against a 10 ms per-invocation allowance, so
      // the lane was over budget by construction and 1102'd; and because it dies
      // before advancing its cutoff, the next run inherited the same batch and
      // failed identically. That is the trap this file already learned once.
      const shouldBackfill = mode === "backfill" && backfillPlayerIds.has(player.id) &&
        typeof backfillStart === "number" && typeof backfillBefore === "number" && backfillBefore > backfillStart;
      const forwardIds = mode === "backfill" ? [] : await fetchSeasonMatchIds(
        player.puuid,
        Math.floor((cutoff?.timestamp || SEASON_START_TIMESTAMP_MS) / 1000),
        apiKey,
        fetchImpl,
        { count: FORWARD_MATCH_BATCH_SIZE, maxPages: 2 },
      );
      const backfillIds = shouldBackfill
        ? await fetchSeasonMatchIds(
          player.puuid,
          Math.floor(backfillStart / 1000),
          apiKey,
          fetchImpl,
          {
            count: BACKFILL_BATCH_SIZE,
            endTime: Math.floor((backfillBefore - 1) / 1000),
            maxPages: 1,
          },
        )
        : [];
      return { playerId: player.id, forwardIds, backfillIds };
    },
  );
  for (const request of playerMatchIds) {
    requestedMatchesByPlayer.set(request.playerId, {
      forwardIds: new Set(request.forwardIds),
      backfillIds: new Set(request.backfillIds),
    });
    request.forwardIds.forEach((matchId) => matchIds.add(matchId));
    request.backfillIds.forEach((matchId) => matchIds.add(matchId));
  }

  // Capped, oldest first. This lane runs in the Worker, where parsing is the
  // scarce resource: an evening of games left it a backlog whose details it
  // downloaded in one invocation — the same repeat-kill shape as the tracker's,
  // because a killed run advances no cutoff and inherits the identical list.
  // Oldest first is what makes the cap safe: the analytics cutoff is the max
  // *processed* timestamp, so draining from the old end advances it without
  // holes, and the rest is still newer than the cutoff on the next run. Match
  // ids are numeric and increase with time, which spares a details fetch just
  // to learn the order.
  // Boundary matches must not occupy the cap. Riot's `startTime` is inclusive,
  // so every player's last-processed match comes back on every scan — up to
  // nine ids, all older than anything genuinely new. Capped oldest-first
  // without this filter, those nine re-filled the five slots on every single
  // run: details fetched, the boundary check below discarded them, no cutoff
  // moved, and the next run drew the identical list. Twenty-two consecutive
  // runs ingested nothing that way. An id is dropped only when *every* player
  // who requested it has it as their own boundary — for anyone else it is a
  // genuinely new match and must stay eligible.
  const boundaryOnly = (matchId: string) => {
    for (const [playerId, request] of requestedMatchesByPlayer) {
      if (request.backfillIds.has(matchId)) return false;
      if (request.forwardIds.has(matchId) && cutoffs.get(playerId)?.matchId !== matchId) return false;
    }
    return true;
  };
  const requestedDetailIds = [...matchIds]
    .filter((matchId) => !boundaryOnly(matchId))
    .sort((left, right) => Number(left.split("_").at(-1)) - Number(right.split("_").at(-1)))
    .slice(0, ANALYTICS_MATCH_DETAILS_PER_RUN);
  const matches = await mapWithConcurrency(
    requestedDetailIds,
    RIOT_REQUEST_CONCURRENCY,
    async (matchId) => ({
      matchId,
      match: record(await fetchRiotJson(
        `https://americas.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`,
        apiKey,
        fetchImpl,
      )),
    }),
  );

  const persistedMatches: PersistedSoloQueueMatch[] = [];

  for (const { matchId, match } of matches) {
    const info = record(match?.info);
    if (!info || info.queueId !== 420 || !Array.isArray(info.participants)) continue;
    const gameStartTimestamp = typeof info.gameStartTimestamp === "number"
      ? info.gameStartTimestamp
      : 0;
    const persistedMatch = normalizePersistedSoloQueueMatch(matchId, match, challengePlayersByPuuid);
    if (persistedMatch) persistedMatches.push(persistedMatch);

    for (const player of players) {
      const cutoff = cutoffs.get(player.id);
      const request = requestedMatchesByPlayer.get(player.id);
      if (!cutoff || !player.puuid || !request) continue;
      const isForwardMatch = request.forwardIds.has(matchId);
      const isBackfillMatch = request.backfillIds.has(matchId);
      if (!isForwardMatch && !isBackfillMatch) continue;

      const latestMatch = normalizeSoloQueueMatch(matchId, match, player.puuid, challengePlayersByPuuid);
      if (
        isForwardMatch &&
        latestMatch &&
        (!player.lastSoloQueueMatch || latestMatch.gameStartTimestamp >= player.lastSoloQueueMatch.gameStartTimestamp)
      ) {
        player.lastSoloQueueMatch = latestMatch;
      }

      if (
        isForwardMatch &&
        gameStartTimestamp === cutoff.timestamp &&
        matchId === cutoff.matchId
      ) continue;

      const participant = info.participants.find((value) => {
        const entry = record(value);
        return entry?.puuid === player.puuid;
      });
      const entry = record(participant);
      const isNewForwardMatch = isForwardMatch && gameStartTimestamp > cutoff.timestamp;
      const shouldCountBackfill = isBackfillMatch && player.analytics.backfillContributesToAnalytics === true;
      if (entry && (isNewForwardMatch || shouldCountBackfill)) {
        addMatchToAnalytics(player.analytics, entry, matchId, gameStartTimestamp);
      }
    }
  }

  for (const player of players) {
    player.analytics = finalizeAnalytics(player.analytics);
  }

  const matchesById = new Map(matches.map(({ matchId, match }) => [matchId, match]));
  for (const player of players) {
    const request = requestedMatchesByPlayer.get(player.id);
    if (!request) continue;
    const timestamps = [...request.backfillIds].flatMap((matchId) => {
      const info = record(matchesById.get(matchId)?.info);
      if (typeof info?.gameStartTimestamp !== "number") return [];
      return [info.gameStartTimestamp];
    });
    // Only the lane that actually ran a batch may conclude anything about its
    // progress. Without the mode guard the forward lane, which no longer
    // requests backfill ids, read its own empty result as a short page and
    // marked the player's season complete — silently abandoning the backfill.
    if (mode !== "backfill" || !backfillPlayerIds.has(player.id)) continue;
    if (request.backfillIds.size < BACKFILL_BATCH_SIZE || timestamps.length === 0) {
      player.analytics.backfillStatus = "complete";
      player.analytics.backfillStartTimestamp = undefined;
      player.analytics.backfillBeforeTimestamp = 0;
    } else {
      player.analytics.backfillStatus = "in_progress";
      player.analytics.backfillBeforeTimestamp = Math.min(...timestamps);
    }
  }

  return persistedMatches;
}

/**
 * Every portrait and crest on the board is built from this version, and it was
 * pinned to whatever the season seed shipped with — nothing ever moved it. Riot
 * keeps adding profile icons and champions, and Data Dragon serves each one only
 * from the release that introduced it, so anything newer than the pin 403s. The
 * first casualty was icon 7188, added for LoL Classic: a real player wearing it
 * simply had no avatar.
 *
 * Best-effort and deliberately unauthenticated — this is Data Dragon, not the
 * Riot API, so it needs no key and counts against no Riot allowance. If it fails
 * the caller keeps the version it already had, which is exactly today's
 * behaviour and never worse.
 */
async function currentDataDragonVersion(fetchImpl: FetchLike, fallback: string) {
  try {
    const response = await fetchImpl("https://ddragon.leagueoflegends.com/api/versions.json");
    if (!response.ok) return fallback;
    const versions = await response.json();
    const latest = Array.isArray(versions) ? versions[0] : null;
    return typeof latest === "string" && /^\d+\.\d+\.\d+$/.test(latest) ? latest : fallback;
  } catch {
    return fallback;
  }
}

export async function fetchRiotLeaderboard(
  apiKey: string,
  rawFetch: FetchLike = fetch,
  now = new Date(),
  cachedSnapshot?: LeaderboardSnapshot,
  persistMatches?: (matches: PersistedSoloQueueMatch[]) => Promise<void> | void,
  /** Overridable so tests can exercise the batching logic without being pinned
      to what production can currently afford per invocation. */
  maxRequests = ANALYTICS_REQUEST_BUDGET,
): Promise<LeaderboardSnapshot> {
  // This path used to call Riot with no budget and no 429 handling at all: a
  // full season backfill can ask for hundreds of match details in one
  // invocation, against a key that allows a hundred requests every two minutes.
  // It shares that window with two tracker runs, so it is the one that yields.
  const requester = createRiotRequester({
    apiKey,
    maxRequests,
    fetchImpl: rawFetch,
  });
  const fetchImpl: FetchLike = (input, init) => requester.fetch(input, init);
  const players = await mapWithConcurrency(
    RIOT_PLAYERS,
    RIOT_REQUEST_CONCURRENCY,
    async (identity): Promise<PlayerSnapshot> => {
      const cached = cachedSnapshot?.players.find((player) => player.id === identity.id);
      const seeded = seasonSeed.players[identity.id];
      const baseline = cached ?? (seeded ? {
        profileIconId: seeded.profileIconId,
        lastSoloQueueMatch: null,
        analytics: analyticsFromSeed(seeded),
        // The seed carries no puuid, so a seeded player still pays for one
        // account lookup — once, until the first refresh caches theirs.
        puuid: null,
      } : undefined);
      try {
        const player = await fetchRiotPlayer(identity, apiKey, fetchImpl, baseline);
        const backfillStatus = player.analytics.backfillStatus ?? (
          typeof player.analytics.backfillBeforeTimestamp === "number" && player.analytics.backfillBeforeTimestamp > 0
            ? "in_progress"
            : player.analytics.backfillBeforeTimestamp === 0
              ? "complete"
              : "not_started"
        );
        player.analytics.backfillStatus = backfillStatus;
        if (player.puuid && backfillStatus === "not_started") {
          player.analytics.backfillStatus = "in_progress";
          player.analytics.backfillContributesToAnalytics ??= player.analytics.games === 0;
          player.analytics.backfillStartTimestamp = SEASON_START_TIMESTAMP_MS;
          player.analytics.backfillBeforeTimestamp = now.getTime();
        }
        return player;
      } catch (error) {
        if (error instanceof RiotApiError && error.code === "NOT_FOUND") {
          return unavailablePlayer(identity, baseline);
        }
        throw error;
      }
    },
  );

  // Running out of budget mid-backfill is an ordinary outcome, not a failure:
  // the backfill is designed to resume across runs, so whatever analytics this
  // run did gather are kept and the rest waits for the next one.
  let persistedMatches: PersistedSoloQueueMatch[] = [];
  try {
    persistedMatches = await refreshSeasonAnalytics(players, apiKey, fetchImpl);
  } catch (error) {
    if (!(error instanceof RiotRequestBudgetExceeded)) throw error;
    console.log(JSON.stringify({
      event: "leaderboard_analytics_capped",
      limit: error.limit,
      note: "season backfill resumes on the next refresh",
    }));
  }
  await persistMatches?.(persistedMatches);

  for (const player of players) {
    if (!player.lastSoloQueueMatch) continue;
    const previous = cachedSnapshot?.players.find((candidate) => candidate.id === player.id);
    player.lastSoloQueueMatch = {
      ...player.lastSoloQueueMatch,
      lpChangeEvidence: inferLeaguePointsChange(
        previous,
        player,
        cachedSnapshot?.fetchedAt ?? "",
        now.toISOString(),
      ),
    };
  }

  return {
    region: "LAS",
    platform: "LA2",
    queue: "RANKED_SOLO_5x5",
    season: "2026",
    fetchedAt: now.toISOString(),
    dataDragonVersion: await currentDataDragonVersion(
      rawFetch,
      cachedSnapshot?.dataDragonVersion || seasonSeed.dataDragonVersion,
    ),
    players: sortLeaderboard(players),
  };
}
