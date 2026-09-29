import { m } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { PlayerSnapshot } from "../../lib/leaderboard";
import {
  ROLE_LABELS,
  bestChampionViews,
  championSplashUrl,
  gapText,
  profileUrl,
  rankLabel,
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
  RankEmblem,
  RespawnPill,
  Stitch,
  WINRATE_BAR_HINT,
  tierClass,
} from "./primitives";

export const PODIUM_CHAMPION_SLOTS = 5;

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
                gap={gapText(standings, index)}
                shortGap={gapText(standings, index, true)}
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

function PodiumCard({ player, place, gap, shortGap, version, roster, now, respawnSeconds, featured }: {
  player: PlayerSnapshot;
  place: number;
  gap: string;
  shortGap: string;
  version: string;
  roster: readonly PlayerSnapshot[];
  now: number;
  respawnSeconds: number | null;
  /** The card being looked at on a touch screen; see `useFeaturedCard`. */
  featured: boolean;
}) {
  const champions = player.riotIdFound ? bestChampionViews(player.analytics.championCounts, PODIUM_CHAMPION_SLOTS) : [];
  const splash = champions[0];
  const role = player.riotIdFound ? player.analytics.mainRole : "UNKNOWN";
  const dead = respawnSeconds !== null;
  const games = player.wins + player.losses;

  return (
    <m.article
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: (place - 1) * 0.06, ease: [0.22, 1, 0.36, 1] }}
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
            <span className="pcard__role">
              <RoleIcon role={role} />
              <span>{player.riotIdFound ? `${ROLE_LABELS[role]} ${player.analytics.roleShare}%` : ROLE_LABELS.UNKNOWN}</span>
              <span aria-hidden="true">·</span>
              <span>{player.analytics.games} partidas</span>
            </span>
          </a>
        </div>

        <div className="plate">
          <div className="plate__rank">
            <div className="plate__head">
              <RankEmblem tier={player.tier} size={56} className="plate__emblem" />
              <div className="plate__figures">
                <span className={`plate__tier ${tierClass(player.tier)}`}>{rankLabel(player)}</span>
                <span className="plate__lp" aria-label={`${player.leaguePoints} PL`}>
                  <b className="mono" aria-hidden="true">{player.leaguePoints}</b>
                  <small aria-hidden="true">PL</small>
                </span>
                {gap ? (
                  <span className="plate__gap">
                    <span className="gap-long">{gap}</span>
                    <span className="gap-short" aria-hidden="true">{shortGap}</span>
                  </span>
                ) : null}
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

      <div className="pcard__side">
        <Stitch />
        {respawnSeconds !== null
          ? <div className="pcard__respawn"><RespawnPill seconds={respawnSeconds} playerName={player.gameName} /></div>
          : <MatchLine player={player} roster={roster} version={version} now={now} />}
        <Stitch />
        <div className="pcard__champs">
          <div className="section-label">
            <span>Mejores campeones</span>
            <InfoHint label={WINRATE_BAR_HINT}>partidas · winrate</InfoHint>
          </div>
          <div className="pcard__champs-bars">
            <ChampionBars champions={champions} version={version} label={`Mejores campeones de ${player.gameName}`} />
          </div>
          <div className="pcard__champs-tiles">
            <ChampionTiles champions={champions} version={version} showGames size={36} />
          </div>
        </div>
      </div>
      </div>
    </m.article>
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
            <span className="sk sk-line" style={{ width: 150, height: 10 }} />
          </span>
        </div>
        <div className="plate">
          <div className="plate__rank">
            <div className="plate__head">
              <span className="sk" style={{ width: 48, height: 48, borderRadius: 12 }} />
              <div className="plate__figures">
                <span className="sk sk-line" style={{ width: 70, height: 10 }} />
                <span className="sk sk-line" style={{ width: 54, height: 26 }} />
              </div>
            </div>
          </div>
          <div className="plate__stats">
            {Array.from({ length: 4 }, (_, index) => <span key={index} className="sk sk-line" style={{ width: 110, height: 10 }} />)}
          </div>
        </div>
      </div>
      <div className="pcard__side">
        <Stitch />
        <div className="mline is-empty"><span className="sk sk-line" style={{ width: "70%", height: 12 }} /></div>
        <Stitch />
        <div className="pcard__champs">
          {Array.from({ length: 5 }, (_, index) => <span key={index} className="sk sk-line sk-champ" />)}
        </div>
      </div>
      </div>
    </article>
  );
}
