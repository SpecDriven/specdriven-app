// The Pomodoro sounds (src/frontend/sounds.ts): each preset is a few
// oscillators with an envelope, nothing plays before a user gesture unlocks
// the context, and "none" is silence.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SOUND_NAMES, normalizeSoundName, play, preview, setAudioFactory, tick, unlock } from "../src/frontend/sounds";
import type { AudioLike, OscillatorLike } from "../src/frontend/sounds";

interface Note {
  type: string;
  freq: number[];
  started: number | null;
  stopped: number | null;
}

function fakeContext() {
  const notes: Note[] = [];
  const gains: number[][] = [];
  let resumed = 0;
  const ctx: AudioLike = {
    currentTime: 10,
    destination: "speaker",
    state: "suspended",
    resume: async () => {
      resumed += 1;
      ctx.state = "running";
    },
    createOscillator: () => {
      const note: Note = { type: "sine", freq: [], started: null, stopped: null };
      notes.push(note);
      const osc: OscillatorLike = {
        get type() {
          return note.type as OscillatorType;
        },
        set type(v) {
          note.type = v;
        },
        frequency: {
          setValueAtTime: (v) => note.freq.push(v),
          linearRampToValueAtTime: (v) => note.freq.push(v),
          exponentialRampToValueAtTime: (v) => note.freq.push(v),
        },
        connect: () => undefined,
        start: (at) => (note.started = at),
        stop: (at) => (note.stopped = at),
      };
      return osc;
    },
    createGain: () => {
      const ramp: number[] = [];
      gains.push(ramp);
      return {
        gain: {
          setValueAtTime: (v) => ramp.push(v),
          linearRampToValueAtTime: (v) => ramp.push(v),
          exponentialRampToValueAtTime: (v) => ramp.push(v),
        },
        connect: () => undefined,
      };
    },
  };
  return { ctx, notes, gains, resumed: () => resumed };
}

let fake: ReturnType<typeof fakeContext>;

beforeEach(() => {
  fake = fakeContext();
});

afterEach(() => {
  setAudioFactory(null);
});

describe("sounds", () => {
  test("nothing plays before a gesture unlocks the context", () => {
    setAudioFactory(() => fake.ctx);
    play("bell");
    tick();
    expect(fake.notes).toHaveLength(0);
    unlock();
    expect(fake.resumed()).toBe(1);
    play("bell");
    expect(fake.notes).toHaveLength(3);
  });

  test("without any AudioContext at all (bun test) everything is a no-op", () => {
    expect(typeof AudioContext).toBe("undefined");
    unlock();
    play("chime");
    preview("ding");
    expect(fake.notes).toHaveLength(0);
  });

  test("the bell is three sine partials; the chime three staggered notes", () => {
    setAudioFactory(() => fake.ctx);
    unlock();
    play("bell");
    expect(fake.notes.map((n) => [n.type, n.freq[0]])).toEqual([["sine", 880], ["sine", 1760], ["sine", 2637]]);
    expect(fake.notes.every((n) => n.started === 10)).toBe(true);
    fake.notes.length = 0;
    play("chime");
    expect(fake.notes.map((n) => n.started)).toEqual([10, 10.12, 10.24]);
  });

  test("the wood block knocks down an octave; the ding is one triangle; the tick is 15 ms", () => {
    setAudioFactory(() => fake.ctx);
    unlock();
    play("woodblock");
    expect(fake.notes[0]!.type).toBe("square");
    expect(fake.notes[0]!.freq).toEqual([800, 400]);
    play("ding");
    expect(fake.notes[1]!.type).toBe("triangle");
    tick();
    const t = fake.notes[2]!;
    expect(t.freq).toEqual([2000]);
    expect(t.stopped! - t.started!).toBeCloseTo(0.065);
  });

  test("none is silence, and every note has an envelope that decays to nothing", () => {
    setAudioFactory(() => fake.ctx);
    unlock();
    play("none");
    expect(fake.notes).toHaveLength(0);
    play("bell");
    for (const ramp of fake.gains) expect(ramp[ramp.length - 1]).toBe(0.0001);
  });

  test("preview unlocks and plays in one go", () => {
    setAudioFactory(() => fake.ctx);
    preview("ding");
    expect(fake.resumed()).toBe(1);
    expect(fake.notes).toHaveLength(1);
  });

  test("names are checked", () => {
    expect(SOUND_NAMES).toEqual(["bell", "chime", "ding", "woodblock", "none"]);
    expect(normalizeSoundName("bell")).toBe("bell");
    expect(normalizeSoundName("siren")).toBeNull();
  });
});
