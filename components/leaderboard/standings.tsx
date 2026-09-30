import { AnimatePresence, m } from "motion/react";
import { useState, useSyncExternalStore, type MouseEvent } from "react";
import {
  isRemakeMatch,
  orderMatchRoster,
  type PlayerSnapshot,
  type RosterSlot,
} from "../../lib/leaderboard";
import { DURATION, EASE, ENTRANCE } from "../../lib/motion";
import {
  ROLE_LABELS,
  bestChampionViews,
  byWinRate,
  championDisplayName,
  championIconUrl,
  formatAge,
  formatDuration,
  formatLpChange,
  kdaRatio,
  lpChangeTone,
  lpEvidenceTitle,
  matchDetailsUrl,
  mostPlayedChampionViews,
  outcomeLabel,
  peerNames,
  profileUrl,
  rankLabel,
  winRateTone,
} from "../../lib/ui-format";
import { ChevronDownIcon, ClockIcon, ExternalIcon, RoleIcon } from "./icons";
import { PlayerPanel } from "./player-panel";
import {
  Avatar,
  ChampionBars,
  ChampionTiles,
  FormPills,
  InfoHint,
  KdaFigures,
  LiveBadge,
  MatchLine,
  PlayerSummary,
  RankEmblem,
  RespawnClock,
  RoleList,
  Segmented,
  WINRATE_BAR_HINT,
  tierClass,
} from "./primitives";

export const ROW_CHAMPION_SLOTS = 4;
const DETAIL_CHAMPION_SLOTS = 5;

/**
 * Where the row detail stops laying its four blocks side by side and becomes
 * the last match over the podium's switchable panel (stacked on a phone, side
 * by side on a half screen), so it stays short where vertical space is scarce.
 * It is only read after a click (a detail never renders on the server), so the
 * server snapshot is never used.
 */
const NARROW_DETAIL_QUERY = "(max-width: 959px)";

function subscribeNarrowDetail(onChange: () => void) {
  const list = window.matchMedia(NARROW_DETAIL_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function useNarrowDetail() {
  return useSyncExternalStore(
    subscribeNarrowDetail,
    () => window.matchMedia(NARROW_DETAIL_QUERY).matches,
    () => false,
  );
}

/** The two ways the detail lists a player's champions. */
const DETAIL_ORDERS = [
  ["best", "Mejores"],
  ["most", "Más jugados"],
] as const;
type DetailOrder = (typeof DETAIL_ORDERS)[number][0];

type StandingsProps = {
  standings: readonly PlayerSnapshot[];
  version: string;
  now: number;
  respawnFor: (player: PlayerSnapshot) => number | null;
  pending: boolean;
};

export function Standings({ standings, version, now, respawnFor, pending }: StandingsProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = standings.slice(3);
  if (!pending && rows.length === 0) return null;

  return (
    <section id="tabla" className="standings shell" aria-labelledby="resto-title">
      <h2 id="resto-title" className="sr-only">Resto de la clasificación</h2>
      <div className="board">
        <div className="board__head srow-grid" aria-hidden="true">
          <span>#</span>
          <span>Jugador</span>
          <span>Rango</span>
          <span>Winrate</span>
          <span className="col-kda">KDA</span>
          <span>Últimas 5</span>
          <span>Mejores campeones</span>
          <span className="col-match">Última partida</span>
          <span />
        </div>
        <ol className="board__body" start={4}>
          {pending
            ? [4, 5, 6, 7, 8, 9].map((place) => <SkeletonRow key={place} place={place} />)
            : rows.map((player, index) => (
                <StandingRow
                  key={player.id}
                  player={player}
                  place={index + 4}
                  version={version}
                  roster={standings}
                  now={now}
                  respawnSeconds={respawnFor(player)}
                  open={openId === player.id}
                  onToggle={() => setOpenId((current) => (current === player.id ? null : player.id))}
                />
              ))}
        </ol>
      </div>
    </section>
  );
}

function PlaceDelta({ delta = 0 }: { delta?: number }) {
  if (delta > 0) return <small className="delta is-up mono" aria-label={`Sube ${delta} ${delta === 1 ? "puesto" : "puestos"}`}>▲{delta}</small>;
  if (delta < 0) return <small className="delta is-down mono" aria-label={`Baja ${-delta} ${delta === -1 ? "puesto" : "puestos"}`}>▼{-delta}</small>;
  return <small className="delta mono" aria-label="Sin cambio de puesto">—</small>;
}

function StandingRow({ player, place, version, roster, now, respawnSeconds, open, onToggle }: {
  player: PlayerSnapshot;
  place: number;
  version: string;
  roster: readonly PlayerSnapshot[];
  now: number;
  respawnSeconds: number | null;
  open: boolean;
  onToggle: () => void;
}) {
  const dead = respawnSeconds !== null;
  // On curfew the row is closed and still: no detail, no toggle, and every cell
  // under the clock inert.
  const isOpen = open && !dead;
  const unranked = player.tier === "UNRANKED";
  const live = player.liveGame ?? null;
  const role = player.riotIdFound ? player.analytics.mainRole : "UNKNOWN";
  // Picked by the Wilson bound, shown by winrate so the percentages read in order.
  const champions = player.riotIdFound
    ? byWinRate(bestChampionViews(player.analytics.championCounts, ROW_CHAMPION_SLOTS, player.recentChampions))
    : [];
  const games = player.wins + player.losses;
  const detailId = `detalle-${player.id}`;

  // The whole row opens the detail for a pointer; keyboards use the toggle
  // button, and links inside the row keep doing what links do.
  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if (dead || (event.target as HTMLElement).closest("a, button")) return;
    onToggle();
  };

  return (
    <m.li
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: ENTRANCE.row.duration, delay: Math.min(ENTRANCE.row.maxDelay, (place - 4) * ENTRANCE.row.step), ease: EASE }}
      className={`srow${isOpen ? " is-open" : ""}${dead ? " is-dead" : ""}${live ? " is-live" : ""}${unranked ? " is-unranked" : ""}`}
      data-ranking-id={player.id}
    >
      <div className="srow__main srow-grid" onClick={handleRowClick}>
        {/* On curfew the clock lies centred over the whole row, the player
            included, and everything under it goes soft and inert. */}
        {respawnSeconds !== null ? <div className="srow__respawn"><RespawnClock seconds={respawnSeconds} playerName={player.gameName} /></div> : null}

        <span className="srow__place" inert={dead}>
          <b className="mono">{place}</b>
          <PlaceDelta delta={player.placeDelta} />
        </span>

        {/* The photo, the name and the tag are one link to the profile; the
            photo takes a frame on hover, apart from the row's own highlight. */}
        <a className="srow__player" href={profileUrl(player)} target="_blank" rel="noreferrer" aria-label={`Ver perfil de ${player.gameName} en League of Graphs`} inert={dead}>
          <Avatar player={player} version={version} size={36} className="srow__avatar" />
          <span className="srow__who" translate="no">
            <strong>{player.gameName}</strong>
            <small className="srow__meta">
              <span className="mono srow__tag">#{player.tagLine}</span>
              <span className="srow__meta-sep" aria-hidden="true">·</span>
              <span className="srow__role" title={player.riotIdFound ? `${ROLE_LABELS[role]} · ${player.analytics.roleShare}% de sus partidas` : undefined}>
                <RoleIcon role={role} size={12} />
                {ROLE_LABELS[role]}
                {player.riotIdFound ? <span className="mono srow__role-share">{player.analytics.roleShare}%</span> : null}
              </span>
            </small>
            {/* Where the table has no last-match column, the game in progress
                is named here with its clock, in place of the tag and role. */}
            {live ? (
              <small className="srow__live">
                <LiveBadge />
                <b className="mono">{formatDuration(Math.max(0, Math.floor((now - live.gameStartedAt) / 1000)))}</b>
              </small>
            ) : null}
          </span>
        </a>

        <span className="srow__rank" inert={dead}>
          <RankEmblem tier={player.tier} size={40} className="srow__emblem" />
          <span className="srow__rank-text">
            <span className="srow__tier">
              <b className={tierClass(player.tier)}>{rankLabel(player)}</b>
              <span className="mono">{player.leaguePoints} PL</span>
            </span>
          </span>
        </span>

        <div className="srow__stats" inert={dead}>
        <span
          className="srow__wr"
          role="group"
          aria-label={player.riotIdFound ? `Winrate ${player.winRate.toFixed(1)}%, ${player.wins} victorias y ${player.losses} derrotas` : "Winrate sin datos"}
        >
          <span className="srow__wr-top">
            <b className="mono">{games > 0 ? `${player.winRate.toFixed(1)}%` : "—"}</b>
            <small className="mono">{player.wins}V {player.losses}D</small>
          </span>
          <span className={`wr-bar is-${winRateTone(player.winRate, games, 1)}`} aria-hidden="true"><i style={{ width: `${games > 0 ? Math.max(2, player.winRate) : 0}%` }} /></span>
        </span>

        <span className="srow__kda mono col-kda" aria-label={`KDA ${player.analytics.kda.toFixed(1)}`}>
          {player.analytics.games > 0 ? player.analytics.kda.toFixed(1) : "—"}
        </span>

        <span className="srow__form"><FormPills results={player.recentResults} withText /></span>

        <span className="srow__champs">
          <ChampionTiles champions={champions} version={version} />
        </span>

        <span className="srow__match col-match">
          <MatchLine player={player} roster={roster} version={version} now={now} compact />
        </span>
        </div>

        {dead ? null : (
          <button
            type="button"
            className="srow__toggle"
            aria-expanded={isOpen}
            aria-controls={detailId}
            aria-label={`${isOpen ? "Ocultar" : "Ver"} el detalle de ${player.gameName}`}
            onClick={onToggle}
          >
            <ChevronDownIcon size={16} />
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {isOpen ? (
          <m.div
            key="detail"
            id={detailId}
            className="srow__detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: DURATION.fill, ease: EASE }}
          >
            <RowDetail player={player} version={version} roster={roster} now={now} />
          </m.div>
        ) : null}
      </AnimatePresence>
    </m.li>
  );
}

/** One side of the last match: its five champions, flush right, the player's own ringed and challenge members' in gold. */
function RosterRow({ label, slots, playerId, version }: {
  label: string;
  slots: readonly RosterSlot[];
  playerId: string;
  version: string;
}) {
  return (
    <div className="roster__row">
      <span className="roster__label">{label}</span>
      <span className="roster__slots">
        {slots.map((participant, index) => {
          if (!participant) return <span key={index} className="roster__slot is-empty" />;
          const isSelf = participant.challengePlayerId === playerId;
          const isPeer = participant.challengePlayerId !== null && !isSelf;
          const champion = championDisplayName({ id: participant.championId, name: participant.championName });
          return (
            <span
              key={index}
              className={`roster__slot${isSelf ? " is-self" : ""}${isPeer ? " is-peer" : ""}`}
              title={`${champion} · ${participant.gameName}`}
            >
              {participant.championId
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={championIconUrl(version, participant.championId)} alt={champion} width={28} height={28} loading="lazy" decoding="async" />
                : null}
            </span>
          );
        })}
      </span>
    </div>
  );
}

/**
 * The last match in full: the podium line's figures in the same words (the
 * result and the age, the K/D/A with its ratio and the length, the lane and the
 * champion with any challenge company), then both teams.
 */
function LastMatchBlock({ player, version, roster, now }: {
  player: PlayerSnapshot;
  version: string;
  roster: readonly PlayerSnapshot[];
  now: number;
}) {
  const match = player.lastSoloQueueMatch;
  const matchHref = match ? matchDetailsUrl(match.matchId) : null;

  let body = <p className="empty-note">Sin partidas SoloQ recientes</p>;
  if (match) {
    const remake = isRemakeMatch(match);
    const outcome = remake ? "remake" : match.win ? "win" : "loss";
    const lp = formatLpChange(match.lpChangeEvidence, remake);
    const lpTone = lpChangeTone(match.lpChangeEvidence, remake);
    const { allies, enemies } = orderMatchRoster(match.participants, player.id);
    const role = match.participants.find((participant) => participant.challengePlayerId === player.id)?.role;
    const lane = role && role !== "UNKNOWN" ? role : null;
    const company = peerNames(match.participants, player.id, roster);
    body = (
      <>
        <p className="detail__result">
          <b className={`outcome is-${outcome}`}>{outcomeLabel(outcome)}</b>
          {lp ? <span className={`mono lp-change is-${lpTone}`} title={lpEvidenceTitle(match.lpChangeEvidence, remake)}>{lp}</span> : null}
          <span className="detail__when">{formatAge(match.gameStartTimestamp, now)}</span>
        </p>
        <p className="detail__kda">
          <KdaFigures kills={match.kills} deaths={match.deaths} assists={match.assists} />
          <small className="mono">{kdaRatio(match.kills, match.deaths, match.assists)} KDA</small>
          <span className="detail__when mono"><ClockIcon size={12} />{formatDuration(match.durationSeconds)}</span>
        </p>
        <p className="detail__champ">
          {lane ? <><RoleIcon role={lane} size={13} /><span className="detail__lane">{ROLE_LABELS[lane]}</span><span className="detail__sep" aria-hidden="true">·</span></> : null}
          <span className="detail__champ-name">{championDisplayName({ id: match.championId, name: match.championName })}</span>
          {company.length > 0 ? <span className="detail__with" translate="no">con <b>{company.join(", ")}</b></span> : null}
        </p>
        {allies.length > 0 ? (
          <div className="roster">
            <RosterRow label="Equipo" slots={allies} playerId={player.id} version={version} />
            {enemies.length > 0 ? <RosterRow label="Enemigo" slots={enemies} playerId={player.id} version={version} /> : null}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <section className="detail__block detail__match" aria-label={`Última partida de ${player.gameName}`}>
      <div className="section-label">
        <span>Última partida</span>
        {matchHref ? (
          <a href={matchHref} target="_blank" rel="noreferrer" className="text-link">
            Ver en League of Graphs <ExternalIcon size={12} />
          </a>
        ) : null}
      </div>
      {body}
    </section>
  );
}

function RowDetail({ player, version, roster, now }: {
  player: PlayerSnapshot;
  version: string;
  roster: readonly PlayerSnapshot[];
  now: number;
}) {
  const narrow = useNarrowDetail();
  // Null until the reader picks a list, as in the podium's panel: only their
  // switches bring the list in with motion.
  const [chosen, setChosen] = useState<DetailOrder | null>(null);
  const order = chosen ?? "best";
  const counts = player.analytics.championCounts;
  const recent = player.recentChampions;
  // Picked by the Wilson bound, shown by winrate, as everywhere else.
  const best = byWinRate(bestChampionViews(counts, DETAIL_CHAMPION_SLOTS, recent));

  // A narrow screen gets the podium's arrangement: the last match, then one
  // panel whose switch shows the champions, the roles or the summary.
  if (narrow) {
    return (
      <div className="detail is-narrow">
        <LastMatchBlock player={player} version={version} roster={roster} now={now} />
        <section className="detail__block" aria-label={`Campeones, roles y resumen de ${player.gameName}`}>
          <PlayerPanel player={player} roster={roster} version={version} best={best} slots={DETAIL_CHAMPION_SLOTS} />
        </section>
      </div>
    );
  }

  const champions = order === "best" ? best : mostPlayedChampionViews(counts, DETAIL_CHAMPION_SLOTS, recent);
  return (
    <div className="detail">
      <section className="detail__block" aria-label={`Campeones de ${player.gameName}`}>
        <div className="section-label">
          <span>Campeones</span>
          <span className="detail__switch">
            <Segmented options={DETAIL_ORDERS} value={order} onChange={setChosen} label="Ordenar campeones" />
            <InfoHint label={WINRATE_BAR_HINT} />
          </span>
        </div>
        <div key={order} className={chosen === null ? undefined : "swap-in"}>
          <ChampionBars champions={champions} version={version} label={`Campeones de ${player.gameName}`} />
        </div>
      </section>

      <section className="detail__block" aria-label={`Roles de ${player.gameName}`}>
        <div className="section-label"><span>Roles</span></div>
        <RoleList player={player} />
      </section>

      <LastMatchBlock player={player} version={version} roster={roster} now={now} />

      <section className="detail__block" aria-label={`Resumen de ${player.gameName}`}>
        <div className="section-label"><span>Resumen</span></div>
        <PlayerSummary player={player} roster={roster} version={version} />
      </section>
    </div>
  );
}

function SkeletonRow({ place }: { place: number }) {
  return (
    <li className="srow is-pending" aria-hidden="true">
      <div className="srow__main srow-grid">
        <span className="srow__place"><b className="mono">{place}</b></span>
        <span className="srow__player">
          <span className="avatar sk" style={{ width: 36, height: 36 }} />
          <span className="srow__who">
            <span className="sk sk-line" style={{ width: 96, height: 12 }} />
            <span className="sk sk-line" style={{ width: 70, height: 9 }} />
          </span>
        </span>
        <span className="srow__rank"><span className="sk" style={{ width: 32, height: 32, borderRadius: 8 }} /><span className="sk sk-line" style={{ width: 90, height: 10 }} /></span>
        <div className="srow__stats">
        <span className="srow__wr"><span className="sk sk-line" style={{ width: "100%", height: 10 }} /></span>
        <span className="srow__kda col-kda"><span className="sk sk-line" style={{ width: 26, height: 10 }} /></span>
        <span className="srow__form"><FormPills /></span>
        <span className="srow__champs"><span className="sk sk-line" style={{ width: 110, height: 30 }} /></span>
        <span className="srow__match col-match"><span className="sk sk-line" style={{ width: 130, height: 10 }} /></span>
        </div>
        <span />
      </div>
    </li>
  );
}
