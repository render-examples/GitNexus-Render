/**
 * Demo-mode session identity — shared validator.
 *
 * In read-only demo mode the server scopes each visitor's analyzed repositories
 * to the browser session that created them. The web app generates the id (kept
 * in localStorage) and sends it on every request via the `X-GitNexus-Session`
 * header; the server validates it before using it as an in-memory ownership key.
 * Both sides import this validator so the accepted charset can never drift.
 *
 * The id is opaque — never a path or secret — and constrained to a short,
 * filesystem- and header-safe charset.
 */

/** Accepted demo session id shape: 1–64 chars of `[A-Za-z0-9_-]`. */
export const DEMO_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** True when `raw` is a syntactically valid demo session id. */
export const isValidDemoSessionId = (raw: unknown): raw is string =>
  typeof raw === 'string' && DEMO_SESSION_ID_PATTERN.test(raw);
