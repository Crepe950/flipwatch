import { raceSignal, sleep } from "./async";

export interface GateOptions {
  /** Minimum pause between the end of one request and the start of the next to the same key. */
  minSpacingMs: number;
  /** Extra random pause in [0, jitterMs) added on top of minSpacingMs. */
  jitterMs: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * In-process politeness gate: requests for the same key (a marketplace) run one at a time, in arrival
 * order, with a randomized pause between them. Different keys never wait for each other.
 */
export class MarketplaceGate {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastDoneAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: GateOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? sleep;
  }

  async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    // The next caller waits for both the previous holder and us, so releasing early on abort is safe.
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);

    let started = false;
    try {
      await raceSignal(previous, signal);
      const last = this.lastDoneAt.get(key);
      if (last !== undefined) {
        const spacing = this.options.minSpacingMs + this.random() * this.options.jitterMs;
        const wait = last + spacing - this.now();
        if (wait > 0) await this.sleep(wait, signal);
      }
      started = true;
      return await fn();
    } finally {
      if (started) this.lastDoneAt.set(key, this.now());
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export const DEFAULT_GATE_SPACING_MS = 3_000;
export const DEFAULT_GATE_JITTER_MS = 1_500;

const globalForGate = globalThis as unknown as { __flipwatchGate?: MarketplaceGate };

/** The process-wide gate shared by every search run (survives Next dev HMR). */
export function defaultGate(): MarketplaceGate {
  globalForGate.__flipwatchGate ??= new MarketplaceGate({
    minSpacingMs: DEFAULT_GATE_SPACING_MS,
    jitterMs: DEFAULT_GATE_JITTER_MS,
  });
  return globalForGate.__flipwatchGate;
}
