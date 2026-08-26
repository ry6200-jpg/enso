import { describe, expect, it, vi } from "vitest";
import { runSequenced } from "../app/lib/pageLoadReadQueue.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runSequenced (R71: mount-time reads for one uid never overlap)", () => {
  it("a second task for the SAME uid does not start until the first one settles", async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const task1 = vi.fn(async () => {
      order.push("task1 start");
      await first.promise;
      order.push("task1 end");
    });
    const task2 = vi.fn(async () => {
      order.push("task2 start");
    });

    const p1 = runSequenced("uid-a", task1);
    const p2 = runSequenced("uid-a", task2);

    // task2's function body must not have run yet — task1 hasn't settled.
    await Promise.resolve();
    await Promise.resolve();
    expect(task2).not.toHaveBeenCalled();

    first.resolve();
    await p1;
    await p2;

    expect(order).toEqual(["task1 start", "task1 end", "task2 start"]);
  });

  it("two DIFFERENT uids never wait on each other — independent queues", async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const p1 = runSequenced("uid-a", async () => {
      order.push("a start");
      await first.promise;
      order.push("a end");
    });
    const p2 = runSequenced("uid-b", async () => {
      order.push("b ran");
    });

    await p2; // uid-b's task completes without waiting on uid-a's still-pending task
    expect(order).toContain("b ran");
    expect(order).not.toContain("a end");

    first.resolve();
    await p1;
  });

  it("a rejected task never blocks the next task for the same uid", async () => {
    const p1 = runSequenced("uid-c", async () => {
      throw new Error("boom");
    });
    await expect(p1).rejects.toThrow("boom");

    let secondRan = false;
    const p2 = runSequenced("uid-c", async () => {
      secondRan = true;
    });
    await p2;
    expect(secondRan).toBe(true);
  });

  it("the caller's own promise still resolves/rejects exactly as task() does — sequencing never changes the result", async () => {
    const p1 = runSequenced("uid-d", async () => "real result");
    await expect(p1).resolves.toBe("real result");

    const p2 = runSequenced("uid-d", async () => {
      throw new Error("real failure");
    });
    await expect(p2).rejects.toThrow("real failure");
  });
});
