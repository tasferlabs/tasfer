/**
 * Auth API — delegates to platform.identity.
 *
 * In the decentralized model there is no login/register/email flow.
 * Identity is a local keypair. This file keeps the AuthUser shape
 * and maps getMe / updateProfile to platform.identity so existing
 * consumers (AuthContext, settings) keep working.
 */

import { getPlatform } from "@/platform";
import type { Identity } from "@/platform";

// Keep the old shape so AuthContext consumers don't break
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
}

function identityToAuthUser(identity: Identity): AuthUser {
  return {
    id: identity.publicKey,
    email: "", // no email in decentralized model
    name: identity.name,
    avatar: identity.avatar,
  };
}

/**
 * Get local identity (replaces "get me from server").
 */
export async function getMe(): Promise<AuthUser> {
  const platform = getPlatform();
  const identity = await platform.identity.get();
  return identityToAuthUser(identity);
}

/**
 * Update local identity profile.
 */
export async function updateProfile(data: {
  name?: string;
  avatar?: string | null;
}): Promise<AuthUser> {
  const platform = getPlatform();
  const identity = await platform.identity.update(data);
  return identityToAuthUser(identity);
}

/**
 * Logout — no-op in decentralized model (there's no session to end).
 */
export async function logout(): Promise<void> {
  // No-op: identity is local, nothing to log out of
}

// ---------------------------------------------------------------------------
// Stubs for flows that no longer exist (login, register, email, password)
// These throw so any remaining call sites are surfaced during development.
// ---------------------------------------------------------------------------

export async function login(_data: {
  email: string;
  password: string;
}): Promise<never> {
  throw new Error("login is not available in decentralized mode");
}

export async function register(_data: {
  email: string;
  password: string;
}): Promise<never> {
  throw new Error("register is not available in decentralized mode");
}

export async function verifyEmail(_data: {
  email: string;
  code: string;
}): Promise<never> {
  throw new Error("verifyEmail is not available in decentralized mode");
}

export async function resendVerification(_email: string): Promise<never> {
  throw new Error("resendVerification is not available in decentralized mode");
}

export async function forgotPassword(_email: string): Promise<never> {
  throw new Error("forgotPassword is not available in decentralized mode");
}

export async function resetPassword(
  _token: string,
  _newPassword: string,
): Promise<never> {
  throw new Error("resetPassword is not available in decentralized mode");
}

export async function changeEmail(_newEmail: string): Promise<never> {
  throw new Error("changeEmail is not available in decentralized mode");
}

export async function verifyEmailChange(_token: string): Promise<never> {
  throw new Error("verifyEmailChange is not available in decentralized mode");
}

export async function changePassword(
  _currentPassword: string,
  _newPassword: string,
): Promise<never> {
  throw new Error("changePassword is not available in decentralized mode");
}
