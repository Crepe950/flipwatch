/**
 * "Play a sound for new deals" preference (per browser, localStorage) and a short Web Audio chime.
 * Everything is wrapped in try/catch: storage can be blocked and audio may be unavailable.
 */

const STORAGE_KEY = "flipwatch.feed.sound";
const listeners = new Set<() => void>();
let audioContext: AudioContext | null = null;
/** Used when localStorage is unavailable, so the toggle still works for this page view. */
let memoryFallback: boolean | null = null;

export function readSoundEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSoundEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    memoryFallback = enabled;
  }
  listeners.forEach((l) => l());
}

/** useSyncExternalStore adapters. */
export function subscribeSound(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function getSoundSnapshot(): boolean {
  return memoryFallback ?? readSoundEnabled();
}

export function getSoundServerSnapshot(): boolean {
  return false;
}

function context(): AudioContext | null {
  try {
    if (!audioContext) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioContext = new Ctor();
    }
    if (audioContext.state === "suspended") void audioContext.resume().catch(() => {});
    return audioContext;
  } catch {
    return null;
  }
}

/** Call from a click handler so browsers allow audio later (autoplay policies). */
export function unlockAudio(): void {
  context();
}

/** Two-note chime, ~0.4 s. */
export function playChime(): void {
  const ctx = context();
  if (!ctx) return;
  try {
    const start = ctx.currentTime + 0.01;
    [880, 1318.5].forEach((freq, i) => {
      const t = start + i * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  } catch {
    // Audio is best-effort.
  }
}
