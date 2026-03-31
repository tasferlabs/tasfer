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
  deviceType: Identity["deviceType"];
}

function identityToAuthUser(identity: Identity): AuthUser {
  return {
    id: identity.publicKey,
    email: "", // no email in decentralized model
    name: identity.name,
    avatar: identity.avatar,
    deviceType: identity.deviceType,
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
  deviceType?: string;
}): Promise<AuthUser> {
  const platform = getPlatform();
  const identity = await platform.identity.update(data);
  return identityToAuthUser(identity);
}


