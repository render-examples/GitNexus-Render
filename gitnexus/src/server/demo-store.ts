/**
 * Demo-mode ownership store.
 *
 * In read-only demo mode (DEMO env) visitors may still analyze/upload their own
 * repositories to explore them, but that data must not persist and must not be
 * visible to the next visitor. A repository must be in the shared registry to be
 * viewable, so isolation is done here: each visitor-added repo is *owned* by the
 * browser session that created it, and the server filters the registry per
 * session. A repo with no owner is a **seed** repo — the pre-indexed demo catalog
 * that every visitor may browse but none may mutate.
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
  /** repo canonical path → owning session. Absence ⇒ seed repo. */
  private owners = new Map<string, DemoOwner>();
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

  /** True when the repo has no owner — i.e. a seed (pre-indexed) repo. */
  isSeed(repoPath: string): boolean {
    return !this.owners.has(key(repoPath));
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
