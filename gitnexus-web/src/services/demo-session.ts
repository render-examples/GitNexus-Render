/**
 * Demo-mode browser session identity.
 *
 * In read-only demo mode the server scopes each visitor's analyzed repositories
 * to the browser session that created them (see gitnexus/src/server/demo-store).
 * The web app supplies that identity: a stable random id kept in localStorage and
 * sent on every request via the `X-GitNexus-Session` header. It is meaningful
 * only in demo mode; outside demo mode the server ignores it. The id is opaque
 * (never a path or secret) and constrained to a safe charset the server validates
 * via the same shared `isValidDemoSessionId`.
 */
import { isValidDemoSessionId } from 'gitnexus-shared';

const STORAGE_KEY = 'gitnexus-demo-session';

let cached: string | null = null;

const newId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    // Extremely old browsers / non-secure contexts without crypto.randomUUID.
    return `s-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
};

/**
 * The stable demo session id for this browser, creating and persisting one on
 * first use. Falls back to an in-memory id if localStorage is unavailable
 * (private browsing) — the session still works for the life of the tab.
 */
export const getDemoSessionId = (): string => {
  if (cached) return cached;
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (isValidDemoSessionId(existing)) {
      cached = existing;
      return existing;
    }
    const id = newId();
    localStorage.setItem(STORAGE_KEY, id);
    cached = id;
    return id;
  } catch {
    cached = cached ?? newId();
    return cached;
  }
};
