import { useState } from "react";
import type { PlayerSnapshot } from "../../lib/leaderboard";
import { mostPlayedChampionViews, type ChampionView } from "../../lib/ui-format";
import {
  ChampionBars,
  ChampionTiles,
  InfoHint,
  PlayerSummary,
  ROLES_HINT,
  RoleList,
  SUMMARY_HINT,
  Segmented,
  WINRATE_BAR_HINT,
} from "./primitives";

/** What the panel can show: the same facts a wide row detail lays out side by side. */
export const PANEL_VIEWS = [
  ["best", "Mejores"],
  ["most", "Más jugados"],
  ["roles", "Roles"],
  ["summary", "Resumen"],
] as const;
type PanelView = (typeof PANEL_VIEWS)[number][0];

/** Every view has its own "i", so the switch keeps one width whichever is shown. */
const VIEW_HINTS: Record<PanelView, string> = {
  best: WINRATE_BAR_HINT,
  most: WINRATE_BAR_HINT,
  roles: ROLES_HINT,
  summary: SUMMARY_HINT,
};

/**
 * A player's champions, roles and summary behind one switch: the podium card's
 * lower panel, and the row detail's on narrow screens, where four stacked
 * blocks would run the page long. It keeps the view to itself, so a switch
 * re-renders the panel and never the card or row around it: the card's layout
 * animation is for the podium moving, and on a phone, where the views are not
 * all the same height, it would stretch the whole card into its new size.
 */
export function PlayerPanel({ player, roster, version, best, slots, still = false, tiles = false }: {
  player: PlayerSnapshot;
  roster: readonly PlayerSnapshot[];
  version: string;
  /** The best champions in the order the list shows them. */
  best: readonly ChampionView[];
  /** How many champions a list holds. */
  slots: number;
  /** On curfew the panel keeps its first view and loses the switch. */
  still?: boolean;
  /** Also lay the champions out as tiles, for the podium's compact phone cards. */
  tiles?: boolean;
}) {
  // Null until the reader picks a view: only their switches bring a view in
  // with motion, and the first paint keeps just the entrance around it.
  const [chosen, setChosen] = useState<PanelView | null>(null);
  const view = still ? "best" : chosen ?? "best";
  const champions = view === "most" && player.riotIdFound
    ? mostPlayedChampionViews(player.analytics.championCounts, slots, player.recentChampions)
    : best;
  const showingChampions = view === "best" || view === "most";

  return (
    <div className="panel">
      {still ? null : (
        <div className="section-label panel__head">
          <Segmented options={PANEL_VIEWS} value={view} onChange={setChosen} label={`Qué mostrar de ${player.gameName}`} />
          <InfoHint label={VIEW_HINTS[view]} />
        </div>
      )}
      {/* The views swap in place at one height, so switching never moves what is below. */}
      <div className="panel__view">
        <div key={view} className={chosen === null ? undefined : "swap-in"}>
          {showingChampions ? (
            <>
              <div className="panel__bars">
                <ChampionBars
                  champions={champions}
                  version={version}
                  label={`${view === "best" ? "Mejores campeones" : "Campeones más jugados"} de ${player.gameName}`}
                />
              </div>
              {tiles ? (
                <div className="panel__tiles">
                  <ChampionTiles champions={champions} version={version} showGames size={36} />
                </div>
              ) : null}
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
