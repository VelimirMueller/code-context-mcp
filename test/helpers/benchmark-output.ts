import os from 'os';
import path from 'path';

/**
 * Resolve where a benchmark results JSON file should be written.
 *
 * By default tests write to the OS temp directory so `pnpm test` never
 * dirties the repo-tracked results files (ticket #243). Set
 * BENCHMARK_WRITE_RESULTS=1 to write to the tracked repo path instead —
 * that is how the dashboard data is intentionally refreshed.
 */
export function resolveBenchmarkOutputPath(trackedPath: string): string {
  if (process.env.BENCHMARK_WRITE_RESULTS === '1') {
    return trackedPath;
  }
  return path.join(os.tmpdir(), path.basename(trackedPath));
}
