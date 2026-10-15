import { describe, expect, it } from "vitest";
import { CancelledError, TimeoutError, createLimiter, isCancellation, mapWithConcurrency, sleep, withTimeout } from "../async";
import { MarketplaceGate } from "../gate";

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("withTimeout", () => {
  it("resolves with the task's value", async () => {
    await expect(withTimeout(async () => 42, 1_000)).resolves.toBe(42);
  });

  it("rejects with TimeoutError and aborts the task's signal", async () => {
    let seen: AbortSignal | undefined;
    const pending = withTimeout((signal) => {
      seen = signal;
      return new Promise(() => {});
    }, 20);
    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it("rejects when the parent signal aborts", async () => {
    const parent = new AbortController();
    const pending = withTimeout(() => new Promise(() => {}), 10_000, parent.signal);
    parent.abort(new CancelledError("stop"));
    await expect(pending).rejects.toThrow("stop");
  });

  it("propagates the task's own error", async () => {
    await expect(withTimeout(async () => Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom");
  });
});

describe("sleep", () => {
  it("can be cancelled", async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(isCancellation(err)).toBe(true);
  });
});

describe("mapWithConcurrency", () => {
  it("limits parallelism, keeps order and captures failures", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
      if (n === 3) throw new Error("three");
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : "x"))).toEqual([10, 20, "x", 40, 50]);
  });

  it("handles empty input", async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});

describe("createLimiter", () => {
  it("runs at most max tasks at once and reports idle", async () => {
    const limiter = createLimiter(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((g, i) =>
      limiter.run(async () => {
        started.push(i);
        await g.promise;
      }),
    );
    await sleep(5);
    expect(started).toEqual([0, 1]);
    expect(limiter.size).toBe(3);
    gates[0].resolve();
    await sleep(5);
    expect(started).toEqual([0, 1, 2]);
    gates[1].resolve();
    gates[2].resolve();
    await limiter.idle();
    await Promise.all(runs);
    expect(limiter.size).toBe(0);
  });
});

describe("MarketplaceGate", () => {
  it("serializes calls per key and spaces them by minSpacing + jitter", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const gate = new MarketplaceGate({
      minSpacingMs: 3_000,
      jitterMs: 1_000,
      now: () => clock,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(`start ${name}`);
      await Promise.resolve();
      clock += 100;
      order.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([gate.run("craigslist", task("a")), gate.run("craigslist", task("b"))]);
    expect(results).toEqual(["a", "b"]);
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
    expect(sleeps).toEqual([3_500]);
  });

  it("does not make different keys wait for each other", async () => {
    const gate = new MarketplaceGate({ minSpacingMs: 60_000, jitterMs: 0 });
    const hold = deferred();
    const first = gate.run("craigslist", () => hold.promise);
    await expect(gate.run("ebay", async () => "ebay")).resolves.toBe("ebay");
    hold.resolve();
    await first;
  });

  it("keeps working after a task throws", async () => {
    const gate = new MarketplaceGate({ minSpacingMs: 0, jitterMs: 0 });
    await expect(gate.run("kijiji", async () => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    await expect(gate.run("kijiji", async () => "ok")).resolves.toBe("ok");
  });

  it("lets a waiting caller cancel without breaking the queue", async () => {
    const gate = new MarketplaceGate({ minSpacingMs: 0, jitterMs: 0 });
    const hold = deferred();
    const first = gate.run("offerup", () => hold.promise.then(() => "first"));
    const controller = new AbortController();
    const cancelled = gate.run("offerup", async () => "never", controller.signal);
    const third = gate.run("offerup", async () => "third");
    controller.abort(new CancelledError());
    await expect(cancelled).rejects.toBeInstanceOf(CancelledError);
    hold.resolve();
    await expect(first).resolves.toBe("first");
    await expect(third).resolves.toBe("third");
  });
});
