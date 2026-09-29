import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import {
  formatRespawnClock,
  isRemakeMatch,
  isStaleMatch,
  type PlayerSnapshot,
  type RankTier,
} from "../../lib/leaderboard";
import {
  championIconUrl,
  formSlots,
  formatAge,
  formatDuration,
  formatLimaTime,
  formatLpChange,
  kdaRatio,
  lpEvidenceTitle,
  matchDetailsUrl,
  outcomeLabel,
  peerNames,
  peerText,
  profileIconUrl,
  profileUrl,
  rankAsset,
  type ChampionView,
  type MatchOutcome,
} from "../../lib/ui-format";
import { ChevronRightIcon, InfoIcon, MoonIcon } from "./icons";

export function Avatar({ player, version, size, className = "" }: {
  player: Pick<PlayerSnapshot, "gameName" | "profileIconId" | "riotIdFound">;
  version: string;
  size: number;
  className?: string;
}) {
  if (!player.riotIdFound || player.profileIconId <= 0) {
    return (
      <span className={`avatar avatar--empty ${className}`} style={{ width: size, height: size }} role="img" aria-label={`Sin icono de perfil para ${player.gameName}`}>
        ?
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`avatar ${className}`}
      src={profileIconUrl(version, player.profileIconId)}
      alt=""
      width={size}
      height={size}
      decoding="async"
    />
  );
}

export function RankEmblem({ tier, size, className = "" }: { tier: RankTier; size: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`emblem${tier === "UNRANKED" ? " is-unranked" : ""} ${className}`}
      src={rankAsset(tier)}
      alt=""
      width={size}
      height={size}
      decoding="async"
    />
  );
}

export function tierClass(tier: RankTier) {
  return `tier-${tier.toLowerCase()}`;
}

/** Five slots, oldest first: filled blue for a win, red for a loss, an outline when empty. */
export function FormPills({ results, withText = false }: { results?: readonly boolean[]; withText?: boolean }) {
  const form = formSlots(results);
  return (
    <span className="form">
      <span className="form__pills" role="img" aria-label={form.label}>
        {form.slots.map((slot, index) => <i key={index} className={`pill is-${slot}`} />)}
      </span>
      {withText ? <small className="form__text mono">{form.text}</small> : null}
    </span>
  );
}

export function Stitch() {
  return <div className="stitch" aria-hidden="true" />;
}

export function PlaceChip({ place }: { place: number }) {
  return (
    <span className={`place-chip place-chip--${place}`} aria-label={`Puesto ${place}`}>
      <i aria-hidden="true" />
      <b className="mono" aria-hidden="true">{place}</b>
    </span>
  );
}

export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button type="button" className="info-hint" aria-label={label}>
          {children}
          <InfoIcon size={13} />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" side="top" align="end" sideOffset={6} collisionPadding={12}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export const WINRATE_BAR_HINT =
  "Barra sólida: winrate ajustado por número de partidas (99% de confianza). Barra clara: winrate observado.";

/** Rows with the adjusted winrate as the solid bar and the observed winrate as its lighter tail. */
export function ChampionBars({ champions, version, label }: { champions: readonly ChampionView[]; version: string; label: string }) {
  if (champions.length === 0) return <p className="empty-note">Sin campeones registrados todavía</p>;
  return (
    <ul className="champ-list" aria-label={label}>
      {champions.map((champion) => (
        <li
          key={champion.id}
          className="champ-row"
          aria-label={`${champion.name}: ${champion.games} partidas, ${champion.winRate}% de winrate`}
        >
          <span className="portrait">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={championIconUrl(version, champion.id)} alt="" width={28} height={28} loading="lazy" decoding="async" />
          </span>
          <span className="champ-row__name" aria-hidden="true">{champion.name}</span>
          <span className="champ-row__games mono" aria-hidden="true">{champion.games}p</span>
          <span className="wr-track" aria-hidden="true">
            <i className="wr-track__observed" style={{ width: `${champion.winRate}%` }} />
            <i className="wr-track__adjusted" style={{ width: `${champion.adjusted}%` }} />
          </span>
          <span className={`champ-row__wr mono tone-${champion.tone}`} aria-hidden="true">{champion.winRate}%</span>
        </li>
      ))}
    </ul>
  );
}

/** Portrait tiles with the winrate underneath; the compact form of the same list. */
export function ChampionTiles({ champions, version, showGames = false, size = 30 }: {
  champions: readonly ChampionView[];
  version: string;
  showGames?: boolean;
  size?: number;
}) {
  if (champions.length === 0) return <span className="empty-note">—</span>;
  return (
    <ul className="champ-tiles">
      {champions.map((champion) => (
        <li key={champion.id} className="champ-tile" title={`${champion.name}: ${champion.games} partidas`} aria-label={`${champion.name}: ${champion.games} partidas, ${champion.winRate}% de winrate`}>
          <span className="portrait" style={{ width: size, height: size }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={championIconUrl(version, champion.id)} alt="" width={size} height={size} loading="lazy" decoding="async" />
          </span>
          <small className={`mono tone-${champion.tone}`} aria-hidden="true">{champion.winRate}%</small>
          {showGames ? <small className="mono champ-tile__games" aria-hidden="true">{champion.games}p</small> : null}
        </li>
      ))}
    </ul>
  );
}

export function RespawnPill({ seconds, playerName }: { seconds: number; playerName: string }) {
  const clock = formatRespawnClock(seconds);
  return (
    <span className="respawn" role="timer" aria-label={`${playerName} reaparece en ${clock}`}>
      <span className="respawn__pill">
        <MoonIcon size={13} />
        <span>Reaparece en</span>
        <b className="mono">{clock}</b>
      </span>
      <small className="respawn__note">Papipu, ya son las 11</small>
    </span>
  );
}

function matchOutcome(match: NonNullable<PlayerSnapshot["lastSoloQueueMatch"]>): MatchOutcome {
  if (isRemakeMatch(match)) return "remake";
  return match.win ? "win" : "loss";
}

/**
 * The player's most recent game: a live game while they are in one, otherwise
 * the last SoloQ match with its inferred PL change. `compact` is the table's
 * two-line form without the company and duration.
 */
export function MatchLine({ player, roster, version, now, compact = false }: {
  player: PlayerSnapshot;
  roster: readonly PlayerSnapshot[];
  version: string;
  now: number;
  compact?: boolean;
}) {
  const live = player.liveGame;
  if (live) {
    const elapsed = Math.max(0, Math.floor((now - live.gameStartedAt) / 1000));
    const company = peerText(peerNames(live.participants, player.id, roster));
    return (
      <div className={`mline is-live${compact ? " is-compact" : ""}`}>
        <span className="mline__icon">
          {live.championId
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={championIconUrl(version, live.championId)} alt="" width={30} height={30} decoding="async" />
            : null}
        </span>
        <span className="mline__body">
          <span className="mline__top">
            <span className="live-badge"><i aria-hidden="true" />En partida</span>
            <b className="mono" role="timer" aria-label={`En partida desde hace ${formatDuration(elapsed)}`}>{formatDuration(elapsed)}</b>
            {compact ? null : <span className="mline__age">desde {formatLimaTime(live.gameStartedAt)}</span>}
          </span>
          <span className="mline__sub">{[live.championName, compact ? "" : company].filter(Boolean).join(" · ") || company}</span>
        </span>
      </div>
    );
  }

  const match = player.lastSoloQueueMatch;
  if (!match) return <p className="mline is-empty">Sin partidas SoloQ recientes</p>;

  const outcome = matchOutcome(match);
  const remake = outcome === "remake";
  const lp = formatLpChange(match.lpChangeEvidence, remake);
  const lpTone = remake ? "neutral" : match.lpChangeEvidence.status === "observed"
    ? (match.lpChangeEvidence.value < 0 ? "loss" : "win")
    : "pending";
  const href = matchDetailsUrl(match.matchId) ?? profileUrl(player);
  const kda = `${match.kills}/${match.deaths}/${match.assists}`;
  const company = peerText(peerNames(match.participants, player.id, roster));
  const age = formatAge(match.gameStartTimestamp, now);
  const detail = compact
    ? `${kda} · ${age}`
    : [match.championName, kda, formatDuration(match.durationSeconds), company].filter(Boolean).join(" · ");

  return (
    <a
      className={`mline is-${outcome}${compact ? " is-compact" : ""}${isStaleMatch(match.gameStartTimestamp, now) ? " is-old" : ""}`}
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Última partida de ${player.gameName}: ${outcomeLabel(outcome)}${lp ? `, ${lp}` : ""}, ${kda}, ${age}. Abrir en League of Graphs`}
    >
      <span className="mline__icon">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={championIconUrl(version, match.championId)} alt="" width={30} height={30} loading="lazy" decoding="async" />
      </span>
      <span className="mline__body">
        <span className="mline__top">
          <b className={`outcome is-${outcome}`}>{outcomeLabel(outcome)}</b>
          {lp ? <span className={`mono lp-change is-${lpTone}`} title={lpEvidenceTitle(match.lpChangeEvidence, remake)}>{lp}</span> : null}
          {compact ? null : <span className="mline__age">{age}</span>}
        </span>
        <span className="mline__sub">{detail}</span>
      </span>
      {compact ? null : <ChevronRightIcon className="mline__chevron" size={14} />}
    </a>
  );
}

export { kdaRatio };
