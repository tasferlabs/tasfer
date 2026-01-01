import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { ScrollableEditor } from "../ScrollableEditor";
import { useCreatePage, useGetPage, useUpdatePage } from "../api/pages.api";
import EmptyStateIllustration from "../components/illustrations/empty-state";
import ErrorStateIllustration from "../components/illustrations/error-state";
import NotFoundStateIllustration from "../components/illustrations/not-found-state";
import { useDebouncedSave } from "../hooks/useDebouncedSave";
import { useSaving } from "../contexts/SavingContext";
import { useConfirmation } from "../components/ConfirmationDialog";
import { useNavigationPrompt } from "../hooks/useNavigationPrompt";
import style from "./EditorPage.module.css";

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const { setIsSaving: setGlobalIsSaving } = useSaving();
  const { getConfirmation } = useConfirmation();

  // If no ID in URL, show empty state
  if (!id) {
    return <EditorEmptyState />;
  }

  // Fetch page data by ID
  const { data: page, isLoading, isError } = useGetPage(id);
  const { mutateAsync: updatePage } = useUpdatePage();
  const initialContentRef = useRef<string | null>(null);
  const lastContentRef = useRef<string | null>(null);
  const isInitializedRef = useRef(false);
  const currentPageIdRef = useRef<string | null>(null);

  // Reset initialization state when navigating to a different page
  useEffect(() => {
    if (id !== currentPageIdRef.current) {
      initialContentRef.current = null;
      lastContentRef.current = null;
      isInitializedRef.current = false;
      currentPageIdRef.current = id || null;
    }
  }, [id]);

  // Store initial content to avoid saving it immediately on mount
  useEffect(() => {
    if (page?.content !== undefined && !isInitializedRef.current) {
      initialContentRef.current = page.content || "";
      lastContentRef.current = page.content || "";
      isInitializedRef.current = true;
    }
  }, [page?.content, id]);

  // Debounced save callback
  const handleSave = useCallback(
    async (content: string) => {
      if (!id) return;

      // Don't save if page hasn't been initialized yet
      if (!isInitializedRef.current) {
        return;
      }

      // Don't save if content hasn't changed from initial
      if (content === initialContentRef.current) {
        return;
      }

      try {
        await updatePage({ id, content });
        // Update lastContentRef after successful save
        lastContentRef.current = content;
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

  // Keep a stable ref to debouncedSave to avoid recreating handleContentChange
  const debouncedSaveRef = useRef(debouncedSave);
  useEffect(() => {
    debouncedSaveRef.current = debouncedSave;
  }, [debouncedSave]);

  // Handle content changes from editor - only trigger save if content actually changed
  // This callback is stable (no dependencies) to prevent editor remounting
  const handleContentChange = useCallback((content: string) => {
    // Don't trigger save before initialization is complete
    if (!isInitializedRef.current) {
      return;
    }

    // CRITICAL FIX: Ignore the first content change event if it's empty and comes right after initialization
    // This handles the race condition where the editor fires an empty state before loading actual content
    if (content === "" && lastContentRef.current === initialContentRef.current && initialContentRef.current !== "") {
      return;
    }

    // Only trigger save if content is different from last seen content
    if (content !== lastContentRef.current) {
      lastContentRef.current = content;
      debouncedSaveRef.current(content);
    }
  }, []); // Empty dependencies - stable callback

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

  if (isLoading) {
    return <EditorLoadingState />;
  }

  if (isError || !page) {
    return <EditorNotFoundState />;
  }

  // Pass raw markdown content to the editor
  return (
    <ScrollableEditor
      type="content"
      source={page.content || ""}
      className="w-full h-full"
      onContentChange={handleContentChange}
    />
  );
}

function EditorLoadingState() {
  return (
    <div className="w-full h-full p-8 max-w-4xl mx-auto">
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
  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: variables.parentId }],
      });
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
