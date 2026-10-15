import { config } from "../config";

/** Maximum Claude requests in flight per process (keeps bursts of new matches under rate limits). */
export const DEFAULT_AI_CONCURRENCY = 3;

export interface RunOptions {
  /** Interactive work (a user waiting on a draft) starts before queued background work. */
  priority?: "high" | "normal";
}

export interface Limiter {
  /** Run `task` once fewer than `concurrency` tasks are active. Settles with the task's result. */
  run<T>(task: () => Promise<T>, opts?: RunOptions): Promise<T>;
  readonly active: number;
  readonly pending: number;
}

/** In-process concurrency limiter. FIFO within each priority; high-priority tasks start first. */
export function createLimiter(concurrency: number = DEFAULT_AI_CONCURRENCY): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`Concurrency must be a positive integer, got ${concurrency}`);
  }
  let active = 0;
  const high: Array<() => void> = [];
  const normal: Array<() => void> = [];

  const startNext = () => {
    while (active < concurrency) {
      const start = high.shift() ?? normal.shift();
      if (!start) return;
      active++;
      start();
    }
  };

  return {
    run<T>(task: () => Promise<T>, opts: RunOptions = {}): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          // Promise.resolve().then(task) also turns a synchronous throw into a rejection.
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              active--;
              startNext();
            });
        };
        (opts.priority === "high" ? high : normal).push(start);
        startNext();
      });
    },
    get active() {
      return active;
    },
    get pending() {
      return high.length + normal.length;
    },
  };
}

/** Shared limiter for every Claude call made by this process (AI_CONCURRENCY at a time). Never nest `run` calls on it. */
export const aiLimiter = createLimiter(config.aiConcurrency);
