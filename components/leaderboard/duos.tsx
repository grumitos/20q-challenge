import { useState } from "react";
import { DUO_LEADERBOARD_MIN_GAMES, type DuoRecord, type PlayerSnapshot } from "../../lib/leaderboard";
import { duoView, firstName, rankLabel } from "../../lib/ui-format";
import { Avatar } from "./primitives";

/** On a phone the table shows this many pairs until asked for the rest. */
const MOBILE_DUO_LIMIT = 6;

export function Duos({ duos, players, version }: {
  duos: readonly DuoRecord[];
  players: readonly PlayerSnapshot[];
  version: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = duos
    .map((duo) => {
      const [first, second] = duo.playerIds.map((id) => players.find((player) => player.id === id));
      return first && second ? { duo, first, second } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  if (rows.length === 0) return null;
  const busiest = Math.max(...rows.map(({ duo }) => duo.games));

  return (
    <section id="duos" className="duos shell" aria-labelledby="duos-title">
      <div className="section-head">
        <h2 id="duos-title">Mejores dúos</h2>
        <span>Mínimo {DUO_LEADERBOARD_MIN_GAMES} partidas juntos · ordenados por winrate ajustado</span>
      </div>
      <div className={`board board--duos${expanded ? " is-expanded" : ""}`}>
        <div className="board__head drow-grid" aria-hidden="true">
          <span>#</span>
          <span>Dúo</span>
          <span>Partidas juntos</span>
          <span>Winrate juntos</span>
          <span className="col-record">Récord</span>
          <span className="col-adjusted">Ajustado</span>
        </div>
        <ol className="board__body">
          {rows.map(({ duo, first, second }, index) => {
            const view = duoView(duo);
            const place = index + 1;
            const names = `${firstName(first.gameName)} + ${firstName(second.gameName)}`;
            const record = `${view.wins}V ${view.losses}D`;
            return (
              <li
                key={duo.playerIds.join("-")}
                className={`drow${place <= 3 ? ` place-${place}` : ""}${index >= MOBILE_DUO_LIMIT ? " is-extra" : ""}`}
              >
                <div className="drow__main drow-grid">
                  <b className="drow__place mono">{place}</b>
                  <span className="drow__pair">
                    <span className="drow__avatars" aria-hidden="true">
                      <Avatar player={first} version={version} size={30} />
                      <Avatar player={second} version={version} size={30} />
                    </span>
                    <span className="drow__names" translate="no">
                      <strong>{names}</strong>
                      <small className="drow__ranks">{rankLabel(first)} · {rankLabel(second)}</small>
                      <small className="drow__mobile-meta mono">{view.games}p · {record}</small>
                    </span>
                  </span>
                  <span className="drow__games" aria-label={`${view.games} partidas juntos`}>
                    <b className="mono" aria-hidden="true">{view.games}</b>
                    <span className="volume" aria-hidden="true"><i style={{ width: `${Math.round((view.games / busiest) * 100)}%` }} /></span>
                  </span>
                  <span className="drow__wr" role="group" aria-label={`${names}: ${view.winRate.toFixed(1)}% de winrate juntos, ${record}`}>
                    <span className="drow__wr-top" aria-hidden="true">
                      <b className={`mono tone-${view.tone}`}>{view.winRate.toFixed(1)}%</b>
                      <small className="mono drow__wr-record">{record}</small>
                      <small className="mono drow__wr-adjusted">aj. {view.adjusted.toFixed(1)}%</small>
                    </span>
                    <span className={`wr-track is-${view.tone}`} aria-hidden="true">
                      <i className="wr-track__observed" style={{ width: `${view.winRate}%` }} />
                      <i className="wr-track__adjusted" style={{ width: `${view.adjusted}%` }} />
                    </span>
                  </span>
                  <span className="drow__record mono col-record">{record}</span>
                  <span className="drow__adjusted mono col-adjusted" aria-label={`Winrate ajustado ${view.adjusted.toFixed(1)}%`}>{view.adjusted.toFixed(1)}%</span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      {rows.length > MOBILE_DUO_LIMIT ? (
        <button type="button" className="duos__more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Ver menos" : `Ver los ${rows.length} dúos`}
        </button>
      ) : null}
    </section>
  );
}
