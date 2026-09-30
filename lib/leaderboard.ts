import { peruDateParts } from "./peru-time.ts";

export const CACHE_TTL_MS = 60 * 1000;
export const CACHE_KEY = "las-2026-soloq";
export const CHALLENGE_MEMBER_COUNT = 9;

export function papipuRespawnSeconds(now: number) {
  const peruTime = peruDateParts(now);
  const hour = peruTime.hour;
  if (hour >= 7 && hour < 23) return null;

  const year = peruTime.year;
  const month = peruTime.month - 1;
  const day = peruTime.day;
  const respawnAt = hour >= 23
    ? Date.UTC(year, month, day + 1, 12)
    : Date.UTC(year, month, day, 12);
  return Math.max(1, Math.ceil((respawnAt - now) / 1000));
}

export type RankTier =
  | "IRON"
  | "BRONZE"
  | "SILVER"
  | "GOLD"
  | "PLATINUM"
  | "EMERALD"
  | "DIAMOND"
  | "MASTER"
  | "GRANDMASTER"
  | "CHALLENGER"
  | "UNRANKED";

export type Division = "IV" | "III" | "II" | "I" | "";
export type PlayerRole = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY" | "UNKNOWN";

export type ChampionAggregate = {
  id: string;
  name: string;
  games: number;
  wins: number;
};

export type LastMatchParticipant = {
  championId: string;
  championName: string;
  teamId: number;
  gameName: string;
  tagLine: string;
  challengePlayerId: string | null;
  /**
   * Assigned position. Match-V5 reports it outright; spectator-v5 has no
   * position field, so live games leave this unset and preserve their original
   * roster index instead. Optional because older cached payloads carry no role.
   */
  role?: PlayerRole;
  /** Original zero-based spectator-v5 position; live games have no lane. */
  rosterIndex?: number;
};

export type LpChangeEvidence =
  | {
      status: "observed";
      value: number;
      source: "rank_snapshot_delta";
      beforeObservedAt: string;
      afterObservedAt: string;
    }
  | {
      status: "pending";
      reason: "league_state_not_updated" | "zero_delta_requires_confirmation";
    }
  | {
      status: "unavailable";
      reason:
        | "no_before_snapshot"
        | "multiple_games_between_snapshots"
        | "match_rank_mismatch"
        | "season_or_rank_reset"
        | "historical_backfill"
        | "rank_not_comparable"
        | "rank_state_changed_without_match"
        | "rank_update_timeout";
    };

export type LastSoloQueueMatch = {
  matchId: string;
  gameStartTimestamp: number;
  durationSeconds: number;
  championId: string;
  championName: string;
  kills: number;
  deaths: number;
  assists: number;
  win: boolean;
  /**
   * Riot's own early-surrender flag. A remake is neither a win nor a loss, and
   * calling it "Derrota" because `win` is false misreads the game.
   */
  remake?: boolean;
  lpChangeEvidence: LpChangeEvidence;
  participants: LastMatchParticipant[];
};

/** Most frequent challenge teammate, aggregated over the indexed history. */
export type HabitualDuo = {
  playerId: string;
  gameName: string;
  games: number;
};

/** Live SoloQ game, surfaced from the spectator-backed tracker sessions. */
export type LiveGame = {
  platformGameId: string;
  gameStartedAt: number;
  championId: string;
  championName: string;
  participants: LastMatchParticipant[];
};

/** 99%. See `wilsonLowerBound` for why this number and not 1.96. */
export const CONFIDENCE_Z = 2.58;

/**
 * Wilson lower bound: the win rate a record can be *shown* to hold, not the one
 * it happens to have. The confidence level is the whole lever, because it is
 * what a small sample is charged for.
 *
 * At 95% it was too cheap, and specifically for perfect records — a flawless
 * run has no observed variance, so only the sample-size term holds it down.
 * Two wins in two games scored above sixty-four percent across fourteen, and
 * every profile on the board led with a champion played two or three times.
 *
 * At 99% those same two games fall from 0.34 to 0.23, below the fourteen-game
 * champion's 0.32, while records with enough games behind them barely move —
 * a 75% champion over twenty games loses about four points. That is the whole
 * intent: charge the small samples, leave the real ones alone. It stays an
 * ordinary Wilson interval, so nothing about how the ranking reads changes.
 *
 * Both rankings that need to order win rates — a player's champions and the
 * board's duos — come through here, so a pair is judged on exactly the terms
 * the champion discs are.
 */
export function wilsonLowerBound(wins: number, games: number) {
  const played = Math.max(0, games);
  if (played === 0) return 0;
  const won = Math.min(played, Math.max(0, wins));
  const winRate = won / played;
  const zSquared = CONFIDENCE_Z * CONFIDENCE_Z;
  return (
    winRate + zSquared / (2 * played) -
    CONFIDENCE_Z * Math.sqrt((winRate * (1 - winRate) + zSquared / (4 * played)) / played)
  ) / (1 + zSquared / played);
}

function championConfidenceScore(champion: ChampionAggregate) {
  return wilsonLowerBound(champion.wins, champion.games);
}

export function selectBestChampions(
  championCounts: Record<string, ChampionAggregate>,
  limit = 5,
) {
  return Object.values(championCounts)
    .sort((a, b) =>
      championConfidenceScore(b) - championConfidenceScore(a) ||
      b.games - a.games ||
      b.wins - a.wins ||
      a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}

export type SeasonAnalytics = {
  games: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  mainRole: PlayerRole;
  roleShare: number;
  roleCounts: Partial<Record<PlayerRole, number>>;
  championCounts: Record<string, ChampionAggregate>;
  topChampions: ChampionAggregate[];
  lastGameStartTimestamp: number;
  lastMatchId: string;
  backfillStatus: "not_started" | "in_progress" | "complete";
  backfillContributesToAnalytics?: boolean;
  backfillStartTimestamp?: number;
  backfillBeforeTimestamp?: number;
};

export type PlayerSnapshot = {
  id: string;
  gameName: string;
  tagLine: string;
  puuid: string | null;
  tier: RankTier;
  division: Division;
  leaguePoints: number;
  wins: number;
  losses: number;
  winRate: number;
  progressToGold: number;
  profileIconId: number;
  riotIdFound: boolean;
  lastSoloQueueMatch: LastSoloQueueMatch | null;
  analytics: SeasonAnalytics;
  /**
   * Enrichments resolved from D1 on the read path. Optional so payloads cached
   * before the redesign keep validating.
   */
  recentResults?: boolean[];
  habitualDuo?: HabitualDuo | null;
  liveGame?: LiveGame | null;
  placeDelta?: number;
};

/**
 * A pair of challenge members and the record they hold on the same team, ranked
 * by `wilsonLowerBound`. Ids rather than names: everything else the panel draws
 * — icon, tier, first name — is already on the player it points at.
 */
export type DuoRecord = {
  playerIds: [string, string];
  games: number;
  wins: number;
  score: number;
};

/** Below this a pair has not played enough together to be worth ranking. */
export const DUO_LEADERBOARD_MIN_GAMES = 10;

export type LeaderboardSnapshot = {
  region: "LAS";
  platform: "LA2";
  queue: "RANKED_SOLO_5x5";
  season: "2026";
  fetchedAt: string;
  dataDragonVersion: string;
  players: PlayerSnapshot[];
  /**
   * Resolved from D1 on the read path like the per-player enrichments, so a
   * snapshot cached before the duos panel existed still validates.
   */
  duos?: DuoRecord[];
};

export type LeaderboardSource = "riot" | "cache" | "demo";

export type LeaderboardPayload = {
  data: LeaderboardSnapshot;
  meta: {
    source: LeaderboardSource;
    isStale: boolean;
    cacheTtlSeconds: number;
    notice?: string;
  };
};

export type LeagueEntry = {
  tier: RankTier;
  division: Division;
  leaguePoints: number;
  wins: number;
  losses: number;
};

const TIER_ORDER: RankTier[] = [
  "IRON",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "EMERALD",
  "DIAMOND",
  "MASTER",
  "GRANDMASTER",
  "CHALLENGER",
];

const DIVISION_ORDER: Exclude<Division, "">[] = ["IV", "III", "II", "I"];
export type ChallengeGoalTier = "GOLD" | "PLATINUM";

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRankTier(value: unknown): value is RankTier {
  return typeof value === "string" && (TIER_ORDER.includes(value as RankTier) || value === "UNRANKED");
}

function isDivision(value: unknown): value is Division {
  return typeof value === "string" && (DIVISION_ORDER.includes(value as Exclude<Division, "">) || value === "");
}

const PLAYER_ROLES: PlayerRole[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY", "UNKNOWN"];

function isPlayerRole(value: unknown): value is PlayerRole {
  return typeof value === "string" && PLAYER_ROLES.includes(value as PlayerRole);
}

function isChampionAggregate(value: unknown): value is ChampionAggregate {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.games === "number" &&
    typeof value.wins === "number";
}

function isLastMatchParticipant(value: unknown): value is LastMatchParticipant {
  return isRecord(value) &&
    typeof value.championId === "string" &&
    typeof value.championName === "string" &&
    typeof value.teamId === "number" &&
    typeof value.gameName === "string" &&
    typeof value.tagLine === "string" &&
    (typeof value.challengePlayerId === "string" || value.challengePlayerId === null) &&
    (value.role === undefined || isPlayerRole(value.role)) &&
    (value.rosterIndex === undefined || (typeof value.rosterIndex === "number" && Number.isInteger(value.rosterIndex) && value.rosterIndex >= 0 && value.rosterIndex < 10));
}

function isLastSoloQueueMatch(value: unknown): value is LastSoloQueueMatch {
  return isRecord(value) &&
    typeof value.matchId === "string" &&
    typeof value.gameStartTimestamp === "number" &&
    typeof value.durationSeconds === "number" &&
    (value.remake === undefined || typeof value.remake === "boolean") &&
    typeof value.championId === "string" &&
    typeof value.championName === "string" &&
    typeof value.kills === "number" &&
    typeof value.deaths === "number" &&
    typeof value.assists === "number" &&
    typeof value.win === "boolean" &&
    (value.remake === undefined || typeof value.remake === "boolean") &&
    (isLpChangeEvidence(value.lpChangeEvidence) ||
      value.leaguePointsChange === undefined || value.leaguePointsChange === null ||
      (typeof value.leaguePointsChange === "number" && Number.isFinite(value.leaguePointsChange))) &&
    Array.isArray(value.participants) &&
    value.participants.length <= 10 &&
    value.participants.every(isLastMatchParticipant);
}

function isLpChangeEvidence(value: unknown): value is LpChangeEvidence {
  if (!isRecord(value)) return false;
  if (value.status === "pending") {
    return value.reason === "league_state_not_updated" || value.reason === "zero_delta_requires_confirmation";
  }
  if (value.status === "observed") {
    return typeof value.value === "number" && Number.isFinite(value.value) &&
      value.source === "rank_snapshot_delta" &&
      typeof value.beforeObservedAt === "string" &&
      typeof value.afterObservedAt === "string";
  }
  return value.status === "unavailable" && [
    "no_before_snapshot",
    "multiple_games_between_snapshots",
    "match_rank_mismatch",
    "season_or_rank_reset",
    "historical_backfill",
    "rank_not_comparable",
    "rank_state_changed_without_match",
    "rank_update_timeout",
  ].includes(String(value.reason));
}

function isSeasonAnalytics(value: unknown): value is SeasonAnalytics {
  if (!isRecord(value) || !isRecord(value.roleCounts) || !isRecord(value.championCounts)) return false;
  return typeof value.games === "number" &&
    typeof value.kills === "number" &&
    typeof value.deaths === "number" &&
    typeof value.assists === "number" &&
    typeof value.kda === "number" &&
    isPlayerRole(value.mainRole) &&
    typeof value.roleShare === "number" &&
    Object.entries(value.roleCounts).every(([role, count]) => isPlayerRole(role) && typeof count === "number") &&
    Object.values(value.championCounts).every(isChampionAggregate) &&
    Array.isArray(value.topChampions) &&
    value.topChampions.every(isChampionAggregate) &&
    typeof value.lastGameStartTimestamp === "number" &&
    typeof value.lastMatchId === "string" &&
    (value.backfillStatus === undefined || value.backfillStatus === "not_started" ||
      value.backfillStatus === "in_progress" || value.backfillStatus === "complete") &&
    (value.backfillContributesToAnalytics === undefined || typeof value.backfillContributesToAnalytics === "boolean") &&
    (value.backfillStartTimestamp === undefined ||
      (typeof value.backfillStartTimestamp === "number" && Number.isFinite(value.backfillStartTimestamp))) &&
    (value.backfillBeforeTimestamp === undefined ||
      (typeof value.backfillBeforeTimestamp === "number" && Number.isFinite(value.backfillBeforeTimestamp)));
}

export function shouldUseCache(
  fetchedAt: number | null,
  now = Date.now(),
  ttlMs = CACHE_TTL_MS,
) {
  return fetchedAt !== null && fetchedAt <= now && now - fetchedAt < ttlMs;
}

export function normalizeSoloQueueEntry(input: unknown): LeagueEntry {
  if (!Array.isArray(input)) return unrankedEntry();

  const solo = input.find(
    (entry) => isRecord(entry) && entry.queueType === "RANKED_SOLO_5x5",
  );
  if (!isRecord(solo)) return unrankedEntry();

  const tier = isRankTier(solo.tier) ? solo.tier : "UNRANKED";
  const division = isDivision(solo.rank) ? solo.rank : "";

  return {
    tier,
    division,
    leaguePoints: Math.max(0, numberOrZero(solo.leaguePoints)),
    wins: Math.max(0, numberOrZero(solo.wins)),
    losses: Math.max(0, numberOrZero(solo.losses)),
  };
}

function unrankedEntry(): LeagueEntry {
  return {
    tier: "UNRANKED",
    division: "",
    leaguePoints: 0,
    wins: 0,
    losses: 0,
  };
}

export function calculateGoalProgress(
  tier: RankTier,
  division: Division,
  leaguePoints: number,
  goalTier: ChallengeGoalTier,
) {
  const tierIndex = TIER_ORDER.indexOf(tier);
  if (tierIndex < 0 || tier === "UNRANKED") return 0;
  const goalTierIndex = TIER_ORDER.indexOf(goalTier);
  if (tierIndex >= goalTierIndex) return 100;

  const divisionIndex = DIVISION_ORDER.indexOf(division as Exclude<Division, "">);
  if (divisionIndex < 0) return 0;

  const score = tierIndex * 400 + divisionIndex * 100 + Math.min(100, Math.max(0, leaguePoints));
  const goalScore = goalTierIndex * 400;
  return Math.min(99, Math.round((score / goalScore) * 100));
}

export function calculateGoldProgress(
  tier: RankTier,
  division: Division,
  leaguePoints: number,
) {
  return calculateGoalProgress(tier, division, leaguePoints, "GOLD");
}

export function calculateWinRate(wins: number, losses: number) {
  const games = wins + losses;
  return games === 0 ? 0 : Math.round((wins / games) * 1000) / 10;
}

export function rankScore(player: Pick<PlayerSnapshot, "tier" | "division" | "leaguePoints">) {
  const tierIndex = TIER_ORDER.indexOf(player.tier);
  if (tierIndex < 0 || player.tier === "UNRANKED") return -1;
  const divisionIndex = DIVISION_ORDER.indexOf(player.division as Exclude<Division, "">);
  return tierIndex * 400 + Math.max(0, divisionIndex) * 100 + player.leaguePoints;
}

/**
 * Orders the pairs that cleared the minimum, best first.
 *
 * Ties break on games rather than on raw win rate: two pairs the interval
 * cannot separate are separated by which of them has actually proven it more,
 * and the id keeps the last step deterministic so a refresh cannot reshuffle a
 * pair of equals.
 */
export function rankDuoRecords(
  records: readonly { playerIds: [string, string]; games: number; wins: number }[],
  minGames = DUO_LEADERBOARD_MIN_GAMES,
): DuoRecord[] {
  return records
    .filter((record) => record.games >= Math.max(1, minGames))
    .map((record) => ({
      playerIds: record.playerIds,
      games: record.games,
      wins: Math.min(record.games, Math.max(0, record.wins)),
      score: wilsonLowerBound(record.wins, record.games),
    }))
    .sort((a, b) =>
      b.score - a.score ||
      b.games - a.games ||
      a.playerIds[0].localeCompare(b.playerIds[0]) ||
      a.playerIds[1].localeCompare(b.playerIds[1]));
}

export function sortLeaderboard(players: PlayerSnapshot[]) {
  return [...players].sort((a, b) => rankScore(b) - rankScore(a));
}

/**
 * Distance in league points to the player one place above. `null` for the
 * leader and for unranked players, whose score is not comparable.
 */
export function leaguePointsGap(
  players: readonly Pick<PlayerSnapshot, "tier" | "division" | "leaguePoints">[],
  index: number,
) {
  const player = players[index];
  if (!player || index <= 0 || player.tier === "UNRANKED") return null;
  const above = players[index - 1];
  if (!above || above.tier === "UNRANKED") return null;
  return Math.max(0, rankScore(above) - rankScore(player));
}

/** Lead the first player holds over the runner-up, or `null` when undefined. */
export function leaderAdvantage(
  players: readonly Pick<PlayerSnapshot, "tier" | "division" | "leaguePoints">[],
) {
  if (players.length < 2) return null;
  const [leader, runnerUp] = players;
  if (leader.tier === "UNRANKED" || runnerUp.tier === "UNRANKED") return null;
  return Math.max(0, rankScore(leader) - rankScore(runnerUp));
}

/** Winrate a champion disc displays, already rounded to a whole percent. */
export function championWinRatePercent(champion: Pick<ChampionAggregate, "games" | "wins">) {
  if (champion.games <= 0) return 0;
  return Math.round((champion.wins / champion.games) * 100);
}

/** Respawn countdown as `H:MM:SS` instead of a raw five-digit second count. */
export function formatRespawnClock(totalSeconds: number) {
  const safe = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(safe / 3_600);
  const minutes = String(Math.floor((safe % 3_600) / 60)).padStart(2, "0");
  const seconds = String(safe % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/** Matches older than a day are de-emphasised rather than shown as equals. */
export function isStaleMatch(gameStartTimestamp: number, now = Date.now()) {
  return now - gameStartTimestamp >= 24 * 60 * 60 * 1_000;
}

/** Explicit Match-V5 remakes plus a safe fallback for legacy cached payloads. */
export function isRemakeMatch(match: { durationSeconds: number; remake?: boolean }) {
  return match.remake === true || (match.durationSeconds > 0 && match.durationSeconds < 5 * 60);
}

/** Ordered role distribution, so the full spread can be drawn from roleCounts. */
export function roleDistribution(roleCounts: Partial<Record<PlayerRole, number>>) {
  const entries = PLAYER_ROLES
    .filter((role) => role !== "UNKNOWN")
    .map((role) => ({ role, games: Math.max(0, roleCounts[role] ?? 0) }));
  const total = entries.reduce((sum, entry) => sum + entry.games, 0);
  if (total === 0) return [];
  const peak = Math.max(...entries.map((entry) => entry.games));
  return entries.map((entry) => ({
    role: entry.role,
    games: entry.games,
    share: Math.round((entry.games / total) * 100),
    intensity: peak === 0 ? 0 : entry.games / peak,
  }));
}

/** Column order of the ten-participant grid: one role per column, both teams. */
export const ROSTER_ROLE_ORDER: PlayerRole[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
export const ROSTER_TEAM_SIZE = ROSTER_ROLE_ORDER.length;

export type RosterSlot = LastMatchParticipant | null;

/**
 * Lays the ten participants out the way the grid draws them: the tracked
 * player's team on the first row, the opponents on the second, and the same
 * role in the same column on both.
 *
 * Riot returns the participants in whatever order the payload happens to carry,
 * which is how a support ended up under the top column. Anyone whose position is
 * missing — a remake Riot reports no positions for, or a spectator slot past the
 * fifth — takes a column that is still free, in arrival order, so the ordering
 * rule never costs the roster a champion.
 */
export function orderMatchRoster(
  participants: readonly LastMatchParticipant[],
  playerId: string,
): { allies: RosterSlot[]; enemies: RosterSlot[] } {
  const own = participants.find((participant) => participant.challengePlayerId === playerId);
  const teamIds = [...new Set(participants.map((participant) => participant.teamId))].sort((a, b) => a - b);
  const ownTeamId = own?.teamId ?? teamIds[0] ?? 0;
  const enemyTeamId = teamIds.find((teamId) => teamId !== ownTeamId);

  const place = (team: readonly LastMatchParticipant[]): RosterSlot[] => {
    const slots: RosterSlot[] = Array.from({ length: ROSTER_TEAM_SIZE }, () => null);
    const leftovers: LastMatchParticipant[] = [];
    for (const participant of team) {
      const column = participant.role ? ROSTER_ROLE_ORDER.indexOf(participant.role) : -1;
      if (column >= 0 && slots[column] === null) slots[column] = participant;
      else leftovers.push(participant);
    }
    for (const participant of leftovers) {
      const free = slots.indexOf(null);
      if (free < 0) break;
      slots[free] = participant;
    }
    return slots;
  };

  return {
    allies: place(participants.filter((participant) => participant.teamId === ownTeamId)),
    enemies: enemyTeamId === undefined
      ? []
      : place(participants.filter((participant) => participant.teamId === enemyTeamId)),
  };
}

/**
 * Live spectator payloads do not contain positions. Keep their original Riot
 * participant order inside each team instead of applying a stale/guessed lane,
 * while still putting the tracked team on the first row of the grid.
 */
export function orderLiveMatchRoster(
  participants: readonly LastMatchParticipant[],
  playerId: string,
): { allies: RosterSlot[]; enemies: RosterSlot[] } {
  const own = participants.find((participant) => participant.challengePlayerId === playerId);
  const teamIds = [...new Set(participants.map((participant) => participant.teamId))].sort((a, b) => a - b);
  const ownTeamId = own?.teamId ?? teamIds[0] ?? 0;
  const enemyTeamId = teamIds.find((teamId) => teamId !== ownTeamId);

  const place = (teamId: number): RosterSlot[] => {
    const slots: RosterSlot[] = participants
      .map((participant, index) => ({ participant, index }))
      .filter(({ participant }) => participant.teamId === teamId)
      .sort((a, b) => {
        const aOrder = a.participant.rosterIndex ?? a.index;
        const bOrder = b.participant.rosterIndex ?? b.index;
        return aOrder - bOrder || a.index - b.index;
      })
      .slice(0, ROSTER_TEAM_SIZE)
      .map(({ participant }) => participant);
    return slots.concat(Array.from({ length: ROSTER_TEAM_SIZE - slots.length }, () => null));
  };

  return {
    allies: place(ownTeamId),
    enemies: enemyTeamId === undefined ? [] : place(enemyTeamId),
  };
}

function isHabitualDuo(value: unknown): value is HabitualDuo {
  return isRecord(value) &&
    typeof value.playerId === "string" &&
    typeof value.gameName === "string" &&
    typeof value.games === "number";
}

function isDuoRecord(value: unknown): value is DuoRecord {
  return isRecord(value) &&
    Array.isArray(value.playerIds) &&
    value.playerIds.length === 2 &&
    value.playerIds.every((id) => typeof id === "string") &&
    typeof value.games === "number" &&
    typeof value.wins === "number" &&
    typeof value.score === "number";
}

function isLiveGame(value: unknown): value is LiveGame {
  return isRecord(value) &&
    typeof value.platformGameId === "string" &&
    typeof value.gameStartedAt === "number" &&
    typeof value.championId === "string" &&
    typeof value.championName === "string" &&
    Array.isArray(value.participants) &&
    value.participants.length <= 10 &&
    value.participants.every(isLastMatchParticipant);
}

function isPlayerSnapshot(value: unknown): value is PlayerSnapshot {
  if (!isRecord(value)) return false;
  if (value.recentResults !== undefined &&
      !(Array.isArray(value.recentResults) && value.recentResults.every((entry) => typeof entry === "boolean"))) {
    return false;
  }
  if (value.habitualDuo !== undefined && value.habitualDuo !== null && !isHabitualDuo(value.habitualDuo)) return false;
  if (value.liveGame !== undefined && value.liveGame !== null && !isLiveGame(value.liveGame)) return false;
  if (value.placeDelta !== undefined && typeof value.placeDelta !== "number") return false;
  return (
    typeof value.id === "string" &&
    typeof value.gameName === "string" &&
    typeof value.tagLine === "string" &&
    (typeof value.puuid === "string" || value.puuid === null) &&
    isRankTier(value.tier) &&
    isDivision(value.division) &&
    typeof value.leaguePoints === "number" &&
    typeof value.wins === "number" &&
    typeof value.losses === "number" &&
    typeof value.winRate === "number" &&
    typeof value.progressToGold === "number" &&
    typeof value.profileIconId === "number" &&
    typeof value.riotIdFound === "boolean" &&
    (value.lastSoloQueueMatch === undefined || value.lastSoloQueueMatch === null || isLastSoloQueueMatch(value.lastSoloQueueMatch)) &&
    isSeasonAnalytics(value.analytics)
  );
}

export function parseLeaderboardSnapshot(serialized: string): LeaderboardSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    value.region !== "LAS" ||
    value.platform !== "LA2" ||
    value.queue !== "RANKED_SOLO_5x5" ||
    value.season !== "2026" ||
    typeof value.fetchedAt !== "string" ||
    typeof value.dataDragonVersion !== "string" ||
    !Number.isFinite(Date.parse(value.fetchedAt)) ||
    !Array.isArray(value.players) ||
    value.players.length < CHALLENGE_MEMBER_COUNT - 1 ||
    value.players.length > CHALLENGE_MEMBER_COUNT ||
    !value.players.every(isPlayerSnapshot) ||
    (value.duos !== undefined && !(Array.isArray(value.duos) && value.duos.every(isDuoRecord)))
  ) {
    return null;
  }
  const snapshot = value as LeaderboardSnapshot;
  return {
    ...snapshot,
    players: snapshot.players.map((player) => ({
      ...player,
      lastSoloQueueMatch: player.lastSoloQueueMatch ? {
        ...player.lastSoloQueueMatch,
        lpChangeEvidence: isLpChangeEvidence(player.lastSoloQueueMatch.lpChangeEvidence)
          ? player.lastSoloQueueMatch.lpChangeEvidence
          : { status: "unavailable", reason: "no_before_snapshot" },
      } : null,
      progressToGold: calculateGoldProgress(player.tier, player.division, player.leaguePoints),
      // Carried through only when present, so a payload without the D1
      // enrichments round-trips to exactly the shape it arrived in.
      ...(player.recentResults ? { recentResults: player.recentResults.slice(0, 5) } : {}),
      ...(player.habitualDuo !== undefined ? { habitualDuo: player.habitualDuo } : {}),
      ...(player.liveGame !== undefined ? { liveGame: player.liveGame } : {}),
      ...(player.placeDelta !== undefined ? { placeDelta: player.placeDelta } : {}),
      analytics: {
        ...player.analytics,
        backfillStatus: player.analytics.backfillStatus ?? (
          typeof player.analytics.backfillBeforeTimestamp === "number" && player.analytics.backfillBeforeTimestamp > 0
            ? "in_progress"
            : player.analytics.backfillBeforeTimestamp === 0
              ? "complete"
              : "not_started"
        ),
        topChampions: selectBestChampions(player.analytics.championCounts),
      },
    })),
    // Re-ranked rather than trusted: a payload restored from browser storage
    // carries whatever order it was written in, and the score is cheap.
    ...(snapshot.duos ? { duos: rankDuoRecords(snapshot.duos) } : {}),
  };
}

export function parseLeaderboardPayload(value: unknown): LeaderboardPayload | null {
  if (!isRecord(value) || !isRecord(value.meta)) return null;
  const data = parseLeaderboardSnapshot(JSON.stringify(value.data));
  if (!data) return null;

  const source = value.meta.source;
  if (source !== "riot" && source !== "cache" && source !== "demo") return null;
  if (
    typeof value.meta.isStale !== "boolean" ||
    typeof value.meta.cacheTtlSeconds !== "number" ||
    !Number.isFinite(value.meta.cacheTtlSeconds) ||
    (value.meta.notice !== undefined && typeof value.meta.notice !== "string")
  ) {
    return null;
  }

  return {
    data,
    meta: {
      source,
      isStale: value.meta.isStale,
      cacheTtlSeconds: value.meta.cacheTtlSeconds,
      ...(typeof value.meta.notice === "string" ? { notice: value.meta.notice } : {}),
    },
  };
}

const DEMO_PLAYERS: Array<{
  id: string;
  gameName: string;
  tagLine: string;
  tier: RankTier;
  division: Division;
  leaguePoints: number;
  wins: number;
  losses: number;
  profileIconId: number;
  role: PlayerRole;
  champions: Array<[string, string]>;
  analyticsGames: number;
  kda: number;
  roleShare: number;
}> = [
  { id: "papipu", gameName: "Papipu", tagLine: "HOLA", tier: "SILVER", division: "I", leaguePoints: 96, wins: 81, losses: 65, profileIconId: 7148, role: "UTILITY", roleShare: 43, analyticsGames: 158, kda: 2.8, champions: [["Mordekaiser", "Mordekaiser"], ["Lux", "Lux"], ["Senna", "Senna"], ["Jhin", "Jhin"]] },
  { id: "rvn", gameName: "RVN", tagLine: "2105", tier: "SILVER", division: "I", leaguePoints: 25, wins: 98, losses: 98, profileIconId: 7128, role: "UTILITY", roleShare: 28, analyticsGames: 215, kda: 2, champions: [["Samira", "Samira"], ["Mordekaiser", "Mordekaiser"], ["Caitlyn", "Caitlyn"], ["Yasuo", "Yasuo"]] },
  { id: "inti", gameName: "INTI VIRAC0NCHA", tagLine: "20CM", tier: "SILVER", division: "II", leaguePoints: 11, wins: 178, losses: 192, profileIconId: 6091, role: "UTILITY", roleShare: 40, analyticsGames: 301, kda: 1.7, champions: [["Chogath", "Cho'Gath"], ["Leona", "Leona"], ["Ryze", "Ryze"], ["Illaoi", "Illaoi"]] },
  { id: "wonder-boi", gameName: "regigig4s", tagLine: "huhu", tier: "SILVER", division: "III", leaguePoints: 80, wins: 176, losses: 173, profileIconId: 6486, role: "BOTTOM", roleShare: 36, analyticsGames: 352, kda: 2.2, champions: [["Varus", "Varus"], ["Jhin", "Jhin"], ["Pyke", "Pyke"], ["Pantheon", "Pantheon"]] },
  { id: "testiculos", gameName: "TESTICrULoOS", tagLine: "2140", tier: "SILVER", division: "III", leaguePoints: 30, wins: 26, losses: 31, profileIconId: 2076, role: "MIDDLE", roleShare: 31, analyticsGames: 58, kda: 1.8, champions: [["Xerath", "Xerath"], ["Leona", "Leona"], ["Olaf", "Olaf"], ["Malphite", "Malphite"]] },
  { id: "piper-twin", gameName: "PiperTwin", tagLine: "20CM", tier: "BRONZE", division: "I", leaguePoints: 25, wins: 38, losses: 47, profileIconId: 6874, role: "BOTTOM", roleShare: 87, analyticsGames: 91, kda: 2.6, champions: [["Tristana", "Tristana"], ["Caitlyn", "Caitlyn"], ["Ashe", "Ashe"], ["Sivir", "Sivir"]] },
  { id: "miqi", gameName: "miqi", tagLine: "8745", tier: "BRONZE", division: "III", leaguePoints: 46, wins: 49, losses: 55, profileIconId: 3152, role: "BOTTOM", roleShare: 59, analyticsGames: 108, kda: 1.7, champions: [["Jhin", "Jhin"], ["Aphelios", "Aphelios"], ["Leona", "Leona"], ["Lux", "Lux"]] },
  { id: "mamimu", gameName: "Mamimu", tagLine: "HOLA", tier: "UNRANKED", division: "", leaguePoints: 0, wins: 0, losses: 0, profileIconId: 0, role: "UNKNOWN", roleShare: 0, analyticsGames: 0, kda: 0, champions: [] },
  { id: "yvncv", gameName: "yvncv", tagLine: "0521", tier: "UNRANKED", division: "", leaguePoints: 0, wins: 0, losses: 0, profileIconId: 0, role: "UNKNOWN", roleShare: 0, analyticsGames: 0, kda: 0, champions: [] },
];

export function createDemoSnapshot(now = new Date()): LeaderboardSnapshot {
  return {
    region: "LAS",
    platform: "LA2",
    queue: "RANKED_SOLO_5x5",
    season: "2026",
    fetchedAt: now.toISOString(),
    dataDragonVersion: "16.13.1",
    players: sortLeaderboard(DEMO_PLAYERS.map((player, playerIndex) => {
      const championCounts = Object.fromEntries(player.champions.map(([id, name], index) => [id, { id, name, games: 18 - index * 3, wins: 10 - index }]));
      const peer = DEMO_PLAYERS[(playerIndex + 1) % DEMO_PLAYERS.length];
      const primaryChampion = player.champions[0];
      const peerChampion = peer.champions[0] ?? primaryChampion;
      const won = playerIndex % 2 === 0;
      return {
        id: player.id,
        gameName: player.gameName,
        tagLine: player.tagLine,
        tier: player.tier,
        division: player.division,
        leaguePoints: player.leaguePoints,
        wins: player.wins,
        losses: player.losses,
        profileIconId: player.profileIconId,
        riotIdFound: true,
        lastSoloQueueMatch: primaryChampion && peerChampion ? {
          matchId: `DEMO_${player.id}`,
          gameStartTimestamp: now.getTime() - (playerIndex + 1) * 3_600_000,
          durationSeconds: 1_620 + playerIndex * 37,
          championId: primaryChampion[0],
          championName: primaryChampion[1],
          kills: 3 + playerIndex,
          deaths: 2 + (playerIndex % 4),
          assists: 5 + playerIndex * 2,
          win: won,
          lpChangeEvidence: {
            status: "observed",
            value: won ? 22 + (playerIndex % 3) : -(18 + (playerIndex % 4)),
            source: "rank_snapshot_delta",
            beforeObservedAt: new Date(now.getTime() - 4_000).toISOString(),
            afterObservedAt: now.toISOString(),
          },
          participants: [
            {
              championId: primaryChampion[0],
              championName: primaryChampion[1],
              teamId: 100,
              gameName: player.gameName,
              tagLine: player.tagLine,
              challengePlayerId: player.id,
            },
            {
              championId: peerChampion[0],
              championName: peerChampion[1],
              teamId: 100,
              gameName: peer.gameName,
              tagLine: peer.tagLine,
              challengePlayerId: peer.id,
            },
            ...["Ahri", "Darius", "Ezreal", "Nami", "LeeSin", "Orianna", "Jinx", "Thresh"].map((id, index) => ({
              championId: id,
              championName: id,
              teamId: index < 3 ? 100 : 200,
              gameName: `Jugador ${index + 1}`,
              tagLine: "LAS",
              challengePlayerId: null,
            })),
          ],
        } : null,
        puuid: null,
        winRate: calculateWinRate(player.wins, player.losses),
        progressToGold: calculateGoldProgress(player.tier, player.division, player.leaguePoints),
        analytics: {
          games: player.analyticsGames,
          kills: 0,
          deaths: 0,
          assists: 0,
          kda: player.kda,
          mainRole: player.role,
          roleShare: player.roleShare,
          roleCounts: { [player.role]: Math.round(player.analyticsGames * player.roleShare / 100) },
          championCounts,
          topChampions: selectBestChampions(championCounts),
          lastGameStartTimestamp: 0,
          lastMatchId: "",
          backfillStatus: "complete",
          backfillContributesToAnalytics: false,
        },
      };
    })),
  };
}
