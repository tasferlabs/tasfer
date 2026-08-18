import {
  useMutation,
  type UseMutationOptions,
  useQuery,
  type UseQueryOptions,
  useQueryClient,
} from "@tanstack/react-query";
import { getPlatform } from "@/platform";
import type {
  PageListItem,
  ArchivedPageItem,
  ArchivedPageRef,
  PageFull,
  PageSearchResult,
  PageCalendarItem,
  PageVersion,
} from "@/platform";
import type { Block } from "@tasfer/editor";

// =============================================================================
// Type aliases — keep old names so consumers don't need updating
// =============================================================================

export type IListPage = PageListItem;
export type { ArchivedPageItem, ArchivedPageRef };
export type IPage = PageFull;
export type ISearchPage = PageSearchResult;
export type ICalendarPage = PageCalendarItem;
export type IVersion = PageVersion;

// =============================================================================
// Pages API — delegates to platform
// =============================================================================

export async function getPages(
  spaceId: string,
  parentId: string | null,
  options?: { includeTasks?: boolean },
): Promise<IListPage[]> {
  const platform = getPlatform();
  return platform.pages.list(spaceId, parentId, options);
}

export function useGetPages(spaceId: string | null, parentId: string | null) {
  return useQuery({
    queryKey: ["pages", { spaceId, parentId, includeTasks: false }],
    queryFn: () => getPages(spaceId!, parentId),
    enabled: !!spaceId,
  });
}

export async function getPage(id: string): Promise<IPage> {
  const platform = getPlatform();
  return platform.pages.get(id);
}

export function useGetPage(
  id?: string,
  options?: UseQueryOptions<IPage, Error, IPage, any>,
) {
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
  /** Markdown projection of the title line (rich title previews). */
  titleMd?: string;
  parentId: string | null;
  spaceId: string;
  scheduledAt?: string;
  duration?: number;
  allDay?: boolean;
  task?: boolean;
}

export async function createPage(data: ICreatePage): Promise<IPage> {
  const platform = getPlatform();
  return platform.pages.create(data);
}

export function useCreatePage<TContext = unknown>(
  options?: UseMutationOptions<IPage, Error, ICreatePage, TContext>,
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
  /** Markdown projection of the title line (rich title previews). */
  titleMd?: string;
  color?: string | null;
  scheduledAt?: string | null;
  duration?: number | null;
  allDay?: boolean | null;
  task?: boolean;
}

export async function updatePage(data: IUpdatePage): Promise<IPage> {
  const platform = getPlatform();
  return platform.pages.update(data);
}

export function useUpdatePage<TContext = unknown>(
  options?: UseMutationOptions<IPage, Error, IUpdatePage, TContext>,
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
  const platform = getPlatform();
  return platform.pages.delete(data.id);
}

export function useDeletePage<TContext = unknown>(
  options?: UseMutationOptions<void, Error, IDeletePage, TContext>,
) {
  return useMutation({
    mutationFn: deletePage,
    ...options,
  });
}

// A page that was archived after someone saved its link
export async function getArchivedPage(
  id: string,
): Promise<ArchivedPageRef | null> {
  const platform = getPlatform();
  return platform.pages.getArchived(id);
}

// Archived (soft-deleted) pages — the Archive
export async function getArchivedPages(): Promise<ArchivedPageItem[]> {
  const platform = getPlatform();
  return platform.pages.listArchived();
}

export function useGetArchivedPages() {
  return useQuery({
    queryKey: ["pages-archived"],
    queryFn: getArchivedPages,
  });
}

// Restore a soft-deleted page (and its archived subtree)
interface IRestorePage {
  id: string;
}

export async function restorePage(data: IRestorePage): Promise<void> {
  const platform = getPlatform();
  return platform.pages.restore(data.id);
}

export function useRestorePage<TContext = unknown>(
  options?: UseMutationOptions<void, Error, IRestorePage, TContext>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: restorePage,
    ...options,
    onSuccess: (...args) => {
      queryClient.invalidateQueries({ queryKey: ["pages-archived"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
      options?.onSuccess?.(...args);
    },
  });
}

// Move page
interface IMovePage {
  id: string;
  parentId: string | null;
  order?: number;
}

export async function movePage(data: IMovePage): Promise<void> {
  const platform = getPlatform();
  return platform.pages.move({
    id: data.id,
    parentId: data.parentId,
    order: data.order,
  });
}

export function useMovePage<TContext = unknown>(
  options?: UseMutationOptions<void, Error, IMovePage, TContext>,
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
  const platform = getPlatform();
  return platform.pages.reorder(data.id, data.order);
}

export function useReorderPage<TContext = unknown>(
  options?: UseMutationOptions<void, Error, IReorderPage, TContext>,
) {
  return useMutation({
    mutationFn: reorderPage,
    ...options,
  });
}

// Search pages
export async function searchPages(
  query: string,
  spaceId?: string | null,
): Promise<ISearchPage[]> {
  const platform = getPlatform();
  return platform.pages.search(query, spaceId);
}

/**
 * Search pages across every space. Pass `spaceId` to restrict the search to
 * one space — for pickers that can only land a page inside a given space.
 */
export function useSearchPages(
  query: string,
  options?: { spaceId?: string | null; enabled?: boolean },
) {
  const spaceId = options?.spaceId ?? null;
  return useQuery({
    queryKey: ["pages-search", { spaceId, query }],
    queryFn: () => searchPages(query, spaceId),
    enabled: options?.enabled ?? true,
    placeholderData: (prev) => prev,
  });
}

// Calendar range query
export async function getCalendarPages(
  _spaceId: string,
  start: number,
  end: number,
): Promise<ICalendarPage[]> {
  const platform = getPlatform();
  return platform.pages.calendar(start, end);
}

export function useGetCalendarPages(
  spaceId: string | null,
  start: number,
  end: number,
) {
  return useQuery({
    queryKey: ["calendar-pages", { spaceId, start, end }],
    queryFn: () => getCalendarPages(spaceId!, start, end),
    enabled: !!spaceId,
  });
}

// Helper to get the query key for a page
export function getKeyForPageQuery(_id: string) {
  return {
    queryKey: ["pages", { parentId: null }],
  };
}

// Helper to update title in cache
export function updateTitleFromCache(
  _id: string,
  _title: string,
  _editingPageId: string | null,
) {
  // Placeholder — cache updates handled by mutation callbacks
}

// =============================================================================
// Version history API
// =============================================================================

export async function getPageVersions(pageId: string): Promise<IVersion[]> {
  const platform = getPlatform();
  return platform.pages.versions(pageId);
}

export function useGetPageVersions(pageId?: string) {
  return useQuery({
    queryKey: ["page-versions", pageId],
    queryFn: () => getPageVersions(pageId!),
    enabled: !!pageId,
  });
}

export async function getVersionBlocks(
  pageId: string,
  versionId: string,
): Promise<Block[]> {
  const platform = getPlatform();
  return platform.pages.versionBlocks(pageId, versionId);
}

/**
 * Content for one version entry, fetched only once the user opens it. The list
 * itself carries no blocks — building all of them up front is a reducer replay
 * per entry, for content nobody has asked to see.
 */
export function useVersionBlocks(pageId?: string, versionId?: string) {
  return useQuery({
    queryKey: ["page-version-blocks", pageId, versionId],
    queryFn: () => getVersionBlocks(pageId!, versionId!),
    enabled: !!pageId && !!versionId,
    staleTime: Infinity,
  });
}

/** Latest content rebuilt straight from the op log (works for archived pages). */
export async function rebuildPageBlocks(pageId: string): Promise<Block[]> {
  const platform = getPlatform();
  return platform.pages.rebuild(pageId);
}

export function useRebuiltPageBlocks(pageId?: string) {
  return useQuery({
    queryKey: ["page-rebuild", pageId],
    queryFn: () => rebuildPageBlocks(pageId!),
    enabled: !!pageId,
  });
}
