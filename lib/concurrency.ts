/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 * Workers pull from a shared queue; the result of each worker is discarded.
 * Errors thrown by a worker are returned in the `errors` array — the runner
 * itself does not throw, so one failing scene doesn't kill the whole batch.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<{ errors: Array<{ index: number; error: unknown }> }> {
  if (limit < 1) throw new Error("concurrency limit must be >= 1");
  const errors: Array<{ index: number; error: unknown }> = [];
  let cursor = 0;

  const runOne = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        await worker(items[i], i);
      } catch (error) {
        errors.push({ index: i, error });
      }
    }
  };

  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, runOne));
  return { errors };
}
