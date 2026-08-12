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
  /** Admits only this person's own devices; cannot be invited into. */
  personal?: boolean;
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
  /**
   * Person this device belongs to, when known. Members sharing a rootKey are
   * the same human on different devices — group them before display. Null for
   * a device whose certificate has not arrived, which is every member from
   * before device identity existed.
   */
  rootKey: string | null;
}

function memberToLegacy(
  m: SpaceMember,
  lastSeen: string | null = null,
): ISpaceMember {
  return {
    id: m.publicKey,
    userId: m.publicKey,
    createdAt: m.addedAt,
    userName: m.name,
    userEmail: "",
    userAvatar: m.avatar,
    lastSeen,
    rootKey: m.rootKey,
  };
}

/** One human in a space, together with every device they joined from. */
export interface ISpacePerson extends ISpaceMember {
  /**
   * The person's devices, most recently seen first. Always holds at least the
   * device the top-level fields were taken from.
   */
  devices: ISpaceMember[];
}

function lastSeenTime(member: ISpaceMember): number {
  if (!member.lastSeen) return -Infinity;
  const time = new Date(member.lastSeen).getTime();
  return Number.isNaN(time) ? -Infinity : time;
}

/**
 * Fold a member list into one entry per person, keeping their devices attached
 * so the UI can show how many they are connected from.
 *
 * A person is represented by their most recently seen device, so presence
 * reflects "is this person around" rather than the state of whichever device
 * happened to join the space first. Members with no known certificate keep
 * their own entry — an unidentified device is not evidence that it belongs to
 * somebody already listed.
 */
export function groupMembersByPerson(members: ISpaceMember[]): ISpacePerson[] {
  const byRootKey = new Map<string, ISpaceMember[]>();
  const groups: ISpaceMember[][] = [];

  for (const member of members) {
    if (!member.rootKey) {
      groups.push([member]);
      continue;
    }
    const group = byRootKey.get(member.rootKey);
    if (group) {
      group.push(member);
      continue;
    }
    const created = [member];
    byRootKey.set(member.rootKey, created);
    groups.push(created);
  }

  return groups.map((group) => {
    // Stable sort keeps devices seen at the same time (or never) in join order.
    const devices = [...group].sort((a, b) => lastSeenTime(b) - lastSeenTime(a));
    return { ...devices[0], devices };
  });
}

export async function getSpaces(): Promise<ISpace[]> {
  const platform = getPlatform();
  const spaces = await platform.spaces.list();
  return spaces.map((s) => ({
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    personal: s.personal,
  }));
}

export function useGetSpaces() {
  return useQuery({
    queryKey: ["spaces"],
    queryFn: getSpaces,
  });
}

export async function createSpace(data: {
  name: string;
  personal?: boolean;
}): Promise<ISpace> {
  const platform = getPlatform();
  const space = await platform.spaces.create(data.name, {
    personal: data.personal,
  });
  return {
    id: space.id,
    name: space.name,
    createdAt: space.createdAt,
    personal: space.personal,
  };
}

export function useCreateSpace<TContext = unknown>(
  options?: UseMutationOptions<
    ISpace,
    Error,
    { name: string; personal?: boolean },
    TContext
  >,
) {
  return useMutation({
    mutationFn: createSpace,
    ...options,
  });
}

export async function updateSpace(data: {
  id: string;
  name: string;
}): Promise<ISpace> {
  const platform = getPlatform();
  await platform.spaces.rename(data.id, data.name);
  const space = await platform.spaces.get(data.id);
  return { id: space.id, name: space.name, createdAt: space.createdAt };
}

export function useUpdateSpace<TContext = unknown>(
  options?: UseMutationOptions<
    ISpace,
    Error,
    { id: string; name: string },
    TContext
  >,
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

/**
 * `enabled` exists for Layout, which only needs this list to tell a first run
 * apart from someone who archived every space — and shouldn't pay for the
 * lookup on every start when spaces are present.
 */
export function useGetArchivedSpaces(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["spaces-archived"],
    queryFn: getArchivedSpaces,
    enabled: options?.enabled,
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

export async function getSpaceMembers(
  spaceId: string,
): Promise<ISpacePerson[]> {
  const platform = getPlatform();
  const [space, peers] = await Promise.all([
    platform.spaces.get(spaceId),
    platform.peers.list(),
  ]);
  const peerLastSeen = new Map(peers.map((p) => [p.publicKey, p.lastSeen]));
  // One row per person, not per device: a collaborator with a laptop and a
  // phone is one member of the space, and showing two would misrepresent both
  // the roster and who has access. Their devices ride along on the row.
  return groupMembersByPerson(
    space.members.map((m) =>
      memberToLegacy(m, peerLastSeen.get(m.publicKey) ?? null),
    ),
  );
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
  return {
    id: space.id,
    name: space.name,
    createdAt: space.createdAt,
    personal: space.personal,
  };
}

export function useGetSpace(spaceId?: string) {
  return useQuery({
    queryKey: ["space", spaceId],
    queryFn: () => getSpace(spaceId!),
    enabled: !!spaceId,
  });
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

/**
 * How an invite was taken up: by pairing with the inviter, or by restoring a
 * space this device already had. `paired` only means the pairing session
 * started — its progress arrives through {@link PairCallbacks}.
 */
export type AcceptInviteResult =
  | { status: "paired" }
  | { status: "restored"; spaceName: string };

export async function acceptInvite(
  invite: SpaceInvite,
  callbacks?: PairCallbacks,
): Promise<AcceptInviteResult> {
  const platform = getPlatform();

  // An invite to a space we archived is a rejoin, not a join: the ops,
  // membership and peer keys never left this device, so restoring the space is
  // the whole job. Pairing again would only re-derive what we still have —
  // and it would need the inviter online, while this works offline.
  // `listArchived` is already scoped to spaces we are a member of.
  const archived = await platform.spaces.listArchived();
  const known = archived.find((space) => space.id === invite.spaceId);
  if (known) {
    await platform.spaces.unarchive(known.id);
    return { status: "restored", spaceName: known.name };
  }

  await platform.pairing.acceptInvite(invite, callbacks);
  return { status: "paired" };
}

export function useAcceptInvite<TContext = unknown>(
  options?: UseMutationOptions<
    AcceptInviteResult,
    Error,
    { invite: SpaceInvite; callbacks?: PairCallbacks },
    TContext
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ invite, callbacks }) => acceptInvite(invite, callbacks),
    ...options,
    onSuccess: (result, ...rest) => {
      // A restore moves the space out of the Archive and back into the sidebar,
      // same as unarchiving it by hand.
      if (result.status === "restored") {
        for (const key of spaceArchiveKeys()) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      }
      options?.onSuccess?.(result, ...rest);
    },
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
  options?: UseMutationOptions<
    void,
    Error,
    { invite: SpaceInvite; callbacks?: PairCallbacks },
    TContext
  >,
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
