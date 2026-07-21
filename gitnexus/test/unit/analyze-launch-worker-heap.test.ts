import { describe, expect, it } from 'vitest';

import { computeWorkerHeapCapMb, resolveWorkerHeapCapMb } from '../../src/server/analyze-launch.js';

// Mirrors the `computeHeapCapMb` tests in analyze-heap-respawn.test.ts, but for
// the server worker's container-aware ceiling. The key difference is the small
// WORKER_HEAP_FLOOR_MB (1024) floor instead of the CLI's 16384: the server runs
// in a memory-limited instance, so the cap must be able to sit BELOW physical
// RAM. A cap >= the container's RAM is exactly what lets the cgroup OOM-killer
// take down the whole service instead of just the worker.
describe('computeWorkerHeapCapMb (container-aware worker heap cap)', () => {
  const GB = 1024 * 1024 * 1024;

  it('sizes to 0.75x physical RAM when unconstrained', () => {
    // 4GB -> 4096MB -> floor(0.75 * 4096) = 3072
    expect(computeWorkerHeapCapMb(4 * GB, null)).toBe(3072);
  });

  it('clamps to the 1024 floor on a tiny box', () => {
    // 1GB -> 0.75 * 1024 = 768 -> clamped to 1024
    expect(computeWorkerHeapCapMb(1 * GB, null)).toBe(1024);
  });

  it('stays below RAM on a small (2GB) instance instead of overshooting it', () => {
    // The bug this fix closes: 2GB instance -> floor(0.75 * 2048) = 1536,
    // comfortably below the 2048MB cgroup limit (NOT the old hardcoded 8192).
    const cap = computeWorkerHeapCapMb(2 * GB, 2 * GB);
    expect(cap).toBe(1536);
    expect(cap).toBeLessThan(2048);
  });

  it('ignores the unconstrained sentinel from constrainedMemory()', () => {
    // ~1.8e19 sentinel > totalmem -> ignored, uses physical RAM
    expect(computeWorkerHeapCapMb(4 * GB, 1.8e19)).toBe(3072);
  });

  it('honors a real cgroup cap smaller than physical RAM', () => {
    // min(8, 4) = 4GB -> floor(0.75 * 4096) = 3072
    expect(computeWorkerHeapCapMb(8 * GB, 4 * GB)).toBe(3072);
  });

  it('uses physical RAM when the cgroup cap is not smaller', () => {
    // cap >= physical -> treated as unconstrained; 8GB -> floor(0.75 * 8192) = 6144
    expect(computeWorkerHeapCapMb(8 * GB, 8 * GB)).toBe(6144);
  });
});

describe('resolveWorkerHeapCapMb (GITNEXUS_SERVER_WORKER_MAX_OLD_SPACE_MB override)', () => {
  const GB = 1024 * 1024 * 1024;

  it('uses a valid positive-integer override verbatim, ignoring the auto-size', () => {
    // Override wins even though the auto-size of a 4GB box would be 3072.
    expect(resolveWorkerHeapCapMb('2048', 4 * GB, null)).toBe(2048);
  });

  it('falls back to the auto-size when the override is unset', () => {
    expect(resolveWorkerHeapCapMb(undefined, 4 * GB, null)).toBe(3072);
  });

  it('falls back to the auto-size when the override is invalid (non-numeric, zero, negative)', () => {
    expect(resolveWorkerHeapCapMb('not-a-number', 4 * GB, null)).toBe(3072);
    expect(resolveWorkerHeapCapMb('0', 4 * GB, null)).toBe(3072);
    expect(resolveWorkerHeapCapMb('-512', 4 * GB, null)).toBe(3072);
  });
});
