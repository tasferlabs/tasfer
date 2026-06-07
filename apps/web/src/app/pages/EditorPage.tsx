import type { SyncState } from "@/app/hooks/useP2PRoom";
import DateTimePicker from "@/components/datetimepickers/DateTimePicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { type Block } from "@cypherkit/editor/serlization/loadPage";
import type { TextualBlock } from "@cypherkit/editor/rendering/blocks/TextBlockView";
import type { AwarenessUser } from "@cypherkit/editor/sync/awareness";
import {
  extractTitleFromBlocks,
  getVisibleTextFromRuns,
} from "@cypherkit/editor/sync/char-runs";
import {
  formatDatePreferred,
  formatTimePreferred,
} from "@/lib/dateTimePreferences";
import {
  DURATION_OPTIONS,
  formatDurationLabel,
  type TFunction,
} from "@/lib/utils";
import * as Popover from "@radix-ui/react-popover";
import { useQueryClient } from "@tanstack/react-query";
import { debounce } from "lodash-es";
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  History,
  Trash,
} from "lucide-react";
import { DateTime } from "luxon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { ActiveUsersAvatars } from "../components/ActiveUsersAvatars";
import { PageSettings } from "../components/PageSettings";
import { SavingIndicator } from "../components/SavingIndicator";
import { TopActionBarPortal } from "../layout/TopActionBarSlot";
import { MountedEditor } from "../MountedEditor";

import { useP2PPageEvents } from "@/app/hooks/useP2PPageEvents";
import { PagePicker } from "@/components/PagePicker";
import clsx from "clsx";
import {
  getPage,
  useCreatePage,
  useGetPage,
  useGetPages,
  useMovePage,
  useUpdatePage,
} from "../api/pages.api";
import EmptyStateIllustration from "../components/illustrations/empty-state";
import ErrorStateIllustration from "../components/illustrations/error-state";
import NotFoundStateIllustration from "../components/illustrations/not-found-state";
import { SnapshotRestore } from "../components/SnapshotRestore";
import { WordCountOverlay } from "../components/WordCountOverlay";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { useSpaces } from "../contexts/SpaceContext";
import { useTreeExpand } from "../contexts/TreeExpandContext";
import { useDebouncedSave } from "../hooks/useDebouncedSave";
import useLocalStorage from "../hooks/useLocalStorage";
import { useNavigationPrompt } from "../hooks/useNavigationPrompt";
import useResponsive from "../hooks/useResponsive";
import style from "./EditorPage.module.css";
import { isTextualBlock } from "@cypherkit/editor/sync/block-registry";

// Helper function to count words from blocks
function countWordsFromBlocks(blocks: Block[]): number {
  let count = 0;

  // CJK (Chinese, Japanese, Korean) character ranges
  const cjkRegex =
    /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g;

  for (const block of blocks) {
    // Skip non-text blocks
    if (!isTextualBlock(block)) continue;
    if (block.deleted) continue;

    // Get text from charRuns
    const text = getVisibleTextFromRuns((block as TextualBlock).charRuns);

    // Count CJK characters (each character is typically a word/concept)
    const cjkMatches = text.match(cjkRegex);
    if (cjkMatches) {
      count += cjkMatches.length;
    }

    // Remove CJK characters for the remaining word count
    const textWithoutCJK = text.replace(cjkRegex, "");

    // Split by whitespace and count non-CJK words
    const words = textWithoutCJK
      .split(/\s+/)
      .map((word) =>
        // Remove punctuation from the beginning and end of each word
        word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""),
      )
      .filter((word) => word.length > 0);

    count += words.length;
  }

  return count;
}

const SCHEDULE_TAG_HEIGHT = 40;
const SCHEDULE_TAG_PADDING = { paddingTop: SCHEDULE_TAG_HEIGHT } as const;

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const {
    setIsSaving: setGlobalIsSaving,
    setWordCount,
    setActiveUsers,
    setPageId,
    setCurrentBlocks,
    setOnRestoreSnapshot,
    setPermission,
  } = usePageSettings();
  const { mutateAsync: updatePage } = useUpdatePage();
  // Permission level from the API - determines if editor is readonly
  const [permission, setLocalPermission] = useState<"view" | "edit" | "owner">(
    "owner",
  );
  // State for loading page blocks once on mount
  const [pageSnapshot, setPageSnapshot] = useState<Block[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  // Track if page was deleted by another user (via WebSocket)
  const [isDeletedByOther, setIsDeletedByOther] = useState(false);
  // Persisted editor state - once entered, stays until user takes action
  const [persistedState, setPersistedState] = useState<
    "empty" | "not-found" | "error" | "corrupted" | null
  >(null);
  // Auto-title state - when true, title is auto-generated from content
  const [autoTitle, setAutoTitle] = useState(true);
  const [currentTitle, setCurrentTitle] = useState<string>("");
  // The page's actual space_id (from DB), used for P2P sync routing
  const [pageSpaceId, setPageSpaceId] = useState<string | null>(null);
  // Live sync state
  const [_syncState, setSyncState] = useState<SyncState>({
    status: "disconnected",
  });
  // Track editor canvas scroll position for scrolling overlay elements (ref to avoid re-renders)
  const scheduleTagRef = useRef<HTMLDivElement>(null);
  // Restore function ref from MountedEditor
  const restoreFnRef = useRef<((blocks: Block[]) => void) | null>(null);

  const navigate = useNavigate();
  const { activeSpaceId } = useSpaces();
  const treeExpand = useTreeExpand();
  const { data: pages, isLoading: isLoadingPages } = useGetPages(
    activeSpaceId,
    null,
  );
  const [lastPageId, setLastPageId] = useLocalStorage<string | null>(
    "lastPageId",
    null,
  );

  // Create debounced word count updater (500ms delay for performance)
  const debouncedWordCountUpdate = useRef(
    debounce((blocks: Block[]) => {
      const count = countWordsFromBlocks(blocks);
      setWordCount(count);
    }, 500),
  ).current;

  // Refs for auto-title to avoid stale closures
  const autoTitleRef = useRef(autoTitle);
  const currentTitleRef = useRef(currentTitle);
  useEffect(() => {
    autoTitleRef.current = autoTitle;
  }, [autoTitle]);
  useEffect(() => {
    currentTitleRef.current = currentTitle;
  }, [currentTitle]);

  useEffect(() => {
    if (id) {
      setLastPageId(id);
      setPageId(id);
      // Reset deleted state when navigating to a new page
      setIsDeletedByOther(false);
    }
    // Reset persisted state and scroll position when ID changes (user navigated)
    setPersistedState(null);
    if (scheduleTagRef.current) {
      scheduleTagRef.current.style.transform = "translateY(0px)";
    }
    // Reset permission to owner (will be updated after page load)
    setLocalPermission("owner");
    setPermission("owner");
    return () => {
      setPageId(null);
    };
  }, [id, setLastPageId, setPageId, setPermission]);

  // Listen for page deletion events (both local and remote)
  useP2PPageEvents({
    onPageDeleted: (deletedPageId) => {
      if (deletedPageId === id) {
        setIsDeletedByOther(true);
        // Navigate to another page so the user isn't stuck on a deleted page
        const remaining = pages?.filter((p) => p.id !== deletedPageId);
        if (remaining && remaining.length > 0) {
          navigate(`/page/${remaining[0].id}`, { replace: true });
        } else {
          navigate("/page", { replace: true });
        }
      }
    },
  });

  useEffect(() => {
    if (isError) {
      setLastPageId(null);
    }
  }, [isError, setLastPageId]);

  // Set persisted state when entering error/empty conditions
  // Once set, this state persists until user navigates (id changes)
  useEffect(() => {
    if (persistedState !== null) return; // Already in a persisted state

    if (!id) {
      // No page ID - check if we should show empty state
      if (activeSpaceId && !isLoadingPages && (!pages || pages.length === 0)) {
        setPersistedState("empty");
      }
    } else {
      // Have page ID - check if we should show not-found state
      if (
        !isLoading &&
        (isError || pageSnapshot === null || isDeletedByOther)
      ) {
        setPersistedState("not-found");
      }
    }
  }, [
    id,
    activeSpaceId,
    isLoadingPages,
    pages,
    isLoading,
    isError,
    pageSnapshot,
    isDeletedByOther,
    persistedState,
  ]);

  // Cleanup debounced word count on unmount
  useEffect(() => {
    return () => {
      debouncedWordCountUpdate.cancel();
    };
  }, [debouncedWordCountUpdate]);

  // Fetch page snapshot once on mount or when ID changes
  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function loadPageData() {
      setIsLoading(true);
      setIsError(false);

      try {
        const page = await getPage(id!);
        if (!cancelled) {
          const blocks = page.blocks || [];
          // Detect corrupted/empty page data — a valid page must have at least one visible block
          const hasVisibleBlocks = blocks.some((b) => !b.deleted);
          if (!hasVisibleBlocks) {
            // Page exists but has no content — mark as corrupted so user can recover from snapshots
            setPageSnapshot(blocks);
            setAutoTitle(page.autoTitle);
            setCurrentTitle(page.title || "");
            setPageSpaceId(page.spaceId ?? null);
            setLocalPermission("owner");
            setPermission("owner");
            setIsLoading(false);
            setPersistedState("corrupted");
            return;
          }
          setPageSnapshot(blocks);
          // Track auto-title state
          setAutoTitle(page.autoTitle);
          setCurrentTitle(page.title || "");
          // Store the page's actual space ID for P2P sync routing
          setPageSpaceId(page.spaceId ?? null);
          // Track permission
          const perm = "owner";
          setLocalPermission(perm);
          setPermission(perm);
          setIsLoading(false);
          // Update initial word count from blocks
          setWordCount(countWordsFromBlocks(blocks));
          // Expand all ancestor pages in the sidebar tree
          if (page.parents && page.parents.length > 0) {
            treeExpand.expandMany(page.parents.map((p) => p.id));
          }
        }
      } catch (error) {
        console.error("Failed to load page:", error);
        if (!cancelled) {
          setIsError(true);
          setIsLoading(false);
        }
      }
    }

    loadPageData();

    return () => {
      cancelled = true;
    };
  }, [id, setWordCount]);

  // Debounced save callback - only called for local user-initiated changes
  // Remote peer updates are NOT persisted by this user; peers handle saving their own changes
  // IMPORTANT: pageId is passed with the data to avoid race conditions when switching pages
  const handleSave = useCallback(
    async ({ pageId, blocks }: { pageId: string; blocks: Block[] }) => {
      if (!pageId) return;

      try {
        const updateData: { id: string; title?: string } = { id: pageId };

        let titleChanged = false;
        // Only update title if we're still on the same page
        if (autoTitleRef.current && pageId === id) {
          const extractedTitle = extractTitleFromBlocks(blocks);
          if (extractedTitle !== currentTitleRef.current) {
            updateData.title = extractedTitle;
            setCurrentTitle(extractedTitle);
            titleChanged = true;
          }
        }

        await updatePage(updateData);

        // Invalidate page list queries AFTER save completes so sidebar gets updated title
        if (titleChanged) {
          queryClient.invalidateQueries({ queryKey: ["pages"] });
          queryClient.invalidateQueries({ queryKey: ["page"] });
        }
      } catch (error) {
        console.error("Failed to save content:", error);
      }
    },
    [id, updatePage, queryClient],
  );

  const {
    save: debouncedSave,
    flush,
    isSaving,
  } = useDebouncedSave(handleSave, 1000);

  // Sync local isSaving state with global context
  useEffect(() => {
    setGlobalIsSaving(isSaving);
  }, [isSaving, setGlobalIsSaving]);

  // Keep a ref to isSaving for beforeunload handler (avoids stale closure)
  const isSavingRef = useRef(isSaving);
  isSavingRef.current = isSaving;

  // Handle content changes from editor (local changes only - for saving)
  // Captures current page ID to ensure save targets the correct page
  const handleContentChange = useCallback(
    (blocks: Block[]) => {
      if (!id) return;
      debouncedSave({ pageId: id, blocks });
    },
    [id, debouncedSave],
  );

  // Handle all content updates (local and remote - for word count)
  const handleContentUpdate = useCallback(
    (blocks: Block[]) => {
      debouncedWordCountUpdate(blocks);
      setCurrentBlocks(blocks);
    },
    [debouncedWordCountUpdate, setCurrentBlocks],
  );

  // Handle snapshot restoration
  const handleRestoreSnapshot = useCallback(
    (blocks: Block[]) => {
      if (!id) return;
      if (restoreFnRef.current) {
        // Normal restore through mounted editor (generates CRDT operations)
        restoreFnRef.current(blocks);
      } else {
        // Corrupted state — no editor mounted, restore directly
        setPageSnapshot(blocks);
        setPersistedState(null);
      }
    },
    [id],
  );

  // Expose restore callback to context (not in readonly mode)
  useEffect(() => {
    if (permission === "view") return;
    setOnRestoreSnapshot(handleRestoreSnapshot);
    return () => {
      setOnRestoreSnapshot(null);
    };
  }, [handleRestoreSnapshot, setOnRestoreSnapshot, permission]);

  // Warn user before leaving page if there are unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isSavingRef.current) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  // Prompt user before in-app navigation if saving
  useNavigationPrompt(isSaving);

  // Flush pending saves and reset saving state before unmount
  useEffect(() => {
    return () => {
      flush();
      setGlobalIsSaving(false);
    };
  }, [flush, setGlobalIsSaving]);

  // Handle awareness changes from collaborators
  const handleAwarenessChange = useCallback(
    (users: AwarenessUser[]) => {
      setActiveUsers(users);
    },
    [setActiveUsers],
  );

  // Check persisted state first - once entered, stay until user navigates
  if (persistedState === "empty") {
    return <EditorEmptyState />;
  }
  if (persistedState === "not-found") {
    return <EditorNotFoundState />;
  }
  if (persistedState === "error") {
    return <EditorErrorState />;
  }
  if (persistedState === "corrupted") {
    return <EditorCorruptedState />;
  }

  // If no ID in URL
  if (!id) {
    if (isLoadingPages || !activeSpaceId) {
      return <EditorLoadingState />;
    }

    if (pages && pages.length > 0) {
      return <Navigate to={`/page/${lastPageId || pages[0].id}`} replace />;
    }

    // Will trigger persistedState effect on next render
    return <EditorEmptyState />;
  }

  if (isLoading) {
    return <EditorLoadingState />;
  }

  if (isError || pageSnapshot === null || isDeletedByOther) {
    // Will trigger persistedState effect on next render
    return <EditorNotFoundState />;
  }

  const readonly = permission === "view";

  // Pass snapshot blocks to the editor
  // Snapshot is loaded once on mount, editor manages state from there
  return (
    <div className="flex flex-col w-full h-full">
      <TopActionBarPortal>
        <PageActionBar pageId={id} />
      </TopActionBarPortal>
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {/* Schedule tag overlaid on editor, scrolls with canvas content */}
        <div
          ref={scheduleTagRef}
          className="pointer-events-none absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-2 md:px-[40px]"
        >
          <div className="pointer-events-auto">
            <ScheduleTag pageId={id} readonly={readonly} />
          </div>
        </div>
        <MountedEditor
          snapshot={pageSnapshot}
          className="w-full h-full"
          onContentChange={readonly ? undefined : handleContentChange}
          onContentUpdate={handleContentUpdate}
          autoFocus={!readonly}
          pageId={id}
          spaceId={pageSpaceId ?? activeSpaceId ?? undefined}
          onSyncStateChange={setSyncState}
          onAwarenessChange={handleAwarenessChange}
          onRestoreReady={
            readonly
              ? undefined
              : (restoreFn) => {
                  restoreFnRef.current = restoreFn;
                }
          }
          readonly={readonly}
          padding={SCHEDULE_TAG_PADDING}
          onScroll={(scrollY) => {
            if (scheduleTagRef.current) {
              scheduleTagRef.current.style.transform = `translateY(${-scrollY}px)`;
            }
          }}
        />
      </div>
      <WordCountOverlay />
    </div>
  );
}

// ── Page Tags Bar ──

function formatScheduleLabel(
  iso: string,
  duration: number | null,
  t: TFunction,
): string {
  const d = new Date(iso);
  const date = formatDatePreferred(d, {
    month: "short",
    day: "numeric",
  });
  const time = formatTimePreferred(d, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (duration) {
    return t("format.dateTimeDuration", {
      defaultValue: "{{date}}, {{time}} ({{duration}})",
      date,
      time,
      duration: formatDurationLabel(duration, t),
    });
  }
  return t("format.dateTime", {
    defaultValue: "{{date}}, {{time}}",
    date,
    time,
  });
}

interface ScheduleFormValues {
  scheduledAt: string | null;
  duration: number;
}

function ScheduleContent({
  pageId,
  scheduledAt,
  duration,
  readonly,
}: {
  pageId: string;
  scheduledAt: string | null;
  duration: number | null;
  readonly: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { mutate: update } = useUpdatePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["page", pageId] });
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
    },
  });

  const tz = DateTime.local().zoneName;

  const { control } = useForm<ScheduleFormValues>({
    defaultValues: {
      scheduledAt: scheduledAt ?? null,
      duration: duration ?? 60,
    },
  });

  const durationLabels = useMemo(
    () => DURATION_OPTIONS.map((d) => formatDurationLabel(d, t)),
    [t],
  );

  const handleRemoveSchedule = () => {
    update({ id: pageId, scheduledAt: null, duration: null, allDay: null });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">
          {t("settings.dateTime.title", "Date & Time")}
        </label>
        <Controller
          control={control}
          name="scheduledAt"
          render={({ field }) => (
            <DateTimePicker
              type="datetime"
              value={field.value}
              onChange={(value) => {
                field.onChange(value);
                update({ id: pageId, scheduledAt: value });
              }}
              disabled={readonly}
              timezone={tz}
              fullWidth
            />
          )}
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">
          {t("calendar.duration", "Duration")}
        </label>
        <Controller
          control={control}
          name="duration"
          render={({ field }) => (
            <Combobox
              items={durationLabels}
              value={formatDurationLabel(field.value, t)}
              onValueChange={(val) => {
                if (val == null) return;
                const idx = durationLabels.indexOf(val);
                if (idx !== -1) {
                  field.onChange(DURATION_OPTIONS[idx]);
                  update({ id: pageId, duration: DURATION_OPTIONS[idx] });
                }
              }}
              disabled={readonly}
            >
              <ComboboxInput
                placeholder={formatDurationLabel(field.value, t)}
              />
              <ComboboxContent>
                <ComboboxList>
                  {(item) => (
                    <ComboboxItem key={item} value={item}>
                      {item}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          )}
        />
      </div>

      {!readonly && scheduledAt && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRemoveSchedule}
          className="w-full justify-start gap-2 text-destructive hover:text-destructive"
        >
          <Trash className="h-4 w-4" />
          {t("calendar.removeFromSchedule", "Remove from Schedule")}
        </Button>
      )}
    </div>
  );
}

function ScheduleTag({
  pageId,
  readonly,
}: {
  pageId: string;
  readonly: boolean;
}) {
  const { t } = useTranslation();
  const { data: page } = useGetPage(pageId);
  const [open, setOpen] = useState(false);
  const isMobile = useResponsive("(max-width: 768px)");

  const isScheduled = !!page?.scheduledAt;
  const label = isScheduled
    ? formatScheduleLabel(page.scheduledAt!, page.duration || null, t)
    : t("calendar.schedule", "Schedule");

  const content = (
    <ScheduleContent
      pageId={pageId}
      scheduledAt={page?.scheduledAt ?? null}
      duration={page?.duration ?? null}
      readonly={readonly}
    />
  );

  if (isMobile) {
    return (
      <>
        <Badge
          variant={isScheduled ? "secondary" : "outline"}
          className="cursor-pointer gap-1.5 select-none"
          onClick={() => setOpen(true)}
        >
          <Calendar className="h-3 w-3" />
          {label}
        </Badge>
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent>
            <div className="mx-auto w-full max-w-sm pb-6">
              <DrawerHeader>
                <DrawerTitle>{t("calendar.schedule", "Schedule")}</DrawerTitle>
              </DrawerHeader>
              <div className="px-4">{content}</div>
            </div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Badge
          variant={isScheduled ? "secondary" : "outline"}
          className="cursor-pointer gap-1.5 select-none"
        >
          <Calendar className="h-3 w-3" />
          {label}
        </Badge>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          className="z-50 w-[320px] rounded-lg border border-border bg-popover p-4 shadow-lg animate-in fade-in-0 zoom-in-95"
          onEscapeKeyDown={(e) => {
            if (
              document.querySelector(
                '[data-slot="combobox-content"][data-open]',
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          <h3 className="text-sm font-semibold mb-3">
            {t("calendar.schedule", "Schedule")}
          </h3>
          {content}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MovePageButton({
  pageId,
  currentParentId,
  children,
}: {
  pageId: string;
  currentParentId: string | null;
  children: React.ReactNode;
}) {
  const { activeSpaceId } = useSpaces();
  const queryClient = useQueryClient();

  const { mutate: move } = useMovePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["page", pageId] });
    },
  });

  return (
    <PagePicker
      spaceId={activeSpaceId}
      excludeId={pageId}
      showNoneOption={!!currentParentId}
      onChange={(page) => move({ id: pageId, parentId: page?.id ?? null })}
    >
      {children}
    </PagePicker>
  );
}

function PageActionBar({ pageId }: { pageId: string }) {
  const {
    data: page,
    isLoading: isPageLoading,
    isError: isPageError,
  } = useGetPage(pageId);
  const { isSaving, activeUsers, permission } = usePageSettings();
  const { t } = useTranslation();

  // Effective color: page's own color, or inherit from closest ancestor that has one
  const effectiveColor =
    page?.color ??
    [...(page?.parents ?? [])].reverse().find((p) => p.color)?.color ??
    null;

  return (
    <>
      {permission !== "view" && page ? (
        <MovePageButton pageId={pageId} currentParentId={page.parentId}>
          <button className={style.breadcrumbs} style={{ cursor: "pointer" }}>
            {page.parents &&
              page.parents.length > 1 &&
              (() => {
                const parentIdx = page.parents!.length - 2;
                const parent = page.parents![parentIdx];
                const parentColor =
                  parent.color ??
                  [...page.parents!.slice(0, parentIdx)]
                    .reverse()
                    .find((p) => p.color)?.color ??
                  null;
                return (
                  <>
                    <span
                      className={clsx(
                        style.breadcrumbLink,
                        "inline-flex! items-center gap-1.5",
                      )}
                    >
                      <span
                        className="shrink-0 inline-block w-2.5 h-2.5 rounded-full"
                        style={{
                          backgroundColor: parentColor || "var(--primary)",
                          opacity: parentColor ? 1 : 0.3,
                        }}
                      />
                      <span className="truncate">
                        {parent.title || t("common.untitled", "Untitled")}
                      </span>
                    </span>
                    <span className={style.breadcrumbSeparator}>
                      <ChevronRight size={12} />
                    </span>
                  </>
                );
              })()}
            <span
              className={clsx(
                style.breadcrumbLink,
                "inline-flex! items-center gap-1.5",
              )}
            >
              <span
                className="shrink-0 inline-block w-2.5 h-2.5 rounded-full"
                style={{
                  backgroundColor: effectiveColor || "var(--primary)",
                  opacity: effectiveColor ? 1 : 0.3,
                }}
              />
              <span className="truncate">
                {page.title || t("common.untitled", "Untitled")}
              </span>
            </span>
            <ChevronDown size={10} className="shrink-0 opacity-40" />
          </button>
        </MovePageButton>
      ) : (
        <div className={style.breadcrumbs}>
          {page?.parents &&
            page.parents.length > 1 &&
            (() => {
              const parentIdx = page.parents!.length - 2;
              const parent = page.parents![parentIdx];
              const parentColor =
                parent.color ??
                [...page.parents!.slice(0, parentIdx)]
                  .reverse()
                  .find((p) => p.color)?.color ??
                null;
              return (
                <>
                  <span
                    className={clsx(
                      style.breadcrumbLink,
                      "inline-flex! items-center gap-2",
                    )}
                  >
                    <span
                      className="shrink-0 inline-block w-2.5 h-2.5 rounded-full"
                      style={{
                        backgroundColor: parentColor || "var(--primary)",
                        opacity: parentColor ? 1 : 0.3,
                      }}
                    />
                    {parent.title || t("common.untitled", "Untitled")}
                  </span>
                  <span className={style.breadcrumbSeparator}>
                    <ChevronRight size={16} />
                  </span>
                </>
              );
            })()}
          <span
            className={clsx(
              style.breadcrumbLink,
              "inline-flex! items-center gap-2",
            )}
          >
            <span
              className="shrink-0 inline-block w-2.5 h-2.5 rounded-full"
              style={{
                backgroundColor: effectiveColor || "var(--primary)",
                opacity: effectiveColor ? 1 : 0.3,
              }}
            />
            {page?.title || t("common.untitled", "Untitled")}
          </span>
        </div>
      )}

      <div className="ms-auto flex items-center gap-2">
        <ActiveUsersAvatars users={activeUsers} />
        {permission !== "view" && <SavingIndicator isSaving={isSaving} />}
        {!isPageLoading && !isPageError && <PageSettings />}
      </div>
    </>
  );
}

export function EditorLoadingState({ padding = true }: { padding?: boolean }) {
  return (
    <div className={clsx("w-full h-full", padding && "p-6 md:p-10")}>
      <Skeleton className="h-12 w-3/4 mb-8" />
      <Skeleton className="h-6 w-full mb-4" />
      <Skeleton className="h-6 w-full mb-4" />
      <Skeleton className="h-6 w-5/6 mb-4" />
      <Skeleton className="h-6 w-full mb-8" />
      <Skeleton className="h-6 w-full mb-4" />
      <Skeleton className="h-6 w-4/5 mb-4" />
    </div>
  );
}

function EditorEmptyState() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { activeSpaceId } = useSpaces();
  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: (newPage, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: variables.parentId }],
      });
      // Navigate to the newly created page
      navigate(`/page/${newPage.id}`);
    },
  });

  function handleAdd() {
    if (!activeSpaceId) return;
    createPage({
      title: "",
      parentId: null,
      spaceId: activeSpaceId,
    });
  }
  return (
    <div className={style.appErrorState}>
      <EmptyStateIllustration />
      <div className={style.appError}>
        {t("page.noPagesFound", "No pages found")}
      </div>
      <p className={style.appErrorDescription}>
        {t(
          "page.noWorriesCreate",
          "No worries. You can create your first page right away",
        )}
      </p>
      <Button onClick={() => handleAdd()} disabled={isCreating}>
        {t("page.createNewPage", "Create new page")}
      </Button>
    </div>
  );
}

function EditorNotFoundState() {
  const { t } = useTranslation();
  return (
    <div className={style.appErrorState}>
      <NotFoundStateIllustration />
      <div className={style.appError}>
        {t("error.pageNotFound", "The page has not been found")}
      </div>
      <p className={style.appErrorDescription}>
        {t(
          "error.pageDeletedOrNotExist",
          "The page has been deleted or does not exist",
        )}
      </p>
    </div>
  );
}

export function EditorErrorState() {
  const { t } = useTranslation();
  return (
    <div className={style.appErrorState}>
      <ErrorStateIllustration />
      <div className={style.appError}>
        {t("error.pageLoadFailed", "Error occurred loading the page")}
      </div>
    </div>
  );
}

function EditorCorruptedState() {
  const { t } = useTranslation();
  const [showVersionHistory, setShowVersionHistory] = useState(false);

  return (
    <div className={style.appErrorState}>
      <ErrorStateIllustration />
      <div className={style.appError}>
        {t("error.pageCorrupted", "This page appears to corrupted")}
      </div>
      <p className={style.appErrorDescription}>
        {t(
          "error.pageCorruptedDescription",
          "The page content could not be loaded. You can restore a previous version or start with a blank page.",
        )}
      </p>
      <div className="flex gap-3">
        <Button onClick={() => setShowVersionHistory(true)}>
          <History className="h-4 w-4 mr-2" />
          {t("snapshot.versionHistory", "Version history")}
        </Button>
      </div>
      <SnapshotRestore
        open={showVersionHistory}
        onOpenChange={setShowVersionHistory}
      />
    </div>
  );
}
