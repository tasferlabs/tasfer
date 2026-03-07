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
import {
  isTextualBlock,
  type Block,
  type TextualBlock,
} from "@/deserializer/loadPage";
import type { AwarenessUser } from "@/editor/sync/awareness";
import {
  extractTitleFromBlocks,
  getVisibleTextFromRuns,
} from "@/editor/sync/char-runs";
import { DURATION_OPTIONS, formatDurationLabel } from "@/lib/utils";
import type { SyncState } from "@/websocket/hooks/useRoom";
import { CaretRightIcon } from "@phosphor-icons/react";
import * as Popover from "@radix-ui/react-popover";
import { useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import { debounce } from "lodash-es";
import { Calendar, FileText, FolderInput, Trash } from "lucide-react";
import { DateTime } from "luxon";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { ActiveUsersAvatars } from "../components/ActiveUsersAvatars";
import { PageSettings } from "../components/PageSettings";
import { SavingIndicator } from "../components/SavingIndicator";
import { MountedEditor } from "../MountedEditor";

import { usePageEvents } from "@/websocket/hooks/usePageEvents";
import clsx from "clsx";
import {
  getPage,
  useCreatePage,
  useGetPage,
  useGetPages,
  useMovePage,
  useSearchPages,
  useUpdatePage,
  type HLC,
} from "../api/pages.api";
import EmptyStateIllustration from "../components/illustrations/empty-state";
import ErrorStateIllustration from "../components/illustrations/error-state";
import NotFoundStateIllustration from "../components/illustrations/not-found-state";
import { WordCountOverlay } from "../components/WordCountOverlay";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { useSpaces } from "../contexts/SpaceContext";
import { useDebouncedSave } from "../hooks/useDebouncedSave";
import useLocalStorage from "../hooks/useLocalStorage";
import { useNavigationPrompt } from "../hooks/useNavigationPrompt";
import useResponsive from "../hooks/useResponsive";
import style from "./EditorPage.module.css";

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
  // State for loading page snapshot once on mount
  const [pageSnapshot, setPageSnapshot] = useState<Block[] | null>(null);
  // Snapshot clock - used for delta sync
  const [snapshotClock, setSnapshotClock] = useState<HLC | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  // Track if page was deleted by another user (via WebSocket)
  const [isDeletedByOther, setIsDeletedByOther] = useState(false);
  // Persisted editor state - once entered, stays until user takes action
  const [persistedState, setPersistedState] = useState<
    "empty" | "not-found" | "error" | null
  >(null);
  // Auto-title state - when true, title is auto-generated from content
  const [autoTitle, setAutoTitle] = useState(true);
  const [currentTitle, setCurrentTitle] = useState<string>("");
  // Live sync state
  const [_syncState, setSyncState] = useState<SyncState>({
    status: "disconnected",
  });
  // Restore function ref from MountedEditor
  const restoreFnRef = useRef<((blocks: Block[]) => void) | null>(null);
  // Confirm save function ref from MountedEditor - called after backend confirms save
  const confirmSaveFnRef = useRef<((clock: HLC) => void) | null>(null);

  const { activeSpaceId } = useSpaces();
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
    // Reset persisted state when ID changes (user navigated)
    setPersistedState(null);
    // Reset permission to owner (will be updated after page load)
    setLocalPermission("owner");
    setPermission("owner");
    return () => {
      setPageId(null);
    };
  }, [id, setLastPageId, setPageId, setPermission]);

  // Listen for page deletion events from other users
  usePageEvents({
    onPageDeleted: (deletedPageId) => {
      if (deletedPageId === id) {
        // Page was deleted by another user, show not found state
        setIsDeletedByOther(true);
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
      if (!isLoadingPages && (!pages || pages.length === 0)) {
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
          const snapshot = page.snapshot || [];
          setPageSnapshot(snapshot);
          // Track snapshot clock for delta sync
          setSnapshotClock(page.snapshotClock || null);
          // Track auto-title state
          setAutoTitle(page.autoTitle);
          setCurrentTitle(page.title || "");
          // Track permission
          const perm = page.permission || "owner";
          setLocalPermission(perm);
          setPermission(perm);
          setIsLoading(false);
          // Update initial word count from blocks
          setWordCount(countWordsFromBlocks(snapshot));
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
    async ({
      pageId,
      snapshot,
      clock,
    }: {
      pageId: string;
      snapshot: Block[];
      clock: HLC | null;
    }) => {
      if (!pageId) return;

      try {
        // Check if we should auto-update the title
        const updateData: {
          id: string;
          snapshot: Block[];
          snapshotClock: HLC | null;
          title?: string;
        } = { id: pageId, snapshot, snapshotClock: clock };

        let titleChanged = false;
        // Only update title if we're still on the same page
        if (autoTitleRef.current && pageId === id) {
          const extractedTitle = extractTitleFromBlocks(snapshot);
          if (extractedTitle !== currentTitleRef.current) {
            updateData.title = extractedTitle;
            setCurrentTitle(extractedTitle);
            titleChanged = true;
          }
        }

        await updatePage(updateData);

        // Confirm save succeeded - update snapshotClock and mark operations as synced
        // This is only called after the backend confirms the save, not optimistically
        // Only confirm if we're still on the same page
        if (clock && confirmSaveFnRef.current && pageId === id) {
          confirmSaveFnRef.current(clock);
        }

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
    (snapshot: Block[], clock: HLC | null) => {
      if (!id) return;
      debouncedSave({ pageId: id, snapshot, clock });
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
        restoreFnRef.current(blocks);
        // Trigger save after restore - include pageId for correct targeting
        debouncedSave({ pageId: id, snapshot: blocks, clock: null });
      }
    },
    [id, debouncedSave],
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

  // If no ID in URL
  if (!id) {
    if (isLoadingPages) {
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
  const headerSlot = document.getElementById("top-action-bar-slot");

  return (
    <div className="flex flex-col w-full h-full">
      {headerSlot && createPortal(<PageActionBar pageId={id} />, headerSlot)}
      <div className="flex items-center gap-2 px-4 py-2 md:px-[40px]">
        <ScheduleTag pageId={id} readonly={readonly} />
      </div>
      <MountedEditor
        snapshot={pageSnapshot}
        className="w-full flex-1 min-h-0"
        onContentChange={readonly ? undefined : handleContentChange}
        onContentUpdate={handleContentUpdate}
        autoFocus={!readonly}
        pageId={id}
        onSyncStateChange={setSyncState}
        snapshotClock={snapshotClock}
        onSnapshotClockUpdate={readonly ? undefined : setSnapshotClock}
        onAwarenessChange={handleAwarenessChange}
        onRestoreReady={
          readonly
            ? undefined
            : (restoreFn) => {
                restoreFnRef.current = restoreFn;
              }
        }
        onConfirmSaveReady={
          readonly
            ? undefined
            : (confirmFn) => {
                confirmSaveFnRef.current = confirmFn;
              }
        }
        readonly={readonly}
      />
      <WordCountOverlay />
    </div>
  );
}

// ── Page Tags Bar ──

function formatScheduleLabel(
  iso: string,
  duration: number | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (duration) {
    return t("{{date}}, {{time}} ({{duration}})", {
      date,
      time,
      duration: formatDurationLabel(duration, t),
    });
  }
  return t("{{date}}, {{time}}", { date, time });
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
        <label className="text-sm font-medium">{t`Date & Time`}</label>
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
        <label className="text-sm font-medium">{t`Duration`}</label>
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
          {t`Remove from Schedule`}
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
    ? formatScheduleLabel(page.scheduledAt!, page.duration, t)
    : t`Schedule`;

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
                <DrawerTitle>{t`Schedule`}</DrawerTitle>
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
          <h3 className="text-sm font-semibold mb-3">{t`Schedule`}</h3>
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
  const { t } = useTranslation();
  const { activeSpaceId } = useSpaces();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: pages } = useSearchPages(activeSpaceId, search);
  const { mutate: move } = useMovePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["page", pageId] });
      setOpen(false);
    },
  });

  const filtered = pages?.filter((p) => p.id !== pageId);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setSearch("");
      }}
    >
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          className="z-50 w-[260px] rounded-lg border border-border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Command shouldFilter={false}>
            <Command.Input
              ref={inputRef}
              value={search}
              onValueChange={setSearch}
              placeholder={t`Move to…`}
              className="h-9 w-full border-b border-border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
            />
            <Command.List className="max-h-52 overflow-y-auto p-1">
              <Command.Empty className="py-4 text-center text-sm text-muted-foreground">
                {t`No pages found`}
              </Command.Empty>
              {currentParentId && (
                <Command.Item
                  value="__root__"
                  onSelect={() => move({ id: pageId, parentId: null })}
                  className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-default select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <FileText
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="text-muted-foreground italic">{t`No parent (root)`}</span>
                </Command.Item>
              )}
              {filtered?.map((page) => (
                <Command.Item
                  key={page.id}
                  value={page.id}
                  onSelect={() => move({ id: pageId, parentId: page.id })}
                  className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-default select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <FileText
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="truncate block">
                      {page.title || t`Untitled`}
                    </span>
                    {page.path && (
                      <span className="truncate block text-xs text-muted-foreground">
                        {page.path}
                      </span>
                    )}
                  </div>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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

  return (
    <>
      <div className={style.breadcrumbs}>
        {page?.parents &&
          page.parents.length > 1 &&
          (() => {
            const parent = page.parents[page.parents.length - 2];
            return (
              <>
                {permission !== "view" ? (
                  <MovePageButton
                    pageId={pageId}
                    currentParentId={page.parentId}
                  >
                    <button
                      className={clsx(style.breadcrumbLink, "inline-flex! items-center gap-2")}
                      style={{ cursor: "pointer" }}
                    >
                      <span className="truncate ">{parent.title || t`Untitled`}</span>
                      <FolderInput size={14} className="shrink-0" />
                    </button>
                  </MovePageButton>
                ) : (
                  <span className={style.breadcrumbLink}>
                    {parent.title || t`Untitled`}
                  </span>
                )}
                <span className={style.breadcrumbSeparator}>
                  <CaretRightIcon size={16} />
                </span>
              </>
            );
          })()}
        <span className={style.breadcrumbLink}>
          {page?.title || t`Untitled`}
        </span>
        {/* {permission !== "view" && page && (!page.parents || page.parents.length <= 1) && (
          <MovePageButton pageId={pageId} currentParentId={page.parentId} />
        )} */}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ActiveUsersAvatars users={activeUsers} />
        {permission !== "view" && <SavingIndicator isSaving={isSaving} />}
        {!isPageLoading && !isPageError && <PageSettings />}
      </div>
    </>
  );
}

function EditorLoadingState() {
  return (
    <div className="w-full h-full p-6 md:p-10">
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
      <div className={style.appError}>No pages found</div>
      <p className={style.appErrorDescription}>
        No worries. You can create your first page right away
      </p>
      <Button
        onClick={() => handleAdd()}
        disabled={isCreating}
      >{t`Create new page`}</Button>
    </div>
  );
}

function EditorNotFoundState() {
  const { t } = useTranslation();
  return (
    <div className={style.appErrorState}>
      <NotFoundStateIllustration />
      <div className={style.appError}>{t`The page has not been found`}</div>
      <p className={style.appErrorDescription}>
        The page has been deleted or does not exist
      </p>
    </div>
  );
}

export function EditorErrorState() {
  const { t } = useTranslation();
  return (
    <div className={style.appErrorState}>
      <ErrorStateIllustration />
      <div className={style.appError}>{t`Error occurred loading the page`}</div>
    </div>
  );
}
