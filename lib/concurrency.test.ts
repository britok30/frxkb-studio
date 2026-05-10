import { describe, it, expect } from "vitest";
import { runWithConcurrency } from "./concurrency";

describe("runWithConcurrency", () => {
  it("runs all items", async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("respects the concurrency limit (never more than `limit` in flight)", async () => {
    let inFlight = 0;
    let peak = 0;

    await runWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(0);
  });

  it("collects errors instead of throwing — one failure doesn't poison the rest", async () => {
    const completed: number[] = [];
    const { errors } = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      if (n === 2) throw new Error("scene 2 failed");
      completed.push(n);
    });

    expect(completed.sort()).toEqual([1, 3, 4]);
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(1); // 0-based index of `2`
    expect((errors[0].error as Error).message).toBe("scene 2 failed");
  });

  it("returns empty when the input array is empty", async () => {
    const { errors } = await runWithConcurrency([], 4, async () => {
      throw new Error("should not run");
    });
    expect(errors).toEqual([]);
  });

  it("does not spawn more workers than items", async () => {
    let starts = 0;
    await runWithConcurrency([1, 2], 16, async () => {
      starts++;
    });
    expect(starts).toBe(2);
  });

  it("rejects a non-positive limit", async () => {
    await expect(
      runWithConcurrency([1], 0, async () => {})
    ).rejects.toThrow(/concurrency limit/);
  });
});
