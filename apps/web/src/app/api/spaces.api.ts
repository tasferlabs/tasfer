/**
 * Spaces API — wired to the local-first Platform engine.
 *
 * Spaces are CRDT-replicated collections of pages shared between
 * trusted peers. All data is stored locally and synced via P2P.
 */

import { useMutation, type UseMutationOptions, useQuery } from "@tanstack/react-query";
import { getPlatform } from "@/platform";
import type { SpaceMember, SpaceInvite, PairCallbacks } from "@/platform/types";

export interface ISpace {
  id: string;
  name: string;
  createdAt: string;
}

export interface ISpaceMember {
  id: string;
  userId: string;
  role: string;
  createdAt: string;
  userName: string;
  userEmail: string;
  userAvatar: string | null;
}

function memberToLegacy(m: SpaceMember): ISpaceMember {
  return {
    id: m.publicKey,
    userId: m.publicKey,
    role: m.role,
    createdAt: m.addedAt,
    userName: m.name,
    userEmail: "",
    userAvatar: m.avatar,
  };
}

export async function getSpaces(): Promise<ISpace[]> {
  const platform = getPlatform();
  const spaces = await platform.spaces.list();
  return spaces.map((s) => ({
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
  }));
}

export function useGetSpaces() {
  return useQuery({
    queryKey: ["spaces"],
    queryFn: getSpaces,
  });
}

export async function createSpace(data: { name: string }): Promise<ISpace> {
  const platform = getPlatform();
  const space = await platform.spaces.create(data.name);
  return { id: space.id, name: space.name, createdAt: space.createdAt };
}

export function useCreateSpace<TContext = unknown>(
  options?: UseMutationOptions<ISpace, Error, { name: string }, TContext>,
) {
  return useMutation({
    mutationFn: createSpace,
    ...options,
  });
}

export async function updateSpace(data: { id: string; name: string }): Promise<ISpace> {
  const platform = getPlatform();
  await platform.spaces.rename(data.id, data.name);
  const space = await platform.spaces.get(data.id);
  return { id: space.id, name: space.name, createdAt: space.createdAt };
}

export function useUpdateSpace<TContext = unknown>(
  options?: UseMutationOptions<ISpace, Error, { id: string; name: string }, TContext>,
) {
  return useMutation({
    mutationFn: updateSpace,
    ...options,
  });
}

export async function leaveSpace(spaceId: string): Promise<void> {
  const platform = getPlatform();
  await platform.spaces.leave(spaceId);
}

export function useLeaveSpace<TContext = unknown>(
  options?: UseMutationOptions<void, Error, string, TContext>,
) {
  return useMutation({
    mutationFn: leaveSpace,
    ...options,
  });
}

export async function getSpaceMembers(spaceId: string): Promise<ISpaceMember[]> {
  const platform = getPlatform();
  const space = await platform.spaces.get(spaceId);
  return space.members.map(memberToLegacy);
}

export function useGetSpaceMembers(spaceId?: string) {
  return useQuery({
    queryKey: ["space-members", spaceId],
    queryFn: () => getSpaceMembers(spaceId!),
    enabled: !!spaceId,
  });
}

// --- Pairing-based invite ---

export async function createInvite(spaceId: string): Promise<SpaceInvite> {
  const platform = getPlatform();
  return platform.pairing.createInvite(spaceId);
}

export function useCreateInvite<TContext = unknown>(
  options?: UseMutationOptions<SpaceInvite, Error, string, TContext>,
) {
  return useMutation({
    mutationFn: createInvite,
    ...options,
  });
}

export async function acceptInvite(
  invite: SpaceInvite,
  callbacks?: PairCallbacks,
): Promise<void> {
  const platform = getPlatform();
  await platform.pairing.acceptInvite(invite, callbacks);
}

export function useAcceptInvite<TContext = unknown>(
  options?: UseMutationOptions<void, Error, { invite: SpaceInvite; callbacks?: PairCallbacks }, TContext>,
) {
  return useMutation({
    mutationFn: ({ invite, callbacks }) => acceptInvite(invite, callbacks),
    ...options,
  });
}

export async function waitForPeer(
  invite: SpaceInvite,
  callbacks?: PairCallbacks,
): Promise<void> {
  const platform = getPlatform();
  await platform.pairing.waitForPeer(invite, callbacks);
}

export function useWaitForPeer<TContext = unknown>(
  options?: UseMutationOptions<void, Error, { invite: SpaceInvite; callbacks?: PairCallbacks }, TContext>,
) {
  return useMutation({
    mutationFn: ({ invite, callbacks }) => waitForPeer(invite, callbacks),
    ...options,
  });
}

export async function cancelPairing(): Promise<void> {
  const platform = getPlatform();
  await platform.pairing.cancel();
}

// Legacy stubs — no longer used but kept for compile compat
export async function addSpaceMember(_data: { spaceId: string; email: string }): Promise<ISpaceMember> {
  throw new Error("Use pairing invites instead of email");
}

export function useAddSpaceMember<TContext = unknown>(
  options?: UseMutationOptions<ISpaceMember, Error, { spaceId: string; email: string }, TContext>,
) {
  return useMutation({
    mutationFn: addSpaceMember,
    ...options,
  });
}

export async function removeSpaceMember(data: { spaceId: string; memberId: string }): Promise<void> {
  const platform = getPlatform();
  await platform.spaces.removeMember(data.spaceId, data.memberId);
}

export function useRemoveSpaceMember<TContext = unknown>(
  options?: UseMutationOptions<void, Error, { spaceId: string; memberId: string }, TContext>,
) {
  return useMutation({
    mutationFn: removeSpaceMember,
    ...options,
  });
}

export async function deleteSpace(id: string): Promise<void> {
  const platform = getPlatform();
  await platform.spaces.leave(id);
}

export function useDeleteSpace<TContext = unknown>(
  options?: UseMutationOptions<void, Error, string, TContext>,
) {
  return useMutation({
    mutationFn: deleteSpace,
    ...options,
  });
}
