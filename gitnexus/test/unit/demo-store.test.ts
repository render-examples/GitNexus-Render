/**
 * Unit tests for DemoStore — the demo-mode ownership tracker.
 *
 * DemoStore keys ownership by canonical repo path and mirrors it to
 * `<GITNEXUS_HOME>/demo-owners.json` for crash recovery. Each test points
 * GITNEXUS_HOME at a fresh temp dir so persistence is isolated and real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DemoStore } from '../../src/server/demo-store.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.GITNEXUS_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-demostore-'));
  process.env.GITNEXUS_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.GITNEXUS_HOME;
  else process.env.GITNEXUS_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const repo = (name: string) => path.join(home, name);

describe('DemoStore ownership', () => {
  it('treats an unclaimed repo as a seed repo, and a claimed repo as owned', async () => {
    const store = new DemoStore();
    const p = repo('alpha');

    expect(store.isSeed(p)).toBe(true);
    expect(store.ownerOf(p)).toBeUndefined();

    await store.claim(p, 'sess-1');

    expect(store.isSeed(p)).toBe(false);
    expect(store.ownerOf(p)).toBe('sess-1');
    expect(store.ownedBy(p, 'sess-1')).toBe(true);
    expect(store.ownedBy(p, 'sess-2')).toBe(false);
    expect(store.ownedBy(p, undefined)).toBe(false);
  });

  it('lists repos owned by a session and drops them on release (back to seed)', async () => {
    const store = new DemoStore();
    await store.claim(repo('a'), 'sess-1');
    await store.claim(repo('b'), 'sess-1');
    await store.claim(repo('c'), 'sess-2');

    expect(store.reposOwnedBy('sess-1').sort()).toEqual(
      [repo('a'), repo('b')].map((p) => path.resolve(p)).sort(),
    );

    await store.release([repo('a'), repo('b')]);
    expect(store.reposOwnedBy('sess-1')).toEqual([]);
    expect(store.isSeed(repo('a'))).toBe(true); // released ⇒ seed again
    expect(store.ownedBy(repo('c'), 'sess-2')).toBe(true); // untouched
  });

  it('reports only sessions idle beyond the threshold', async () => {
    const store = new DemoStore();
    store.touch('fresh');

    expect(store.idleSessions(60_000)).toEqual([]); // just seen ⇒ not idle
    expect(store.idleSessions(-1)).toEqual(['fresh']); // any elapsed time is "idle"

    store.forgetSession('fresh');
    expect(store.idleSessions(-1)).toEqual([]);
  });
});

describe('DemoStore persistence (crash recovery)', () => {
  it('surfaces a prior run’s owned repos as boot orphans exactly once', async () => {
    const first = new DemoStore();
    await first.claim(repo('leaked'), 'sess-x');

    // A fresh store (new process) reads the persisted owners as orphans to erase.
    const afterCrash = new DemoStore();
    const orphans = await afterCrash.loadOrphans();
    expect(orphans).toEqual([path.resolve(repo('leaked'))]);

    // The store resets to empty and the file is cleared, so a subsequent boot
    // finds nothing (no repeated erase of already-gone repos).
    expect(afterCrash.reposOwnedBy('sess-x')).toEqual([]);
    const nextBoot = new DemoStore();
    expect(await nextBoot.loadOrphans()).toEqual([]);
  });

  it('loadOrphans is a no-op with an empty/absent owners file', async () => {
    const store = new DemoStore();
    expect(await store.loadOrphans()).toEqual([]);
  });
});
