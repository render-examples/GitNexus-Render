/**
 * HTTP serve demo mode (DEMO env) — end-to-end route wiring.
 *
 * Spawns the built CLI (`gitnexus serve`) with and without DEMO=true and probes
 * real routes over HTTP. In demo mode visitors may still analyze their own
 * repositories, but the pre-indexed "seed" repos are read-only and visitor repos
 * are session-scoped. This suite seeds one repo into a temp registry (via the
 * in-process storage helpers — no full analysis needed) and asserts:
 *   - /api/info reports the flag the web UI reads
 *   - mutations targeting a seed repo are 403 (analyze/embed/delete)
 *   - starting a brand-new analysis is NOT demo-blocked (fails only on input)
 *   - read-only POSTs (query/search) are never demo-blocked
 *   - the /api/demo/end-session route exists only in demo mode
 *
 * Per-session ownership/filtering logic is unit-tested in test/unit/demo-store.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { getStoragePaths, registerRepo, saveMeta } from '../../src/storage/repo-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_CLI = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');

const STARTUP_BUDGET_MS = process.env.CI ? 30_000 : 15_000;
const SEED_REPO_NAME = 'seed-repo';

const allocateFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (typeof addr !== 'object' || !addr) {
        probe.close();
        reject(new Error('could not allocate ephemeral port'));
        return;
      }
      const port = addr.port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

interface Reply {
  status: number;
  body: string;
}

const request = (
  port: number,
  method: string,
  routePath: string,
  payload?: unknown,
  session?: string,
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const headers: Record<string, string> = {};
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(data));
    }
    if (session) headers['x-gitnexus-session'] = session;
    const req = http.request(
      { host: '127.0.0.1', port, method, path: routePath, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5_000, () => {
      req.destroy();
      reject(new Error(`${method} ${routePath} timed out`));
    });
    if (data) req.write(data);
    req.end();
  });

// POST an `application/x-www-form-urlencoded` body — mirrors how the web app's
// end-session beacon sends the session id (in the body, never the URL query
// string, so it can't leak into access logs).
const postForm = (port: number, routePath: string, form: Record<string, string>): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const data = new URLSearchParams(form).toString();
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: routePath,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(Buffer.byteLength(data)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5_000, () => {
      req.destroy();
      reject(new Error(`POST ${routePath} timed out`));
    });
    req.write(data);
    req.end();
  });

// Seed one registered repo into `homeDir` so the spawned server sees a seed
// (pre-indexed, unowned) repo. Uses the storage helpers directly — no analysis —
// which is enough for the guard assertions (they never open the graph). Restores
// GITNEXUS_HOME so seeding the registry does not leak into other tests.
const seedRepo = async (homeDir: string, repoDir: string): Promise<string> => {
  const prevHome = process.env.GITNEXUS_HOME;
  process.env.GITNEXUS_HOME = homeDir;
  try {
    fs.mkdirSync(repoDir, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir });
    git('init');
    git('config', 'user.email', 'gitnexus@example.com');
    git('config', 'user.name', 'GitNexus Test');
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export const a = 1;\n');
    git('add', 'a.ts');
    git('commit', '-m', 'seed');
    const storagePath = getStoragePaths(repoDir).storagePath;
    const meta = {
      repoPath: repoDir,
      lastCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      indexedAt: '2024-01-01T00:00:00Z',
      stats: { files: 1, nodes: 1, processes: 0 },
    };
    await saveMeta(storagePath, meta);
    await registerRepo(repoDir, meta, { name: SEED_REPO_NAME });
    return repoDir;
  } finally {
    if (prevHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = prevHome;
  }
};

// See server-http-startup.test.ts: spawned serve is reliable on Linux CI; skip
// on Windows where the listen socket can lag the "running" log line.
const describeDemo = process.platform === 'win32' ? describe.skip : describe;

describeDemo('gitnexus serve — demo mode (DEMO)', () => {
  let proc: ChildProcessWithoutNullStreams | undefined;
  let homeDir: string | undefined;

  const startServer = async (demo: boolean, seedRepoDir?: string): Promise<number> => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(`Missing ${DIST_CLI} — run npm run build before integration tests`);
    }
    const port = await allocateFreePort();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-demo-home-'));
    if (seedRepoDir) await seedRepo(homeDir, seedRepoDir);

    const env: NodeJS.ProcessEnv = { ...process.env, GITNEXUS_HOME: homeDir, NODE_OPTIONS: '' };
    if (demo) env.DEMO = 'true';
    else delete env.DEMO;

    proc = spawn(
      process.execPath,
      [DIST_CLI, 'serve', '--port', String(port), '--host', '127.0.0.1'],
      { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => (stdout += b.toString()));
    proc.stderr.on('data', (b) => (stderr += b.toString()));

    const startedAt = Date.now();
    while (Date.now() - startedAt < STARTUP_BUDGET_MS) {
      if (proc.exitCode !== null) {
        throw new Error(`serve exited ${proc.exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }
      try {
        const { status } = await request(port, 'GET', '/api/health');
        if (status === 200) return port;
      } catch {
        // still starting
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`serve did not become ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  };

  afterEach(async () => {
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc?.kill('SIGKILL');
          resolve();
        }, 3_000);
        proc?.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    proc = undefined;
    if (homeDir) {
      fs.rmSync(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  it('with DEMO=true: seed repos are read-only, new analyses are allowed, reads are not gated', async () => {
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-demo-seed-'));
    const session = 'sess-alpha';
    try {
      const port = await startServer(true, seedDir);

      // Flag the web UI reads.
      const info = await request(port, 'GET', '/api/info');
      expect(info.status).toBe(200);
      expect(JSON.parse(info.body).demo).toBe(true);

      // The seed repo is listed and marked not-owned (browsable, not the caller's).
      const repos = await request(port, 'GET', '/api/repos', undefined, session);
      expect(repos.status).toBe(200);
      const list = JSON.parse(repos.body) as Array<{ name: string; demoOwned?: boolean }>;
      const seed = list.find((r) => r.name === SEED_REPO_NAME);
      expect(seed, 'seed repo should be visible in demo mode').toBeTruthy();
      expect(seed?.demoOwned).toBe(false);

      // Mutations targeting the seed repo are blocked with a demo message.
      const del = await request(
        port,
        'DELETE',
        `/api/repo?repo=${SEED_REPO_NAME}`,
        undefined,
        session,
      );
      expect(del.status, 'delete seed').toBe(403);
      expect(JSON.parse(del.body).error).toContain('demo mode');

      const reanalyze = await request(port, 'POST', '/api/analyze', { path: seedDir }, session);
      expect(reanalyze.status, 're-analyze seed').toBe(403);
      expect(JSON.parse(reanalyze.body).error).toContain('read-only');

      const embed = await request(port, 'POST', `/api/embed?repo=${SEED_REPO_NAME}`, {}, session);
      expect(embed.status, 'embed seed').toBe(403);

      // Starting a brand-new analysis is NOT demo-blocked — it fails only for the
      // missing url/path input, never with a demo 403.
      const newAnalyze = await request(port, 'POST', '/api/analyze', {}, session);
      expect(newAnalyze.status, 'empty analyze is an input error, not a demo block').toBe(400);

      // Read-only POSTs are never demo-gated (gated by route, not verb).
      const query = await request(
        port,
        'POST',
        '/api/query',
        { query: 'MATCH (n) RETURN n' },
        session,
      );
      expect(query.status).not.toBe(403);
      const search = await request(port, 'POST', '/api/search', { query: 'x' }, session);
      expect(search.status).not.toBe(403);

      // The end-session endpoint exists and accepts the session via header or,
      // for the sendBeacon path (which can't set headers), a form body.
      const endHeader = await request(port, 'POST', '/api/demo/end-session', undefined, session);
      expect(endHeader.status).toBe(200);
      expect(JSON.parse(endHeader.body).ok).toBe(true);
      const endBody = await postForm(port, '/api/demo/end-session', { session: 'sess-beta' });
      expect(endBody.status).toBe(200);
      expect(JSON.parse(endBody.body).ok).toBe(true);
    } finally {
      fs.rmSync(seedDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('without DEMO: demo:false, no end-session route, analyze not demo-blocked', async () => {
    const port = await startServer(false);

    const info = await request(port, 'GET', '/api/info');
    expect(info.status).toBe(200);
    expect(JSON.parse(info.body).demo).toBe(false);

    // The demo-only route is not mounted outside demo mode.
    const end = await request(port, 'POST', '/api/demo/end-session', undefined, 'sess-x');
    expect(end.status).toBe(404);

    // Analyze still fails for input reasons, never with a demo 403.
    const analyze = await request(port, 'POST', '/api/analyze', {});
    expect(analyze.status).not.toBe(403);
  }, 60_000);
});
