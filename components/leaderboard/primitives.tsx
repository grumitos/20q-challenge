import * as Tooltip from "@radix-ui/react-tooltip";
import { m } from "motion/react";
import { Fragment, useId, type ReactNode } from "react";
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
  ROLE_LABELS,
  championDisplayName,
  championIconUrl,
  championShortName,
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
  recentRecordText,
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

/** What each panel view's "i" explains; the podium's switch keeps it in every view, so the switch never changes width. */
export const WINRATE_BAR_HINT =
  "Barra y porcentaje: winrate de toda la temporada.\nMarca: winrate de los últimos 30 días; hueca si fueron 1 o 2 partidas (pasa el cursor para ver cuántas).";
export const ROLES_HINT = "Partidas de la temporada en cada rol y su porcentaje; la barra compara cada rol con el más jugado.";
export const SUMMARY_HINT = "Promedios y dúo habitual sobre las partidas analizadas de la temporada.";

/**
 * One row per champion. The bar and the percentage are the season, the bar in
 * the muted ink of its own result, so the two always agree. The last month is
 * a mark in the bright ink of its own result, standing where that month's
 * winrate falls: past the bar's end the champion is running hot, inside it
 * cold, and at either edge the month still shows (a lost month sits on the
 * left). A mark is hollow when the month rests on one or two games, and there
 * is none when the champion was not played in it, or when the payload carries
 * no month at all (an older API).
 */
export function ChampionBars({ champions, version, label }: { champions: readonly ChampionView[]; version: string; label: string }) {
  if (champions.length === 0) return <p className="empty-note">Sin campeones registrados todavía</p>;
  return (
    <ul className="champ-list" aria-label={label}>
      {champions.map((champion) => {
        const recent = recentRecordText(champion);
        const month = champion.recent;
        return (
          <li
            key={champion.id}
            className="champ-row"
            title={recent ? `${champion.name}: ${recent}` : undefined}
            aria-label={`${champion.name}: ${champion.games} partidas, ${champion.winRate}% de winrate${recent ? `; ${recent}` : ""}`}
          >
            <span className="portrait">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={championIconUrl(version, champion.id)} alt="" width={28} height={28} loading="lazy" decoding="async" />
            </span>
            <span className="champ-row__name" aria-hidden="true">{championShortName(champion.name)}</span>
            <span className="champ-row__games mono" aria-hidden="true">{champion.games}p</span>
            <span className={`wr-track is-${champion.tone}`} aria-hidden="true">
              <i className="wr-track__season" style={{ width: `${champion.winRate}%` }} />
              {/* Clamped inside the track, so 0% and 100% stay on it. Not an <i>:
                  the switch's bar-fill animation is for the bars, not the mark. */}
              {month ? (
                <b
                  className={`wr-track__month is-${month.tone}${month.games < 3 ? " is-few" : ""}`}
                  style={{ left: `clamp(0px, calc(${month.winRate}% - 2px), calc(100% - 4px))` }}
                />
              ) : null}
            </span>
            <span className={`champ-row__wr mono tone-${champion.tone}`} aria-hidden="true">{champion.winRate}%</span>
          </li>
        );
      })}
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
        <li key={champion.id} className="champ-tile" title={`${champion.name}: ${champion.games} partidas, ${champion.winRate}%`} aria-label={`${champion.name}: ${champion.games} partidas, ${champion.winRate}% de winrate`}>
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
          {/* Two right-aligned columns, so the games line up whether the share
              has one digit or two; a compact list shows just the share. */}
          <span className="mono role-list__value">
            <span className="role-list__games">{entry.games}</span>
            <span className="role-list__share">{entry.share}%</span>
          </span>
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
 * Papipu's curfew clock. It lies centred over the whole card or row it belongs
 * to, whose contents go grey, soft and inert underneath, as the respawn overlay
 * did before the redesign. The label and the clock share a line on a row; the
 * note goes under them wherever the line is short.
 */
export function RespawnClock({ seconds, playerName }: { seconds: number; playerName: string }) {
  const clock = formatRespawnClock(seconds);
  return (
    <span className="respawn" role="timer" aria-label={`${playerName} reaparece en ${clock}`}>
      <span className="respawn__label" aria-hidden="true"><MoonIcon size={15} />Reaparece en</span>
      <b className="respawn__clock mono" aria-hidden="true">{clock}</b>
      <small className="respawn__note" aria-hidden="true">Papipu, ya son las 11</small>
    </span>
  );
}

/** A live game's light: a red dot that comes and goes, the way a camera shows it is recording. */
export function LiveBadge() {
  return <span className="live-badge"><i aria-hidden="true" />In-game</span>;
}

function matchOutcome(match: NonNullable<PlayerSnapshot["lastSoloQueueMatch"]>): MatchOutcome {
  if (isRemakeMatch(match)) return "remake";
  return match.win ? "win" : "loss";
}

/** A game's K/D/A with quiet slashes: the same figures wherever a match shows. */
export function KdaFigures({ kills, deaths, assists }: { kills: number; deaths: number; assists: number }) {
  return <b className="kda mono">{kills}<i>/</i>{deaths}<i>/</i>{assists}</b>;
}

/** The lane (its icon and name, when the game reported one) and the champion played. */
function MatchChampion({ name, role }: { name: string; role?: PlayerRole }) {
  const lane = role && role !== "UNKNOWN" ? role : null;
  return (
    <span className="mline__champ">
      {lane ? (
        <>
          <RoleIcon role={lane} size={13} />
          <span className="mline__lane">{ROLE_LABELS[lane]}</span>
          <span className="mline__sep" aria-hidden="true"> · </span>
        </>
      ) : null}
      <span className="mline__name">{name}</span>
    </span>
  );
}

/** The challenge members who shared the game, by first name, in the leader's gold. */
function MatchCompany({ names }: { names: readonly string[] }) {
  return (
    <span className="mline__with" translate="no">
      con{" "}
      {names.map((name, index) => (
        <Fragment key={name}>
          {index > 0 ? ", " : null}
          <b>{name}</b>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The player's most recent game: a live game while they are in one, otherwise
 * the last SoloQ match with its inferred PL change. Its figures sit on a grid
 * of two rows: the result, the K/D/A and the age above; the lane and champion,
 * the ratio and the length below, where a game shared with challenge members
 * names them instead of the length (in a duo the company says more). The
 * figure columns are the same width on every wide card, so the podium reads as
 * one table; narrower cards size them to their content, and the narrowest
 * stack the figures in two columns. `compact` is the table's three-line form,
 * the same facts in a narrow column: the result and the age, the lane and
 * champion and the K/D/A, then the length (or the company) and the ratio.
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
    const company = peerNames(live.participants, player.id, roster);
    return (
      <div className={`mline is-live${compact ? " is-compact" : ""}${company.length > 0 ? " has-company" : ""}`}>
        <span className="mline__icon">
          {live.championId
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={championIconUrl(version, live.championId)} alt="" width={30} height={30} decoding="async" />
            : null}
        </span>
        <span className="mline__body">
          <span className="mline__result">
            <LiveBadge />
            <b className="mono mline__clock" role="timer" aria-label={`In-game desde hace ${formatDuration(elapsed)}`}>{formatDuration(elapsed)}</b>
          </span>
          <span className="mline__age">desde {formatLimaTime(live.gameStartedAt)}</span>
          {/* Spectator data has no lane, so a live game names only the champion. */}
          <MatchChampion name={championDisplayName({ id: live.championId, name: live.championName })} />
          {company.length > 0 ? <MatchCompany names={company} /> : null}
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
  const company = peerNames(match.participants, player.id, roster);
  const age = formatAge(match.gameStartTimestamp, now);
  const role = match.participants.find((participant) => participant.challengePlayerId === player.id)?.role;
  const lane = role && role !== "UNKNOWN" ? ROLE_LABELS[role] : null;
  const champion = championDisplayName({ id: match.championId, name: match.championName });

  return (
    <a
      className={`mline is-${outcome}${compact ? " is-compact" : ""}${company.length > 0 ? " has-company" : ""}${isStaleMatch(match.gameStartTimestamp, now) ? " is-old" : ""}`}
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Última partida de ${player.gameName}: ${outcomeLabel(outcome)}${lp ? `, ${lp}` : ""}, ${kda}, ${lane ? `${lane}, ` : ""}${champion}${company.length > 0 ? `, ${peerText(company)}` : ""}, ${age}. Abrir en League of Graphs`}
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
        <MatchChampion name={champion} role={role} />
        <small className="mline__ratio mono">{kdaRatio(match.kills, match.deaths, match.assists)} KDA</small>
        {/* In a shared game the company takes the length's place: who played says more than how long. */}
        {company.length > 0
          ? <MatchCompany names={company} />
          : <span className="mline__time mono"><ClockIcon size={12} />{formatDuration(match.durationSeconds)}</span>}
      </span>
      {compact ? null : <ChevronRightIcon className="mline__chevron" size={14} />}
    </a>
  );
}

export { kdaRatio };
