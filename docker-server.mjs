import { open } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

const host = '0.0.0.0';
const port = Number(process.env.PORT || '4173');
const root = resolve(process.cwd(), 'dist');

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function jsonForScriptTag(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

// Return `value` if it's a usable http/https URL, otherwise null. Warns (with
// the raw value sanitized to one line, truncated) when a non-empty value is
// malformed so a misconfigured env var is visible in the logs. `label` names
// the env var in that warning.
function validHttpUrl(label, value) {
  if (!value) return null;
  if (isValidUrl(value)) return value;
  const safeRaw = value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
  console.warn(`[gitnexus-web] ${label} "${safeRaw}" is not a valid http/https URL -- ignoring.`);
  return null;
}

// Falls back to RENDER_EXTERNAL_URL so a Render web service serves its own
// public origin to the browser (same-origin API calls via the proxy below)
// with no manual configuration.
const rawBackendUrl = process.env.GITNEXUS_BACKEND_URL ?? process.env.RENDER_EXTERNAL_URL ?? null;
const backendUrl = validHttpUrl('GITNEXUS_BACKEND_URL', rawBackendUrl);
const configScript = backendUrl
  ? `<script>window.__GITNEXUS_CONFIG__=${jsonForScriptTag({ backendUrl })};</script>`
  : '';

// Optional same-origin reverse proxy for the API server.
//
// On a split hosting setup (e.g. Render: this static web service is public,
// the API server is a private/internal service) the browser must reach the
// server WITHOUT a cross-origin request — the server's CORS allowlist and its
// write-route origin guard only admit loopback/same-host origins. So instead
// of exposing the server publicly and widening CORS, we point the browser at
// THIS service's own origin (GITNEXUS_BACKEND_URL = our public URL) and
// transparently forward every `/api/*` call to the internal server named by
// GITNEXUS_UPSTREAM_URL. Unset → no proxy (the default docker-compose setup
// where the browser talks to the server directly on the host).
// Accept a scheme-less `host:port` (what Render's `fromService: hostport`
// yields for an internal service) by defaulting to http://.
const rawUpstream = process.env.GITNEXUS_UPSTREAM_URL;
const rawUpstreamUrl = rawUpstream
  ? /^https?:\/\//.test(rawUpstream)
    ? rawUpstream
    : `http://${rawUpstream}`
  : null;
const upstreamBase = validHttpUrl('GITNEXUS_UPSTREAM_URL', rawUpstreamUrl);

// Idle timeout for a proxied request: if the upstream neither responds nor
// streams any bytes for this long, fail with 504 instead of holding the
// browser connection open forever. Socket activity (e.g. SSE heartbeats)
// resets it, so long-lived streams are unaffected. 0 disables the timeout.
const proxyTimeoutMs = Number(process.env.GITNEXUS_PROXY_TIMEOUT_MS || '120000');

// Bounded connection-retry for proxied requests. A single-instance upstream
// (e.g. the Render private server with a disk, which can't do zero-downtime
// deploys) has a few-second window during every restart/redeploy where the old
// instance is gone and the new one hasn't bound its port or propagated its
// internal DNS name yet. A connect-level failure in that window (ECONNRESET
// "socket hang up", ENOTFOUND, ECONNREFUSED, EAI_AGAIN, ETIMEDOUT) means the
// upstream received nothing, so re-attempting is safe (no double-executed job).
// We retry only BEFORE any response byte reaches the browser, only for a small
// buffered/replayable body, and keep it bounded so a genuinely-down upstream
// still fails fast. Set attempts to 1 to disable.
const proxyRetryAttempts = Math.max(1, Number(process.env.GITNEXUS_PROXY_RETRY_ATTEMPTS || '3'));
const proxyRetryMaxBodyBytes = Number(
  process.env.GITNEXUS_PROXY_RETRY_MAX_BODY_BYTES || String(256 * 1024),
);
const retryableProxyCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
]);

// Read a request body into a single Buffer, capping total size. Resolves null
// if the body exceeds `cap`, the client errors mid-read, OR the read exceeds
// `timeoutMs` (so the caller can fall back to a single streamed attempt instead
// of buffering, or reject an unreadable body). A single "unreadable body ->
// null" contract keeps the caller simple; it already maps null -> 400.
// Listeners and the timer are detached once settled so a later pipe of the same
// request is unaffected and a settled request never fires a stray callback.
function readBodyCapped(req, cap, timeoutMs) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > cap) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks));
    const onError = () => finish(null);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    // Idle-agnostic hard cap on how long we'll wait for the full body — the
    // reverse-proxy equivalent of nginx's client_body_timeout. Reuses the
    // proxyTimeoutMs knob; 0 disables it, mirroring the upstream timeout. Node's
    // default server requestTimeout remains the outer backstop.
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        console.warn(`[gitnexus-web] client body read timed out after ${timeoutMs}ms`);
        finish(null);
      }, timeoutMs);
    }
  });
}

// Hop-by-hop headers (RFC 7230 §6.1) are connection-specific and must not be
// forwarded by a proxy. Node's http client sets its own Connection/
// Transfer-Encoding for the upstream hop, so passing the browser's through
// would be incorrect.
const hopByHopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

// Forward an `/api/*` request to the upstream API server, streaming the
// request and response bodies (SSE / chunked graph streams) untouched.
//
// Connect-level failures are retried a bounded number of times (see
// proxyRetryAttempts) to ride out an upstream restart window, but only when the
// request body is replayable — see the buffering logic below.
async function proxyToUpstream(req, res) {
  let upstream;
  try {
    upstream = new URL(req.url, upstreamBase);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const isHttps = upstream.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const headers = { ...req.headers };
  // Drop hop-by-hop headers; the http client sets its own for the upstream hop.
  for (const name of hopByHopHeaders) delete headers[name];
  // Terminate the browser origin here: strip Origin/Referer so the API sees a
  // trusted server-to-server call. Its CORS check (`isAllowedOrigin`) returns
  // true for requests with no Origin, and its write-route guard falls through
  // to `next()` when Origin is undefined. The browser only ever talks to this
  // same-origin web service, so no cross-origin reach is lost.
  delete headers.origin;
  delete headers.referer;
  headers.host = upstream.host;

  // Decide whether this request can be retried. A retry replays the body, so we
  // buffer it up front — but only when it is small and its length is known:
  //   - GET/HEAD have no body → trivially replayable (empty buffer).
  //   - A body with a known Content-Length <= cap → buffer and retry.
  //   - Larger / unknown-length bodies (e.g. multipart uploads) → stream once
  //     with no retry, exactly as before (never buffer an upload).
  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const len = Number(req.headers['content-length']);
  const small = Number.isFinite(len) && len >= 0 && len <= proxyRetryMaxBodyBytes;
  let bodyBuf = hasBody ? null : Buffer.alloc(0);
  if (hasBody && small) {
    bodyBuf = await readBodyCapped(req, proxyRetryMaxBodyBytes, proxyTimeoutMs);
    if (bodyBuf === null) {
      // Overflowed the cap, the client errored mid-read, or the read timed out.
      // Kept as a single 400 (not split into 408/413) — the overflow->400
      // behavior was not flagged, so preserve it deliberately.
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad request');
      }
      return;
    }
  }
  // bodyBuf === null means "stream the live request once, no retry".
  const retryEligible = bodyBuf !== null;

  const attempt = (n) => {
    let timedOut = false;
    const upstreamReq = requestFn(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (isHttps ? 443 : 80),
        method: req.method,
        path: upstream.pathname + upstream.search,
        headers,
      },
      (upstreamRes) => {
        // Forward status + headers verbatim; pipe the body so streaming
        // responses (text/event-stream heartbeat, chunked graph stream) reach
        // the browser incrementally instead of being buffered.
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.on('error', () => res.destroy());
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on('error', (err) => {
      if (timedOut) return; // 504 already sent by the timeout handler below
      // Retry a connect-level failure that happened before any response byte
      // reached the browser: the upstream got nothing, so this can't
      // double-execute a job. Once headers are sent the body is partially
      // written and can't be replayed — fall through and destroy.
      if (
        retryEligible &&
        !res.headersSent &&
        n < proxyRetryAttempts &&
        retryableProxyCodes.has(err.code)
      ) {
        const delay = 250 * 2 ** (n - 1); // 250ms, 500ms, ...
        console.warn(
          `[gitnexus-web] upstream ${err.code}; retry ${n}/${proxyRetryAttempts - 1} in ${delay}ms`,
        );
        setTimeout(() => attempt(n + 1), delay);
        return;
      }
      console.error('[gitnexus-web] upstream proxy error:', err.message);
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad gateway');
      }
    });
    if (proxyTimeoutMs > 0) {
      upstreamReq.setTimeout(proxyTimeoutMs, () => {
        timedOut = true;
        console.error(`[gitnexus-web] upstream proxy timeout after ${proxyTimeoutMs}ms`);
        if (res.headersSent) {
          res.destroy();
        } else {
          res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Gateway timeout');
        }
        upstreamReq.destroy();
      });
    }
    if (bodyBuf !== null) {
      // Replayable body already buffered; write it fresh on each attempt.
      if (bodyBuf.length) upstreamReq.write(bodyBuf);
      upstreamReq.end();
    } else {
      // Non-retryable: stream the live request once.
      req.on('error', () => upstreamReq.destroy());
      req.pipe(upstreamReq);
    }
  };
  attempt(1);
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Static asset server for the gitnexus-web Docker image.
//
// TOCTOU prevention: every filesystem interaction uses open() to get a
// file handle; subsequent reads use handle.readFile()/createReadStream().
//
// CodeQL js/file-system-race: the query pairs open() calls when their
// path arguments are data-flow aliased. This handler uses exactly two
// open() calls whose paths are provably independent:
//   1. open(requestedPath) — derived from the URL
//   2. open(spaFallback)   — the constant root/index.html
// Because spaFallback has no data-flow from the request, CodeQL cannot
// pair them as a check/use on the same path.
//
// Path-injection containment: each open() is preceded by a
// path.relative() barrier that CodeQL recognizes as a sanitizer.

const spaFallback = resolve(root, 'index.html');

const server = createServer(async (req, res) => {
  const urlPath = req.url?.split('?')[0] || '/';

  // Same-origin API proxy: forward `/api/*` to the upstream server when
  // configured. Everything else is served as a static asset / SPA below.
  if (upstreamBase && (urlPath === '/api' || urlPath.startsWith('/api/'))) {
    // proxyToUpstream is async and invoked fire-and-forget; guard the boundary
    // so a future await added inside it can't become an unhandledRejection.
    // Mirror the 502 / res.destroy() shape used inside its own error handler.
    proxyToUpstream(req, res).catch((err) => {
      console.error('[gitnexus-web] proxy handler crashed:', err?.message ?? err);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad gateway');
      } else {
        res.destroy();
      }
    });
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  if (decoded.includes('\0')) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const cleanPath = normalize(decoded.replace(/^\/+/, ''));
  const requestedPath = resolve(root, cleanPath);

  const rel = relative(root, requestedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  let handle;
  try {
    let servePath = requestedPath;

    // Try to open the exact path the client asked for.
    handle = await open(requestedPath, 'r').catch(() => null);
    if (handle) {
      const s = await handle.stat();
      if (!s.isFile()) {
        // Directories and other non-files fall through to SPA fallback.
        await handle.close();
        handle = null;
      }
    }

    // If the requested path wasn't a regular file, serve the SPA entry
    // point. spaFallback is a module-level constant with no data-flow
    // from the request, so this open() is independent of the one above.
    if (!handle) {
      servePath = spaFallback;
      handle = await open(spaFallback, 'r').catch(() => null);
      if (!handle) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const s = await handle.stat();
      if (!s.isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    }

    const isHtml = extname(servePath) === '.html' || !extname(servePath);
    const cacheControl = servePath.includes(`${sep}assets${sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    const contentType = contentTypes[extname(servePath)] || 'application/octet-stream';

    if (isHtml && configScript) {
      const raw = await handle.readFile('utf8');
      await handle.close();
      handle = null;
      if (!raw.includes('</head>')) {
        console.warn('[gitnexus-web] Could not inject config: no </head> tag found in HTML');
      }
      const html = raw.includes('</head>') ? raw.replace('</head>', `${configScript}</head>`) : raw;
      const buf = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'Cache-Control': cacheControl,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': buf.length,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      res.end(buf);
    } else {
      res.writeHead(200, {
        'Cache-Control': cacheControl,
        'Content-Type': contentType,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      const stream = handle.createReadStream();
      handle = null;
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end('Internal server error');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
});

server.listen(port, host, () => {
  console.log(`gitnexus-web listening on http://${host}:${port}`);
});
