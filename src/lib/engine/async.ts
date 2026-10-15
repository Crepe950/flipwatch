/** Small async primitives: cancellable sleep, timeouts, bounded concurrency. */

export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)} s` : `${timeoutMs} ms`}`);
    this.name = "TimeoutError";
  }
}

export class CancelledError extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError || (err instanceof Error && err.name === "AbortError");
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new CancelledError();
}

/** Resolves when `signal` aborts; never resolves otherwise. Rejects with the abort reason. */
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(abortReason(signal));
    else signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
  });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Waits for `promise` but gives up (rejecting) as soon as `signal` aborts. */
export function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return Promise.race([promise, whenAborted(signal)]);
}

/**
 * Run `fn` with an AbortSignal that fires after `timeoutMs` (or when `parent` aborts), and reject with
 * TimeoutError/the parent's reason at that moment even if `fn` ignores the signal.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs);
  const onParentAbort = () => controller.abort(parent ? abortReason(parent) : new CancelledError());
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  try {
    return await Promise.race([fn(controller.signal), whenAborted(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}

/** Map over `items` with at most `limit` promises in flight. Never rejects; returns settled results in order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Tasks running or waiting. */
  readonly size: number;
  /** Resolves once nothing is running or queued. */
  idle(): Promise<void>;
}

/** A FIFO semaphore: at most `max` tasks run at once. */
export function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  let idleWaiters: Array<() => void> = [];

  const settleIdle = () => {
    if (active === 0 && queue.length === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  };

  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < max) {
        active++;
        resolve();
      } else {
        queue.push(() => {
          active++;
          resolve();
        });
      }
    });

  const release = () => {
    active--;
    queue.shift()?.();
    settleIdle();
  };

  return {
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get size() {
      return active + queue.length;
    },
    idle() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
