import { authFetch, authFetchJson, API_BASE, isNative, setSessionId } from "./client";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
}

interface AuthResponse {
  user: AuthUser;
}

interface RegisterResponse {
  needsVerification?: true;
  email?: string;
  user?: AuthUser;
}

export async function register(data: {
  email: string;
  password: string;
}): Promise<RegisterResponse> {
  const response = await authFetch(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data;
}

interface LoginResponse {
  needsVerification?: true;
  email?: string;
  user?: AuthUser;
  sessionId?: string;
}

export async function login(data: {
  email: string;
  password: string;
}): Promise<LoginResponse> {
  const response = await authFetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
  if (isNative && result.data.sessionId) {
    setSessionId(result.data.sessionId);
  }
  return result.data;
}

export async function verifyEmail(data: {
  email: string;
  code: string;
}): Promise<AuthResponse> {
  const response = await authFetch(`${API_BASE}/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
  if (isNative && result.data.sessionId) {
    setSessionId(result.data.sessionId);
  }
  return result.data;
}

export async function resendVerification(email: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/auth/resend-verification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
}

export async function getMe(): Promise<AuthUser> {
  const response = await authFetch(`${API_BASE}/auth/me`);

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data.user;
}

export async function logout(): Promise<void> {
  await authFetch(`${API_BASE}/auth/logout`, {
    method: "POST",
  });
  if (isNative) {
    setSessionId(null);
  }
}

export async function updateProfile(data: {
  name?: string;
  avatar?: string | null;
}): Promise<AuthUser> {
  const response = await authFetch(`${API_BASE}/auth/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data.user;
}

export async function forgotPassword(email: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
}

export async function changeEmail(newEmail: string): Promise<void> {
  await authFetchJson("/auth/change-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newEmail }),
  });
}

export async function verifyEmailChange(token: string): Promise<AuthUser> {
  const response = await authFetch(`${API_BASE}/auth/verify-email-change`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data.user;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await authFetchJson("/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}
