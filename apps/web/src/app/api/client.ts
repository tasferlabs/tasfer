const API_BASE = "/api";

type TokenGetter = () => string | null;
type TokenRefresher = () => Promise<string | null>;

let getAccessToken: TokenGetter = () => null;
let refreshAccessToken: TokenRefresher = async () => null;

/** Called by AuthContext to wire up token management */
export function setAuthHandlers(getter: TokenGetter, refresher: TokenRefresher) {
  getAccessToken = getter;
  refreshAccessToken = refresher;
}

/**
 * Authenticated fetch wrapper.
 * Adds Authorization header and handles 401 → refresh → retry.
 */
export async function authFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  let response = await fetch(input, { ...init, headers });

  // On 401, attempt token refresh and retry once
  if (response.status === 401 && token) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers.set("Authorization", `Bearer ${newToken}`);
      response = await fetch(input, { ...init, headers });
    }
  }

  return response;
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
    throw new Error(data.error || "Request failed");
  }

  return data.data;
}

export { API_BASE };
