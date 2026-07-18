import type { SyncState } from "@/app/hooks/useP2PRoom";
import DateTimePicker from "@/components/datetimepickers/DateTimePicker";
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
import {
  formatDatePreferred,
  formatTimePreferred,
} from "@/lib/dateTimePreferences";
import { countWordsFromBlocks } from "@/lib/documentStats";
import { deriveTitles } from "@/lib/pageTitle";
import { buildEnvTable, buildIssueUrl, useReportPath } from "@/lib/reportIssue";
import {
  DURATION_OPTIONS,
  formatDurationLabel,
  type TFunction,
} from "@/lib/utils";
import * as Popover from "@radix-ui/react-popover";
import { useQueryClient } from "@tanstack/react-query";
import { type Block } from "@tasfer/editor";
import type { CursorUser } from "@tasfer/provider-core/cursors";
import { debounce } from "lodash-es";
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  Github,
  History,
  Image as ImageIcon,
  Trash,
  TriangleAlert,
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
import { TitlePreview } from "../TitlePreview";

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
import CorruptionErrorState from "../components/illustrations/corruption-state";
import EmptyStateIllustration from "../components/illustrations/empty-state";

import { openImageUploadMenu } from "@/editorSchema";
import { imageBleedHeight } from "@tasfer/editor/internal";
import NotFoundStateIllustration from "../components/illustrations/not-found-state";
import { SnapshotRestore } from "../components/SnapshotRestore";
import { useActiveEditor } from "../contexts/ActiveEditorContext";
import {
  NARROW_CONTENT_WIDTH,
  usePageSettings,
} from "../contexts/PageSettingsContext";
import { useSpaces } from "../contexts/SpaceContext";
import { useTreeExpand } from "../contexts/TreeExpandContext";
import { useDebouncedSave } from "../hooks/useDebouncedSave";
import useLocalStorage from "../hooks/useLocalStorage";
import { useNavigationPrompt } from "../hooks/useNavigationPrompt";
import useResponsive from "../hooks/useResponsive";
import style from "./EditorPage.module.css";

// Height of the page tag row (Schedule / Add cover): h-8 ghost buttons plus
// py-2. Reserved as canvas top padding so document content starts below the
// row. When the page opens with a cover image (a first full-width image bleeds
// to the very top of the canvas), the same-size strip re-emerges below the
// cover and the row is translated down onto it — see the tag-row effect below.
const SCHEDULE_TAG_HEIGHT = 48;
const SCHEDULE_TAG_PADDING = { paddingTop: SCHEDULE_TAG_HEIGHT } as const;

// Quiet text-button styling shared by the page-top tag row (schedule, add
// cover): muted icon + label that brighten on hover, like inline page
// controls rather than pill badges.
const PAGE_TAG_CLASS = "text-muted-foreground hover:text-foreground gap-1.5";

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
  // The page's title always mirrors its heading: it is auto-derived from the
  // document content on every local edit (see handleSave). This tracks the last
  // derived value so we only write the record string when it actually changes.
  const [currentTitle, setCurrentTitle] = useState<string>("");
  // The page's actual space_id (from DB), used for P2P sync routing
  const [pageSpaceId, setPageSpaceId] = useState<string | null>(null);
  // Live sync state
  const [_syncState, setSyncState] = useState<SyncState>({
    status: "disconnected",
  });
  // Track editor canvas scroll position for scrolling overlay elements (ref to avoid re-renders)
  const scheduleTagRef = useRef<HTMLDivElement>(null);
  // Tag-row geometry, mutated imperatively (no re-render per scroll frame): the
  // row sits at the top of the page, or directly below the cover image when the
  // document starts with one. Cover bottom is in document space; the transform
  // combines it with the live scroll offset.
  const tagRowCoverBottomRef = useRef(0);
  const tagRowScrollYRef = useRef(0);
  const applyTagRowTransform = useCallback(() => {
    if (scheduleTagRef.current) {
      scheduleTagRef.current.style.transform = `translateY(${
        tagRowCoverBottomRef.current - tagRowScrollYRef.current
      }px)`;
    }
  }, []);
  // Restore function ref from MountedEditor
  const restoreFnRef = useRef<((blocks: Block[]) => void) | null>(null);

  const { editor: activeEditor, setEditor: setActiveEditor } =
    useActiveEditor();
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

  // Ref for the last derived title to avoid stale closures in the save callback.
  const currentTitleRef = useRef(currentTitle);
  useEffect(() => {
    currentTitleRef.current = currentTitle;
  }, [currentTitle]);
  // The title's rich (markdown) projection, tracked the same way. A ref only —
  // nothing renders it here; it exists so marks-only edits to the heading
  // (bolding a word changes no visible text) still persist a fresh titleMd.
  const currentTitleMdRef = useRef<string>("");

  useEffect(() => {
    if (id) {
      setLastPageId(id);
      setPageId(id);
      // Reset deleted state when navigating to a new page
      setIsDeletedByOther(false);
    }
    // Reset persisted state and scroll position when ID changes (user navigated)
    setPersistedState(null);
    tagRowCoverBottomRef.current = 0;
    tagRowScrollYRef.current = 0;
    applyTagRowTransform();
    // Reset permission to owner (will be updated after page load)
    setLocalPermission("owner");
    setPermission("owner");
    return () => {
      setPageId(null);
    };
  }, [id, setLastPageId, setPageId, setPermission, applyTagRowTransform]);

  // Keep the tag row out of the cover image: when the document starts with a
  // full-width image it bleeds to the very top of the canvas, and the strip
  // reserved by SCHEDULE_TAG_PADDING re-emerges below it (see ImageNode) — so
  // drop the row onto that strip. Re-read on every editor tick so
  // the row follows cover add/remove, image resize, and upload placeholder →
  // real image transitions; scroll-follow shares the transform via onScroll.
  useEffect(() => {
    if (!activeEditor) return;
    const recompute = () => {
      const first = activeEditor.query.block("start");
      tagRowCoverBottomRef.current =
        (first?.type === "image"
          ? imageBleedHeight(first.attrs, activeEditor.view.getStyles())
          : null) ?? 0;
      tagRowScrollYRef.current = activeEditor.view.getScrollY();
      applyTagRowTransform();
    };
    recompute();
    return activeEditor.subscribe(recompute);
  }, [activeEditor, applyTagRowTransform]);

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
        // Forget the dead page so "/" doesn't redirect back to it
        setLastPageId(null);
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
    setLastPageId,
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
            setCurrentTitle(page.title || "");
            currentTitleMdRef.current = page.titleMd || "";
            setPageSpaceId(page.spaceId ?? null);
            setLocalPermission("owner");
            setPermission("owner");
            setIsLoading(false);
            setPersistedState("corrupted");
            return;
          }
          setPageSnapshot(blocks);
          setCurrentTitle(page.title || "");
          currentTitleMdRef.current = page.titleMd || "";
          // Store the page's actual space ID for P2P sync routing
          setPageSpaceId(page.spaceId ?? null);
          // Track permission
          const perm = "owner";
          setLocalPermission(perm);
          setPermission(perm);
          setIsLoading(false);
          // Word count is intentionally deferred through the existing
          // debounced update path. Large documents should become interactive
          // before this full-content scan runs.
          debouncedWordCountUpdate(blocks);
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
  }, [id, debouncedWordCountUpdate]);

  // Debounced save callback - only called for local user-initiated changes
  // Remote peer updates are NOT persisted by this user; peers handle saving their own changes
  // IMPORTANT: pageId is passed with the data to avoid race conditions when switching pages
  const handleSave = useCallback(
    async ({ pageId, blocks }: { pageId: string; blocks: Block[] }) => {
      if (!pageId) return;

      try {
        const updateData: { id: string; title?: string; titleMd?: string } = {
          id: pageId,
        };

        let titleChanged = false;
        // The title always mirrors the heading — derive it from content and save
        // whenever it changes (only while we're still on the same page). Both
        // projections are checked independently: a marks-only edit changes the
        // markdown but not the visible text.
        if (pageId === id) {
          const { title: extractedTitle, titleMd: extractedTitleMd } =
            deriveTitles(blocks);
          if (extractedTitle !== currentTitleRef.current) {
            updateData.title = extractedTitle;
            setCurrentTitle(extractedTitle);
            titleChanged = true;
          }
          if (extractedTitleMd !== currentTitleMdRef.current) {
            updateData.titleMd = extractedTitleMd;
            currentTitleMdRef.current = extractedTitleMd;
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
      // Restore only works through a mounted editor, where it emits CRDT ops
      // against the live op-log. Without one (e.g. a corrupted page) an
      // in-memory swap would not persist and the page would rebuild to the same
      // broken state on reopen — that flow forks instead. See EditorCorruptedState.
      if (!restoreFnRef.current) return;
      restoreFnRef.current(blocks);
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
    (users: CursorUser[]) => {
      setActiveUsers(users);
    },
    [setActiveUsers],
  );

  // For testing corrupted state.
  // return <EditorCorruptedState />;

  // For testing error state.
  // return <EditorErrorState />;

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
          {/* Ghost buttons carry internal padding; pull the first one back so
              its label stays flush with the text column. */}
          <div className="pointer-events-auto -ms-2.5">
            <ScheduleTag pageId={id} readonly={readonly} />
          </div>
          {!readonly && (
            <div className="pointer-events-auto">
              <AddCoverTag
                getContainerRect={() =>
                  scheduleTagRef.current?.parentElement?.getBoundingClientRect() ??
                  null
                }
              />
            </div>
          )}
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
          onEditorReady={setActiveEditor}
          readonly={readonly}
          padding={SCHEDULE_TAG_PADDING}
          onScroll={(scrollY) => {
            tagRowScrollYRef.current = scrollY;
            applyTagRowTransform();
          }}
          onHorizontalPaddingChange={(padding) => {
            // Keep the schedule tag aligned with the (possibly narrowed,
            // centered) text column. Mutated imperatively like the scroll
            // transform to avoid re-rendering on resize; overrides the
            // default px-4 md:px-[40px] gutter classes.
            if (scheduleTagRef.current) {
              scheduleTagRef.current.style.paddingLeft = `${padding}px`;
              scheduleTagRef.current.style.paddingRight = `${padding}px`;
            }
          }}
        />
      </div>
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

/**
 * Quick "Add cover" chip next to the schedule tag. Inserts a placeholder image
 * block at the very top of the page and immediately opens the existing image
 * upload popover for it — the same overlay a placeholder image opens on click
 * (see `TasferImageNode.activate`). Hidden while the page already starts with
 * an image, so the cover slot can't be stacked from here.
 */
function AddCoverTag({
  getContainerRect,
}: {
  getContainerRect: () => DOMRect | null;
}) {
  const { t } = useTranslation();
  const { editor } = useActiveEditor();
  const [hasCover, setHasCover] = useState(true);

  useEffect(() => {
    if (!editor) return;
    const recompute = () =>
      setHasCover(editor.query.block("start")?.type === "image");
    recompute();
    return editor.subscribe(recompute);
  }, [editor]);

  if (!editor || hasCover) return null;

  const addCover = (e: React.MouseEvent<HTMLElement>) => {
    const first = editor.query.block("start");
    editor.change((c) =>
      c.insertBlock(
        { type: "image" },
        first ? { block: first.id, side: "before" } : undefined,
      ),
    );
    const inserted = editor.query.block("start");
    if (inserted?.type !== "image") return;
    // Anchor the upload popover under the chip, in canvas/container space (the
    // overlay shifts it back into viewport space — see ImageUploadOverlay).
    const chip = e.currentTarget.getBoundingClientRect();
    const container = getContainerRect();
    openImageUploadMenu(
      editor,
      inserted.id,
      container ? chip.left - container.left : 0,
      container ? chip.bottom - container.top : 0,
    );
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className={PAGE_TAG_CLASS}
      onClick={addCover}
    >
      <ImageIcon />
      {t("image.addCover", "Add cover")}
    </Button>
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
        <Button
          variant="ghost"
          size="sm"
          className={PAGE_TAG_CLASS}
          onClick={() => setOpen(true)}
        >
          <Calendar />
          {label}
        </Button>
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
        <Button variant="ghost" size="sm" className={PAGE_TAG_CLASS}>
          <Calendar />
          {label}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          className="z-50 w-80 rounded-lg border border-border bg-popover p-4 shadow-lg animate-in fade-in-0 zoom-in-95"
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
              page.parents.length >= 1 &&
              (() => {
                const parentIdx = page.parents!.length - 1;
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
                          backgroundColor:
                            parentColor || "var(--page-color-default)",
                          opacity: parentColor ? 1 : 0.3,
                        }}
                      />
                      <span className="truncate">
                        <TitlePreview
                          title={parent.title}
                          titleMd={parent.titleMd}
                        />
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
                  backgroundColor:
                    effectiveColor || "var(--page-color-default)",
                  opacity: effectiveColor ? 1 : 0.3,
                }}
              />
              <span className="truncate">
                <TitlePreview title={page.title} titleMd={page.titleMd} />
              </span>
            </span>
            <ChevronDown size={10} className="shrink-0 opacity-40" />
          </button>
        </MovePageButton>
      ) : (
        <div className={style.breadcrumbs}>
          {page?.parents &&
            page.parents.length >= 1 &&
            (() => {
              const parentIdx = page.parents!.length - 1;
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
                        backgroundColor:
                          parentColor || "var(--page-color-default)",
                        opacity: parentColor ? 1 : 0.3,
                      }}
                    />
                    <TitlePreview
                      title={parent.title}
                      titleMd={parent.titleMd}
                    />
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
                backgroundColor: effectiveColor || "var(--page-color-default)",
                opacity: effectiveColor ? 1 : 0.3,
              }}
            />
            <TitlePreview title={page?.title} titleMd={page?.titleMd} />
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
  const { editorWidth } = usePageSettings();
  return (
    <div className={clsx("w-full h-full", padding && "p-6 md:p-10")}>
      {/* Mirror the mounted editor's width setting so the skeleton doesn't
          jump when the canvas takes over: "narrow" centers the same reading
          column the engine gets via horizontalPaddingForWidth (the outer
          md:p-10 matches its minimum 40px gutter), "wide" spans the canvas. */}
      <div
        className={clsx(editorWidth === "narrow" && "mx-auto")}
        style={
          editorWidth === "narrow"
            ? { maxWidth: NARROW_CONTENT_WIDTH }
            : undefined
        }
      >
        <Skeleton className="h-12 w-3/4 mb-8" />
        <Skeleton className="h-6 w-full mb-4" />
        <Skeleton className="h-6 w-full mb-4" />
        <Skeleton className="h-6 w-5/6 mb-4" />
        <Skeleton className="h-6 w-full mb-8" />
        <Skeleton className="h-6 w-full mb-4" />
        <Skeleton className="h-6 w-4/5 mb-4" />
      </div>
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
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { activeSpaceId } = useSpaces();
  const { data: pages } = useGetPages(activeSpaceId, null);
  const hasPages = !!pages && pages.length > 0;
  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: (newPage, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: variables.parentId }],
      });
      navigate(`/page/${newPage.id}`);
    },
  });

  function handleAdd() {
    if (!activeSpaceId) return;
    createPage({ title: "", parentId: null, spaceId: activeSpaceId });
  }

  return (
    <div className={style.appErrorState}>
      <NotFoundStateIllustration className="w-39" />
      <div className={style.appError}>
        {t("error.pageNotFound", "Page not found")}
      </div>
      <p className={style.appErrorDescription}>
        {hasPages
          ? t(
              "error.pageNotFoundBody",
              "It may have been deleted, or the link may be wrong. Your other pages are in the sidebar.",
            )
          : t(
              "error.pageNotFoundBodyEmpty",
              "It may have been deleted, or the link may be wrong. Create a new page to get started.",
            )}
      </p>
      {hasPages ? (
        <Button onClick={() => navigate("/")}>
          {t("error.goToMyPages", "Go to my pages")}
        </Button>
      ) : (
        <Button onClick={() => handleAdd()} disabled={isCreating}>
          {t("page.createNewPage", "Create new page")}
        </Button>
      )}
    </div>
  );
}

export function EditorErrorState() {
  const { t } = useTranslation();
  const reportPath = useReportPath();

  const reportUrl = buildIssueUrl(
    "[Bug] Page failed to load",
    [
      t(
        "error.pageLoadFailedReportIntro",
        "A page failed to load. Add anything that might help us reproduce it:",
      ),
      "",
      "---",
      "",
      buildEnvTable(reportPath),
    ].join("\n"),
  );

  return (
    <div className={style.appErrorState}>
      <TriangleAlert className="mx-auto mb-2 size-24 text-red-300 dark:text-red-600" />
      <div className={style.appError}>
        {t("error.pageLoadFailed", "This page couldn't load")}
      </div>
      <p className={style.appErrorDescription}>
        {t(
          "error.pageLoadFailedBody",
          "Something unexpected went wrong while opening it. Try reloading — if that doesn't help, report the issue so we can track it down.",
        )}
      </p>
      <div className="flex gap-3">
        <Button onClick={() => window.location.reload()}>
          {t("error.boundary.reload", "Reload")}
        </Button>
        <Button variant="outline" asChild>
          <a href={reportUrl} target="_blank" rel="noreferrer noopener">
            <Github className="h-4 w-4 mr-2" />
            {t("error.boundary.reportIssue", "Report issue")}
          </a>
        </Button>
      </div>
    </div>
  );
}

function EditorCorruptedState() {
  const { t } = useTranslation();
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const reportPath = useReportPath();

  const reportUrl = buildIssueUrl(
    "[Bug] Corrupted page",
    [
      t(
        "error.pageCorruptedReportIntro",
        "A page couldn't load because its saved content is corrupted. Add anything that might help us reproduce it:",
      ),
      "",
      "---",
      "",
      buildEnvTable(reportPath),
    ].join("\n"),
  );

  return (
    <div className={style.appErrorState}>
      <CorruptionErrorState className="w-50" />
      <div className={style.appError}>
        {t("error.pageCorrupted", "This page is corrupted")}
      </div>
      <p className={style.appErrorDescription}>
        {t(
          "error.pageCorruptedDescription",
          "Its saved content can't be read, but your earlier versions are safe — open version history to bring one back as a new page.",
        )}
      </p>
      <div className="flex gap-3">
        <Button onClick={() => setShowVersionHistory(true)}>
          <History className="h-4 w-4 mr-2" />
          {t("snapshot.versionHistory", "Version history")}
        </Button>
        <Button variant="outline" asChild>
          <a href={reportUrl} target="_blank" rel="noreferrer noopener">
            <Github className="h-4 w-4 mr-2" />
            {t("error.boundary.reportIssue", "Report issue")}
          </a>
        </Button>
      </div>
      <SnapshotRestore
        open={showVersionHistory}
        onOpenChange={setShowVersionHistory}
        forkOnly
      />
    </div>
  );
}
