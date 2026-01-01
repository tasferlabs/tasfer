import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { ScrollableEditor } from "../ScrollableEditor";
import { useCreatePage, getPage, useUpdatePage } from "../api/pages.api";
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
  const { mutateAsync: updatePage } = useUpdatePage();

  // State for loading page content once on mount
  const [pageContent, setPageContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  // Fetch page content once on mount or when ID changes
  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function loadPage() {
      setIsLoading(true);
      setIsError(false);

      try {
        const page = await getPage(id!);
        if (!cancelled) {
          setPageContent(page.content || "");
          setIsLoading(false);
        }
      } catch (error) {
        console.error("Failed to load page:", error);
        if (!cancelled) {
          setIsError(true);
          setIsLoading(false);
        }
      }
    }

    loadPage();

    return () => {
      cancelled = true;
    };
  }, [id]);

  // Debounced save callback
  const handleSave = useCallback(
    async (content: string) => {
      if (!id) return;

      try {
        await updatePage({ id, content });
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

  // Handle content changes from editor
  const handleContentChange = useCallback(
    (content: string) => {
      debouncedSave(content);
    },
    [debouncedSave]
  );

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

  // If no ID in URL, show empty state
  if (!id) {
    return <EditorEmptyState />;
  }

  if (isLoading) {
    return <EditorLoadingState />;
  }

  if (isError || pageContent === null) {
    return <EditorNotFoundState />;
  }

  // Pass raw markdown content to the editor
  // Content is loaded once on mount, editor manages state from there
  return (
    <ScrollableEditor
      content={pageContent}
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
