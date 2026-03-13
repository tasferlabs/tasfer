const API_BASE = import.meta.env.VITE_API_URL || "/api";

const isNative =
  typeof window !== "undefined" &&
  !!(window as any).Capacitor?.isNativePlatform?.();

const SESSION_KEY = "cypher_session_id";

const BASIC_AUTH = import.meta.env.VITE_BASIC_AUTH
  ? `Basic ${btoa(import.meta.env.VITE_BASIC_AUTH)}`
  : null;

function getSessionId(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function setSessionId(id: string | null): void {
  if (id) {
    localStorage.setItem(SESSION_KEY, id);
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
}

/**
 * Authenticated fetch wrapper.
 * On web: session cookie is sent automatically via credentials: "include".
 * On native (Capacitor): session ID is sent via X-Session-Id header
 * since third-party cookies don't work in WebViews.
 * Basic auth is added on native to pass through Traefik.
 */
export async function authFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  if (isNative) {
    const sessionId = getSessionId();
    const headers = new Headers(init?.headers);
    if (sessionId) {
      headers.set("X-Session-Id", sessionId);
    }
    if (BASIC_AUTH) {
      headers.set("Authorization", BASIC_AUTH);
    }
    return fetch(input, { ...init, headers });
  }
  return fetch(input, { ...init, credentials: "include" });
}

/**
 * JSON fetch helper with auth. Parses response and throws on error.
 */
export async function authFetchJson<T = any>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await authFetch(`${API_BASE}${path}`, init);
  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || "internal_error");
  }

  return data.data;
}

export { API_BASE, isNative };
