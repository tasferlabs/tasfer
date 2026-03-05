import { useMutation, type UseMutationOptions, useQuery } from "@tanstack/react-query";
import { authFetchJson } from "./client";

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

export async function getSpaces(): Promise<SpacesResponse> {
  return authFetchJson<SpacesResponse>("/spaces");
}

export function useGetSpaces() {
  return useQuery({
    queryKey: ["spaces"],
    queryFn: getSpaces,
  });
}

export async function createSpace(data: { name: string; description: string }): Promise<ISpace> {
  return authFetchJson<ISpace>("/spaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function useCreateSpace<TContext = unknown>(
  options?: UseMutationOptions<ISpace, Error, { name: string; description: string }, TContext>
) {
  return useMutation({
    mutationFn: createSpace,
    ...options,
  });
}

export async function updateSpace(data: {
  id: string;
  name: string;
  description?: string;
}): Promise<ISpace> {
  return authFetchJson<ISpace>(`/spaces/${data.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: data.name, description: data.description }),
  });
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

export async function deleteSpace(id: string): Promise<void> {
  await authFetchJson(`/spaces/${id}`, { method: "DELETE" });
}

export function useDeleteSpace<TContext = unknown>(
  options?: UseMutationOptions<void, Error, string, TContext>
) {
  return useMutation({
    mutationFn: deleteSpace,
    ...options,
  });
}

export async function leaveSpace(spaceId: string): Promise<void> {
  await authFetchJson(`/spaces/${spaceId}/leave`, { method: "POST" });
}

export function useLeaveSpace<TContext = unknown>(
  options?: UseMutationOptions<void, Error, string, TContext>
) {
  return useMutation({
    mutationFn: leaveSpace,
    ...options,
  });
}

export async function getSpaceMembers(spaceId: string): Promise<ISpaceMember[]> {
  return authFetchJson<ISpaceMember[]>(`/spaces/${spaceId}/members`);
}

export function useGetSpaceMembers(spaceId?: string) {
  return useQuery({
    queryKey: ["space-members", spaceId],
    queryFn: () => getSpaceMembers(spaceId!),
    enabled: !!spaceId,
  });
}

export async function addSpaceMember(data: {
  spaceId: string;
  email: string;
}): Promise<ISpaceMember> {
  return authFetchJson<ISpaceMember>(`/spaces/${data.spaceId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: data.email }),
  });
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

export async function removeSpaceMember(data: {
  spaceId: string;
  memberId: string;
}): Promise<void> {
  await authFetchJson(`/spaces/${data.spaceId}/members/${data.memberId}`, {
    method: "DELETE",
  });
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
