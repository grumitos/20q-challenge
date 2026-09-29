import { RefreshIcon, TrophyIcon } from "./icons";
import { GASPI_TITLE } from "./gaspi";

export function TopBar({ updatedAt, stale, liveCount, onRefresh, onOpenGaspi }: {
  /** Lima "HH:MM" of the snapshot on screen, or null while nothing has loaded. */
  updatedAt: string | null;
  stale: boolean;
  liveCount: number;
  onRefresh: () => void;
  onOpenGaspi: () => void;
}) {
  const liveText = liveCount === 0 ? "Nadie en partida" : liveCount === 1 ? "1 en partida" : `${liveCount} en partida`;
  const statusLabel = updatedAt === null ? "Cargando" : stale ? "Sin actualizar desde" : "Actualizado";

  return (
    <header className="topbar">
      <div className="topbar__inner shell">
        <button type="button" className="brand" onClick={onRefresh} aria-label="Actualizar el marcador" title="Actualizar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand__logo" src="/brand-logo.webp" alt="" width={28} height={28} />
          <span className="brand__name">20Q Challenge</span>
        </button>
        <span className="topbar__rule" aria-hidden="true" />
        <span className="topbar__meta">LAS · Solo/Duo · Temporada 2026</span>
        <nav className="topbar__nav" aria-label="Secciones">
          <a href="#clasificacion" className="is-current">Clasificación</a>
          <a href="#duos">Dúos</a>
        </nav>
        <span className="topbar__spacer" />
        <span className={`topbar__status${stale ? " is-stale" : ""}`}>
          <i className="status-dot" aria-hidden="true" />
          <span className="topbar__status-label">{statusLabel}</span>
          <b className="mono">{updatedAt ?? "--:--"}</b>
          <button type="button" className="icon-button topbar__refresh" onClick={onRefresh} aria-label="Actualizar ahora" title="Actualizar ahora">
            <RefreshIcon size={14} />
          </button>
        </span>
        <span className="topbar__rule topbar__rule--live" aria-hidden="true" />
        <span className={`topbar__live${liveCount > 0 ? " is-live" : ""}`}>
          {liveCount > 0 ? <i className="live-dot" aria-hidden="true" /> : null}
          {liveText}
        </span>
        <button type="button" className="gaspi-button" onClick={onOpenGaspi} aria-label={`Abrir ${GASPI_TITLE}`}>
          <TrophyIcon size={16} />
          <span className="gaspi-button__label">Los Juegos de Gaspi</span>
          <span className="gaspi-button__edition mono">Ed. I</span>
        </button>
      </div>
    </header>
  );
}
