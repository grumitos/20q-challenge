import * as Tooltip from "@radix-ui/react-tooltip";
import { m } from "motion/react";
import { useId, type ReactNode } from "react";
import {
  formatRespawnClock,
  isRemakeMatch,
  isStaleMatch,
  type PlayerRole,
  type PlayerSnapshot,
  type RankTier,
} from "../../lib/leaderboard";
import { DURATION, EASE } from "../../lib/motion";
import {
  championIconUrl,
  firstName,
  formSlots,
  formatAge,
  formatDuration,
  formatLimaTime,
  formatLpChange,
  kdaRatio,
  lpChangeTone,
  lpEvidenceTitle,
  matchDetailsUrl,
  outcomeLabel,
  peerNames,
  peerText,
  perGameAverages,
  profileIconUrl,
  profileUrl,
  rankAsset,
  roleShares,
  type ChampionView,
  type MatchOutcome,
} from "../../lib/ui-format";
import { ChevronRightIcon, ClockIcon, InfoIcon, MoonIcon, RoleIcon } from "./icons";

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

/** Five slots, oldest first: filled green for a win, red for a loss, an outline when empty. */
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
      <b className="mono" aria-hidden="true">{place}</b>
    </span>
  );
}

/**
 * A few options, one chosen: the podium panel's views and the row detail's
 * champion lists. The highlight is one thumb that slides to the chosen option
 * (a shared layout animation keyed to this switch) while the labels fade their
 * colour. Choosing the option already chosen does nothing, so the view it
 * shows never replays its entrance.
 */
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  const thumbId = useId();
  return (
    <span className="segmented" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => {
            if (key !== value) onChange(key);
          }}
        >
          {value === key ? (
            // Measured only when the choice changes, or the clock's re-renders
            // would finish a slide early. The radius rides in `style` so the
            // slide's scale does not squash it.
            <m.span
              layoutId={thumbId}
              layoutDependency={value}
              className="segmented__thumb"
              style={{ borderRadius: 6 }}
              transition={{ duration: DURATION.switch, ease: EASE }}
              aria-hidden="true"
            />
          ) : null}
          <span className="segmented__label">{text}</span>
        </button>
      ))}
    </span>
  );
}

/** An "i" that explains itself on hover; `children` is an optional visible caption before it. */
export function InfoHint({ label, children }: { label: string; children?: ReactNode }) {
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
  "Barra sólida: winrate ajustado por número de partidas (99% de confianza).\nBarra clara: winrate observado.";

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
          <span className={`wr-track is-${champion.tone}`} aria-hidden="true">
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

/** The roles a player has played, most played first, each against the top one. */
export function RoleList({ player }: { player: PlayerSnapshot }) {
  const roles = roleShares(player.analytics.roleCounts).slice(0, 5);
  if (roles.length === 0) return <p className="empty-note">Sin partidas analizadas</p>;
  return (
    <ul className="role-list" aria-label={`Roles de ${player.gameName}`}>
      {roles.map((entry) => (
        <li key={entry.role}>
          <RoleIcon role={entry.role} size={14} />
          <span className="role-list__name">{entry.label}</span>
          <span className="role-list__bar" aria-hidden="true"><i style={{ width: `${entry.bar}%` }} /></span>
          {/* The games stand apart so a compact list can show just the share. */}
          <span className="mono role-list__value"><span className="role-list__games">{entry.games} · </span>{entry.share}%</span>
        </li>
      ))}
    </ul>
  );
}

/** Per-game averages, the habitual duo and how many games the analysis rests on. */
export function PlayerSummary({ player, roster, version }: {
  player: PlayerSnapshot;
  roster: readonly PlayerSnapshot[];
  version: string;
}) {
  const averages = perGameAverages(player.analytics);
  const duo = player.habitualDuo;
  const duoPlayer = duo ? roster.find((candidate) => candidate.id === duo.playerId) : undefined;
  return (
    <dl className="summary">
      <div>
        <dt>Promedio por partida</dt>
        <dd className="mono">{averages ?? "—"}</dd>
      </div>
      <div>
        <dt>Dúo habitual</dt>
        <dd className="summary__duo">
          {duo ? (
            <>
              {duoPlayer ? <Avatar player={duoPlayer} version={version} size={22} /> : null}
              <b translate="no">{firstName(duoPlayer?.gameName ?? duo.gameName)}</b>
              <small className="mono">{duo.games} partidas</small>
            </>
          ) : "—"}
        </dd>
      </div>
      <div>
        <dt>Partidas analizadas</dt>
        <dd className="mono">{player.analytics.games}</dd>
      </div>
    </dl>
  );
}

/**
 * Papipu's curfew clock. It takes over the card or the row it belongs to, whose
 * contents go grey, soft and inert underneath, as the respawn overlay did
 * before the redesign.
 */
export function RespawnClock({ seconds, playerName }: { seconds: number; playerName: string }) {
  const clock = formatRespawnClock(seconds);
  return (
    <span className="respawn" role="timer" aria-label={`${playerName} reaparece en ${clock}`}>
      <span className="respawn__label" aria-hidden="true"><MoonIcon size={13} />Reaparece en</span>
      <b className="respawn__clock mono" aria-hidden="true">{clock}</b>
      <small className="respawn__note" aria-hidden="true">Papipu, ya son las 11</small>
    </span>
  );
}

function matchOutcome(match: NonNullable<PlayerSnapshot["lastSoloQueueMatch"]>): MatchOutcome {
  if (isRemakeMatch(match)) return "remake";
  return match.win ? "win" : "loss";
}

/** A game's K/D/A with quiet slashes: the same figures wherever a match shows. */
export function KdaFigures({ kills, deaths, assists }: { kills: number; deaths: number; assists: number }) {
  return <b className="kda mono">{kills}<i>/</i>{deaths}<i>/</i>{assists}</b>;
}

/** The champion played, the role's icon before it and the company after it. */
function MatchChampion({ name, role, company }: { name: string; role?: PlayerRole; company: string }) {
  return (
    <span className="mline__champ">
      {role && role !== "UNKNOWN" ? <RoleIcon role={role} size={12} /> : null}
      {name}
      {company ? <span className="mline__with"> {company}</span> : null}
    </span>
  );
}

/**
 * The player's most recent game: a live game while they are in one, otherwise
 * the last SoloQ match with its inferred PL change. Its figures sit on a grid
 * of two rows: the result, the K/D/A and the age above; the champion (and the
 * company), the ratio and the length below. The K/D/A and time columns are the
 * same width on every card, duo or not, so the cards read as one table.
 * `compact` is the table's two-line form: the result, then the K/D/A and the age.
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
          <span className="mline__result">
            <span className="live-badge"><i aria-hidden="true" />En partida</span>
            <b className="mono" role="timer" aria-label={`En partida desde hace ${formatDuration(elapsed)}`}>{formatDuration(elapsed)}</b>
          </span>
          {compact ? null : <span className="mline__age">desde {formatLimaTime(live.gameStartedAt)}</span>}
          {/* Spectator data has no lane, so a live game names no role; the table's form leaves out the company. */}
          <MatchChampion name={live.championName} company={compact ? "" : company} />
        </span>
        {/* A live game links nowhere, but keeps the chevron's room so its columns meet the other cards'. */}
        {compact ? null : <span className="mline__chevron-room" aria-hidden="true" />}
      </div>
    );
  }

  const match = player.lastSoloQueueMatch;
  if (!match) return <p className="mline is-empty">Sin partidas SoloQ recientes</p>;

  const outcome = matchOutcome(match);
  const remake = outcome === "remake";
  const lp = formatLpChange(match.lpChangeEvidence, remake);
  const lpTone = lpChangeTone(match.lpChangeEvidence, remake);
  const href = matchDetailsUrl(match.matchId) ?? profileUrl(player);
  const kda = `${match.kills}/${match.deaths}/${match.assists}`;
  const company = peerText(peerNames(match.participants, player.id, roster));
  const age = formatAge(match.gameStartTimestamp, now);
  const role = match.participants.find((participant) => participant.challengePlayerId === player.id)?.role;

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
        <span className="mline__result">
          <b className={`outcome is-${outcome}`}>{outcomeLabel(outcome)}</b>
          {lp ? <span className={`mono lp-change is-${lpTone}`} title={lpEvidenceTitle(match.lpChangeEvidence, remake)}>{lp}</span> : null}
        </span>
        <span className="mline__kda"><KdaFigures kills={match.kills} deaths={match.deaths} assists={match.assists} /></span>
        <span className="mline__age">{age}</span>
        {compact ? null : (
          <>
            <MatchChampion name={match.championName} role={role} company={company} />
            <small className="mline__ratio mono">{kdaRatio(match.kills, match.deaths, match.assists)} KDA</small>
            <span className="mline__time mono"><ClockIcon size={12} />{formatDuration(match.durationSeconds)}</span>
          </>
        )}
      </span>
      {compact ? null : <ChevronRightIcon className="mline__chevron" size={14} />}
    </a>
  );
}

export { kdaRatio };
