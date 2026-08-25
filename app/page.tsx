"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DUO_LEADERBOARD_MIN_GAMES,
  championWinRatePercent,
  championWinRateTone,
  createDemoSnapshot,
  formatRespawnClock,
  isRemakeMatch,
  isStaleMatch,
  leaderAdvantage,
  leaguePointsGap,
  orderLiveMatchRoster,
  orderMatchRoster,
  papipuRespawnSeconds,
  parseLeaderboardPayload,
  selectBestChampions,
  sortLeaderboard,
  type ChampionAggregate,
  type DuoRecord,
  type LastMatchParticipant,
  type LeaderboardPayload,
  type LpChangeEvidence,
  type PlayerRole,
  type PlayerSnapshot,
  type RankTier,
  type RosterSlot,
} from "../lib/leaderboard";

const initialPayload: LeaderboardPayload = {
  data: createDemoSnapshot(new Date("2026-01-01T00:00:00.000Z")),
  meta: { source: "demo", isStale: false, cacheTtlSeconds: 60 },
};

const LEADERBOARD_STORAGE_KEY = "20q-leaderboard-payload-v1";
const LEADERBOARD_REFRESH_MS = 60_000;
const PODIUM_CHAMPION_SLOTS = 5;
const ROW_CHAMPION_SLOTS = 4;

/**
 * Los Juegos de Gaspi. The header badge opens a title card over the ranking and
 * repaints what is underneath it — see `html.is-invaded` in the stylesheet.
 */
const GASPI_PARTICLE_COUNT = 18;
/** Long enough for the overlay's own fade to have covered the ranking, so the
    palette swap underneath is never seen happening. */
const GASPI_INVASION_DELAY_MS = 560;
const GASPI_TITLE = "LOS JUEGOS DE GASPI";
const GASPI_LETTER_START_MS = 350;
const GASPI_LETTER_STEP_MS = 70;
const GASPI_LINES = ["LOS JUEGOS", "DE GASPI"] as const;

const awayTabTitles = [
  "Bienvenidos a los juegos de Gaspi",
  "Papipu, Mamimu e Hijuepu",
  "Haz lo tuyo Giancarlo",
  "BOMBA",
  "Quiero queque",
  "Haz caso bro",
  "Comenzó la racha",
  "NO HAY NINGÚN MAÑANA",
  "Gente murió Oliver Tree",
  "SERRANOOOO",
  "Yo estaría tilteado",
  "El que muere es cabro",
  "Le pegó al nexo",
  "elweso",
  "equisdeee",
  "Papipu ya son las 11",
  "API API...",
] as const;

/**
 * A title that sets up the next one. When the key is drawn, its value comes up
 * on the following tab-away and then the bag carries on as normal — the pair
 * reads as one line delivered across two glances, which is the joke.
 *
 * Follow-ups are not in the bag: they only ever arrive behind their setup.
 */
const awayTabFollowUps: Record<string, string> = {
  "Bienvenidos a los juegos de Gaspi": "de Gaspi",
};

const tierLabels: Record<RankTier, string> = {
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

const roleLabels: Record<PlayerRole, string> = {
  TOP: "Top",
  JUNGLE: "Jungla",
  MIDDLE: "Mid",
  BOTTOM: "ADC",
  UTILITY: "Support",
  UNKNOWN: "Sin rol",
};

/**
 * The loading view is the real card with `pending` set: labels, tracks, frames
 * and the grid all come from the same JSX, and only the leaves that carry Riot
 * values shimmer. This placeholder feeds those leaves so no component has to
 * guard for a missing player — none of its values ever reach the screen.
 */
const PENDING_PLAYER: PlayerSnapshot = {
  id: "pending",
  gameName: "",
  tagLine: "",
  puuid: null,
  tier: "UNRANKED",
  division: "",
  leaguePoints: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  progressToGold: 0,
  profileIconId: 0,
  riotIdFound: false,
  lastSoloQueueMatch: null,
  analytics: {
    games: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    kda: 0,
    mainRole: "UNKNOWN",
    roleShare: 0,
    roleCounts: {},
    championCounts: {},
    topChampions: [],
    lastGameStartTimestamp: 0,
    lastMatchId: "",
    backfillStatus: "complete",
  },
  recentResults: [],
  habitualDuo: null,
  liveGame: null,
  placeDelta: 0,
};

function rankLabel(player: PlayerSnapshot) {
  return player.division ? `${tierLabels[player.tier]} ${player.division}` : tierLabels[player.tier];
}

function rankAsset(tier: RankTier) {
  return `/ranks/${tier === "UNRANKED" ? "iron" : tier.toLowerCase()}.png`;
}

function rankEmblemClass(tier: RankTier) {
  // UNRANKED has no crest of its own, so Iron's stands in. Marking it lets the
  // stylesheet drain the colour: an untouched Iron crest next to "Sin rango"
  // reads as a real placement the player does not have.
  return tier === "UNRANKED"
    ? "rank-emblem tier-iron is-unranked"
    : `rank-emblem tier-${tier.toLowerCase()}`;
}

function tierTextClass(tier: RankTier) {
  return `tier-${tier.toLowerCase()}`;
}

function profileAsset(version: string, profileIconId: number) {
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${profileIconId}.png`;
}

function championAsset(version: string, champion: ChampionAggregate | string) {
  const championId = typeof champion === "string" ? champion : champion.id;
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${championId}.png`;
}

/**
 * The loading-screen portrait, not the landscape "centered" splash: it is the
 * only Riot art that is already composed vertically, so a card can crop it to
 * its own height without cutting the champion in half.
 */
function championLoadingAsset(champion: ChampionAggregate) {
  return `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${champion.id}_0.jpg`;
}

/** Duo labels use the part of a handle a person is actually called by. */
function firstName(player: PlayerSnapshot) {
  return player.gameName.split(" ")[0];
}

function profileUrl(player: PlayerSnapshot) {
  return `https://www.leagueofgraphs.com/summoner/las/${encodeURIComponent(player.gameName)}-${encodeURIComponent(player.tagLine)}`;
}

function formattedUpdate(iso: string) {
  const lima = new Date(new Date(iso).getTime() - 5 * 60 * 60 * 1000);
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const day = String(lima.getUTCDate()).padStart(2, "0");
  const hour = String(lima.getUTCHours()).padStart(2, "0");
  const minute = String(lima.getUTCMinutes()).padStart(2, "0");
  return `${day} ${months[lima.getUTCMonth()]}, ${hour}:${minute}`;
}

function formattedMatchAge(timestamp: number) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  // One letter, joined to the number: "hace 20m", not "hace 20 min". The unit
  // carries no information the letter does not, and the space let a long age
  // wrap away from its number.
  if (elapsedMinutes < 1) return "ahora";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}

function formattedLeaguePointsChange(evidence: LpChangeEvidence) {
  if (evidence.status === "pending") return "Calculando…";
  if (evidence.status === "unavailable") return null;
  if (evidence.value === 0) return "0 PL";
  if (evidence.value < 0) return `−${Math.abs(evidence.value)} PL`;
  return `+${evidence.value} PL`;
}

function leaguePointsEvidenceTitle(evidence: LpChangeEvidence) {
  if (evidence.status === "observed") {
    return "Calculado comparando dos estados clasificatorios alrededor de esta partida. Riot no proporciona el cambio de PL por partida.";
  }
  if (evidence.status === "pending") {
    return "La partida ya aparece, pero el estado clasificatorio de Riot todavía no refleja un cambio comprobable.";
  }
  return "No existe evidencia suficiente para atribuir un cambio de PL a esta partida.";
}

function matchDetailsUrl(matchId: string) {
  if (!/^LA2_\d+$/.test(matchId)) return null;
  return `https://www.leagueofgraphs.com/match/las/${matchId.slice(4)}`;
}

/* ─── PENDING PRIMITIVES ───
   `Bone` stands in for a run of text; `sk-slot` shimmers inside a frame that is
   already part of the design, so an image slot keeps its border and size. */

function Bone({ w, h, className = "" }: { w: number | string; h: number | string; className?: string }) {
  return (
    <span
      className={`sk-bone${className ? ` ${className}` : ""}`}
      style={{
        width: typeof w === "number" ? `${w}px` : w,
        height: typeof h === "number" ? `${h}px` : h,
      }}
      aria-hidden="true"
    />
  );
}

/** A link that becomes a plain box while pending, so no dead href is focusable. */
function Linkable({ pending, className, href, label, dataLabel, children }: {
  pending: boolean;
  className: string;
  href: string | null;
  label: string;
  dataLabel?: string;
  children: ReactNode;
}) {
  if (pending || !href) return <span className={className} data-label={dataLabel}>{children}</span>;
  return (
    <a className={className} data-label={dataLabel} href={href} target="_blank" rel="noreferrer" aria-label={label}>
      {children}
    </a>
  );
}

function RoleIcon({ role, className = "role-icon" }: { role: PlayerRole; className?: string }) {
  const paths: Record<PlayerRole, ReactNode> = {
    TOP: <><path opacity=".5" d="M21 14h-7v7h7v-7Zm5-3v15H11.014l-4 4H30V7.016Z" /><polygon points="4 4 4.003 28.045 9 23 9 9 23 9 28.045 4.003 4 4" /></>,
    JUNGLE: <path d="M25 3c-2.128 3.3-5.147 6.851-6.966 11.469A42.373 42.373 0 0 1 20 20a27.7 27.7 0 0 1 1-3c0-4.977 1.856-8.723 4-14ZM13 20c-1.488-4.487-4.76-6.966-9-9 3.868 3.136 4.422 7.52 5 12l3.743 3.312C14.215 27.917 16.527 30.451 17 31c4.555-9.445-3.366-20.8-8-28 2.67 6.573 4.717 10.342 4 17Zm8 5a15.271 15.271 0 0 1 0 2l4-4c.578-4.48 1.132-8.864 5-12-5.288 2.537-7.866 7.854-9 14Z" />,
    MIDDLE: <><path opacity=".5" d="m30 12.968-4.008 4L26 26h-9l-4 4h17ZM16.979 8 21 4H4v16.977L8 17V8h8.981Z" /><polygon points="25 4 4 25 4 30 9 30 30 9 30 4 25 4" /></>,
    BOTTOM: <><path opacity=".5" d="M13 20h7v-7h-7v7ZM4 4v22.984l3.955-4L8 8h14.986l4-4H4Z" /><polygon points="29.997 5.955 25 11 25 25 11 25 5.955 29.997 30 30 29.997 5.955" /></>,
    UTILITY: <path d="M26 13c3.535 0 8-4 8-4H23l-3 3 2 7 5-2-3-4h2ZM22 5l-1.173-2h-7.765L12 5l5 6Zm-5 9-1-1-3 15 4 3 4-3-3-15ZM11 9H0s4.465 4 8 4h2l-3 4 5 2 2-7Z" />,
    UNKNOWN: <><circle cx="17" cy="17" r="12" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M14 13a3.2 3.2 0 1 1 4.7 2.8c-1.7 1-1.7 1.6-1.7 3.2M17 23h.01" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
  };
  return <svg className={className} viewBox="0 0 34 34" fill="currentColor" aria-hidden="true">{paths[role]}</svg>;
}

function ProfileIcon({ player, version, size, className, lazy = false, pending = false }: {
  player: PlayerSnapshot;
  version: string;
  size: number;
  className?: string;
  lazy?: boolean;
  pending?: boolean;
}) {
  const framed = `profile-placeholder${className ? ` ${className}` : ""}`;
  if (pending) {
    return <span className={`${framed} sk-slot`} style={{ width: size, height: size }} aria-hidden="true" />;
  }
  if (!player.riotIdFound || player.profileIconId <= 0) {
    return <span className={framed} style={{ width: size, height: size }} role="img" aria-label={`Sin icono de perfil para ${player.gameName}`}>?</span>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className={className} src={profileAsset(version, player.profileIconId)} alt={`Icono de perfil de ${player.gameName}`} width={size} height={size} loading={lazy ? "lazy" : undefined} />
  );
}

/** The rank crest. Its frame is structure; which crest it is, is data. */
function RankEmblem({ player, size, pending = false, describe = false, lazy = false }: {
  player: PlayerSnapshot;
  size: number;
  pending?: boolean;
  describe?: boolean;
  lazy?: boolean;
}) {
  if (pending) return <span className="rank-slot sk-slot" style={{ width: size, height: size }} aria-hidden="true" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={rankEmblemClass(player.tier)}
      src={rankAsset(player.tier)}
      alt={describe ? `Emblema de ${tierLabels[player.tier]}` : ""}
      width={size}
      height={size}
      loading={lazy ? "lazy" : undefined}
    />
  );
}

/** Main role plus its share, the compact form used inside a row. */
function Role({ player, pending = false }: { player: PlayerSnapshot; pending?: boolean }) {
  if (pending) {
    return (
      <span className="role-block" aria-hidden="true">
        <Bone w={24} h={24} />
        <small className="role-share"><Bone w={17} h={8} /></small>
      </span>
    );
  }
  const role = player.riotIdFound ? player.analytics.mainRole : "UNKNOWN";
  const label = player.riotIdFound ? `${roleLabels[role]} · ${player.analytics.roleShare}%` : "Rol no disponible";
  return (
    <span className="role-block" role="img" aria-label={label}>
      <RoleIcon role={role} />
      {player.riotIdFound ? <small className="role-share">{player.analytics.roleShare}%</small> : null}
    </span>
  );
}

/**
 * Champion discs whose winrate is text, not a pointer-only tooltip. The band is
 * its own list — there is no wrapper between it and the discs — so the discs are
 * the grid columns, and a set shorter than its slots centres itself instead of
 * hugging the left edge of an otherwise empty track.
 */
function ChampionBand({ player, version, slots, className, label, showGames = false, pending = false }: {
  player: PlayerSnapshot;
  version: string;
  slots: number;
  className: string;
  label?: string;
  showGames?: boolean;
  pending?: boolean;
}) {
  const champions = pending || !player.riotIdFound ? [] : selectBestChampions(player.analytics.championCounts, slots);
  const shown = pending ? slots : champions.length;
  const style = { "--shown": shown } as CSSProperties;

  if (shown === 0) {
    return (
      <span className={`${className} is-empty`} data-label={label} style={style} role="img" aria-label={`Campeones no disponibles para ${player.gameName}`}>—</span>
    );
  }
  return (
    <span
      className={`${className}${shown < slots ? " is-partial" : ""}`}
      data-label={label}
      style={style}
      role={pending ? undefined : "list"}
      aria-hidden={pending ? true : undefined}
      aria-label={pending ? undefined : `Mejores campeones de ${player.gameName}`}
    >
      {pending
        ? Array.from({ length: slots }, (_, index) => (
            <span className="champion" key={`slot-${index}`}>
              <span className="champion-portrait sk-slot" />
              <small className="champion-wr"><Bone w={21} h={8} /></small>
              {showGames ? <small className="champion-games"><Bone w={15} h={8} /></small> : null}
            </span>
          ))
        : champions.map((champion) => {
            const shownPercent = championWinRatePercent(champion);
            const tone = championWinRateTone(shownPercent);
            return (
              <span
                className={`champion is-${tone}`}
                key={`${player.id}-${champion.id}`}
                role="listitem"
                aria-label={`${champion.name}: ${champion.games} partidas, ${shownPercent}% de winrate`}
              >
                <span className="champion-portrait" aria-hidden="true">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={championAsset(version, champion)} alt="" width={48} height={48} loading="lazy" />
                </span>
                <small className="champion-wr" aria-hidden="true">{shownPercent}%</small>
                {showGames ? <small className="champion-games" aria-hidden="true">{champion.games}p</small> : null}
              </span>
            );
          })}
    </span>
  );
}

/**
 * The ten participants as two rows of five: the player's team above, the enemy
 * team below, one role per column. The cells are 20px on a 3px gutter, the same
 * rhythm as the two text lines beside them, so the first row lands on the result
 * line and the second on the KDA line.
 */
function MatchRoster({ participants, playerId, version, pending = false, live = false }: {
  participants: LastMatchParticipant[];
  playerId: string;
  version: string;
  pending?: boolean;
  live?: boolean;
}) {
  if (pending) {
    return (
      <span className="roster" aria-hidden="true">
        {Array.from({ length: 10 }, (_, index) => <span className="sk-slot" key={`slot-${index}`} />)}
      </span>
    );
  }
  if (participants.length === 0) return null;

  const { allies, enemies } = (live
    ? orderLiveMatchRoster(participants, playerId)
    : orderMatchRoster(participants, playerId));
  const slot = (participant: RosterSlot, side: "ally" | "foe", index: number) => {
    if (!participant) return <span className={`is-${side} is-empty`} key={`${side}-${index}`} />;
    const isSelf = participant.challengePlayerId === playerId;
    const isPeer = participant.challengePlayerId !== null && !isSelf;
    return (
      <span className={`is-${side}${isSelf ? " is-self" : ""}${isPeer ? " is-peer" : ""}`} key={`${side}-${index}`}>
        {/* A champion key Data Dragon could not resolve leaves the frame empty
            rather than requesting an asset that does not exist. */}
        {participant.championId
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={championAsset(version, participant.championId)} alt="" width={20} height={20} loading="lazy" />
          : null}
      </span>
    );
  };

  return (
    <span className="roster" aria-hidden="true">
      {allies.map((participant, index) => slot(participant, "ally", index))}
      {enemies.map((participant, index) => slot(participant, "foe", index))}
    </span>
  );
}

/** Challenge members in the same game, as the "con X" the design puts on line 2. */
function peerLabel(participants: readonly LastMatchParticipant[], playerId: string) {
  const peers = participants.filter((participant) =>
    participant.challengePlayerId && participant.challengePlayerId !== playerId);
  return peers.length > 0 ? `con ${peers.map((peer) => peer.gameName.split(" ")[0]).join(", ")}` : "";
}

/**
 * Recent form. The five slots are structure, not values: they keep the row's
 * rhythm whether the history is empty or still loading, which is why they do not
 * shimmer.
 */
function Streak({ results, label, pending = false }: { results: readonly boolean[]; label?: string; pending?: boolean }) {
  const slots = [...results.slice(-5)];
  const padding = Math.max(0, 5 - slots.length);
  const wins = slots.filter(Boolean).length;
  return (
    <span className="streak">
      {label ? <small className="streak-label">{label}</small> : null}
      <span
        className="streak-dots"
        role={pending ? undefined : "img"}
        aria-hidden={pending ? true : undefined}
        aria-label={pending ? undefined : slots.length === 0 ? "Sin partidas recientes registradas" : `Últimas ${slots.length}: ${wins} victorias`}
      >
        {Array.from({ length: padding }, (_, index) => <i className="is-empty" key={`pad-${index}`} />)}
        {slots.map((won, index) => <i className={won ? "is-win" : undefined} key={`res-${index}`} />)}
      </span>
    </span>
  );
}

function DuoText({ player, pending = false }: { player: PlayerSnapshot; pending?: boolean }) {
  if (pending) return <small className="duo-text"><Bone w={72} h={8} /></small>;
  const duo = player.habitualDuo;
  if (!duo) return null;
  return <small className="duo-text">dúo {duo.gameName.split(" ")[0]} ×{duo.games}</small>;
}

/**
 * Two lines of 20px, never one long one: the result and the LP above, the KDA
 * and the company below. `compact` changes type sizes, not which line a field
 * lives on, so the strip is the same shape in a card, in a row and while it
 * loads.
 */
function MatchSummary({ player, version, compact, pending = false }: {
  player: PlayerSnapshot;
  version: string;
  compact: boolean;
  pending?: boolean;
}) {
  if (pending) {
    return (
      <>
        <span className="match-art sk-slot" aria-hidden="true" />
        <span className="match-body">
          <span className="match-line">
            <span className="match-outcome">
              <Bone w={compact ? 48 : 56} h={10} />
              <Bone w={compact ? 34 : 40} h={9} />
            </span>
            <small className="match-when"><Bone w={74} h={8} /></small>
          </span>
          <span className="match-line">
            <strong className="match-score"><Bone w={compact ? 62 : 68} h={compact ? 13 : 14} /></strong>
            <small className="duo-text"><Bone w={70} h={8} /></small>
          </span>
        </span>
        <MatchRoster participants={[]} playerId={player.id} version={version} pending />
      </>
    );
  }

  const match = player.lastSoloQueueMatch;
  if (!match) return <span className="match-empty">Sin partida SoloQ reciente</span>;

  const matchKda = ((match.kills + match.assists) / Math.max(1, match.deaths)).toFixed(1);
  const stale = isStaleMatch(match.gameStartTimestamp);
  const remake = isRemakeMatch(match);
  const evidence = match.lpChangeEvidence;
  const lpTone = remake ? "is-remake" : evidence.status === "observed" ? (evidence.value < 0 ? "is-negative" : "is-positive") : `is-${evidence.status}`;
  const lpText = remake ? "0 PL" : formattedLeaguePointsChange(evidence);
  // A remake is neither a win nor a loss; Riot's own early-surrender flag says so.
  const outcome = remake ? "is-remake" : match.win ? "is-win" : "is-loss";
  const outcomeText = remake ? "Remake" : match.win ? "Victoria" : "Derrota";

  return (
    <>
      <span className={`match-art ${outcome}`} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={championAsset(version, match.championId)} alt="" width={44} height={44} loading="lazy" />
      </span>
      <span className="match-body">
        <span className="match-line">
          <span className="match-outcome">
            <strong className={`match-result ${outcome}`}>{outcomeText}</strong>
            {lpText ? <span className={`match-lp ${lpTone}`} title={remake ? "La partida terminó como remake y no alteró los PL." : leaguePointsEvidenceTitle(evidence)}>{lpText}</span> : null}
          </span>
          <small className={`match-when${stale ? " is-stale" : ""}`}>hace {formattedMatchAge(match.gameStartTimestamp)}</small>
        </span>
        <span className="match-line">
          <strong className="match-score">
            {match.kills}<i>/</i><span className="deaths">{match.deaths}</span><i>/</i><span className="assists">{match.assists}</span>
            <small className="match-kda">{matchKda}</small>
          </strong>
          <small className="duo-text">{peerLabel(match.participants, player.id)}</small>
        </span>
      </span>
      <MatchRoster participants={match.participants} playerId={player.id} version={version} />
    </>
  );
}

/**
 * Live game. Same slot and same density as the last match: clock, start time,
 * company and the two teams. The champion is already visible in the art slot;
 * the elapsed clock gets the second-line text position instead of repeating it.
 *
 * No lane. Spectator-v5 reports no position, and its participant order is not
 * the draft order either — a live lobby came back with the jungler third and the
 * support last — so any lane here would be invented.
 */
function LiveSummary({ player, version, clockNow }: {
  player: PlayerSnapshot;
  version: string;
  clockNow: number;
}) {
  const live = player.liveGame!;
  const elapsed = Math.max(0, Math.floor((clockNow - live.gameStartedAt) / 1000));
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const started = new Date(live.gameStartedAt - 5 * 60 * 60 * 1_000);
  const startText = `inicio ${String(started.getUTCHours()).padStart(2, "0")}:${String(started.getUTCMinutes()).padStart(2, "0")}`;

  return (
    <>
      <span className="match-art is-live" aria-hidden="true">
        {live.championId
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={championAsset(version, live.championId)} alt="" width={44} height={44} />
          : null}
      </span>
      <span className="match-body">
        <span className="match-line">
          <span className="live-badge">
            <i aria-hidden="true" />
            <strong>IN-GAME</strong>
          </span>
          <small className="match-when">{startText}</small>
        </span>
        <span className="match-line">
          <span className="live-clock"><b role="timer" aria-label={`IN-GAME desde hace ${clock}`}>{clock}</b></span>
          <small className="duo-text">{peerLabel(live.participants, player.id)}</small>
        </span>
      </span>
      <MatchRoster participants={live.participants} playerId={player.id} version={version} live />
    </>
  );
}

/** The respawn overlay: a real clock, on a diffused card, legible at a glance. */
function Respawn({ player, respawnSeconds }: { player: PlayerSnapshot; respawnSeconds: number }) {
  return (
    <span className="respawn" role="timer" aria-label={`${player.gameName} reaparece en ${formatRespawnClock(respawnSeconds)}`}>
      <small>Reaparece en</small>
      <strong>{formatRespawnClock(respawnSeconds)}</strong>
    </span>
  );
}

type RankingItemRef = (playerId: string, element: HTMLElement | null) => void;

type CardProps = {
  player: PlayerSnapshot;
  place: number;
  version: string;
  gap: number | null;
  isLeader: boolean;
  aheadName?: string;
  respawnSeconds: number | null;
  clockNow: number;
  registerRankingItem: RankingItemRef;
  pending?: boolean;
};

/** "12 PL para Papipu" beats an invisible ordering criterion. */
function gapLabel(gap: number | null, isLeader: boolean, aheadName: string | undefined, unranked: boolean) {
  if (unranked) return "sin partidas clasificadas";
  if (isLeader) return "";
  if (gap === null) return "";
  return aheadName ? `${gap} PL para ${aheadName.split(" ")[0]}` : `−${gap} PL`;
}

function PodiumCard({ player, place, version, gap, isLeader, aheadName, respawnSeconds, clockNow, registerRankingItem, pending = false }: CardProps) {
  const bestChampion = pending || !player.riotIdFound ? undefined : selectBestChampions(player.analytics.championCounts)[0];
  const games = player.wins + player.losses;
  const gapText = gapLabel(gap, isLeader, aheadName, player.tier === "UNRANKED");
  const isLive = !pending && Boolean(player.liveGame);
  const matchHref = player.lastSoloQueueMatch
    ? matchDetailsUrl(player.lastSoloQueueMatch.matchId) ?? profileUrl(player)
    : null;
  return (
    <article
      ref={pending ? undefined : (element) => registerRankingItem(player.id, element)}
      data-ranking-id={pending ? undefined : player.id}
      data-disabled={respawnSeconds !== null}
      aria-hidden={pending ? true : undefined}
      className={`podium-card place-${place}${pending ? " is-pending" : ""}${respawnSeconds !== null ? " is-dead" : ""}`}
    >
      {bestChampion ? (
        <span className="podium-splash-frame" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="podium-splash is-aligned" src={championLoadingAsset(bestChampion)} alt="" crossOrigin="anonymous" width={308} height={560} />
        </span>
      ) : null}
      <span className="podium-crest" aria-hidden="true" />
      <span className="podium-notch" aria-hidden="true" />

      <div className="podium-body">
        <header className="podium-header">
          <strong className={`podium-place${pending ? " sk-fixed" : ""}`} aria-label={pending ? undefined : `Puesto ${place}`}>{place}</strong>
          <Linkable pending={pending} className="podium-identity" href={profileUrl(player)} label={`Ver perfil de ${player.gameName} en League of Graphs`}>
            <ProfileIcon player={player} version={version} size={50} className="podium-avatar" pending={pending} />
            <span translate="no">
              {pending
                ? <><Bone w={106} h={13} /><small><Bone w={66} h={8} /></small></>
                : (
                  <>
                    <strong>{player.gameName}<span className="podium-tag">#{player.tagLine}</span></strong>
                    <small><span className="games">{player.analytics.games} partidas</span></small>
                  </>
                )}
            </span>
          </Linkable>
          <Role player={player} pending={pending} />
        </header>

        <div className="podium-rank">
          <RankEmblem player={player} size={104} pending={pending} describe />
          <span>
            <strong className="podium-lp" aria-label={pending ? undefined : `${player.leaguePoints} PL`}>
              {pending ? <Bone w={60} h={32} /> : <span aria-hidden="true">{player.leaguePoints}</span>}
              <span className="lp-unit" aria-hidden="true">PL</span>
            </strong>
            {pending
              ? <Bone w={74} h={10} />
              : <small className={`podium-tier ${tierTextClass(player.tier)}`}>{rankLabel(player)}</small>}
            <span className="gap-slot">
              {pending
                ? <Bone w={118} h={16} />
                : gapText ? <span className="gap-pill">{gapText}</span> : null}
            </span>
          </span>
        </div>

        <div className="podium-performance">
          <span className="stat-pair" role={pending ? undefined : "group"} aria-label={pending ? undefined : `Winrate: ${player.winRate.toFixed(1)}%, ${player.wins} victorias, ${player.losses} derrotas`}>
            {pending
              ? <><Bone w={54} h={16} /><small><Bone w={62} h={8} /></small></>
              : (
                <>
                  <strong>{player.winRate.toFixed(1)}%</strong>
                  <small><span className="wins">{player.wins}V</span> · <span className="losses">{player.losses}D</span></small>
                </>
              )}
          </span>
          <span className="stat-pair is-end" role={pending ? undefined : "group"} aria-label={pending ? undefined : `KDA: ${player.analytics.kda.toFixed(1)} sobre ${player.analytics.games} partidas analizadas`}>
            {pending ? <Bone w={32} h={16} /> : <strong>{player.analytics.kda.toFixed(1)}</strong>}
            <small className="kda-label">KDA</small>
          </span>
          <span className="wr-bar" role={pending ? undefined : "img"} aria-hidden={pending ? true : undefined} aria-label={pending ? undefined : `Proporción: ${player.wins} victorias, ${player.losses} derrotas`}>
            <i style={{ width: `${games > 0 ? Math.max(2, player.winRate) : 0}%` }} />
          </span>
          <span className="podium-form">
            <Streak results={player.recentResults ?? []} label="Últimas 5" pending={pending} />
            <DuoText player={player} pending={pending} />
          </span>
        </div>

        <ChampionBand player={player} version={version} slots={PODIUM_CHAMPION_SLOTS} className="podium-champions champions" showGames pending={pending} />
      </div>

      {isLive ? (
        <div className="podium-strip is-live">
          <span className="match-row">
            <LiveSummary player={player} version={version} clockNow={clockNow} />
          </span>
        </div>
      ) : (
        <div className="podium-strip">
          <Linkable pending={pending} className="match-row" href={matchHref} label={`Abrir detalles de la última SoloQ de ${player.gameName}`}>
            <MatchSummary player={player} version={version} compact={false} pending={pending} />
          </Linkable>
        </div>
      )}

      {respawnSeconds !== null ? <Respawn player={player} respawnSeconds={respawnSeconds} /> : null}
    </article>
  );
}

function LeaderboardRow({ player, place, version, gap, isLeader, aheadName, respawnSeconds, clockNow, registerRankingItem, pending = false }: CardProps) {
  const unranked = player.tier === "UNRANKED";
  const games = player.wins + player.losses;
  const gapText = gapLabel(gap, isLeader, aheadName, unranked);
  const delta = player.placeDelta ?? 0;
  const deltaText = delta > 0 ? `▲${delta}` : delta < 0 ? `▼${Math.abs(delta)}` : "—";
  const isLive = Boolean(player.liveGame);
  // A month-old match gets a quieter panel than one from an hour ago.
  const matchIsStale = !pending && Boolean(player.lastSoloQueueMatch) &&
    isStaleMatch(player.lastSoloQueueMatch!.gameStartTimestamp);
  const matchHref = player.lastSoloQueueMatch
    ? matchDetailsUrl(player.lastSoloQueueMatch.matchId) ?? profileUrl(player)
    : null;
  return (
    <li
      ref={pending ? undefined : (element) => registerRankingItem(player.id, element)}
      data-ranking-id={pending ? undefined : player.id}
      data-disabled={respawnSeconds !== null}
      aria-hidden={pending ? true : undefined}
      className={`leaderboard-row${unranked && !pending ? " is-unranked" : ""}${pending ? " is-pending" : ""}${respawnSeconds !== null ? " is-dead" : ""}`}
    >
      <div className="row-grid">
        <span className="row-place" data-label="Puesto">
          <strong className={pending ? "sk-fixed" : undefined}>{place}</strong>
          {pending
            ? <small className="row-delta"><Bone w={18} h={8} /></small>
            : (
              <small
                className={`row-delta${delta > 0 ? " is-up" : delta < 0 ? " is-down" : ""}`}
                aria-label={delta === 0 ? "Sin cambio de puesto" : delta > 0 ? `Sube ${delta} puestos` : `Baja ${Math.abs(delta)} puestos`}
              >{deltaText}</small>
            )}
        </span>

        <Linkable pending={pending} className="row-player" href={profileUrl(player)} label={`Ver perfil de ${player.gameName} en League of Graphs`}>
          <ProfileIcon player={player} version={version} size={46} pending={pending} lazy />
          <span translate="no">
            {pending
              ? <><Bone w={102} h={12} /><small className="handle"><Bone w={84} h={8} /></small><DuoText player={player} pending /></>
              : (
                <>
                  <strong>{player.gameName}</strong>
                  <small className="handle">#{player.tagLine} · {player.analytics.games}p</small>
                  <DuoText player={player} />
                </>
              )}
          </span>
        </Linkable>

        <span className="row-rank" data-label="Rango">
          <RankEmblem player={player} size={46} pending={pending} lazy />
          <span>
            {pending
              ? <><Bone w={70} h={10} /><small className="lp"><Bone w={32} h={13} /><i>PL</i></small><Bone w={86} h={8} /></>
              : (
                <>
                  <strong className={`tier ${tierTextClass(player.tier)}`}>{rankLabel(player)}</strong>
                  <small className="lp">{player.leaguePoints}<i>PL</i></small>
                  {gapText ? <small className="gap-text">{gapText}</small> : null}
                </>
              )}
          </span>
        </span>

        <span className="row-performance" data-label="Rendimiento">
          <span className="perf-head">
            <span className="stat-pair" role={pending ? undefined : "group"} aria-label={pending ? undefined : `Winrate: ${player.riotIdFound ? `${player.winRate.toFixed(1)}%` : "sin estadísticas"}`}>
              {pending
                ? <Bone w={50} h={15} />
                : <strong>{player.riotIdFound ? `${player.winRate.toFixed(1)}%` : "sin dato"}</strong>}
            </span>
            <span className="stat-pair is-end" role={pending ? undefined : "group"} aria-label={pending ? undefined : `KDA: ${player.riotIdFound ? `${player.analytics.kda.toFixed(1)} sobre ${player.analytics.games} partidas analizadas` : "sin historial"}`}>
              {pending
                ? <Bone w={30} h={15} />
                : <strong>{player.riotIdFound ? player.analytics.kda.toFixed(1) : "sin dato"}</strong>}
              <small className="kda-label">KDA</small>
            </span>
          </span>
          <span className="wr-bar" role={pending ? undefined : "img"} aria-hidden={pending ? true : undefined} aria-label={pending ? undefined : `Proporción: ${player.wins} victorias, ${player.losses} derrotas`}>
            <i style={{ width: `${games > 0 ? Math.max(2, player.winRate) : 0}%` }} />
          </span>
          {/* The record moves next to the form dots: the row reads
              "últimas cinco, y así va el total" on one line. */}
          <span className="perf-foot">
            <Streak results={player.recentResults ?? []} pending={pending} />
            {pending
              ? <small className="record"><Bone w={58} h={8} /></small>
              : <small className="record"><span className="wins">{player.wins}V</span> · <span className="losses">{player.losses}D</span></small>}
          </span>
        </span>

        <span className="row-role" data-label="Rol"><Role player={player} pending={pending} /></span>

        <ChampionBand player={player} version={version} slots={ROW_CHAMPION_SLOTS} className="row-champions champions" label="Mejores campeones" pending={pending} />

        {isLive ? (
          <span className="row-live">
            <LiveSummary player={player} version={version} clockNow={clockNow} />
          </span>
        ) : (
          <Linkable pending={pending} className={`row-match${matchIsStale ? " is-stale" : ""}`} dataLabel="Partida" href={matchHref} label={`Abrir detalles de la última SoloQ de ${player.gameName}`}>
            <MatchSummary player={player} version={version} compact pending={pending} />
          </Linkable>
        )}
      </div>

      {respawnSeconds !== null ? <Respawn player={player} respawnSeconds={respawnSeconds} /> : null}
    </li>
  );
}

let helicopterPlayed = false;

/**
 * The rotor that arrives with Los Juegos: brown noise chopped by an LFO at
 * blade frequency over a low body tone, panned slowly across the stereo field.
 * Synthesised rather than shipped, because seven seconds of audio is a bigger
 * download than the whole ranking.
 *
 * Once per page load, and only ever from the click that opens the card — which
 * is also what lets the context start at all. Anything unsupported, refused or
 * broken leaves the view exactly as it was.
 */
function playHelicopter() {
  if (helicopterPlayed) return;
  helicopterPlayed = true;
  try {
    const AudioContextConstructor = window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;

    const context = new AudioContextConstructor();
    const duration = 7.5;
    const now = context.currentTime;

    const master = context.createGain();
    master.gain.setValueAtTime(0, now);
    master.gain.linearRampToValueAtTime(.05, now + 1.4);
    master.gain.setValueAtTime(.05, now + 4.6);
    master.gain.linearRampToValueAtTime(0, now + duration);

    const sampleCount = Math.floor(context.sampleRate * duration);
    const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const samples = buffer.getChannelData(0);
    let previous = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      const white = Math.random() * 2 - 1;
      previous = (previous + .02 * white) / 1.02;
      samples[index] = previous * 3.5;
    }

    const noise = context.createBufferSource();
    noise.buffer = buffer;
    const lowpass = context.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 300;
    lowpass.Q.value = .7;

    const chop = context.createGain();
    chop.gain.value = .55;
    const bladeRate = context.createOscillator();
    bladeRate.frequency.setValueAtTime(11.2, now);
    bladeRate.frequency.linearRampToValueAtTime(13.4, now + duration);
    const bladeDepth = context.createGain();
    bladeDepth.gain.value = .45;
    bladeRate.connect(bladeDepth);
    bladeDepth.connect(chop.gain);

    // The body shares the chop, so the hum pulses with the blades.
    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.value = 52;
    const bodyGain = context.createGain();
    bodyGain.gain.value = .32;

    if (typeof context.createStereoPanner === "function") {
      const panner = context.createStereoPanner();
      const panRate = context.createOscillator();
      panRate.frequency.value = .16;
      const panDepth = context.createGain();
      panDepth.gain.value = .55;
      panRate.connect(panDepth);
      panDepth.connect(panner.pan);
      master.connect(panner);
      panner.connect(context.destination);
      panRate.start(now);
      panRate.stop(now + duration);
    } else {
      master.connect(context.destination);
    }

    noise.connect(lowpass);
    lowpass.connect(chop);
    chop.connect(master);
    body.connect(bodyGain);
    bodyGain.connect(chop);

    noise.start(now);
    bladeRate.start(now);
    body.start(now);
    noise.stop(now + duration);
    bladeRate.stop(now + duration);
    body.stop(now + duration);
    window.setTimeout(() => { void context.close().catch(() => undefined); }, (duration + .4) * 1_000);
  } catch {
    // No audio is not a failure state: the card opens either way.
  }
}

/**
 * One line of the duo table. Nothing here is stored: the pair is two ids, and
 * every name, crest and icon is read off the players the ranking already has.
 */
function DuoRow({ duo, players, version, place }: {
  duo: DuoRecord;
  players: readonly PlayerSnapshot[];
  version: string;
  place: number;
}) {
  const [first, second] = duo.playerIds.map((id) => players.find((player) => player.id === id));
  if (!first || !second) return null;
  const losses = duo.games - duo.wins;
  const winRate = duo.games > 0 ? (duo.wins / duo.games) * 100 : 0;
  const names = `${firstName(first)} + ${firstName(second)}`;
  return (
    <li className={`duo-row${place === 1 ? " is-top" : ""}`}>
      <div className="duo-grid">
        <span className="duo-place"><strong>{place}</strong></span>
        <span className="duo-pair">
          <span className="duo-avatars" aria-hidden="true">
            {[first, second].map((player) => (
              player.profileIconId > 0
                /* eslint-disable-next-line @next/next/no-img-element */
                ? <img key={player.id} src={profileAsset(version, player.profileIconId)} alt="" width={38} height={38} loading="lazy" />
                /* eslint-disable-next-line @next/next/no-img-element */
                : <img key={player.id} src="/brand-logo.webp" alt="" width={38} height={38} loading="lazy" />
            ))}
          </span>
          <span translate="no">
            <strong>{names}</strong>
            <small>{rankLabel(first)} · {rankLabel(second)}</small>
          </span>
        </span>
        <span className="duo-games" data-label="Partidas"><strong>{duo.games}</strong></span>
        <span className="duo-wr" data-label="Winrate juntos">
          <span className="duo-wr-head">
            <strong>{winRate.toFixed(1)}%</strong>
            <small className="record"><span className="wins">{duo.wins}V</span> · <span className="losses">{losses}D</span></small>
          </span>
          <span className="wr-bar" role="img" aria-label={`${names}: ${duo.wins} victorias, ${losses} derrotas juntos`}>
            <i style={{ width: `${Math.max(2, winRate)}%` }} />
          </span>
        </span>
        <span className="duo-score" data-label="Ponderado"><strong>{(duo.score * 100).toFixed(1)}</strong><small>puntaje</small></span>
      </div>
    </li>
  );
}

/**
 * The tournament title card. On its first opening of a page load every letter
 * animates on its own delay, so the name assembles rather than fading in as a
 * block. After that the reveal has been seen: `seen` opens the card as a place
 * rather than as an entrance — one fade for everything at once, and the title
 * steps back from hero to a header at the top edge.
 */
function GaspiOverlay({ onClose, particles, seen }: {
  onClose: () => void;
  particles: readonly CSSProperties[];
  seen: boolean;
}) {
  let letterIndex = 0;
  return (
    <div className={`gaspi${seen ? " is-seen" : ""}`} role="dialog" aria-modal="true" aria-label={GASPI_TITLE}>
      <div className="gaspi-bg" aria-hidden="true" />
      <div className="gaspi-particles" aria-hidden="true">
        {particles.map((style, index) => <i key={index} style={style} />)}
      </div>
      <button type="button" className="gaspi-back" onClick={onClose}>← Volver al ranking</button>
      <div className="gaspi-stage">
        <small className="gaspi-kicker">20Q Challenge</small>
        <span className="gaspi-beam is-top" aria-hidden="true" />
        <h2 className="gaspi-title">
          <span className="sr-only">{GASPI_TITLE}</span>
          {GASPI_LINES.map((line) => (
            <span className="gaspi-line" key={line} aria-hidden="true">
              {[...line].map((character, index) => (
                <span
                  className="gaspi-letter"
                  key={`${line}-${index}`}
                  style={seen ? undefined : { animationDelay: `${GASPI_LETTER_START_MS + letterIndex++ * GASPI_LETTER_STEP_MS}ms` }}
                >{character === " " ? "\u00a0" : character}</span>
              ))}
            </span>
          ))}
        </h2>
        <span className="gaspi-beam is-bottom" aria-hidden="true" />
        <small className="gaspi-sub">Torneo 1v1 · S2026</small>
        <div className="gaspi-hall">
          <small className="gaspi-hall-label">Sala de la fama</small>
          <article className="gaspi-edition">
            <strong className="gaspi-edition-name">Edición I</strong>
            <span className="gaspi-slot" aria-hidden="true">?</span>
          </article>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [payload, setPayload] = useState(initialPayload);
  const [hasLiveData, setHasLiveData] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [hydratedFromCache, setHydratedFromCache] = useState(false);
  const [isHeaderScrolled, setIsHeaderScrolled] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [gaspiOpen, setGaspiOpen] = useState(false);
  const [gaspiSeen, setGaspiSeen] = useState(false);
  const hasCachedData = useRef(false);
  const renderedFetchedAt = useRef<string | null>(null);
  const reloadBoard = useRef<() => void>(() => undefined);
  const renderedOrder = useRef<string | null>(null);
  const invasionTimer = useRef(0);
  const gaspiRevealSpent = useRef(false);
  const scrollSentinel = useRef<HTMLSpanElement | null>(null);
  const rankingNodes = useRef(new Map<string, HTMLElement>());
  const rankingPositions = useRef(new Map<string, DOMRectReadOnly>());
  const rankingAnimations = useRef(new Map<string, Animation>());
  const rankingFallbackCleanups = useRef(new Map<string, () => void>());
  const players = payload.data.players;
  // Nobody is held out of the standings any more. The board used to keep its
  // target beside the ranking rather than in it, which meant the place a player
  // held and the arrow beside it were counted over different lists; one list
  // makes both true at once.
  const visiblePlayers = sortLeaderboard(players);
  const topThree = visiblePlayers.slice(0, 3);
  const remaining = visiblePlayers.slice(3);
  const leaderLead = leaderAdvantage(visiblePlayers);
  const liveCount = visiblePlayers.filter((player) => player.liveGame).length;
  const duos = payload.data.duos ?? [];
  const cardPropsFor = (player: PlayerSnapshot, index: number) => ({
    gap: index === 0 ? leaderLead : leaguePointsGap(visiblePlayers, index),
    isLeader: index === 0,
    aheadName: visiblePlayers[index - 1]?.gameName,
  });
  const papipuSeconds = papipuRespawnSeconds(clockNow);
  const respawnFor = (player: PlayerSnapshot) => player.gameName.toLocaleLowerCase("es-PE") === "papipu" ? papipuSeconds : null;

  const registerRankingItem = useCallback<RankingItemRef>((playerId, element) => {
    if (element) rankingNodes.current.set(playerId, element);
    else rankingNodes.current.delete(playerId);
  }, []);
  const syncRankingNodes = useCallback(() => {
    const nodes = new Map<string, HTMLElement>();
    document.querySelectorAll<HTMLElement>("[data-ranking-id]").forEach((element) => {
      const playerId = element.dataset.rankingId;
      if (playerId) nodes.set(playerId, element);
    });
    rankingNodes.current = nodes;
    return nodes;
  }, []);
  const captureRankingPositions = useCallback(() => {
    const positions = new Map<string, DOMRectReadOnly>();
    syncRankingNodes().forEach((element, playerId) => positions.set(playerId, element.getBoundingClientRect()));
    rankingPositions.current = positions;
  }, [syncRankingNodes]);

  useLayoutEffect(() => {
    if (rankingPositions.current.size === 0) return;
    const previousPositions = rankingPositions.current;
    rankingPositions.current = new Map();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const scheduleFrame = (callback: () => void) => typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(callback) : window.setTimeout(callback, 0);
    const cancelFrame = (frame: number) => {
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
      else window.clearTimeout(frame);
    };

    type Frame = { opacity?: number; transform?: string };
    const animateWithFallback = (playerId: string, element: HTMLElement, keyframes: Frame[], duration: number) => {
      rankingFallbackCleanups.current.get(playerId)?.();
      const from = keyframes[0];
      const to = keyframes[keyframes.length - 1];
      element.style.transition = "none";
      if (from.transform !== undefined) element.style.transform = from.transform;
      if (from.opacity !== undefined) element.style.opacity = String(from.opacity);

      let frame = 0;
      let timer = 0;
      const cleanup = () => {
        cancelFrame(frame);
        window.clearTimeout(timer);
        element.style.transition = "";
        element.style.transform = "";
        element.style.opacity = "";
        if (rankingFallbackCleanups.current.get(playerId) === cleanup) rankingFallbackCleanups.current.delete(playerId);
      };
      rankingFallbackCleanups.current.set(playerId, cleanup);
      frame = scheduleFrame(() => {
        element.style.transition = `transform ${duration}ms var(--ease-rank), opacity ${duration}ms var(--ease-rank)`;
        if (to.transform !== undefined) element.style.transform = to.transform;
        if (to.opacity !== undefined) element.style.opacity = String(to.opacity);
      });
      timer = window.setTimeout(cleanup, duration + 80);
    };

    const play = (playerId: string, element: HTMLElement, keyframes: Frame[], duration: number) => {
      if (typeof element.animate !== "function") {
        animateWithFallback(playerId, element, keyframes, duration);
        return;
      }
      // `backwards`, not `both`: the last keyframe is already the element's natural
      // state, and a forwards fill keeps overriding author declarations for as
      // long as it lives — including the hover lift and the dimmed respawn card.
      // The cancel below is hygiene for an in-flight animation, not the thing
      // that hands the element back to CSS.
      const animation = element.animate(keyframes, { duration, easing: "cubic-bezier(.22, 1, .28, 1)", fill: "backwards" });
      rankingAnimations.current.set(playerId, animation);
      void animation.finished.then(() => {
        if (rankingAnimations.current.get(playerId) === animation) {
          animation.cancel();
          rankingAnimations.current.delete(playerId);
        }
      }).catch(() => undefined);
    };

    syncRankingNodes().forEach((element, playerId) => {
      rankingAnimations.current.get(playerId)?.cancel();
      rankingAnimations.current.delete(playerId);
      rankingFallbackCleanups.current.get(playerId)?.();
      const isRow = element.classList.contains("leaderboard-row");
      const next = element.getBoundingClientRect();
      const previous = previousPositions.get(playerId);

      if (!previous) {
        // Arriving from off screen. The podium reflows sideways and the list
        // reflows downwards, so each slides along the axis its own container
        // moves — no scaling, which reads as the card wobbling into place.
        play(playerId, element, [
          { opacity: 0, transform: isRow ? "translate3d(0, -18px, 0)" : "translate3d(-32px, 0, 0)" },
          { opacity: 1, transform: "translate3d(0, 0, 0)" },
        ], isRow ? 380 : 460);
        return;
      }

      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      // A player crossing the podium boundary swaps a card for a row, so that
      // element changes shape between the two frames.
      // Scaling the new element from the old one's dimensions squashes its
      // contents the whole way across; it travels centre to centre at its own
      // size instead, and a short fade carries the change of shape.
      const changedForm = Math.abs(previous.height - next.height) > 24 || Math.abs(previous.width - next.width) > 24;
      if (!changedForm && Math.abs(deltaX) < .5 && Math.abs(deltaY) < .5) return;

      if (changedForm) {
        const centreX = (previous.left + previous.width / 2) - (next.left + next.width / 2);
        const centreY = (previous.top + previous.height / 2) - (next.top + next.height / 2);
        play(playerId, element, [
          { opacity: .35, transform: `translate3d(${centreX.toFixed(2)}px, ${centreY.toFixed(2)}px, 0)` },
          { opacity: 1, transform: "translate3d(0, 0, 0)" },
        ], 520);
        return;
      }

      play(playerId, element, [
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
        { transform: "translate3d(0, 0, 0)" },
      ], isRow ? 360 : 480);
    });
  }, [hasLiveData, payload.data.fetchedAt, syncRankingNodes]);

  // A live game's elapsed clock is drawn from `clockNow`, so it only advances
  // while this ticks. Tying the per-second beat to `papipuSeconds` alone meant
  // that outside that countdown's window the clock was rescheduled for 4am the
  // next day — and anyone actually in a game watched a frozen timer for hours.
  const needsSecondTicks = papipuSeconds !== null || liveCount > 0;

  useEffect(() => {
    if (!needsSecondTicks) {
      const peruTime = new Date(clockNow - 5 * 60 * 60 * 1000);
      const nextStart = Date.UTC(peruTime.getUTCFullYear(), peruTime.getUTCMonth(), peruTime.getUTCDate() + 1, 4);
      const timer = window.setTimeout(() => setClockNow(Date.now()), Math.max(1_000, nextStart - clockNow));
      return () => window.clearTimeout(timer);
    }

    const timer = window.setTimeout(() => setClockNow(Date.now()), 1_000 - (clockNow % 1_000));
    return () => window.clearTimeout(timer);
  }, [clockNow, needsSecondTicks]);

  // Which box scrolls is not always the document, and whenever it was not, the
  // header never took its contrast wash: `scrollY` stayed at zero while the
  // page moved. Both answers to that question run, because each covers a case
  // the other misses — a sentinel does not care who scrolls, and a listener
  // does not care whether observations are being delivered. They flip at the
  // same nine pixels, so agreeing costs nothing and either one alone is a
  // header that silently stops taking its background.
  useEffect(() => {
    const readScroll = () => Math.max(
      window.scrollY || 0,
      document.scrollingElement?.scrollTop || 0,
      document.documentElement.scrollTop || 0,
      document.body.scrollTop || 0,
    );
    const handleScroll = () => setIsHeaderScrolled(readScroll() > 8);
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true, capture: true });

    const sentinel = scrollSentinel.current;
    const observer = sentinel && typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          ([entry]) => setIsHeaderScrolled(!entry.isIntersecting || readScroll() > 8),
          { rootMargin: "-9px 0px 0px 0px", threshold: 0 },
        )
      : null;
    observer?.observe(sentinel!);

    return () => {
      window.removeEventListener("scroll", handleScroll, { capture: true });
      observer?.disconnect();
    };
  }, []);

  // While the card is up nothing behind it may scroll. `<html>` is the
  // scrolling element, not `<body>`: locking only the body left the document
  // itself scrollable underneath the fixed overlay, so the ranking's own
  // scroll range leaked through as empty space above and below the card.
  useEffect(() => {
    if (!gaspiOpen) return;
    const root = document.documentElement;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;
    const previousPadding = root.style.paddingRight;
    // On a desktop with classic scrollbars, taking scrolling away takes the
    // scrollbar with it and everything underneath jumps sideways by its width.
    // Measured rather than assumed, because overlay scrollbars measure zero and
    // must not be compensated for. `scrollbar-gutter` cannot do this: it only
    // reserves the gutter while the element is still a scroll container, which
    // is exactly what the line below stops it being.
    const gutter = window.innerWidth - root.clientWidth;
    root.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    if (gutter > 0) root.style.paddingRight = `${gutter}px`;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGaspiOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      root.style.overflow = previousRootOverflow;
      document.body.style.overflow = previousBodyOverflow;
      root.style.paddingRight = previousPadding;
    };
  }, [gaspiOpen]);

  // The invasion is not an overlay painted over the ranking: it mutates the
  // palette the ranking is drawn from, and it outlives the card that started
  // it. Coming back from Los Juegos, the board stays gold — that is what makes
  // it an invasion rather than a skin on one screen. It waits for the card's
  // own fade to have covered the board, so the swap is never seen happening,
  // and the timer is deliberately not cancelled on close: a visitor who leaves
  // within that half second has still been through it.
  useEffect(() => {
    if (!gaspiOpen) return;
    invasionTimer.current = window.setTimeout(
      () => document.documentElement.classList.add("is-invaded"),
      GASPI_INVASION_DELAY_MS,
    );
  }, [gaspiOpen]);

  useEffect(() => () => {
    window.clearTimeout(invasionTimer.current);
    document.documentElement.classList.remove("is-invaded");
  }, []);

  // Spent once per page load, like the helicopter: a reveal that replays on
  // every visit stops being a reveal and starts being a wait.
  const openGaspi = useCallback(() => {
    playHelicopter();
    setGaspiSeen(gaspiRevealSpent.current);
    gaspiRevealSpent.current = true;
    setGaspiOpen(true);
  }, []);

  // The tab title belongs to whichever view is on top, so a tab-away that
  // returns to the tournament card comes back to its name and not the board's.
  const homeTitle = useCallback(() => gaspiOpen ? GASPI_TITLE : "20Q Challenge", [gaspiOpen]);

  useEffect(() => {
    document.title = homeTitle();
  }, [homeTitle]);

  useEffect(() => {
    let isAway = false;
    // Drawn without replacement: a uniform pick repeated titles long before it
    // had shown them all, so the bag empties before it is refilled and a whole
    // session's worth of tab-aways works through the list instead.
    let bag: string[] = [];
    let pending: string | null = null;
    const nextTitle = () => {
      if (pending !== null) {
        const followUp = pending;
        pending = null;
        return followUp;
      }
      if (bag.length === 0) bag = [...awayTabTitles];
      const index = Math.floor(Math.random() * bag.length);
      const title = bag.splice(index, 1)[0]!;
      pending = awayTabFollowUps[title] ?? null;
      return title;
    };
    // Set once and left alone. Animating it is not possible in any way worth
    // having: browsers clamp timers in a hidden tab — which is the only state
    // this runs in — to about one tick a second, and to one a minute once the
    // tab has been away five minutes. Every speed tried here ran at the same
    // throttled rate, so a long title reads as a slideshow or not at all.
    const markAway = () => {
      if (isAway) return;
      isAway = true;
      document.title = nextTitle();
    };
    const restoreTitle = () => {
      if (!isAway) return;
      isAway = false;
      document.title = homeTitle();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") markAway();
      else restoreTitle();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", markAway);
    window.addEventListener("focus", restoreTitle);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", markAway);
      window.removeEventListener("focus", restoreTitle);
    };
  }, [homeTitle]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let hydrateFrame = 0;
    let refreshTimer = 0;
    let refreshFrame = 0;
    let pollTimer = 0;
    let loadInFlight = false;

    try {
      const storedPayload = parseLeaderboardPayload(JSON.parse(window.localStorage.getItem(LEADERBOARD_STORAGE_KEY) ?? "null"));
      if (storedPayload) {
        hasCachedData.current = true;
        renderedFetchedAt.current = storedPayload.data.fetchedAt;
        renderedOrder.current = sortLeaderboard(storedPayload.data.players).map((player) => player.id).join(",");
        hydrateFrame = window.requestAnimationFrame(() => {
          if (!active) return;
          setHydratedFromCache(true);
          setPayload(storedPayload);
          setHasLiveData(true);
        });
      }
    } catch {
      // Ignore malformed or unavailable browser storage and use the skeleton.
    }

    async function loadLeaderboard() {
      if (loadInFlight) return;
      loadInFlight = true;
      try {
        const response = await fetch("/api/leaderboard", {
          cache: "no-store",
          headers: { Accept: "application/json", "Cache-Control": "no-cache" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Leaderboard request failed.");
        const nextPayload = parseLeaderboardPayload(await response.json());
        if (!nextPayload) throw new Error("Leaderboard response was invalid.");
        if (active) {
          window.cancelAnimationFrame(hydrateFrame);
          hydrateFrame = 0;
          const shouldAnimateRefresh = hasCachedData.current && renderedFetchedAt.current !== nextPayload.data.fetchedAt;
          renderedFetchedAt.current = nextPayload.data.fetchedAt;
          // A refresh that reorders the board is the thing the arrows in the
          // place column describe, so the cards travel to their new positions
          // rather than snapping there. Measured before React commits, which
          // is the whole point of a FLIP; nothing is captured when the order
          // held, and the layout effect then has nothing to play.
          const nextOrder = sortLeaderboard(nextPayload.data.players).map((player) => player.id).join(",");
          if (renderedOrder.current !== null && renderedOrder.current !== nextOrder) captureRankingPositions();
          renderedOrder.current = nextOrder;
          hasCachedData.current = true;
          setPayload(nextPayload);
          setHasLiveData(true);
          setLoadError(false);
          try {
            window.localStorage.setItem(LEADERBOARD_STORAGE_KEY, JSON.stringify(nextPayload));
          } catch {
            // Live data remains usable when storage is unavailable or full.
          }
          if (shouldAnimateRefresh) {
            refreshFrame = window.requestAnimationFrame(() => {
              if (!active) return;
              setIsRefreshing(true);
              refreshTimer = window.setTimeout(() => setIsRefreshing(false), 520);
            });
          }
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (active && !hasCachedData.current) setLoadError(true);
      } finally {
        loadInFlight = false;
      }
    }

    reloadBoard.current = () => { void loadLeaderboard(); };
    void loadLeaderboard();
    pollTimer = window.setInterval(() => {
      void loadLeaderboard();
    }, LEADERBOARD_REFRESH_MS);

    return () => {
      active = false;
      reloadBoard.current = () => undefined;
      controller.abort();
      window.cancelAnimationFrame(hydrateFrame);
      window.cancelAnimationFrame(refreshFrame);
      window.clearTimeout(refreshTimer);
      window.clearInterval(pollTimer);
    };
  }, [captureRankingPositions]);

  const pendingCardProps = { gap: null, isLeader: false, aheadName: undefined, respawnSeconds: null, clockNow, registerRankingItem, pending: true as const };
  // Deterministic rather than random: the field has to look scattered, not be
  // scattered, and a stable one survives a re-render without twitching.
  const gaspiParticles: CSSProperties[] = Array.from({ length: GASPI_PARTICLE_COUNT }, (_, index) => ({
    left: `${(index * 53 + 7) % 100}%`,
    width: `${2 + index % 3}px`,
    height: `${2 + index % 3}px`,
    animationDuration: `${6 + (index % 5) * 1.3}s`,
    animationDelay: `${((index * .7) % 5).toFixed(1)}s`,
  }));

  return (
    <main className={`app-shell${isRefreshing ? " is-refreshing" : ""}`}>
      <span className="scroll-sentinel" aria-hidden="true" ref={scrollSentinel} />
      <a className="skip-link" href="#clasificacion">Ir al ranking</a>
      <header className={`site-header${isHeaderScrolled ? " is-scrolled" : ""}`}>
        <button type="button" className="brand" onClick={() => reloadBoard.current()} aria-label="Actualizar el marcador" title="Actualizar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/brand-logo.webp" alt="" width={34} height={34} />
          <span>
            <strong><span className="brand-mark">20Q</span> Challenge</strong>
            <small>LAS · Solo/Duo · S2026</small>
          </span>
        </button>
        <div className="header-stats" aria-label="Contexto del ranking">
          <span>{visiblePlayers.length} jugadores</span>
          <span className={liveCount > 0 ? "is-live" : undefined}>
            {liveCount > 0 ? <i className="live-dot" aria-hidden="true" /> : null}
            {liveCount} IN-GAME
          </span>
          <span>{hasLiveData ? `act. ${formattedUpdate(payload.data.fetchedAt).split(", ")[1]}` : "cargando"}</span>
        </div>
        <button type="button" className="gaspi-card" onClick={openGaspi} aria-label={`Abrir ${GASPI_TITLE}`}>
          <span className="gaspi-card-label">Torneo</span>
          <span className="gaspi-card-body">
            <strong>Los Juegos de Gaspi</strong>
            <small>Edición I</small>
          </span>
          <span className="gaspi-card-arrow" aria-hidden="true">→</span>
        </button>
      </header>

      {loadError ? <p className="status-notice" role="alert">No se pudo contactar con Riot. Reintenta recargando la página.</p> : null}
      {payload.meta.notice ? <p className="status-notice" role="status">{payload.meta.notice}</p> : null}

      <section className={`leaderboard-panel${!hasLiveData && !loadError ? " is-loading" : ""}${hydratedFromCache ? " is-cached" : ""}`} id="clasificacion" aria-labelledby="leaderboard-title" aria-busy={!hasLiveData && !loadError}>
        <h1 className="sr-only" id="leaderboard-title">20Q Challenge</h1>

        {!loadError || hasLiveData ? (
          <>
        <section className="podium" aria-labelledby="podio-title">
          <h2 className="sr-only" id="podio-title">Top 3 del ranking</h2>
          {hasLiveData
            ? topThree.map((player, index) => (
                <PodiumCard key={player.id} player={player} place={index + 1} version={payload.data.dataDragonVersion} respawnSeconds={respawnFor(player)} clockNow={clockNow} registerRankingItem={registerRankingItem} {...cardPropsFor(player, index)} />
              ))
            : [1, 2, 3].map((place) => (
                <PodiumCard key={`pending-${place}`} player={PENDING_PLAYER} place={place} version={payload.data.dataDragonVersion} {...pendingCardProps} />
              ))
          }
        </section>

        <div className="table-heading" aria-hidden="true">
          <span>#</span><span>Jugador</span><span>Rango</span><span>Rendimiento</span>
          <span className="center">Rol</span><span>Campeones</span>
          <span className="indent">Partida</span>
        </div>
        <h2 className="sr-only" id="resto-title">Resto de la clasificación</h2>
        <ol className="leaderboard-list" start={4} aria-labelledby="resto-title">
          {hasLiveData
            ? remaining.map((player, index) => (
                <LeaderboardRow key={player.id} player={player} place={index + 4} version={payload.data.dataDragonVersion} respawnSeconds={respawnFor(player)} clockNow={clockNow} registerRankingItem={registerRankingItem} {...cardPropsFor(player, index + 3)} />
              ))
            : [4, 5, 6, 7].map((place) => (
                <LeaderboardRow key={`pending-${place}`} player={PENDING_PLAYER} place={place} version={payload.data.dataDragonVersion} {...pendingCardProps} />
              ))
          }
        </ol>
          </>
        ) : null}
      </section>

      {hasLiveData && duos.length > 0 ? (
        <>
          <hr className="section-divider" />
          <section className="duo-panel" id="duos" aria-labelledby="duos-title">
            <h2 className="sr-only" id="duos-title">Mejores dúos</h2>
            <div className="duo-heading" aria-hidden="true">
              <span>#</span><span>Dúo</span><span>Partidas</span><span>Winrate</span><span>Ponderado</span>
            </div>
            <ol className="duo-list">
              {duos.map((duo, index) => (
                <DuoRow
                  key={duo.playerIds.join("-")}
                  duo={duo}
                  players={players}
                  version={payload.data.dataDragonVersion}
                  place={index + 1}
                />
              ))}
            </ol>
            <div className="panel-footnote">
              <span>Puntaje: límite inferior de Wilson (99%) sobre el winrate del dúo — el mismo criterio que ordena los campeones</span>
              <span>Mínimo {DUO_LEADERBOARD_MIN_GAMES} partidas juntos · parejas por debajo no listadas</span>
            </div>
          </section>
        </>
      ) : null}

      <footer>
        <span>El marcador se actualiza automáticamente aproximadamente cada minuto · <a href="/privacy">Privacidad</a> · <a href="/terms">Términos</a></span>
        <span lang="en">20Q Challenge is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.</span>
      </footer>

      {gaspiOpen ? <GaspiOverlay onClose={() => setGaspiOpen(false)} particles={gaspiParticles} seen={gaspiSeen} /> : null}
    </main>
  );
}
