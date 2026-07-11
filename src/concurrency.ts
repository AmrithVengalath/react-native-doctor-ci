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
  concurrency: number = 8,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  // Use a mutable array to hold results
  const results: any[] = Array.from({ length: items.length });
  let index = 0;

  const worker = async (): Promise<void> => {
    let currentIndex = index++;
    while (currentIndex < items.length) {
      (results as any)[currentIndex] = await fn(items[currentIndex]!);
      currentIndex = index++;
    }
  };

  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}
