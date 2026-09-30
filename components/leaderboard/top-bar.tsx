import type { MouseEvent } from "react";
import { GaspiDoor } from "./gaspi-door";

/**
 * The section links only move the scroll. They leave the URL alone (a hash
 * would be re-applied by some mobile browsers whenever their toolbar resizes,
 * pulling the page back) and keep no "current" state, so nothing about them
 * follows the reader's scrolling. The stylesheet's `scroll-padding-top` and
 * `scroll-behavior` (off under reduced motion) decide where and how it lands.
 */
function goToSection(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ block: "start" });
}

export function TopBar({ liveCount, onOpenGaspi }: {
  liveCount: number;
  onOpenGaspi: () => void;
}) {
  const liveText = liveCount === 1 ? "1 en partida" : `${liveCount} en partida`;

  return (
    <header className="topbar">
      <div className="topbar__inner shell">
        <span className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand__logo" src="/brand-logo.webp" alt="" width={28} height={28} />
          <span className="brand__name">20Q Challenge</span>
        </span>
        <span className="topbar__rule" aria-hidden="true" />
        <span className="topbar__meta">LAS · Solo/Duo · Temporada 2026</span>
        <nav className="topbar__nav" aria-label="Secciones">
          {/* Phones say "Top": both links fit the bar, so neither has to hide. */}
          <a href="#clasificacion" aria-label="Clasificación" onClick={(event) => goToSection(event, "clasificacion")}>
            <span className="nav-full" aria-hidden="true">Clasificación</span>
            <span className="nav-short" aria-hidden="true">Top</span>
          </a>
          <a href="#duos" onClick={(event) => goToSection(event, "duos")}>Dúos</a>
        </nav>
        <span className="topbar__spacer" />
        {/* The board refreshes itself, so the only status here is a live one:
            it appears while someone is in a game and is absent otherwise. */}
        {liveCount > 0 ? (
          <span className="topbar__live">
            <i className="live-dot" aria-hidden="true" />
            <span className="sr-only">{liveText}</span>
            <span aria-hidden="true">{liveCount}<span className="topbar__live-text"> en partida</span></span>
          </span>
        ) : null}
        <GaspiDoor onOpen={onOpenGaspi} />
      </div>
    </header>
  );
}
