/**
 * Concurrency utilities for parallel data fetching.
 * @packageDocumentation
 */

/**
 * Execute a function on each item, with bounded concurrency.
 * @param items - Items to process.
 * @param fn - Async function to apply.
 * @param concurrency - Maximum concurrent operations (default 8).
 * @returns Array of results, in the same order as items.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  concurrency = 8,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let index = 0;

  const worker = async (): Promise<void> => {
    let currentIndex = index++;
    while (currentIndex < items.length) {
      results[currentIndex] = await fn(items[currentIndex]!);
      currentIndex = index++;
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());

  await Promise.all(workers);
  return results;
}
