/**
 * Shared memory-sizing helpers for RAM-aware V8 heap caps.
 *
 * Both the CLI re-exec (`cli/analyze.ts`) and the server analyze worker
 * (`server/analyze-launch.ts`) size their `--max-old-space-size` from the
 * host's available memory. This module is the single home for the
 * constrained-memory probe and the `0.75 ×` sizing arithmetic so the two call
 * sites can't drift; they differ only in their floor (see `heapCapMb`).
 *
 * @module
 */

/**
 * The cgroup/container memory limit in bytes, or `null` when unconstrained or
 * unavailable.
 *
 * NOTE: `process.constrainedMemory()` returns a huge sentinel (not `0`) on some
 * runtimes when UNCONSTRAINED, so this value is only a *candidate* cap. Callers
 * must ignore it when it is not smaller than physical RAM — {@link heapCapMb}
 * does exactly that.
 */
export function readConstrainedBytes(): number | null {
  if (typeof process.constrainedMemory !== 'function') return null;
  const c = process.constrainedMemory();
  return typeof c === 'number' && c > 0 ? c : null;
}

/**
 * RAM-aware old-space heap cap (MB): `0.75 × effective RAM`, clamped to
 * `>= floorMb`. Kept BELOW physical RAM on purpose — a cap `>=` RAM makes V8
 * collect lazily and inflate the heap into swap-thrash, and in a memory-limited
 * container it lets the cgroup OOM-killer fire before V8's own recoverable
 * heap-limit.
 *
 * `constrainedBytes` (the cgroup limit or `null`) is honored ONLY when it is a
 * real, smaller-than-physical cap, because `process.constrainedMemory()`
 * returns a huge sentinel when UNCONSTRAINED (see {@link readConstrainedBytes}).
 */
export function heapCapMb(
  totalBytes: number,
  constrainedBytes: number | null,
  floorMb: number,
): number {
  const effectiveBytes =
    constrainedBytes !== null && constrainedBytes > 0 && constrainedBytes < totalBytes
      ? constrainedBytes
      : totalBytes;
  const effectiveMb = Math.floor(effectiveBytes / (1024 * 1024));
  return Math.max(floorMb, Math.floor(0.75 * effectiveMb));
}
