import { useMutation, type UseMutationOptions, useQuery } from "@tanstack/react-query";
import { authFetchJson } from "./client";

export interface IPageShare {
  id: string;
  pageId: string;
  userId: string;
  sharedBy: string;
  permission: "view" | "edit";
  includeChildren: boolean;
  createdAt: string;
  userName: string;
  userEmail: string;
}

export interface ISharedPage {
  shareId: string;
  pageId: string;
  permission: string;
  includeChildren: boolean;
  createdAt: string;
  pageTitle: string | null;
  pageParentId: string | null;
  pageSpaceId: string;
}

export async function getPageShares(pageId: string): Promise<IPageShare[]> {
  return authFetchJson<IPageShare[]>(`/pages/${pageId}/shares`);
}

export function useGetPageShares(pageId?: string) {
  return useQuery({
    queryKey: ["page-shares", pageId],
    queryFn: () => getPageShares(pageId!),
    enabled: !!pageId,
  });
}

export async function sharePage(data: {
  pageId: string;
  email: string;
  permission: "view" | "edit";
  includeChildren: boolean;
}): Promise<IPageShare> {
  return authFetchJson<IPageShare>(`/pages/${data.pageId}/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: data.email,
      permission: data.permission,
      includeChildren: data.includeChildren,
    }),
  });
}

export function useSharePage<TContext = unknown>(
  options?: UseMutationOptions<
    IPageShare,
    Error,
    { pageId: string; email: string; permission: "view" | "edit"; includeChildren: boolean },
    TContext
  >
) {
  return useMutation({
    mutationFn: sharePage,
    ...options,
  });
}

export async function updatePageShare(data: {
  pageId: string;
  shareId: string;
  permission?: "view" | "edit";
  includeChildren?: boolean;
}): Promise<IPageShare> {
  return authFetchJson<IPageShare>(`/pages/${data.pageId}/shares/${data.shareId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      permission: data.permission,
      includeChildren: data.includeChildren,
    }),
  });
}

export function useUpdatePageShare<TContext = unknown>(
  options?: UseMutationOptions<
    IPageShare,
    Error,
    { pageId: string; shareId: string; permission?: "view" | "edit"; includeChildren?: boolean },
    TContext
  >
) {
  return useMutation({
    mutationFn: updatePageShare,
    ...options,
  });
}

export async function removePageShare(data: {
  pageId: string;
  shareId: string;
}): Promise<void> {
  await authFetchJson(`/pages/${data.pageId}/shares/${data.shareId}`, {
    method: "DELETE",
  });
}

export function useRemovePageShare<TContext = unknown>(
  options?: UseMutationOptions<
    void,
    Error,
    { pageId: string; shareId: string },
    TContext
  >
) {
  return useMutation({
    mutationFn: removePageShare,
    ...options,
  });
}

export async function getSharedWithMe(): Promise<ISharedPage[]> {
  return authFetchJson<ISharedPage[]>("/shared-with-me");
}

export function useGetSharedWithMe() {
  return useQuery({
    queryKey: ["shared-with-me"],
    queryFn: getSharedWithMe,
  });
}
