// Value Accumulator — batched parallel fixture processing.
//
// Fixtures used to be processed one at a time: a 40-match live scan (and a
// 30-day backtest with several hundred finished matches) awaited
// resolveBzzoiroEvent → fetchSummary → xG → engine → odds for each match in
// turn, so the wall clock was the SUM of every HTTP round trip. This module is
// the single primitive both scanner loops now run on.
//
// Contract (mirrors the ticket that introduced it):
//   RULE 1 — at most `FIXTURE_BATCH_SIZE` (3) fixtures in flight. Bzzoiro's free
//            tier rate-limits aggressively; more concurrency costs more than it
//            saves.
//   RULE 2 — order preservation. The results array is pre-sized and each worker
//            writes to its own index (results[i + j]). Nothing is ever pushed,
//            so the output order is the input order no matter which fixture
//            finishes first. The ticket builder's determinism depends on it.
//   RULE 3 — per-fixture isolation. Each worker is wrapped in try/catch and a
//            failure writes null at that index instead of rejecting the batch:
//            one bad fixture can never abort a scan.
//
// Lives in its own module (rather than in performScan.ts) so scanner.ts can
// import it without a circular dependency — performScan.ts already imports
// scanner.ts and re-exports this primitive so callers/tests have one entry
// point.

/** Maximum number of fixtures processed concurrently. */
export const FIXTURE_BATCH_SIZE = 3;

/** Retry one connection-level failure once; application errors fail fast. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code
      ?? (error as { code?: string })?.code;
    if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ECONNRESET" || code === "ETIMEDOUT") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return fn();
    }
    throw error;
  }
}

/**
 * Per-fixture worker. Return `null` to drop the fixture from the compacted
 * results (e.g. no Bzzoiro event, no odds) — a thrown error has the same effect
 * but is logged.
 */
export type FixtureWorker<T, R> = (item: T, index: number) => Promise<R | null>;

/**
 * Runs `worker` over `items` in batches of `batchSize`, awaiting each batch
 * before starting the next.
 *
 * Returns the index-aligned results array: `results[k]` is the outcome of
 * `items[k]`, or null when that worker returned null or threw. Use
 * {@link compactFixtureResults} to drop the nulls while keeping the order.
 */
export async function runFixtureBatches<T, R>(
  items: readonly T[],
  worker: FixtureWorker<T, R>,
  batchSize: number = FIXTURE_BATCH_SIZE,
  label: (item: T, index: number) => string = (_item, index) => `#${index}`,
): Promise<Array<R | null>> {
  // Pre-sized, index-addressed: never push() (RULE 2).
  const results = new Array<R | null>(items.length).fill(null);
  if (items.length === 0) return results;

  const size = Number.isFinite(batchSize) && batchSize > 0
    ? Math.floor(batchSize)
    : FIXTURE_BATCH_SIZE;

  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    await Promise.all(
      batch.map(async (item, j) => {
        try {
          results[i + j] = await withRetry(() => worker(item, i + j));
        } catch (err) {
          // RULE 3 — one fixture failing must not abort the batch.
          console.error(`[VA] fixture ${label(item, i + j)} failed:`, err);
          results[i + j] = null;
        }
      }),
    );
  }

  return results;
}

/** Drops the null slots of an index-aligned result array, preserving order. */
export function compactFixtureResults<R>(results: Array<R | null>): R[] {
  return results.filter((r): r is R => r !== null);
}
