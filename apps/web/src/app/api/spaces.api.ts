/**
 * Spaces API — wired to the local-first Platform engine.
 *
 * Spaces are CRDT-replicated collections of pages shared between
 * trusted peers. All data is stored locally and synced via P2P.
 */

import {
  useMutation,
  type UseMutationOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getPlatform } from "@/platform";
import type {
  SpaceMember,
  SpaceInvite,
  PairCallbacks,
  ArchivedSpaceItem,
} from "@/platform/types";

export interface ISpace {
  id: string;
  name: string;
  createdAt: string;
}

export type { ArchivedSpaceItem };

/**
 * Invalidate everything affected by a space changing its archived state.
 * Archiving or restoring a space moves it between the sidebar and the Archive,
 * and shifts which of its archived pages the Archive can surface (pages in an archived
 * space are hidden with it), so both space and page lists must refresh.
 */
function spaceArchiveKeys(): string[][] {
  return [["spaces"], ["spaces-archived"], ["pages"], ["pages-archived"]];
}

export interface ISpaceMember {
  id: string;
  userId: string;
  createdAt: string;
  userName: string;
  userEmail: string;
  userAvatar: string | null;
  lastSeen: string | null;
}

function memberToLegacy(m: SpaceMember, lastSeen: string | null = null): ISpaceMember {
  return {
    id: m.publicKey,
    userId: m.publicKey,
    createdAt: m.addedAt,
    userName: m.name,
    userEmail: "",
    userAvatar: m.avatar,
    lastSeen,
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

export async function getArchivedSpaces(): Promise<ArchivedSpaceItem[]> {
  const platform = getPlatform();
  return platform.spaces.listArchived();
}

export function useGetArchivedSpaces() {
  return useQuery({
    queryKey: ["spaces-archived"],
    queryFn: getArchivedSpaces,
  });
}

export async function archiveSpace(spaceId: string): Promise<void> {
  const platform = getPlatform();
  await platform.spaces.archive(spaceId);
}

export function useArchiveSpace<TContext = unknown>(
  options?: UseMutationOptions<void, Error, string, TContext>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: archiveSpace,
    ...options,
    onSuccess: (...args) => {
      for (const key of spaceArchiveKeys()) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      options?.onSuccess?.(...args);
    },
  });
}

export async function unarchiveSpace(spaceId: string): Promise<void> {
  const platform = getPlatform();
  await platform.spaces.unarchive(spaceId);
}

export function useUnarchiveSpace<TContext = unknown>(
  options?: UseMutationOptions<void, Error, string, TContext>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: unarchiveSpace,
    ...options,
    onSuccess: (...args) => {
      for (const key of spaceArchiveKeys()) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      options?.onSuccess?.(...args);
    },
  });
}

export async function getSpaceMembers(spaceId: string): Promise<ISpaceMember[]> {
  const platform = getPlatform();
  const [space, peers] = await Promise.all([
    platform.spaces.get(spaceId),
    platform.peers.list(),
  ]);
  const peerLastSeen = new Map(peers.map((p) => [p.publicKey, p.lastSeen]));
  return space.members.map((m) => memberToLegacy(m, peerLastSeen.get(m.publicKey) ?? null));
}

export function useGetSpaceMembers(spaceId?: string) {
  return useQuery({
    queryKey: ["space-members", spaceId],
    queryFn: () => getSpaceMembers(spaceId!),
    enabled: !!spaceId,
  });
}

// --- Pairing-based invite ---

export async function getSpace(spaceId: string): Promise<ISpace> {
  const platform = getPlatform();
  const space = await platform.spaces.get(spaceId);
  return { id: space.id, name: space.name, createdAt: space.createdAt };
}

export async function createInvite(data: {
  spaceId: string;
  ttlMs: number;
}): Promise<SpaceInvite> {
  const platform = getPlatform();
  return platform.pairing.createInvite(data.spaceId, data.ttlMs);
}

export function useCreateInvite<TContext = unknown>(
  options?: UseMutationOptions<
    SpaceInvite,
    Error,
    { spaceId: string; ttlMs: number },
    TContext
  >,
) {
  return useMutation({
    mutationFn: createInvite,
    ...options,
  });
}

export async function getInvite(spaceId: string): Promise<SpaceInvite | null> {
  const platform = getPlatform();
  return platform.pairing.getInvite(spaceId);
}

export async function revokeInvite(spaceId: string): Promise<void> {
  const platform = getPlatform();
  await platform.pairing.revokeInvite(spaceId);
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

export async function cancelPairing(invite: SpaceInvite): Promise<void> {
  const platform = getPlatform();
  await platform.pairing.cancel(invite);
}

// ---------------------------------------------------------------------------
// Device linking — adding another of YOUR devices, not another person.
//
// Kept separate from the invite helpers above because what it grants is
// different in kind: the accepting device receives this identity and joins
// every space, personal ones included.
// ---------------------------------------------------------------------------

export async function createDeviceLink(ttlMs: number): Promise<SpaceInvite> {
  const platform = getPlatform();
  return platform.pairing.createDeviceLink(ttlMs);
}

export function useCreateDeviceLink<TContext = unknown>(
  options?: UseMutationOptions<SpaceInvite, Error, { ttlMs: number }, TContext>,
) {
  return useMutation({
    mutationFn: ({ ttlMs }: { ttlMs: number }) => createDeviceLink(ttlMs),
    ...options,
  });
}

export async function revokeDeviceLink(): Promise<void> {
  const platform = getPlatform();
  await platform.pairing.revokeDeviceLink();
}

export async function waitForDevice(
  invite: SpaceInvite,
  callbacks?: PairCallbacks,
): Promise<void> {
  const platform = getPlatform();
  await platform.pairing.waitForDevice(invite, callbacks);
}

export async function acceptDeviceLink(
  invite: SpaceInvite,
  callbacks?: PairCallbacks,
): Promise<void> {
  const platform = getPlatform();
  await platform.pairing.acceptDeviceLink(invite, callbacks);
}

export function useAcceptDeviceLink<TContext = unknown>(
  options?: UseMutationOptions<
    void,
    Error,
    { invite: SpaceInvite; callbacks?: PairCallbacks },
    TContext
  >,
) {
  return useMutation({
    mutationFn: ({ invite, callbacks }) => acceptDeviceLink(invite, callbacks),
    ...options,
  });
}
