const API_BASE = "/api";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

interface AuthResponse {
  user: AuthUser;
  accessToken: string;
}

export async function register(data: {
  email: string;
  name: string;
  password: string;
}): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || "Registration failed");
  }
  return result.data;
}

export async function login(data: {
  email: string;
  password: string;
}): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || "Login failed");
  }
  return result.data;
}

export async function refreshToken(): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });

    const result = await response.json();
    if (!result.success) return null;
    return result.data.accessToken;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

export async function getMe(accessToken: string): Promise<AuthUser> {
  const response = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || "Failed to get user");
  }
  return result.data.user;
}
