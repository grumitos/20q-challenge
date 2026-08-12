import {
  selectBestChampions,
  type ChampionAggregate,
  type PlayerRole,
  type SeasonAnalytics,
} from "./leaderboard.ts";

export type SeasonSeedPlayer = {
  puuid: string | null;
  profileIconId: number;
  analyticsGames: number;
  kills: number;
  deaths: number;
  assists: number;
  roles: Partial<Record<PlayerRole, number>>;
  champions: Record<string, ChampionAggregate>;
  lastGameStartTimestamp: number;
  lastMatchId: string;
};

export type SeasonSeed = {
  season: "2026";
  queue: "RANKED_SOLO_5x5";
  generatedAt: string;
  dataDragonVersion: string;
  players: Record<string, SeasonSeedPlayer>;
};

type MatchParticipant = {
  championId?: number;
  championName?: string;
  kills?: number;
  deaths?: number;
  assists?: number;
  win?: boolean;
  teamPosition?: string;
  individualPosition?: string;
};

const ROLES: PlayerRole[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function roleFromRiot(value: unknown): PlayerRole {
  return typeof value === "string" && ROLES.includes(value as PlayerRole)
    ? value as PlayerRole
    : "UNKNOWN";
}

function calculateKda(kills: number, deaths: number, assists: number) {
  return Math.round(((kills + assists) / Math.max(1, deaths)) * 10) / 10;
}

export function finalizeAnalytics(
  analytics: Omit<SeasonAnalytics, "kda" | "mainRole" | "roleShare" | "topChampions"> &
    Partial<Pick<SeasonAnalytics, "kda" | "mainRole" | "roleShare" | "topChampions">>,
): SeasonAnalytics {
  const roles = Object.entries(analytics.roleCounts) as Array<[PlayerRole, number]>;
  const [mainRole = "UNKNOWN", roleGames = 0] = roles
    .filter(([role]) => role !== "UNKNOWN")
    .sort((a, b) => b[1] - a[1])[0] ?? ["UNKNOWN", 0];
  const topChampions = selectBestChampions(analytics.championCounts);

  return {
    ...analytics,
    kda: calculateKda(analytics.kills, analytics.deaths, analytics.assists),
    mainRole,
    roleShare: analytics.games === 0 ? 0 : Math.round((roleGames / analytics.games) * 100),
    topChampions,
  };
}

export function analyticsFromSeed(seed: SeasonSeedPlayer): SeasonAnalytics {
  const roleCounts: Partial<Record<PlayerRole, number>> = {};
  for (const [rawRole, games] of Object.entries(seed.roles)) {
    const role = roleFromRiot(rawRole);
    roleCounts[role] = (roleCounts[role] ?? 0) + safeNumber(games);
  }

  return finalizeAnalytics({
    games: safeNumber(seed.analyticsGames),
    kills: safeNumber(seed.kills),
    deaths: safeNumber(seed.deaths),
    assists: safeNumber(seed.assists),
    roleCounts,
    championCounts: Object.fromEntries(
      Object.entries(seed.champions).map(([key, champion]) => [key, { ...champion }]),
    ),
    lastGameStartTimestamp: safeNumber(seed.lastGameStartTimestamp),
    lastMatchId: seed.lastMatchId || "",
    backfillStatus: "not_started",
    backfillContributesToAnalytics: false,
  });
}

export function cloneAnalytics(analytics: SeasonAnalytics): SeasonAnalytics {
  return {
    ...analytics,
    roleCounts: { ...analytics.roleCounts },
    championCounts: Object.fromEntries(
      Object.entries(analytics.championCounts).map(([key, champion]) => [key, { ...champion }]),
    ),
    topChampions: analytics.topChampions.map((champion) => ({ ...champion })),
  };
}

export function emptyAnalytics(): SeasonAnalytics {
  return finalizeAnalytics({
    games: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    roleCounts: {},
    championCounts: {},
    lastGameStartTimestamp: 0,
    lastMatchId: "",
    backfillStatus: "not_started",
    backfillContributesToAnalytics: true,
  });
}

export function addMatchToAnalytics(
  analytics: SeasonAnalytics,
  participant: MatchParticipant,
  matchId: string,
  gameStartTimestamp: number,
) {
  analytics.games += 1;
  analytics.kills += safeNumber(participant.kills);
  analytics.deaths += safeNumber(participant.deaths);
  analytics.assists += safeNumber(participant.assists);

  const role = roleFromRiot(participant.teamPosition || participant.individualPosition);
  analytics.roleCounts[role] = (analytics.roleCounts[role] ?? 0) + 1;

  const championKey = String(safeNumber(participant.championId));
  const champion = analytics.championCounts[championKey] ?? {
    id: participant.championName || championKey,
    name: participant.championName || `Champion ${championKey}`,
    games: 0,
    wins: 0,
  };
  champion.games += 1;
  champion.wins += participant.win ? 1 : 0;
  analytics.championCounts[championKey] = champion;

  if (gameStartTimestamp > analytics.lastGameStartTimestamp) {
    analytics.lastGameStartTimestamp = gameStartTimestamp;
    analytics.lastMatchId = matchId;
  }
}
