const API_BASE = import.meta.env.VITE_API_URL || "/api";

/**
 * Authenticated fetch wrapper.
 * Session cookie is sent automatically via credentials: "include".
 */
export async function authFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
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
    throw new Error(data.error || "Request failed");
  }

  return data.data;
}

export { API_BASE };
