import { describe, expect, it } from "vitest";
import { createLimiter, DEFAULT_AI_CONCURRENCY } from "./limiter";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createLimiter", () => {
  it("defaults to 3 concurrent tasks", () => {
    expect(DEFAULT_AI_CONCURRENCY).toBe(3);
  });

  it("never runs more than `concurrency` tasks at once and starts queued tasks in order", async () => {
    const limiter = createLimiter(3);
    const gates = Array.from({ length: 7 }, () => deferred<number>());
    const started: number[] = [];
    let running = 0;
    let peak = 0;

    const results = gates.map((gate, i) =>
      limiter.run(async () => {
        started.push(i);
        running++;
        peak = Math.max(peak, running);
        try {
          return await gate.promise;
        } finally {
          running--;
        }
      }),
    );

    await tick();
    expect(started).toEqual([0, 1, 2]);
    expect(limiter.active).toBe(3);
    expect(limiter.pending).toBe(4);

    gates[1].resolve(1);
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);

    gates.forEach((gate, i) => gate.resolve(i));
    await expect(Promise.all(results)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(3);
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it("propagates rejections (including synchronous throws) and keeps draining the queue", async () => {
    const limiter = createLimiter(1);
    const failing = limiter.run<number>(() => Promise.reject(new Error("boom")));
    const throwing = limiter.run<number>(() => {
      throw new Error("sync boom");
    });
    const ok = limiter.run(async () => 42);

    await expect(failing).rejects.toThrow("boom");
    await expect(throwing).rejects.toThrow("sync boom");
    await expect(ok).resolves.toBe(42);
    expect(limiter.active).toBe(0);
  });

  it("starts high-priority tasks before queued normal ones", async () => {
    const limiter = createLimiter(1);
    const gate = deferred();
    const order: string[] = [];
    const record = (name: string) => async () => {
      order.push(name);
    };

    const blocker = limiter.run(() => gate.promise);
    const tasks = [
      limiter.run(record("normal-1")),
      limiter.run(record("normal-2")),
      limiter.run(record("high-1"), { priority: "high" }),
      limiter.run(record("high-2"), { priority: "high" }),
    ];
    expect(limiter.pending).toBe(4);

    gate.resolve();
    await Promise.all([blocker, ...tasks]);
    expect(order).toEqual(["high-1", "high-2", "normal-1", "normal-2"]);
  });

  it("rejects invalid concurrency", () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
    expect(() => createLimiter(1.5)).toThrow(RangeError);
  });
});
