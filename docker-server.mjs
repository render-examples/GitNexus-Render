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

// Falls back to RENDER_EXTERNAL_URL so a Render web service serves its own
// public origin to the browser (same-origin API calls via the proxy below)
// with no manual configuration.
const rawBackendUrl = process.env.GITNEXUS_BACKEND_URL ?? process.env.RENDER_EXTERNAL_URL ?? null;
if (rawBackendUrl && !isValidUrl(rawBackendUrl)) {
  const safeRaw = rawBackendUrl.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
  console.warn(
    `[gitnexus-web] GITNEXUS_BACKEND_URL "${safeRaw}" is not a valid http/https URL -- ignoring.`,
  );
}
const backendUrl = rawBackendUrl && isValidUrl(rawBackendUrl) ? rawBackendUrl : null;
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
const rawUpstreamUrl = process.env.GITNEXUS_UPSTREAM_URL
  ? /^https?:\/\//.test(process.env.GITNEXUS_UPSTREAM_URL)
    ? process.env.GITNEXUS_UPSTREAM_URL
    : `http://${process.env.GITNEXUS_UPSTREAM_URL}`
  : null;
if (rawUpstreamUrl && !isValidUrl(rawUpstreamUrl)) {
  const safeRaw = rawUpstreamUrl.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
  console.warn(
    `[gitnexus-web] GITNEXUS_UPSTREAM_URL "${safeRaw}" is not a valid http/https URL -- ignoring.`,
  );
}
const upstreamBase = rawUpstreamUrl && isValidUrl(rawUpstreamUrl) ? rawUpstreamUrl : null;

// Forward an `/api/*` request to the upstream API server, streaming the
// request and response bodies (SSE / chunked graph streams) untouched.
function proxyToUpstream(req, res) {
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
  // Terminate the browser origin here: strip Origin/Referer so the API sees a
  // trusted server-to-server call. Its CORS check (`isAllowedOrigin`) returns
  // true for requests with no Origin, and its write-route guard falls through
  // to `next()` when Origin is undefined. The browser only ever talks to this
  // same-origin web service, so no cross-origin reach is lost.
  delete headers.origin;
  delete headers.referer;
  headers.host = upstream.host;

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
    console.error('[gitnexus-web] upstream proxy error:', err.message);
    if (res.headersSent) {
      res.destroy();
    } else {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad gateway');
    }
  });
  req.on('error', () => upstreamReq.destroy());
  req.pipe(upstreamReq);
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
    proxyToUpstream(req, res);
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
