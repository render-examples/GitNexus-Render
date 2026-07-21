import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import http, { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverScript = join(__dirname, 'docker-server.mjs');

function getFreePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(port, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      await rawGet(port, '/');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('Server did not start in time');
}

let tmpDir, serverPort, child;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'gitnexus-docker-test-'));
  const distDir = join(tmpDir, 'dist');
  const assetsDir = join(distDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<html><body>spa</body></html>');
  await writeFile(join(assetsDir, 'app.abc123.js'), 'console.log("app")');

  serverPort = await getFreePort();
  child = spawn(process.execPath, [serverScript], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(serverPort) },
    stdio: 'pipe',
  });
  child.on('error', (err) => {
    throw err;
  });

  await waitForServer(serverPort);
});

function killAndWait(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) {
      resolve();
      return;
    }
    proc.once('exit', resolve);
    proc.kill();
    if (proc.exitCode !== null) resolve();
  });
}

after(async () => {
  await killAndWait(child);
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

it('serves a valid asset with immutable cache header', async () => {
  const res = await rawGet(serverPort, '/assets/app.abc123.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'], /immutable/);
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(res.headers['cross-origin-embedder-policy'], 'require-corp');
});

it('serves SPA fallback for unknown routes', async () => {
  const res = await rawGet(serverPort, '/some/unknown/route');
  assert.equal(res.status, 200);
  assert.match(res.body, /spa/);
  assert.match(res.headers['cache-control'], /no-cache/);
});

it('rejects path traversal with 400', async () => {
  const res = await rawGet(serverPort, '/../../../etc/passwd');
  assert.equal(res.status, 400);
});

it('rejects percent-encoded null bytes with 400', async () => {
  const res = await rawGet(serverPort, '/foo%00bar');
  assert.equal(res.status, 400);
});

it('rejects percent-encoded path traversal with 400', async () => {
  // %2e%2e%2f decodes to '../'. Without the path.relative inline barrier,
  // a naive string check on the raw URL would let this through and only
  // the lexical-decoded path.resolve would catch it. Confirm the barrier
  // does its job after decodeURIComponent.
  const res = await rawGet(serverPort, '/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
  assert.equal(res.status, 400);
});

it('rejects malformed percent-encoding with 400', async () => {
  // %GG is not a valid percent-encoded sequence — decodeURIComponent throws.
  // The handler's try/catch around decode must convert this to a 400 rather
  // than an unhandled rejection.
  const res = await rawGet(serverPort, '/foo%GGbar');
  assert.equal(res.status, 400);
});

it('returns 404 when dist/index.html is missing', async () => {
  await unlink(join(tmpDir, 'dist', 'index.html'));
  const res = await rawGet(serverPort, '/nonexistent-page');
  assert.equal(res.status, 404);
});

// -- Config injection: server-level integration tests ---

function spawnServerWithEnv(cwd, port, env) {
  const proc = spawn(process.execPath, [serverScript], {
    cwd,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: 'pipe',
  });
  proc.on('error', (err) => {
    throw err;
  });
  return proc;
}

async function withInjectionServer(envOverrides, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-inject-'));
  const distDir = join(dir, 'dist');
  const assetsDir = join(distDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  await writeFile(
    join(distDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body>app</body></html>',
  );
  await writeFile(join(assetsDir, 'style.abc.css'), 'body{}');

  const port = await getFreePort();
  const proc = spawnServerWithEnv(dir, port, envOverrides);
  try {
    await waitForServer(port);
    await fn(port);
  } finally {
    await killAndWait(proc);
    await rm(dir, { recursive: true, force: true });
  }
}

it('injects __GITNEXUS_CONFIG__ into / when GITNEXUS_BACKEND_URL is valid', async () => {
  await withInjectionServer({ GITNEXUS_BACKEND_URL: 'http://10.0.0.1:4747' }, async (port) => {
    const res = await rawGet(port, '/');
    assert.equal(res.status, 200);
    assert.ok(
      res.body.includes('window.__GITNEXUS_CONFIG__'),
      'Expected __GITNEXUS_CONFIG__ in response body',
    );
    assert.ok(res.body.includes('http://10.0.0.1:4747'), 'Expected backend URL in response body');
  });
});

it('injects __GITNEXUS_CONFIG__ into SPA fallback routes', async () => {
  await withInjectionServer({ GITNEXUS_BACKEND_URL: 'http://10.0.0.1:4747' }, async (port) => {
    const res = await rawGet(port, '/some/deep/link');
    assert.equal(res.status, 200);
    assert.ok(
      res.body.includes('window.__GITNEXUS_CONFIG__'),
      'Expected __GITNEXUS_CONFIG__ in SPA fallback response',
    );
    assert.ok(
      res.body.includes('http://10.0.0.1:4747'),
      'Expected backend URL in SPA fallback response',
    );
  });
});

it('does not inject when GITNEXUS_BACKEND_URL is not set', async () => {
  await withInjectionServer({}, async (port) => {
    const res = await rawGet(port, '/');
    assert.equal(res.status, 200);
    assert.ok(
      !res.body.includes('__GITNEXUS_CONFIG__'),
      'Expected no __GITNEXUS_CONFIG__ when env var is unset',
    );
  });
});

it('does not inject when GITNEXUS_BACKEND_URL is invalid', async () => {
  await withInjectionServer({ GITNEXUS_BACKEND_URL: 'not-a-url' }, async (port) => {
    const res = await rawGet(port, '/');
    assert.equal(res.status, 200);
    assert.ok(
      !res.body.includes('__GITNEXUS_CONFIG__'),
      'Expected no __GITNEXUS_CONFIG__ for invalid URL',
    );
  });
});

it('does not inject when GITNEXUS_BACKEND_URL uses a non-http protocol', async () => {
  await withInjectionServer({ GITNEXUS_BACKEND_URL: 'ftp://somehost:21' }, async (port) => {
    const res = await rawGet(port, '/');
    assert.equal(res.status, 200);
    assert.ok(
      !res.body.includes('__GITNEXUS_CONFIG__'),
      'Expected no __GITNEXUS_CONFIG__ for non-http protocol',
    );
  });
});

it('escapes </script> in GITNEXUS_BACKEND_URL to prevent XSS', async () => {
  const xssUrl = 'http://example.com/?x=</script><script>alert(1)</script>';
  await withInjectionServer({ GITNEXUS_BACKEND_URL: xssUrl }, async (port) => {
    const res = await rawGet(port, '/');
    assert.equal(res.status, 200);

    const scriptMatches = res.body.match(/<script>/gi) || [];
    assert.equal(
      scriptMatches.length,
      1,
      `Expected exactly 1 <script> tag but found ${scriptMatches.length}: XSS breakout detected`,
    );

    assert.ok(
      !res.body.includes('</script><script>'),
      '</script> must not appear unescaped -- would allow script breakout',
    );
    assert.ok(res.body.includes('\\u003c'), 'Angle brackets must be escaped as \\u003c');
  });
});

it('does not inject config into static assets', async () => {
  await withInjectionServer({ GITNEXUS_BACKEND_URL: 'http://10.0.0.1:4747' }, async (port) => {
    const res = await rawGet(port, '/assets/style.abc.css');
    assert.equal(res.status, 200);
    assert.ok(
      !res.body.includes('__GITNEXUS_CONFIG__'),
      'Static assets must not contain injected config',
    );
    assert.equal(res.body, 'body{}');
  });
});

// -- API reverse proxy (GITNEXUS_UPSTREAM_URL) -----------------------------

function rawRequest(port, path, { method = 'GET', headers = {}, body } = {}) {
  // Mirror how a browser's fetch() sends a string/buffer body: with an explicit
  // Content-Length (not chunked). The proxy's retry path only buffers requests
  // whose length is known, so tests must send one to exercise it realistically.
  const outHeaders = { ...headers };
  if (
    body !== undefined &&
    !Object.keys(outHeaders).some((h) => h.toLowerCase() === 'content-length')
  ) {
    outHeaders['content-length'] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: outHeaders },
      (res) => {
        let respBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          respBody += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: respBody }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Spins up a fake upstream API server plus a docker-server pointed at it.
// `upstream.handler` is mutable so each test can shape the upstream reply;
// `upstream.received` captures the last forwarded request.
async function withProxyServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-proxy-'));
  const distDir = join(dir, 'dist');
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<html><body>spa</body></html>');

  const upstream = {
    received: null,
    handler: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    },
  };
  const upstreamServer = createServer((req, res) => {
    let reqBody = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      reqBody += c;
    });
    req.on('end', () => {
      upstream.received = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: reqBody,
      };
      upstream.handler(req, res);
    });
  });
  const upstreamPort = await new Promise((resolve) => {
    upstreamServer.listen(0, '127.0.0.1', () => resolve(upstreamServer.address().port));
  });

  const port = await getFreePort();
  const proc = spawnServerWithEnv(dir, port, {
    GITNEXUS_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
    GITNEXUS_BACKEND_URL: `http://127.0.0.1:${port}`,
  });
  try {
    await waitForServer(port);
    await fn(port, upstream);
  } finally {
    await killAndWait(proc);
    await new Promise((r) => upstreamServer.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}

it('proxies /api/* requests to the upstream server', async () => {
  await withProxyServer(async (port, upstream) => {
    const res = await rawRequest(port, '/api/info?x=1');
    assert.equal(res.status, 200);
    assert.match(res.body, /"ok":true/);
    assert.equal(upstream.received.url, '/api/info?x=1', 'path + query forwarded verbatim');
  });
});

it('forwards the request method and body to the upstream', async () => {
  await withProxyServer(async (port, upstream) => {
    await rawRequest(port, '/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"q":"hello"}',
    });
    assert.equal(upstream.received.method, 'POST');
    assert.equal(upstream.received.body, '{"q":"hello"}');
  });
});

it('strips the browser Origin and Referer before forwarding to the API', async () => {
  await withProxyServer(async (port, upstream) => {
    await rawRequest(port, '/api/info', {
      headers: { origin: 'https://gitnexus-web.onrender.com', referer: 'https://x/y' },
    });
    assert.equal(
      upstream.received.headers.origin,
      undefined,
      'Origin must be stripped so the API treats it as a trusted server-to-server call',
    );
    assert.equal(upstream.received.headers.referer, undefined, 'Referer must be stripped');
  });
});

it('strips hop-by-hop headers before forwarding to the API', async () => {
  await withProxyServer(async (port, upstream) => {
    await rawRequest(port, '/api/info', {
      headers: {
        'keep-alive': 'timeout=5',
        upgrade: 'h2c',
        'proxy-authorization': 'Basic abc',
        te: 'trailers',
      },
    });
    assert.equal(upstream.received.headers['keep-alive'], undefined);
    assert.equal(upstream.received.headers.upgrade, undefined);
    assert.equal(upstream.received.headers['proxy-authorization'], undefined);
    assert.equal(upstream.received.headers.te, undefined);
  });
});

it('does NOT proxy non-/api routes (still serves the SPA)', async () => {
  await withProxyServer(async (port, upstream) => {
    const res = await rawRequest(port, '/some/app/route');
    assert.equal(res.status, 200);
    assert.match(res.body, /spa/);
    assert.equal(upstream.received, null, 'non-/api requests must not reach the upstream');
  });
});

it('streams a chunked upstream response through to the client', async () => {
  await withProxyServer(async (port, upstream) => {
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end();
      }, 20);
    };
    const res = await rawRequest(port, '/api/heartbeat');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.match(res.body, /data: one/);
    assert.match(res.body, /data: two/);
  });
});

it('accepts a scheme-less host:port upstream (Render fromService hostport)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-proxy-schemeless-'));
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'index.html'), '<html><body>spa</body></html>');

  let received = null;
  const upstreamServer = createServer((req, res) => {
    received = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await new Promise((resolve) => {
    upstreamServer.listen(0, '127.0.0.1', () => resolve(upstreamServer.address().port));
  });

  const port = await getFreePort();
  const proc = spawnServerWithEnv(dir, port, {
    // No http:// scheme — mimics `fromService: { property: hostport }`.
    GITNEXUS_UPSTREAM_URL: `127.0.0.1:${upstreamPort}`,
  });
  try {
    await waitForServer(port);
    const res = await rawRequest(port, '/api/info');
    assert.equal(res.status, 200);
    assert.equal(received, '/api/info', 'scheme-less upstream should still be proxied');
  } finally {
    await killAndWait(proc);
    await new Promise((r) => upstreamServer.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

it('serves RENDER_EXTERNAL_URL as the backend origin when GITNEXUS_BACKEND_URL is unset', async () => {
  await withInjectionServer(
    { RENDER_EXTERNAL_URL: 'https://gitnexus-web.onrender.com' },
    async (port) => {
      const res = await rawGet(port, '/');
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('window.__GITNEXUS_CONFIG__'));
      assert.ok(res.body.includes('https://gitnexus-web.onrender.com'));
    },
  );
});

it('returns 504 when the upstream does not respond within the timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-proxy-timeout-'));
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'index.html'), '<html><body>spa</body></html>');

  // Upstream accepts the connection but never responds — an idle hang.
  const upstreamServer = createServer(() => {});
  const upstreamPort = await new Promise((resolve) => {
    upstreamServer.listen(0, '127.0.0.1', () => resolve(upstreamServer.address().port));
  });

  const port = await getFreePort();
  const proc = spawnServerWithEnv(dir, port, {
    GITNEXUS_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
    GITNEXUS_PROXY_TIMEOUT_MS: '300',
  });
  try {
    await waitForServer(port);
    const res = await rawRequest(port, '/api/info');
    assert.equal(res.status, 504);
  } finally {
    await killAndWait(proc);
    upstreamServer.closeAllConnections?.();
    await new Promise((r) => upstreamServer.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

it('returns 502 when the upstream is unreachable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-proxy-down-'));
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'index.html'), '<html><body>spa</body></html>');
  const deadPort = await getFreePort(); // nothing listening here
  const port = await getFreePort();
  const proc = spawnServerWithEnv(dir, port, {
    GITNEXUS_UPSTREAM_URL: `http://127.0.0.1:${deadPort}`,
    // Disable retry so this fails fast (the unreachable-upstream contract).
    GITNEXUS_PROXY_RETRY_ATTEMPTS: '1',
  });
  try {
    await waitForServer(port);
    const res = await rawRequest(port, '/api/info');
    assert.equal(res.status, 502);
  } finally {
    await killAndWait(proc);
    await rm(dir, { recursive: true, force: true });
  }
});

// -- Connection-retry across an upstream restart window ---------------------

// A fake upstream that refuses the first `failFirst` connections (by not
// listening) then binds on the same port, mimicking a single-instance server
// restart. Retries in the proxy should absorb the gap so the first browser
// request still succeeds. `started` counts served requests.
async function withFlakyUpstream(failFirst, envOverrides, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-proxy-retry-'));
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'index.html'), '<html><body>spa</body></html>');

  const upstreamPort = await getFreePort(); // fixed port we bind late
  const state = { served: 0, lastBody: null };
  let upstreamServer = null;
  // Bind the upstream only after a short delay, so the first proxy attempt(s)
  // hit ECONNREFUSED (nothing listening) and must retry.
  const bindDelay = failFirst > 0 ? 400 : 0;
  const bindTimer = setTimeout(() => {
    upstreamServer = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        state.served += 1;
        state.lastBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    upstreamServer.listen(upstreamPort, '127.0.0.1');
  }, bindDelay);

  const port = await getFreePort();
  const proc = spawnServerWithEnv(dir, port, {
    GITNEXUS_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
    ...envOverrides,
  });
  try {
    await waitForServer(port);
    await fn(port, state);
  } finally {
    clearTimeout(bindTimer);
    await killAndWait(proc);
    if (upstreamServer) await new Promise((r) => upstreamServer.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}

it('retries a connection-refused POST and succeeds once the upstream is up', async () => {
  // Upstream binds after ~400ms; the default 3 attempts (backoff 250ms, 500ms)
  // span ~750ms, so a retry should land after the upstream comes up.
  await withFlakyUpstream(1, {}, async (port, state) => {
    const res = await rawRequest(port, '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"repo":"x"}',
    });
    assert.equal(res.status, 200, 'first attempt should ride out the restart gap');
    assert.match(res.body, /"ok":true/);
    assert.equal(state.served, 1, 'upstream must run the job exactly once (no double-execute)');
    assert.equal(state.lastBody, '{"repo":"x"}', 'buffered body replayed intact');
  });
});

it('returns 502 after exhausting the retry budget when the upstream stays down', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-proxy-retry-down-'));
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'index.html'), '<html><body>spa</body></html>');
  const deadPort = await getFreePort(); // nothing ever listens here
  const port = await getFreePort();
  const proc = spawnServerWithEnv(dir, port, {
    GITNEXUS_UPSTREAM_URL: `http://127.0.0.1:${deadPort}`,
    GITNEXUS_PROXY_RETRY_ATTEMPTS: '3',
  });
  try {
    await waitForServer(port);
    const res = await rawRequest(port, '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"repo":"x"}',
    });
    assert.equal(res.status, 502, 'genuinely-down upstream still returns 502 after the budget');
  } finally {
    await killAndWait(proc);
    await rm(dir, { recursive: true, force: true });
  }
});

it('does NOT retry after the upstream starts streaming, then drops mid-body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-proxy-midbody-'));
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'index.html'), '<html><body>spa</body></html>');

  let calls = 0;
  const upstreamServer = createServer((req, res) => {
    calls += 1;
    // Send headers + a partial body, then abruptly destroy the socket.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"partial":');
    setTimeout(() => res.socket.destroy(), 20);
  });
  const upstreamPort = await new Promise((resolve) => {
    upstreamServer.listen(0, '127.0.0.1', () => resolve(upstreamServer.address().port));
  });

  const port = await getFreePort();
  const proc = spawnServerWithEnv(dir, port, {
    GITNEXUS_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
    GITNEXUS_PROXY_RETRY_ATTEMPTS: '3',
  });
  // Issue a request that settles on end OR on the mid-body abort/error, so the
  // dropped connection can't hang the test. What matters is the proxy did NOT
  // replay the request (no duplicate job): the upstream must see exactly 1 call.
  const requestUntilSettled = () =>
    new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/analyze',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '12' },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
          res.on('aborted', resolve);
          res.on('error', resolve);
        },
      );
      req.on('error', resolve);
      req.write('{"repo":"x"}');
      req.end();
    });
  try {
    await waitForServer(port);
    await requestUntilSettled();
    // Give any (erroneous) retry a chance to fire before asserting.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls, 1, 'must not replay once the response body has started');
  } finally {
    await killAndWait(proc);
    upstreamServer.closeAllConnections?.();
    await new Promise((r) => upstreamServer.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

it('does NOT buffer or retry a body larger than the retry cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-proxy-bigbody-'));
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'index.html'), '<html><body>spa</body></html>');

  let receivedLen = -1;
  const upstreamServer = createServer((req, res) => {
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
    });
    req.on('end', () => {
      receivedLen = len;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upstreamPort = await new Promise((resolve) => {
    upstreamServer.listen(0, '127.0.0.1', () => resolve(upstreamServer.address().port));
  });

  const port = await getFreePort();
  const proc = spawnServerWithEnv(dir, port, {
    GITNEXUS_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
    // Tiny cap so a modest body exceeds it and is streamed, not buffered.
    GITNEXUS_PROXY_RETRY_MAX_BODY_BYTES: '16',
  });
  const bigBody = 'x'.repeat(1024);
  try {
    await waitForServer(port);
    const res = await rawRequest(port, '/api/analyze/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bigBody,
    });
    assert.equal(res.status, 200, 'over-cap body is streamed straight through');
    assert.equal(receivedLen, bigBody.length, 'full body reaches upstream (not truncated to cap)');
  } finally {
    await killAndWait(proc);
    await new Promise((r) => upstreamServer.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
