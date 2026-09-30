/**
 * Presentation helpers for the leaderboard page. Pure functions only: every
 * string the board shows about ranks, ages and matches is decided here,
 * so the components stay declarative and the wording is unit-tested.
 */
import {
  selectBestChampions,
  wilsonLowerBound,
  type ChampionAggregate,
  type LastMatchParticipant,
  type LpChangeEvidence,
  type PlayerRole,
  type PlayerSnapshot,
  type RankTier,
} from "./leaderboard.ts";
import { peruDateParts } from "./peru-time.ts";

export const TIER_LABELS: Record<RankTier, string> = {
  IRON: "Hierro",
  BRONZE: "Bronce",
  SILVER: "Plata",
  GOLD: "Oro",
  PLATINUM: "Platino",
  EMERALD: "Esmeralda",
  DIAMOND: "Diamante",
  MASTER: "Maestro",
  GRANDMASTER: "Gran Maestro",
  CHALLENGER: "Challenger",
  UNRANKED: "Sin rango",
};

export const ROLE_LABELS: Record<PlayerRole, string> = {
  TOP: "Top",
  JUNGLE: "Jungla",
  MIDDLE: "Mid",
  BOTTOM: "ADC",
  UTILITY: "Support",
  UNKNOWN: "Sin rol",
};

export function rankLabel(player: Pick<PlayerSnapshot, "tier" | "division">) {
  return player.division ? `${TIER_LABELS[player.tier]} ${player.division}` : TIER_LABELS[player.tier];
}

/** UNRANKED has no crest of its own; Iron's stands in and the page drains it. */
export function rankAsset(tier: RankTier) {
  return `/ranks/${tier === "UNRANKED" ? "iron" : tier.toLowerCase()}.png`;
}

/** The part of a Riot ID a person is actually called by: "INTI VIRAC0NCHA" → "INTI". */
export function firstName(gameName: string) {
  return gameName.trim().split(/\s+/)[0] ?? gameName;
}

export function formatDuration(totalSeconds: number) {
  const safe = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

/** "hace 57 min", "hace 5 h", "hace 30 d". */
export function formatAge(timestamp: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

/** Lima wall-clock "HH:MM" for an ISO timestamp or epoch. */
export function formatLimaTime(value: string | number) {
  const parts = peruDateParts(value);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/** Signed PL change with a real minus sign; null when there is nothing to show. */
export function formatLpChange(evidence: LpChangeEvidence, remake = false) {
  if (remake) return "0 PL";
  if (evidence.status === "pending") return "Calculando…";
  if (evidence.status === "unavailable") return null;
  if (evidence.value === 0) return "0 PL";
  return evidence.value < 0 ? `−${Math.abs(evidence.value)} PL` : `+${evidence.value} PL`;
}

export function lpEvidenceTitle(evidence: LpChangeEvidence, remake = false) {
  if (remake) return "La partida terminó como remake y no alteró los PL.";
  if (evidence.status === "observed") {
    return "Calculado comparando dos estados clasificatorios alrededor de esta partida. Riot no informa el cambio de PL por partida.";
  }
  if (evidence.status === "pending") {
    return "La partida ya aparece, pero Riot todavía no refleja un cambio de PL comprobable.";
  }
  return "No hay evidencia suficiente para atribuir un cambio de PL a esta partida.";
}

export type MatchOutcome = "win" | "loss" | "remake";

export function outcomeLabel(outcome: MatchOutcome) {
  return outcome === "win" ? "Victoria" : outcome === "loss" ? "Derrota" : "Remake";
}

export function kdaRatio(kills: number, deaths: number, assists: number) {
  return ((kills + assists) / Math.max(1, deaths)).toFixed(1);
}

/** Per-game kills / deaths / assists over the analysed games. */
export function perGameAverages(analytics: PlayerSnapshot["analytics"]) {
  if (analytics.games <= 0) return null;
  const per = (value: number) => (value / analytics.games).toFixed(1);
  return `${per(analytics.kills)} / ${per(analytics.deaths)} / ${per(analytics.assists)}`;
}

export type FormSlot = "win" | "loss" | "empty";

/** The last five results as five slots, oldest first, padded on the left. */
export function formSlots(results: readonly boolean[] = []) {
  const recent = results.slice(-5);
  const slots: FormSlot[] = [
    ...Array.from({ length: 5 - recent.length }, () => "empty" as const),
    ...recent.map((won) => (won ? "win" as const : "loss" as const)),
  ];
  const wins = recent.filter(Boolean).length;
  const losses = recent.length - wins;
  const label = recent.length === 0
    ? "Sin partidas recientes registradas"
    : `Últimas ${recent.length}: ${wins} ${wins === 1 ? "victoria" : "victorias"} y ${losses} ${losses === 1 ? "derrota" : "derrotas"}`;
  return { slots, wins, losses, text: `${wins}V ${losses}D`, label };
}

export type ChampionView = {
  id: string;
  name: string;
  games: number;
  winRate: number;
  adjusted: number;
  tone: "strong" | "even" | "weak";
};

/** Winrate as displayed (rounded) and the Wilson lower bound the list is ordered by. */
export function championView(champion: ChampionAggregate): ChampionView {
  const winRate = champion.games > 0 ? Math.round((champion.wins / champion.games) * 100) : 0;
  return {
    id: champion.id,
    name: championDisplayName(champion),
    games: champion.games,
    winRate,
    adjusted: Math.round(wilsonLowerBound(champion.wins, champion.games) * 100),
    tone: winRate >= 55 ? "strong" : winRate >= 48 ? "even" : "weak",
  };
}

export function bestChampionViews(championCounts: Record<string, ChampionAggregate>, limit: number) {
  return selectBestChampions(championCounts, limit).map(championView);
}

export function mostPlayedChampionViews(championCounts: Record<string, ChampionAggregate>, limit: number) {
  return Object.values(championCounts)
    .sort((a, b) => b.games - a.games || b.wins - a.wins || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit))
    .map(championView);
}

const DISPLAY_NAMES: Record<string, string> = {
  Chogath: "Cho'Gath",
  MissFortune: "Miss Fortune",
  TahmKench: "Tahm Kench",
  LeeSin: "Lee Sin",
  MasterYi: "Master Yi",
  TwistedFate: "Twisted Fate",
  XinZhao: "Xin Zhao",
  JarvanIV: "Jarvan IV",
  DrMundo: "Dr. Mundo",
  AurelionSol: "Aurelion Sol",
  KogMaw: "Kog'Maw",
  RekSai: "Rek'Sai",
  KSante: "K'Sante",
  Khazix: "Kha'Zix",
  Velkoz: "Vel'Koz",
  Kaisa: "Kai'Sa",
  Belveth: "Bel'Veth",
  MonkeyKing: "Wukong",
  Nunu: "Nunu y Willump",
  FiddleSticks: "Fiddlesticks",
  RenataGlasc: "Renata Glasc",
  LeBlanc: "LeBlanc",
};

/** Match-V5 and the stored aggregates sometimes carry the key, not the name. */
export function championDisplayName(champion: Pick<ChampionAggregate, "id" | "name">) {
  if (champion.name && champion.name !== champion.id) return champion.name;
  return DISPLAY_NAMES[champion.id] ?? champion.name ?? champion.id;
}

/** Data Dragon keys that differ from the ids Match-V5 reports. */
const DDRAGON_KEYS: Record<string, string> = {
  FiddleSticks: "Fiddlesticks",
};

export function championKey(id: string) {
  return DDRAGON_KEYS[id] ?? id;
}

export function championIconUrl(version: string, id: string) {
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${championKey(id)}.png`;
}

/** The landscape "centered" splash: the podium crops it to a short band. */
export function championSplashUrl(id: string) {
  return `https://ddragon.leagueoflegends.com/cdn/img/champion/centered/${championKey(id)}_0.jpg`;
}

export function profileIconUrl(version: string, profileIconId: number) {
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${profileIconId}.png`;
}

export function profileUrl(player: Pick<PlayerSnapshot, "gameName" | "tagLine">) {
  return `https://www.leagueofgraphs.com/summoner/las/${encodeURIComponent(player.gameName)}-${encodeURIComponent(player.tagLine)}`;
}

export function matchDetailsUrl(matchId: string) {
  if (!/^LA2_\d+$/.test(matchId)) return null;
  return `https://www.leagueofgraphs.com/match/las/${matchId.slice(4)}`;
}

/**
 * Challenge members who shared the game, by their current name. Participants
 * carry the Riot ID from when the match was played, so a renamed player is
 * resolved through their challenge id rather than the stale name.
 */
export function peerNames(
  participants: readonly LastMatchParticipant[],
  playerId: string,
  roster: readonly Pick<PlayerSnapshot, "id" | "gameName">[],
) {
  const names = participants
    .filter((participant) => participant.challengePlayerId && participant.challengePlayerId !== playerId)
    .map((participant) => {
      const current = roster.find((player) => player.id === participant.challengePlayerId);
      return firstName(current?.gameName ?? participant.gameName);
    });
  return [...new Set(names)];
}

export function peerText(names: readonly string[]) {
  return names.length > 0 ? `con ${names.join(", ")}` : "";
}

export type RoleShare = { role: PlayerRole; label: string; games: number; share: number; bar: number };

/** Every role the player has games in, most played first, bars relative to the peak. */
export function roleShares(roleCounts: Partial<Record<PlayerRole, number>>): RoleShare[] {
  const entries = (Object.keys(ROLE_LABELS) as PlayerRole[])
    .filter((role) => role !== "UNKNOWN")
    .map((role) => ({ role, games: Math.max(0, roleCounts[role] ?? 0) }))
    .filter((entry) => entry.games > 0);
  const total = entries.reduce((sum, entry) => sum + entry.games, 0);
  const peak = Math.max(0, ...entries.map((entry) => entry.games));
  return entries
    .sort((a, b) => b.games - a.games)
    .map((entry) => ({
      role: entry.role,
      label: ROLE_LABELS[entry.role],
      games: entry.games,
      share: total > 0 ? Math.round((entry.games / total) * 100) : 0,
      bar: peak > 0 ? Math.round((entry.games / peak) * 100) : 0,
    }));
}

export type DuoView = {
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  adjusted: number;
  tone: "strong" | "even" | "weak";
};

export function duoView(duo: { games: number; wins: number; score: number }): DuoView {
  const winRate = duo.games > 0 ? (duo.wins / duo.games) * 100 : 0;
  return {
    games: duo.games,
    wins: duo.wins,
    losses: Math.max(0, duo.games - duo.wins),
    winRate,
    adjusted: duo.score * 100,
    tone: winRate >= 55 ? "strong" : winRate >= 48 ? "even" : "weak",
  };
}
