/**
 * Spaces API — transitional stub.
 *
 * Spaces (multi-user groups with a central server) are being removed
 * in the decentralized model. This file keeps the type exports and
 * hook signatures so existing consumers compile, but all operations
 * return a single local workspace.
 *
 * TODO: Remove this file once SpaceContext and all consumers are
 * migrated to the workspace concept or removed entirely.
 */

import { useMutation, type UseMutationOptions, useQuery } from "@tanstack/react-query";

export interface ISpace {
  id: string;
  name: string;
  description: string;
  type: "personal" | "group";
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  role?: string;
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

interface SpacesResponse {
  owned: ISpace[];
  member: (ISpace & { role: string })[];
}

// Return a single local workspace
const LOCAL_WORKSPACE: ISpace = {
  id: "local",
  name: "My Workspace",
  description: "",
  type: "personal",
  ownerId: "local",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  role: "owner",
};

export async function getSpaces(): Promise<SpacesResponse> {
  return { owned: [LOCAL_WORKSPACE], member: [] };
}

export function useGetSpaces() {
  return useQuery({
    queryKey: ["spaces"],
    queryFn: getSpaces,
  });
}

export async function createSpace(_data: { name: string; description: string }): Promise<ISpace> {
  throw new Error("Spaces are not available in decentralized mode");
}

export function useCreateSpace<TContext = unknown>(
  options?: UseMutationOptions<ISpace, Error, { name: string; description: string }, TContext>
) {
  return useMutation({
    mutationFn: createSpace,
    ...options,
  });
}

export async function updateSpace(_data: {
  id: string;
  name: string;
  description?: string;
}): Promise<ISpace> {
  throw new Error("Spaces are not available in decentralized mode");
}

export function useUpdateSpace<TContext = unknown>(
  options?: UseMutationOptions<
    ISpace,
    Error,
    { id: string; name: string; description?: string },
    TContext
  >
) {
  return useMutation({
    mutationFn: updateSpace,
    ...options,
  });
}

export async function deleteSpace(_id: string): Promise<void> {
  throw new Error("Spaces are not available in decentralized mode");
}

export function useDeleteSpace<TContext = unknown>(
  options?: UseMutationOptions<void, Error, string, TContext>
) {
  return useMutation({
    mutationFn: deleteSpace,
    ...options,
  });
}

export async function leaveSpace(_spaceId: string): Promise<void> {
  throw new Error("Spaces are not available in decentralized mode");
}

export function useLeaveSpace<TContext = unknown>(
  options?: UseMutationOptions<void, Error, string, TContext>
) {
  return useMutation({
    mutationFn: leaveSpace,
    ...options,
  });
}

export async function getSpaceMembers(_spaceId: string): Promise<ISpaceMember[]> {
  return [];
}

export function useGetSpaceMembers(spaceId?: string) {
  return useQuery({
    queryKey: ["space-members", spaceId],
    queryFn: () => getSpaceMembers(spaceId!),
    enabled: !!spaceId,
  });
}

export async function addSpaceMember(_data: {
  spaceId: string;
  email: string;
}): Promise<ISpaceMember> {
  throw new Error("Spaces are not available in decentralized mode");
}

export function useAddSpaceMember<TContext = unknown>(
  options?: UseMutationOptions<
    ISpaceMember,
    Error,
    { spaceId: string; email: string },
    TContext
  >
) {
  return useMutation({
    mutationFn: addSpaceMember,
    ...options,
  });
}

export async function removeSpaceMember(_data: {
  spaceId: string;
  memberId: string;
}): Promise<void> {
  throw new Error("Spaces are not available in decentralized mode");
}

export function useRemoveSpaceMember<TContext = unknown>(
  options?: UseMutationOptions<
    void,
    Error,
    { spaceId: string; memberId: string },
    TContext
  >
) {
  return useMutation({
    mutationFn: removeSpaceMember,
    ...options,
  });
}
