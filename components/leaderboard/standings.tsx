import { AnimatePresence, m } from "motion/react";
import { useState, type MouseEvent } from "react";
import {
  formatRespawnClock,
  isRemakeMatch,
  orderMatchRoster,
  type PlayerSnapshot,
  type RosterSlot,
} from "../../lib/leaderboard";
import {
  ROLE_LABELS,
  bestChampionViews,
  championIconUrl,
  formatAge,
  formatDuration,
  formatLpChange,
  kdaRatio,
  lpEvidenceTitle,
  matchDetailsUrl,
  mostPlayedChampionViews,
  outcomeLabel,
  profileUrl,
  rankLabel,
} from "../../lib/ui-format";
import { ChevronDownIcon, ExternalIcon, MoonIcon, RoleIcon } from "./icons";
import {
  Avatar,
  ChampionBars,
  ChampionTiles,
  FormPills,
  InfoHint,
  MatchLine,
  PlayerSummary,
  RankEmblem,
  RespawnPill,
  RoleList,
  WINRATE_BAR_HINT,
  tierClass,
} from "./primitives";

export const ROW_CHAMPION_SLOTS = 4;
const DETAIL_CHAMPION_SLOTS = 5;

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
  const unranked = player.tier === "UNRANKED";
  const role = player.riotIdFound ? player.analytics.mainRole : "UNKNOWN";
  const champions = player.riotIdFound ? bestChampionViews(player.analytics.championCounts, ROW_CHAMPION_SLOTS) : [];
  const games = player.wins + player.losses;
  const detailId = `detalle-${player.id}`;

  // The whole row opens the detail for a pointer; keyboards use the toggle
  // button, and links inside the row keep doing what links do.
  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("a, button")) return;
    onToggle();
  };

  return (
    <m.li
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: Math.min(0.3, (place - 4) * 0.035), ease: [0.22, 1, 0.36, 1] }}
      className={`srow${open ? " is-open" : ""}${dead ? " is-dead" : ""}${unranked ? " is-unranked" : ""}`}
      data-ranking-id={player.id}
    >
      <div className="srow__main srow-grid" onClick={handleRowClick}>
        <span className="srow__place">
          <b className="mono">{place}</b>
          <PlaceDelta delta={player.placeDelta} />
        </span>

        <a className="srow__player" href={profileUrl(player)} target="_blank" rel="noreferrer" aria-label={`Ver perfil de ${player.gameName} en League of Graphs`}>
          <Avatar player={player} version={version} size={36} className="srow__avatar" />
          <span className="srow__who" translate="no">
            <strong>{player.gameName}</strong>
            <small className="srow__meta">
              <span className="mono">#{player.tagLine}</span>
              <span aria-hidden="true">·</span>
              <RoleIcon role={role} size={12} />
              <span>{ROLE_LABELS[role]}</span>
            </small>
            {respawnSeconds !== null ? (
              <small className="srow__respawn-inline">
                <MoonIcon size={12} />
                <span>Reaparece en</span>
                <b className="mono">{formatRespawnClock(respawnSeconds)}</b>
              </small>
            ) : null}
          </span>
          <RoleIcon role={role} size={12} className="srow__role-mark" />
        </a>

        <span className="srow__rank">
          <RankEmblem tier={player.tier} size={40} className="srow__emblem" />
          <span className="srow__rank-text">
            <span className="srow__tier">
              <b className={tierClass(player.tier)}>{rankLabel(player)}</b>
              <span className="mono">{player.leaguePoints} PL</span>
            </span>
          </span>
        </span>

        <div className="srow__stats">
        <span
          className="srow__wr"
          role="group"
          aria-label={player.riotIdFound ? `Winrate ${player.winRate.toFixed(1)}%, ${player.wins} victorias y ${player.losses} derrotas` : "Winrate sin datos"}
        >
          <span className="srow__wr-top">
            <b className="mono">{games > 0 ? `${player.winRate.toFixed(1)}%` : "—"}</b>
            <small className="mono">{player.wins}V {player.losses}D</small>
          </span>
          <span className="wr-bar" aria-hidden="true"><i style={{ width: `${games > 0 ? Math.max(2, player.winRate) : 0}%` }} /></span>
        </span>

        <span className="srow__kda mono col-kda" aria-label={`KDA ${player.analytics.kda.toFixed(1)}`}>
          {player.analytics.games > 0 ? player.analytics.kda.toFixed(1) : "—"}
        </span>

        <span className="srow__form"><FormPills results={player.recentResults} withText /></span>

        <span className="srow__champs">
          <ChampionTiles champions={champions} version={version} />
        </span>

        <span className="srow__match col-match">
          {respawnSeconds !== null
            ? <RespawnPill seconds={respawnSeconds} playerName={player.gameName} />
            : <MatchLine player={player} roster={roster} version={version} now={now} compact />}
        </span>
        </div>

        <button
          type="button"
          className="srow__toggle"
          aria-expanded={open}
          aria-controls={detailId}
          aria-label={`${open ? "Ocultar" : "Ver"} el detalle de ${player.gameName}`}
          onClick={onToggle}
        >
          <ChevronDownIcon size={16} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <m.div
            key="detail"
            id={detailId}
            className="srow__detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <RowDetail player={player} version={version} roster={roster} now={now} />
          </m.div>
        ) : null}
      </AnimatePresence>
    </m.li>
  );
}

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
          return (
            <span
              key={index}
              className={`roster__slot${isSelf ? " is-self" : ""}${isPeer ? " is-peer" : ""}`}
              title={`${participant.championName} · ${participant.gameName}`}
            >
              {participant.championId
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={championIconUrl(version, participant.championId)} alt={participant.championName} width={28} height={28} loading="lazy" decoding="async" />
                : null}
            </span>
          );
        })}
      </span>
    </div>
  );
}

function RowDetail({ player, version, roster, now }: {
  player: PlayerSnapshot;
  version: string;
  roster: readonly PlayerSnapshot[];
  now: number;
}) {
  const [order, setOrder] = useState<"best" | "most">("best");
  const counts = player.analytics.championCounts;
  const champions = order === "best"
    ? bestChampionViews(counts, DETAIL_CHAMPION_SLOTS)
    : mostPlayedChampionViews(counts, DETAIL_CHAMPION_SLOTS);
  const match = player.lastSoloQueueMatch;

  let matchBlock = <p className="empty-note">Sin partidas SoloQ recientes</p>;
  if (match) {
    const remake = isRemakeMatch(match);
    const outcome = remake ? "remake" : match.win ? "win" : "loss";
    const lp = formatLpChange(match.lpChangeEvidence, remake);
    const lpTone = remake ? "neutral" : match.lpChangeEvidence.status === "observed"
      ? (match.lpChangeEvidence.value < 0 ? "loss" : "win")
      : "pending";
    const { allies, enemies } = orderMatchRoster(match.participants, player.id);
    matchBlock = (
      <>
        <p className="detail__result">
          <b className={`outcome is-${outcome}`}>{outcomeLabel(outcome)}</b>
          {lp ? <span className={`mono lp-change is-${lpTone}`} title={lpEvidenceTitle(match.lpChangeEvidence, remake)}>{lp}</span> : null}
          <span className="muted">{formatDuration(match.durationSeconds)} · {formatAge(match.gameStartTimestamp, now)}</span>
        </p>
        <p className="detail__kda">
          <b className="mono">{match.kills} / {match.deaths} / {match.assists}</b>
          <small className="mono">KDA {kdaRatio(match.kills, match.deaths, match.assists)}</small>
        </p>
        {allies.length > 0 ? (
          <div className="roster">
            <RosterRow label="Su equipo" slots={allies} playerId={player.id} version={version} />
            {enemies.length > 0 ? <RosterRow label="Rivales" slots={enemies} playerId={player.id} version={version} /> : null}
          </div>
        ) : null}
      </>
    );
  }
  const matchHref = match ? matchDetailsUrl(match.matchId) : null;

  return (
    <div className="detail">
      <section className="detail__block" aria-label={`Campeones de ${player.gameName}`}>
        <div className="section-label">
          <span>Campeones</span>
          <span className="segmented" role="group" aria-label="Ordenar campeones">
            <button type="button" aria-pressed={order === "best"} onClick={() => setOrder("best")}>Mejores</button>
            <button type="button" aria-pressed={order === "most"} onClick={() => setOrder("most")}>Más jugados</button>
          </span>
        </div>
        <ChampionBars champions={champions} version={version} label={`Campeones de ${player.gameName}`} />
        <div className="detail__hint"><InfoHint label={WINRATE_BAR_HINT}>Cómo leer las barras</InfoHint></div>
      </section>

      <section className="detail__block" aria-label={`Roles de ${player.gameName}`}>
        <div className="section-label"><span>Roles</span></div>
        <RoleList player={player} />
      </section>

      <section className="detail__block" aria-label={`Última partida de ${player.gameName}`}>
        <div className="section-label">
          <span>Última partida</span>
          {matchHref ? (
            <a href={matchHref} target="_blank" rel="noreferrer" className="text-link">
              Ver en League of Graphs <ExternalIcon size={12} />
            </a>
          ) : null}
        </div>
        {matchBlock}
      </section>

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
