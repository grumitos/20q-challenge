import type { MetalFxProps } from "metal-fx";
import { useReducedMotion } from "motion/react";
import { Component, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { GASPI_TITLE } from "./gaspi";

type MetalFxComponent = ComponentType<MetalFxProps>;

/**
 * The package's gold reads as champagne, almost silver, on this door, so its
 * dark tuning takes warmer stops: deep shadow, pale-gold glint, gold, old gold
 * and a warm black. The engine, the motion and every other setting stay the
 * package's own. The shader reads the first five stops.
 */
const DOOR_GOLD = ["#000000", "#fff2d2", "#f2cf85", "#b98936", "#0d0b07", "#fffdc3", "#ffffff"] as const;

/** A throwaway WebGL context: metal-fx throws from its effects when there is none. */
function canRunMetal() {
  try {
    const context = document.createElement("canvas").getContext("webgl");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return context !== null;
  } catch {
    return false;
  }
}

/** Should the metal still fail once mounted, the door goes back to its still rim. */
class MetalFallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Los Juegos' door in the top bar. The page ships it with a still gilded rim;
 * once the page runs, metal-fx (Jakub Antalik's liquid-metal ring, in its gold
 * preset) loads in its own chunk and flows around the rim, held on one frame
 * under reduced motion.
 */
export function GaspiDoor({ onOpen }: { onOpen: () => void }) {
  const [Metal, setMetal] = useState<MetalFxComponent | null>(null);
  const reduceMotion = useReducedMotion() === true;

  useEffect(() => {
    if (!canRunMetal()) return;
    let cancelled = false;
    import("metal-fx").then(
      (module) => {
        module.PRESETS.gold.modes.dark.colors = [...DOOR_GOLD];
        if (!cancelled) setMetal(() => module.MetalFx);
      },
      () => { /* the still rim stays */ },
    );
    return () => { cancelled = true; };
  }, []);

  const door = (
    <button type="button" className="gaspi-button" onClick={onOpen} aria-label={`Abrir ${GASPI_TITLE}`}>
      {/* The tournament's own mark: the title's gilded Cinzel, in one letter. */}
      <span className="gaspi-mark" aria-hidden="true">G</span>
      <span className="gaspi-button__label">Los Juegos de Gaspi</span>
      <span className="gaspi-button__edition mono">Ed. I</span>
    </button>
  );
  if (!Metal) return door;

  return (
    <MetalFallback fallback={door}>
      <Metal className="gaspi-metal" preset="gold" theme="dark" strength={0.9} paused={reduceMotion} normalizeHostStyles={false}>
        {door}
      </Metal>
    </MetalFallback>
  );
}
