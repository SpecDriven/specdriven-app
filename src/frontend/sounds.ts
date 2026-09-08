// The Pomodoro sounds (roadmap/support-for-human-code-sessions.md), made
// with Web Audio rather than shipped as files: the app has no asset
// pipeline for audio, the desktop shell's static server knows no audio
// MIME types, and a few oscillators with an envelope are all a chime is.
// Cirillo gives the sounds their roles — the ring announces the break, the
// tick externalizes the urge to finish — so the ring is a gentle chime (a
// harsh alarm startles) and the tick is off unless asked for.
//
// Browsers only let audio start from a user gesture: `unlock()` runs inside
// the click that starts a session, and creates the context then.

export type SoundName = "bell" | "chime" | "ding" | "woodblock" | "none";
export const SOUND_NAMES: readonly SoundName[] = ["bell", "chime", "ding", "woodblock", "none"];
export const SOUND_LABEL: Record<SoundName, string> = {
  bell: "Bell",
  chime: "Chime",
  ding: "Ding",
  woodblock: "Wood block",
  none: "None",
};

export function normalizeSoundName(value: unknown): SoundName | null {
  return SOUND_NAMES.includes(value as SoundName) ? (value as SoundName) : null;
}

// The slice of the Web Audio API the presets use — narrow enough for a fake
// in tests, which have no AudioContext at all.
export interface ParamLike {
  setValueAtTime(value: number, at: number): unknown;
  linearRampToValueAtTime(value: number, at: number): unknown;
  exponentialRampToValueAtTime(value: number, at: number): unknown;
}
export interface OscillatorLike {
  type: OscillatorType;
  frequency: ParamLike;
  connect(node: unknown): unknown;
  start(at: number): void;
  stop(at: number): void;
}
export interface GainLike {
  gain: ParamLike;
  connect(node: unknown): unknown;
}
export interface AudioLike {
  currentTime: number;
  destination: unknown;
  state: string;
  resume(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
}

let ctx: AudioLike | null = null;
let factory: (() => AudioLike) | null = null;

/** Tests swap the context in; null restores the real one (and forgets any open context). */
export function setAudioFactory(fn: (() => AudioLike) | null): void {
  factory = fn;
  ctx = null;
}

function hasAudio(): boolean {
  return factory !== null || typeof AudioContext !== "undefined";
}

/** Create (once) and resume the context — call from inside a user gesture. */
export function unlock(): void {
  if (!hasAudio()) return;
  if (!ctx) ctx = factory ? factory() : (new AudioContext() as unknown as AudioLike);
  if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
}

/** One note: an oscillator with a quick attack and an exponential decay. */
interface Tone {
  type: OscillatorType;
  freq: number;
  /** Glide to this frequency over the first 40 ms (the wood block's knock). */
  to?: number;
  /** Start, in seconds of context time. */
  at: number;
  /** Decay length in seconds. */
  dur: number;
  /** Peak gain, 0..1. */
  gain: number;
}

function tone(c: AudioLike, t: Tone): void {
  const osc = c.createOscillator();
  osc.type = t.type;
  osc.frequency.setValueAtTime(t.freq, t.at);
  if (t.to !== undefined) osc.frequency.exponentialRampToValueAtTime(t.to, t.at + 0.04);
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t.at);
  gain.gain.linearRampToValueAtTime(t.gain, t.at + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t.at + t.dur);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t.at);
  osc.stop(t.at + t.dur + 0.05);
}

const PRESETS: Record<Exclude<SoundName, "none">, (at: number) => Tone[]> = {
  // A struck bell: the fundamental with two inharmonic partials fading faster.
  bell: (at) => [
    { type: "sine", freq: 880, at, dur: 1.2, gain: 0.35 },
    { type: "sine", freq: 1760, at, dur: 0.9, gain: 0.15 },
    { type: "sine", freq: 2637, at, dur: 0.6, gain: 0.08 },
  ],
  // A rising C major arpeggio, each note a little after the last.
  chime: (at) => [
    { type: "sine", freq: 523.25, at, dur: 0.8, gain: 0.25 },
    { type: "sine", freq: 659.25, at: at + 0.12, dur: 0.8, gain: 0.25 },
    { type: "sine", freq: 783.99, at: at + 0.24, dur: 0.8, gain: 0.25 },
  ],
  // One short bright note.
  ding: (at) => [{ type: "triangle", freq: 1318.5, at, dur: 0.5, gain: 0.3 }],
  // A knock: a square wave dropping an octave in a few milliseconds.
  woodblock: (at) => [{ type: "square", freq: 800, to: 400, at, dur: 0.09, gain: 0.4 }],
};

/** Play the named sound; nothing without an unlocked context or for "none". */
export function play(name: SoundName): void {
  if (name === "none" || !ctx) return;
  const at = ctx.currentTime;
  for (const t of PRESETS[name](at)) tone(ctx, t);
}

/** The once-a-second tick during focus: very short, very quiet. */
export function tick(): void {
  if (!ctx) return;
  tone(ctx, { type: "sine", freq: 2000, at: ctx.currentTime, dur: 0.015, gain: 0.05 });
}

/** The dialog's ▶ button: unlock (it is a click) and play. */
export function preview(name: SoundName): void {
  unlock();
  play(name);
}

/** What the store needs of this module — swapped for a fake in its tests. */
export interface SoundPlayer {
  unlock(): void;
  play(name: SoundName): void;
  tick(): void;
}

export const sounds: SoundPlayer = { unlock, play, tick };
