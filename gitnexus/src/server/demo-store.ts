/**
 * Demo-mode ownership store.
 *
 * In read-only demo mode (DEMO env) visitors may still analyze/upload their own
 * repositories to explore them, but that data must not persist and must not be
 * visible to the next visitor. A repository must be in the shared registry to be
 * viewable, so isolation is done here: each visitor-added repo is *owned* by the
 * browser session that created it, and the server filters the registry per
 * session. A repo is a **seed** repo — part of the pre-indexed demo catalog that
 * every visitor may browse but none may mutate — only when it is *explicitly*
 * marked as one (see `markSeed`). Seeds are the registry snapshot taken at boot;
 * everything registered afterwards is either session-owned or hidden. Crucially,
 * absence of an owner no longer means "public": an unowned, unseeded repo (e.g.
 * one registered by a non-browser caller or across a deploy/restart race) is
 * hidden from everyone rather than silently leaking as a public seed.
 *
 * Ownership lives in memory but is mirrored to `<globalDir>/demo-owners.json` for
 * one reason only: crash recovery. If the process dies mid-session, the next boot
 * reads that file, erases the orphaned repos, and clears it — otherwise an
 * abandoned repo would linger on disk and, being unowned, be mistaken for a seed
 * repo (visible to everyone forever). Owned repos are erased when the session
 * ends (an explicit end-session beacon) or, as a backstop, after the session goes
 * idle. The erase of the on-disk index/registry entry is done by the caller
 * (api.ts owns the filesystem+registry teardown); this module only tracks who
 * owns what.
 */

import fsp from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { canonicalizePath, getGlobalDir } from '../storage/repo-manager.js';
import { retryRename } from '../storage/fs-atomic.js';
import { logger } from '../core/logger.js';

export interface DemoOwner {
  sessionId: string;
  createdAt: number;
}

const OWNERS_FILE = 'demo-owners.json';

/** Canonical key for a repo path — matches how the registry canonicalizes. */
const key = (repoPath: string): string => canonicalizePath(path.resolve(repoPath));

export class DemoStore {
  /** repo canonical path → owning session. */
  private owners = new Map<string, DemoOwner>();
  /**
   * Canonical paths of explicit seed repos — the curated catalog every visitor
   * may browse. Populated at boot from the registry snapshot (see api.ts). A
   * repo that is neither an explicit seed nor owned by the requesting session is
   * hidden, so a leaked/unclaimed repo defaults to invisible, not public.
   */
  private seeds = new Set<string>();
  /** sessionId → last-seen epoch ms (for idle-based session-end cleanup). */
  private sessions = new Map<string, number>();
  private readonly file: string;

  constructor() {
    this.file = path.join(getGlobalDir(), OWNERS_FILE);
  }

  /**
   * Read owners persisted by a previous run and return their repo paths as
   * boot orphans to be erased, then reset the store to empty. Never throws.
   */
  async loadOrphans(): Promise<string[]> {
    let parsed: Record<string, DemoOwner> = {};
    try {
      parsed = JSON.parse(await fsp.readFile(this.file, 'utf8')) as Record<string, DemoOwner>;
    } catch {
      parsed = {};
    }
    const orphanPaths = Object.keys(parsed);
    this.owners.clear();
    await this.persist();
    return orphanPaths;
  }

  private async persist(): Promise<void> {
    const obj: Record<string, DemoOwner> = {};
    for (const [k, v] of this.owners) obj[k] = v;
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      // Atomic tmp-file + rename (matches repo-manager's writeMetaFile). This
      // file exists only for crash recovery, so a torn write from a mid-write
      // crash must be impossible: loadOrphans would parse-fail on it, treat it
      // as empty, and leak the very orphaned repos it is meant to reclaim.
      const tmpPath = `${this.file}.tmp.${randomBytes(8).toString('hex')}`;
      const handle = await fsp.open(tmpPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(obj), 'utf8');
      } finally {
        await handle.close();
      }
      await retryRename(tmpPath, this.file);
    } catch (err) {
      logger.warn({ err }, '[demo] failed to persist demo owners');
    }
  }

  /**
   * True only when the repo is an explicitly marked seed (curated catalog).
   * An unowned, unseeded repo is NOT a seed — it is hidden from everyone.
   */
  isSeed(repoPath: string): boolean {
    return this.seeds.has(key(repoPath));
  }

  /** Mark a repo as an explicit seed (curated catalog, browsable by all). */
  markSeed(repoPath: string): void {
    this.seeds.add(key(repoPath));
  }

  /** Drop a repo's seed status (operator cleanup of a leaked/stale seed). */
  unmarkSeed(repoPath: string): void {
    this.seeds.delete(key(repoPath));
  }

  /** Number of explicit seed repos currently tracked (for boot logging). */
  seedCount(): number {
    return this.seeds.size;
  }

  ownerOf(repoPath: string): string | undefined {
    return this.owners.get(key(repoPath))?.sessionId;
  }

  /** True when `sessionId` is defined and owns `repoPath`. */
  ownedBy(repoPath: string, sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.ownerOf(repoPath) === sessionId;
  }

  /** Record `sessionId` as the owner of `repoPath` and touch the session. */
  async claim(repoPath: string, sessionId: string): Promise<void> {
    this.owners.set(key(repoPath), { sessionId, createdAt: Date.now() });
    this.touch(sessionId);
    await this.persist();
  }

  /** Bump a session's last-seen time (called on every request it makes). */
  touch(sessionId: string): void {
    this.sessions.set(sessionId, Date.now());
  }

  /** Canonical repo paths currently owned by `sessionId`. */
  reposOwnedBy(sessionId: string): string[] {
    const out: string[] = [];
    for (const [p, o] of this.owners) if (o.sessionId === sessionId) out.push(p);
    return out;
  }

  /** Drop ownership for repo paths that have already been erased on disk. */
  async release(repoPaths: string[]): Promise<void> {
    let changed = false;
    for (const p of repoPaths) changed = this.owners.delete(key(p)) || changed;
    if (changed) await this.persist();
  }

  /** Forget a session (after its repos are erased). */
  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Sessions whose last activity is older than `idleMs` — candidates to erase. */
  idleSessions(idleMs: number): string[] {
    const now = Date.now();
    const out: string[] = [];
    for (const [s, seen] of this.sessions) if (now - seen > idleMs) out.push(s);
    return out;
  }
}
