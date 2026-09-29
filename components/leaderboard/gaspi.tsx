import * as Dialog from "@radix-ui/react-dialog";
import type { CSSProperties } from "react";
import { ArrowLeftIcon } from "./icons";

/**
 * Los Juegos de Gaspi. The top-bar badge opens this title card, and opening it
 * repaints the ranking underneath in the tournament's gold — see
 * `html.is-invaded` in the stylesheet.
 */
export const GASPI_TITLE = "LOS JUEGOS DE GASPI";
const GASPI_LINES = ["Los Juegos", "de Gaspi"] as const;
const LETTER_START_MS = 350;
const LETTER_STEP_MS = 60;
const PARTICLE_COUNT = 18;

/** Deterministic rather than random: the field only has to look scattered, and a
    stable one survives a re-render without twitching. */
const PARTICLES: CSSProperties[] = Array.from({ length: PARTICLE_COUNT }, (_, index) => ({
  left: `${(index * 53 + 7) % 100}%`,
  top: `${(index * 37 + 11) % 100}%`,
  width: `${2 + (index % 3)}px`,
  height: `${2 + (index % 3)}px`,
  animationDuration: `${6 + (index % 5) * 1.3}s`,
  animationDelay: `${((index * 0.7) % 5).toFixed(1)}s`,
}));

function Beam() {
  return (
    <span className="gaspi__beam" aria-hidden="true">
      <i />
      <b />
      <i />
    </span>
  );
}

/**
 * On its first opening in a page load every letter arrives on its own delay, so
 * the name assembles instead of fading in as a block. After that the reveal has
 * been spent: `seen` opens the card as a place, not as an entrance.
 */
export function GaspiDialog({ open, seen, onOpenChange }: {
  open: boolean;
  seen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  let letterIndex = 0;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="gaspi-overlay" />
        <Dialog.Content className={`gaspi${seen ? " is-seen" : ""}`} aria-describedby={undefined}>
          <div className="gaspi__dust" aria-hidden="true">
            {PARTICLES.map((style, index) => <i key={index} style={style} />)}
          </div>
          <div className="gaspi__frame" aria-hidden="true" />
          <div className="gaspi__bar">
            <Dialog.Close className="gaspi__back">
              <ArrowLeftIcon size={16} />
              Volver al ranking
            </Dialog.Close>
            <span className="gaspi__esc" aria-hidden="true"><kbd>Esc</kbd> para volver</span>
          </div>
          <div className="gaspi__stage">
            <span className="gaspi__kicker">20Q Challenge</span>
            <Beam />
            <Dialog.Title className="gaspi__title">
              <span className="sr-only">Los Juegos de Gaspi</span>
              {GASPI_LINES.map((line) => (
                <span className="gaspi__line" key={line} aria-hidden="true">
                  {[...line].map((character, index) => (
                    <span
                      key={`${line}-${index}`}
                      className="gaspi__letter"
                      style={seen ? undefined : { animationDelay: `${LETTER_START_MS + letterIndex++ * LETTER_STEP_MS}ms` }}
                    >
                      {character === " " ? " " : character}
                    </span>
                  ))}
                </span>
              ))}
            </Dialog.Title>
            <Beam />
            <p className="gaspi__sub">Torneo 1v1 · Temporada 2026</p>
            <div className="gaspi__hall">
              <span className="gaspi__kicker">Sala de la fama</span>
              <article className="gaspi__edition">
                <div>
                  <strong>Edición I</strong>
                  <small>Campeón por definirse</small>
                </div>
                <span className="gaspi__slot" role="img" aria-label="Campeón sin definir">?</span>
              </article>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

let helicopterPlayed = false;

/**
 * The rotor that arrives with Los Juegos: brown noise chopped by an LFO at
 * blade frequency over a low body tone, panned slowly across the stereo field.
 * Synthesised rather than shipped, because seven seconds of audio would weigh
 * more than the whole ranking.
 *
 * Once per page load, and only from the click that opens the card — which is
 * also what lets the audio context start at all. Anything unsupported, refused
 * or broken leaves the view exactly as it was.
 */
export function playHelicopter() {
  if (helicopterPlayed) return;
  helicopterPlayed = true;
  try {
    const AudioContextConstructor = window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;

    const context = new AudioContextConstructor();
    const duration = 7.5;
    const now = context.currentTime;

    const master = context.createGain();
    master.gain.setValueAtTime(0, now);
    master.gain.linearRampToValueAtTime(0.05, now + 1.4);
    master.gain.setValueAtTime(0.05, now + 4.6);
    master.gain.linearRampToValueAtTime(0, now + duration);

    const sampleCount = Math.floor(context.sampleRate * duration);
    const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const samples = buffer.getChannelData(0);
    let previous = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      const white = Math.random() * 2 - 1;
      previous = (previous + 0.02 * white) / 1.02;
      samples[index] = previous * 3.5;
    }

    const noise = context.createBufferSource();
    noise.buffer = buffer;
    const lowpass = context.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 300;
    lowpass.Q.value = 0.7;

    const chop = context.createGain();
    chop.gain.value = 0.55;
    const bladeRate = context.createOscillator();
    bladeRate.frequency.setValueAtTime(11.2, now);
    bladeRate.frequency.linearRampToValueAtTime(13.4, now + duration);
    const bladeDepth = context.createGain();
    bladeDepth.gain.value = 0.45;
    bladeRate.connect(bladeDepth);
    bladeDepth.connect(chop.gain);

    // The body shares the chop, so the hum pulses with the blades.
    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.value = 52;
    const bodyGain = context.createGain();
    bodyGain.gain.value = 0.32;

    if (typeof context.createStereoPanner === "function") {
      const panner = context.createStereoPanner();
      const panRate = context.createOscillator();
      panRate.frequency.value = 0.16;
      const panDepth = context.createGain();
      panDepth.gain.value = 0.55;
      panRate.connect(panDepth);
      panDepth.connect(panner.pan);
      master.connect(panner);
      panner.connect(context.destination);
      panRate.start(now);
      panRate.stop(now + duration);
    } else {
      master.connect(context.destination);
    }

    noise.connect(lowpass);
    lowpass.connect(chop);
    chop.connect(master);
    body.connect(bodyGain);
    bodyGain.connect(chop);

    noise.start(now);
    bladeRate.start(now);
    body.start(now);
    noise.stop(now + duration);
    bladeRate.stop(now + duration);
    body.stop(now + duration);
    window.setTimeout(() => { void context.close().catch(() => undefined); }, (duration + 0.4) * 1_000);
  } catch {
    // No audio is not a failure state: the card opens either way.
  }
}
