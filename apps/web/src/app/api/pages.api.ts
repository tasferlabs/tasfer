import { useMutation, type UseMutationOptions, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { Block } from "@/deserializer/loadPage";
import { authFetch, API_BASE } from "./client";

export interface IListPage {
  id: string;
  title: string;
  autoTitle: boolean;
  parentId: string | null;
  order: number;
  hasChildren: boolean;
  scheduledAt?: string | null;
  duration?: number | null;
  allDay?: boolean | null;
  recurrenceId?: string | null;
}

// HLC (Hybrid Logical Clock) for operation ordering
export interface HLC {
  counter: number;
  peerId: string;
}

export interface IPage {
  id: string;
  title: string;
  autoTitle: boolean;
  // Block snapshot
  snapshot: Block[] | null;
  // Clock of the snapshot - used for delta sync
  snapshotClock: HLC | null;
  parentId: string | null;
  order: number;
  // Calendar fields
  scheduledAt: string | null;
  duration: number | null;
  allDay: boolean | null;
  recurrenceId: string | null;
  createdAt: string;
  updatedAt: string;
  parents?: { id: string; title: string }[];
  permission?: "view" | "edit" | "owner";
}

// Fetch pages list
export async function getPages(spaceId: string, parentId: string | null): Promise<IListPage[]> {
  const params = new URLSearchParams();
  params.append("spaceId", spaceId);
  if (parentId) {
    params.append("parentId", parentId);
  }

  const response = await authFetch(`${API_BASE}/pages/list?${params.toString()}`);
  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || "Failed to fetch pages");
  }

  return data.data;
}

export function useGetPages(spaceId: string | null, parentId: string | null) {
  return useQuery({
    queryKey: ["pages", { spaceId, parentId }],
    queryFn: () => getPages(spaceId!, parentId),
    enabled: !!spaceId,
  });
}

// Fetch single page
export async function getPage(id: string): Promise<IPage> {
  const response = await authFetch(`${API_BASE}/pages/${id}`);
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
  parentId: string | null;
  spaceId: string;
  scheduledAt?: string;
  duration?: number;
  allDay?: boolean;
}

export async function createPage(data: ICreatePage): Promise<IPage> {
  const response = await authFetch(`${API_BASE}/pages/create`, {
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
  autoTitle?: boolean;
  // Block snapshot (includes tombstones for offline sync)
  snapshot?: Block[];
  // Clock of the snapshot - used for delta sync
  snapshotClock?: HLC | null;
  // Calendar fields
  scheduledAt?: string | null;
  duration?: number | null;
  allDay?: boolean | null;
}

export async function updatePage(data: IUpdatePage): Promise<IPage> {
  // Use AbortController for timeout - ensures save indicator doesn't spin forever
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const response = await authFetch(`${API_BASE}/pages/${data.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || "Failed to update page");
    }

    return result.data;
  } catch (error) {
    clearTimeout(timeoutId);
    // Re-throw with more context for network errors
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Save timed out - changes will sync when online");
    }
    throw error;
  }
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
  const response = await authFetch(`${API_BASE}/pages/${data.id}`, {
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
  spaceId?: string;
}

export async function movePage(data: IMovePage): Promise<void> {
  const response = await authFetch(`${API_BASE}/pages/${data.id}/move`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parentId: data.parentId,
      order: data.order,
      spaceId: data.spaceId,
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
  const response = await authFetch(`${API_BASE}/pages/${data.id}/reorder`, {
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

// Search pages by title
export interface ISearchPage {
  id: string;
  title: string | null;
  parentId: string | null;
  path: string | null;
}

export async function searchPages(spaceId: string, query: string): Promise<ISearchPage[]> {
  const params = new URLSearchParams({ spaceId, q: query, limit: "20" });
  const response = await authFetch(`${API_BASE}/pages/search?${params.toString()}`);
  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || "Failed to search pages");
  }

  return data.data;
}

export function useSearchPages(spaceId: string | null, query: string) {
  return useQuery({
    queryKey: ["pages-search", { spaceId, query }],
    queryFn: () => searchPages(spaceId!, query),
    enabled: !!spaceId,
    placeholderData: (prev) => prev,
  });
}

// Calendar range query
export interface ICalendarPage {
  id: string;
  title: string;
  autoTitle: boolean;
  parentId: string | null;
  order: number;
  scheduledAt: string;
  duration: number | null;
  allDay: boolean | null;
  recurrenceId: string | null;
  createdAt: string;
}

export async function getCalendarPages(spaceId: string, start: number, end: number): Promise<ICalendarPage[]> {
  const params = new URLSearchParams({
    spaceId,
    start: String(start),
    end: String(end),
  });

  const response = await authFetch(`${API_BASE}/pages/calendar/range?${params.toString()}`);
  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || "Failed to fetch calendar pages");
  }

  return data.data;
}

export function useGetCalendarPages(spaceId: string | null, start: number, end: number) {
  return useQuery({
    queryKey: ["calendar-pages", { spaceId, start, end }],
    queryFn: () => getCalendarPages(spaceId!, start, end),
    enabled: !!spaceId,
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

// =============================================================================
// Snapshot API
// =============================================================================

export interface ISnapshot {
  id: string;
  pageId: string;
  blocks: Block[];
  size: number;
  clock: HLC | null;
  createdAt: string;
  updatedAt: string;
}

// Get all snapshots for a page (version history)
export async function getPageSnapshots(pageId: string): Promise<ISnapshot[]> {
  const response = await authFetch(`${API_BASE}/pages/${pageId}/snapshots`);
  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || "Failed to fetch snapshots");
  }

  return data.data;
}

export function useGetPageSnapshots(pageId?: string) {
  return useQuery({
    queryKey: ["page-snapshots", pageId],
    queryFn: () => getPageSnapshots(pageId!),
    enabled: !!pageId,
  });
}
