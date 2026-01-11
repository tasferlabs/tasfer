import { useMutation, type UseMutationOptions, useQuery, type UseQueryOptions } from "@tanstack/react-query";

const API_BASE = "/api";

export interface IListPage {
  id: string;
  title: string;
  parentId: string | null;
  order: number;
  hasChildren: boolean;
}

export interface IPage {
  id: string;
  title: string;
  content: string | null;
  // CRDT operations log - serialized JSON array of operations
  operations: string | null;
  parentId: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
  parents?: { id: string; title: string }[];
}

// Fetch pages list
export async function getPages(parentId: string | null): Promise<IListPage[]> {
  const params = new URLSearchParams();
  if (parentId) {
    params.append("parentId", parentId);
  }
  
  const response = await fetch(`${API_BASE}/pages/list?${params.toString()}`);
  const data = await response.json();
  
  if (!data.success) {
    throw new Error(data.error || "Failed to fetch pages");
  }
  
  return data.data;
}

export function useGetPages(parentId: string | null) {
  return useQuery({
    queryKey: ["pages", { parentId }],
    queryFn: () => getPages(parentId),
  });
}

// Fetch single page
export async function getPage(id: string): Promise<IPage> {
  const response = await fetch(`${API_BASE}/pages/${id}`);
  const data = await response.json();
  
  if (!data.success) {
    throw new Error(data.error || "Failed to fetch page");
  }
  
  return data.data;
}

export function useGetPage(id?: string, options?: UseQueryOptions<IPage, Error, IPage, any>) {
  return useQuery({
    queryKey: ["page", id],
    queryFn: () => getPage(id!),
    enabled: !!id,
    ...options,
  });
}

// Create page
interface ICreatePage {
  title: string;
  content?: string;
  parentId: string | null;
}

export async function createPage(data: ICreatePage): Promise<IPage> {
  const response = await fetch(`${API_BASE}/pages/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  
  const result = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || "Failed to create page");
  }
  
  return result.data;
}

export function useCreatePage<TContext = unknown>(
  options?: UseMutationOptions<IPage, Error, ICreatePage, TContext>
) {
  return useMutation({
    mutationFn: createPage,
    ...options,
  });
}

// Update page
interface IUpdatePage {
  id: string;
  title?: string;
  content?: string;
  // CRDT operations log - serialized JSON array of operations
  operations?: string;
}

export async function updatePage(data: IUpdatePage): Promise<IPage> {
  const response = await fetch(`${API_BASE}/pages/${data.id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  
  const result = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || "Failed to update page");
  }
  
  return result.data;
}

export function useUpdatePage<TContext = unknown>(
  options?: UseMutationOptions<IPage, Error, IUpdatePage, TContext>
) {
  return useMutation({
    mutationFn: updatePage,
    ...options,
  });
}

// Delete page
interface IDeletePage {
  id: string;
}

export async function deletePage(data: IDeletePage): Promise<void> {
  const response = await fetch(`${API_BASE}/pages/${data.id}`, {
    method: "DELETE",
  });
  
  const result = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || "Failed to delete page");
  }
}

export function useDeletePage<TContext = unknown>(
  options?: UseMutationOptions<void, Error, IDeletePage, TContext>
) {
  return useMutation({
    mutationFn: deletePage,
    ...options,
  });
}

// Move page
interface IMovePage {
  id: string;
  parentId: string | null;
  order?: number;
}

export async function movePage(data: IMovePage): Promise<void> {
  const response = await fetch(`${API_BASE}/pages/${data.id}/move`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parentId: data.parentId,
      order: data.order,
    }),
  });
  
  const result = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || "Failed to move page");
  }
}

export function useMovePage<TContext = unknown>(
  options?: UseMutationOptions<void, Error, IMovePage, TContext>
) {
  return useMutation({
    mutationFn: movePage,
    ...options,
  });
}

// Reorder page
interface IReorderPage {
  id: string;
  order: number;
}

export async function reorderPage(data: IReorderPage): Promise<void> {
  const response = await fetch(`${API_BASE}/pages/${data.id}/reorder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ order: data.order }),
  });
  
  const result = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || "Failed to reorder page");
  }
}

export function useReorderPage<TContext = unknown>(
  options?: UseMutationOptions<void, Error, IReorderPage, TContext>
) {
  return useMutation({
    mutationFn: reorderPage,
    ...options,
  });
}

// Helper to get the query key for a page
export function getKeyForPageQuery(_id: string) {
  // This function helps to find which query contains this page
  // For now, we'll return a simple structure
  return {
    queryKey: ["pages", { parentId: null }],
  };
}

// Helper to update title in cache
export function updateTitleFromCache(_id: string, _title: string, _editingPageId: string | null) {
  // This is a placeholder - in the real implementation, we'd update the cache
  // For now, we'll let the mutation handle it
}

