import { authFetch, authFetchJson } from "./client";

const API_BASE = "/api";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
}

interface AuthResponse {
  user: AuthUser;
  accessToken: string;
}

interface RegisterResponse {
  needsVerification?: true;
  email?: string;
  user?: AuthUser;
  accessToken?: string;
}

export async function register(data: {
  email: string;
  password: string;
}): Promise<RegisterResponse> {
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

interface LoginResponse {
  needsVerification?: true;
  email?: string;
  user?: AuthUser;
  accessToken?: string;
}

export async function login(data: {
  email: string;
  password: string;
}): Promise<LoginResponse> {
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

export async function verifyEmail(data: {
  email: string;
  code: string;
}): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || "Verification failed");
  }
  return result.data;
}

export async function resendVerification(email: string): Promise<void> {
  const response = await fetch(`${API_BASE}/auth/resend-verification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
    credentials: "include",
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || "Failed to resend code");
  }
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
    throw new Error(result.error || "Failed to update profile");
  }
  return result.data.user;
}

export async function forgotPassword(email: string): Promise<void> {
  const response = await fetch(`${API_BASE}/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || "Failed to send reset code");
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const response = await fetch(`${API_BASE}/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || "Failed to reset password");
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
  const response = await fetch(`${API_BASE}/auth/verify-email-change`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || "Verification failed");
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
