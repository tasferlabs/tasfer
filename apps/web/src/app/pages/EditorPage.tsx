import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useParams, useNavigate } from "react-router-dom";
import { debounce } from "lodash-es";
import { MountedEditor } from "../MountedEditor";
import type { SyncState } from "../../editor/sync/websocket";
import type { AwarenessUser } from "@/editor/sync/awareness";
import { isTextualBlock, type Block, type TextualBlock } from "@/deserializer/loadPage";
import { getVisibleTextFromRuns } from "@/editor/sync/char-runs";

// WebSocket server URL - defaults to using Vite proxy
// Uses wss:// for HTTPS, ws:// for HTTP
const WEBSOCKET_URL =
  import.meta.env.VITE_WEBSOCKET_URL ||
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${
    window.location.host
  }/ws`;
import {
  useCreatePage,
  getPage,
  useUpdatePage,
  useGetPages,
  type HLC,
} from "../api/pages.api";
import EmptyStateIllustration from "../components/illustrations/empty-state";
import ErrorStateIllustration from "../components/illustrations/error-state";
import NotFoundStateIllustration from "../components/illustrations/not-found-state";
import { useDebouncedSave } from "../hooks/useDebouncedSave";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { useConfirmation } from "../components/ConfirmationDialog";
import { useNavigationPrompt } from "../hooks/useNavigationPrompt";
import useLocalStorage from "../hooks/useLocalStorage";
import { WordCountOverlay } from "../components/WordCountOverlay";
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
        word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
      )
      .filter((word) => word.length > 0);

    count += words.length;
  }

  return count;
}

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const {
    setIsSaving: setGlobalIsSaving,
    setWordCount,
    setActiveUsers,
    setPageId,
    setCurrentBlocks,
    setOnRestoreSnapshot,
  } = usePageSettings();
  const { getConfirmation } = useConfirmation();
  const { mutateAsync: updatePage } = useUpdatePage();
  // State for loading page snapshot once on mount
  const [pageSnapshot, setPageSnapshot] = useState<Block[] | null>(null);
  // Snapshot clock - used for delta sync
  const [snapshotClock, setSnapshotClock] = useState<HLC | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  // Live sync state
  const [_syncState, setSyncState] = useState<SyncState>({
    status: "disconnected",
  });
  // Restore function ref from MountedEditor
  const restoreFnRef = useRef<((blocks: Block[]) => void) | null>(null);

  const { data: pages, isLoading: isLoadingPages } = useGetPages(null);
  const [lastPageId, setLastPageId] = useLocalStorage<string | null>(
    "lastPageId",
    null
  );

  // Create debounced word count updater (500ms delay for performance)
  const debouncedWordCountUpdate = useRef(
    debounce((blocks: Block[]) => {
      const count = countWordsFromBlocks(blocks);
      setWordCount(count);
    }, 500)
  ).current;

  useEffect(() => {
    if (id) {
      setLastPageId(id);
      setPageId(id);
    }
    return () => {
      setPageId(null);
    };
  }, [id, setLastPageId, setPageId]);

  useEffect(() => {
    if (isError) {
      setLastPageId(null);
    }
  }, [isError, setLastPageId]);

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
  const handleSave = useCallback(
    async ({
      snapshot,
      clock,
    }: {
      snapshot: Block[];
      clock: HLC | null;
    }) => {
      if (!id) return;

      try {
        await updatePage({ id, snapshot, snapshotClock: clock });
      } catch (error) {
        console.error("Failed to save content:", error);
      }
    },
    [id, updatePage]
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
  const handleContentChange = useCallback(
    (snapshot: Block[], clock: HLC | null) => {
      debouncedSave({ snapshot, clock });
    },
    [debouncedSave]
  );

  // Handle all content updates (local and remote - for word count)
  const handleContentUpdate = useCallback(
    (blocks: Block[]) => {
      debouncedWordCountUpdate(blocks);
      setCurrentBlocks(blocks);
    },
    [debouncedWordCountUpdate, setCurrentBlocks]
  );

  // Handle snapshot restoration
  const handleRestoreSnapshot = useCallback(
    (blocks: Block[]) => {
      if (restoreFnRef.current) {
        restoreFnRef.current(blocks);
        // Trigger save after restore
        debouncedSave({ snapshot: blocks, clock: null });
      }
    },
    [debouncedSave]
  );

  // Expose restore callback to context
  useEffect(() => {
    setOnRestoreSnapshot(() => handleRestoreSnapshot);
    return () => {
      setOnRestoreSnapshot(null);
    };
  }, [handleRestoreSnapshot, setOnRestoreSnapshot]);

  // Warn user before leaving page if there are unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isSaving) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isSaving]);

  // Prompt user before in-app navigation if saving
  useNavigationPrompt(isSaving, getConfirmation);

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
    [setActiveUsers]
  );

  // If no ID in URL
  if (!id) {
    if (isLoadingPages) {
      return <EditorLoadingState />;
    }

    if (pages && pages.length > 0) {
      return <Navigate to={`/page/${lastPageId || pages[0].id}`} replace />;
    }

    return <EditorEmptyState />;
  }

  if (isLoading) {
    return <EditorLoadingState />;
  }

  if (isError || pageSnapshot === null) {
    return <EditorNotFoundState />;
  }

  // Pass snapshot blocks to the editor
  // Snapshot is loaded once on mount, editor manages state from there
  return (
    <>
      <MountedEditor
        snapshot={pageSnapshot}
        className="w-full h-full"
        onContentChange={handleContentChange}
        onContentUpdate={handleContentUpdate}
        autoFocus={true}
        pageId={id}
        signalingUrl={WEBSOCKET_URL}
        onSyncStateChange={setSyncState}
        snapshotClock={snapshotClock}
        onSnapshotClockUpdate={setSnapshotClock}
        onAwarenessChange={handleAwarenessChange}
        onRestoreReady={(restoreFn) => {
          restoreFnRef.current = restoreFn;
        }}
      />
      <WordCountOverlay />
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
  const { t } = useTranslation("PagesLinks");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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
    createPage({
      title: "",
      parentId: null,
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
  const { t } = useTranslation("PagesLinks");
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
  const { t } = useTranslation("PagesLinks");
  return (
    <div className={style.appErrorState}>
      <ErrorStateIllustration />
      <div className={style.appError}>{t`Error occurred loading the page`}</div>
    </div>
  );
}
