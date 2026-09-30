import { m } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { PlayerSnapshot } from "../../lib/leaderboard";
import { EASE, ENTRANCE } from "../../lib/motion";
import {
  ROLE_LABELS,
  bestChampionViews,
  championSplashUrl,
  mostPlayedChampionViews,
  profileUrl,
  rankLabel,
  type ChampionView,
} from "../../lib/ui-format";
import { RoleIcon } from "./icons";
import {
  Avatar,
  ChampionBars,
  ChampionTiles,
  FormPills,
  InfoHint,
  MatchLine,
  PlaceChip,
  PlayerSummary,
  RankEmblem,
  RespawnPill,
  RoleList,
  Segmented,
  Stitch,
  WINRATE_BAR_HINT,
  tierClass,
} from "./primitives";

export const PODIUM_CHAMPION_SLOTS = 5;

/** What a podium card's lower panel can show: the same facts a row keeps in its detail. */
const PANEL_VIEWS = [
  ["best", "Mejores"],
  ["most", "Más jugados"],
  ["roles", "Roles"],
  ["summary", "Resumen"],
] as const;
type PanelView = (typeof PANEL_VIEWS)[number][0];

/** How much more of itself another card needs on screen to take the featured colour. */
const FEATURE_SWITCH_MARGIN = 1.15;

type PodiumProps = {
  standings: readonly PlayerSnapshot[];
  version: string;
  now: number;
  respawnFor: (player: PlayerSnapshot) => number | null;
  pending: boolean;
};

/**
 * Touch screens have no hover to bring a card's art back to full colour, so
 * the card being looked at gets it instead: the one with the most of itself on
 * screen below the sticky top bar. Only ever one, and only where hover is not
 * available; elsewhere this stays null and hover does the job.
 */
function useFeaturedCard(grid: RefObject<HTMLDivElement | null>, active: boolean) {
  const [featured, setFeatured] = useState<string | null>(null);
  useEffect(() => {
    const container = grid.current;
    if (!active || !container || !window.matchMedia("(hover: none)").matches) return;
    let frame = 0;
    let current: string | null = null;
    const update = () => {
      frame = 0;
      const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
      const areas = new Map<string, number>();
      for (const card of container.querySelectorAll<HTMLElement>(".pcard[data-ranking-id]")) {
        const rect = card.getBoundingClientRect();
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, top);
        areas.set(card.dataset.rankingId ?? "", Math.max(0, visibleHeight) * rect.width);
      }
      let best: string | null = null;
      let bestArea = 0;
      for (const [id, area] of areas) {
        if (area > bestArea) {
          bestArea = area;
          best = id;
        }
      }
      // The card already featured keeps it until another clearly has more on
      // screen, so two cards at about the same height do not trade the colour
      // back and forth while the page is nudged.
      const currentArea = current === null ? 0 : areas.get(current) ?? 0;
      if (currentArea > 0 && bestArea < currentArea * FEATURE_SWITCH_MARGIN) best = current;
      current = best;
      setFeatured(best);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    const resized = new ResizeObserver(schedule);
    resized.observe(container);
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      resized.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [grid, active]);
  return active ? featured : null;
}

export function Podium({ standings, version, now, respawnFor, pending }: PodiumProps) {
  const grid = useRef<HTMLDivElement>(null);
  const featured = useFeaturedCard(grid, !pending);
  return (
    <section id="clasificacion" className="podium shell" aria-labelledby="podio-title">
      <h2 id="podio-title" className="sr-only">Top 3 del ranking</h2>
      {/* Places stay 1-2-3 in the document so focus follows the reading order;
          the leader's weight comes from width and the medal, not from reordering. */}
      <div className="podium__grid" ref={grid}>
        {pending
          ? [1, 2, 3].map((place) => <PodiumSkeleton key={place} place={place} />)
          : standings.slice(0, 3).map((player, index) => (
              <PodiumCard
                key={player.id}
                player={player}
                place={index + 1}
                version={version}
                roster={standings}
                now={now}
                respawnSeconds={respawnFor(player)}
                featured={featured === player.id}
              />
            ))}
      </div>
    </section>
  );
}

function PodiumCard({ player, place, version, roster, now, respawnSeconds, featured }: {
  player: PlayerSnapshot;
  place: number;
  version: string;
  roster: readonly PlayerSnapshot[];
  now: number;
  respawnSeconds: number | null;
  /** The card being looked at on a touch screen; see `useFeaturedCard`. */
  featured: boolean;
}) {
  // The art follows the best champion whichever view the panel shows, so
  // switching views never repaints the cover.
  const best = player.riotIdFound ? bestChampionViews(player.analytics.championCounts, PODIUM_CHAMPION_SLOTS) : [];
  const splash = best[0];
  const role = player.riotIdFound ? player.analytics.mainRole : "UNKNOWN";
  const dead = respawnSeconds !== null;
  const games = player.wins + player.losses;

  return (
    <m.article
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: ENTRANCE.card.duration, delay: (place - 1) * ENTRANCE.card.step, ease: EASE }}
      className={`pcard place-${place}${dead ? " is-dead" : ""}${featured ? " is-featured" : ""}`}
      data-ranking-id={player.id}
    >
      <div className="pcard__body">
      <div className="pcard__art">
        {splash ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="pcard__splash" src={championSplashUrl(splash.id)} alt="" decoding="async" fetchPriority={place === 1 ? "high" : "auto"} />
        ) : null}
        <PlaceChip place={place} />
      </div>

      <div className="pcard__main">
        <div className="pcard__identity">
          <Avatar player={player} version={version} size={52} className="pcard__avatar" />
          <a className="pcard__who" href={profileUrl(player)} target="_blank" rel="noreferrer" aria-label={`Ver perfil de ${player.gameName} en League of Graphs`}>
            <span className="pcard__name" translate="no">
              <strong>{player.gameName}</strong>
              <small className="mono">#{player.tagLine}</small>
            </span>
            {/* The role's icon and share sit at the row's far end; its name is
                the tooltip. The games played are the record's V + D below. */}
            <span
              className="pcard__role"
              title={player.riotIdFound ? `${ROLE_LABELS[role]} · ${player.analytics.roleShare}% de sus partidas` : ROLE_LABELS.UNKNOWN}
            >
              <RoleIcon role={role} />
              <span className="mono">{player.riotIdFound ? `${player.analytics.roleShare}%` : "—"}</span>
            </span>
          </a>
        </div>

        <div className="plate">
          <div className="plate__grid">
            <div className="plate__rank">
              <div className="plate__head">
                <RankEmblem tier={player.tier} size={70} className="plate__emblem" />
                <div className="plate__figures">
                  <span className={`plate__tier ${tierClass(player.tier)}`}>{rankLabel(player)}</span>
                  <span className="plate__lp" aria-label={`${player.leaguePoints} PL`}>
                    <b className="mono" aria-hidden="true">{player.leaguePoints}</b>
                    <small aria-hidden="true">PL</small>
                  </span>
                </div>
              </div>
            </div>

            <dl className="plate__stats">
              <div>
                <dt>Winrate</dt>
                <dd className="mono">{games > 0 ? `${player.winRate.toFixed(1)}%` : "—"}</dd>
              </div>
              <div className="plate__record">
                <dt>Récord</dt>
                <dd className="mono">{player.wins}V {player.losses}D</dd>
              </div>
              <div>
                <dt>KDA</dt>
                <dd className="mono">{player.analytics.games > 0 ? player.analytics.kda.toFixed(1) : "—"}</dd>
              </div>
              <div>
                <dt>Últimas 5</dt>
                <dd><FormPills results={player.recentResults} /></dd>
              </div>
            </dl>
          </div>
        </div>
        {/* The last match closes the card's plain part; only the panel below
            it sits on the dot grid. */}
        <Stitch />
        {respawnSeconds !== null
          ? <div className="pcard__respawn"><RespawnPill seconds={respawnSeconds} playerName={player.gameName} /></div>
          : <MatchLine player={player} roster={roster} version={version} now={now} />}
        <Stitch />
      </div>

      <div className="pcard__side">
        <PodiumPanel player={player} roster={roster} version={version} best={best} />
      </div>
      </div>
    </m.article>
  );
}

/**
 * The card's lower panel. It keeps the view to itself, so a switch re-renders
 * the panel and never the card: the card's layout animation is for the podium
 * moving, and on a phone, where the views are not all the same height, it
 * would stretch the whole card into its new size.
 */
function PodiumPanel({ player, roster, version, best }: {
  player: PlayerSnapshot;
  roster: readonly PlayerSnapshot[];
  version: string;
  best: readonly ChampionView[];
}) {
  // Null until the reader picks a view: only their switches bring a view in
  // with motion, and the first paint keeps just the card's own entrance.
  const [chosen, setChosen] = useState<PanelView | null>(null);
  const view = chosen ?? "best";
  const champions = view === "most" && player.riotIdFound
    ? mostPlayedChampionViews(player.analytics.championCounts, PODIUM_CHAMPION_SLOTS)
    : best;
  const showingChampions = view === "best" || view === "most";

  return (
    <div className="pcard__champs">
      <div className="section-label">
        <Segmented options={PANEL_VIEWS} value={view} onChange={setChosen} label={`Qué mostrar de ${player.gameName}`} />
        {showingChampions ? <InfoHint label={WINRATE_BAR_HINT} /> : null}
      </div>
      {/* The views swap in place at one height, so switching never moves the podium. */}
      <div className="pcard__panel">
        <div key={view} className={chosen === null ? undefined : "swap-in"}>
          {showingChampions ? (
            <>
              <div className="pcard__champs-bars">
                <ChampionBars
                  champions={champions}
                  version={version}
                  label={`${view === "best" ? "Mejores campeones" : "Campeones más jugados"} de ${player.gameName}`}
                />
              </div>
              <div className="pcard__champs-tiles">
                <ChampionTiles champions={champions} version={version} showGames size={36} />
              </div>
            </>
          ) : view === "roles" ? (
            <RoleList player={player} />
          ) : (
            <PlayerSummary player={player} roster={roster} version={version} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The loading card: the real frame with shimmering blocks where the values go. */
function PodiumSkeleton({ place }: { place: number }) {
  return (
    <article className={`pcard place-${place} is-pending`} aria-hidden="true">
      <div className="pcard__body">
      <div className="pcard__art"><PlaceChip place={place} /></div>
      <div className="pcard__main">
        <div className="pcard__identity">
          <span className="avatar pcard__avatar sk" style={{ width: 52, height: 52 }} />
          <span className="pcard__who">
            <span className="sk sk-line" style={{ width: 120, height: 14 }} />
            <span className="sk sk-line" style={{ width: 36, height: 12 }} />
          </span>
        </div>
        <div className="plate">
          <div className="plate__grid">
            <div className="plate__rank">
              <div className="plate__head">
                <span className="sk" style={{ width: 58, height: 48, borderRadius: 12 }} />
                <div className="plate__figures">
                  <span className="sk sk-line" style={{ width: 70, height: 10 }} />
                  <span className="sk sk-line" style={{ width: 54, height: 26 }} />
                </div>
              </div>
            </div>
            <div className="plate__stats">
              {Array.from({ length: 4 }, (_, index) => <span key={index} className="sk sk-line" style={{ width: 56, height: 28 }} />)}
            </div>
          </div>
        </div>
        <Stitch />
        <div className="mline is-empty"><span className="sk sk-line" style={{ width: "70%", height: 12 }} /></div>
        <Stitch />
      </div>
      <div className="pcard__side">
        <div className="pcard__champs">
          {Array.from({ length: 5 }, (_, index) => <span key={index} className="sk sk-line sk-champ" />)}
        </div>
      </div>
      </div>
    </article>
  );
}
