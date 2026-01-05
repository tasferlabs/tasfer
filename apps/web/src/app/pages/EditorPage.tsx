import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useParams, useNavigate } from "react-router-dom";
import { MountedEditor } from "../MountedEditor";
import {
  useCreatePage,
  getPage,
  useUpdatePage,
  useGetPages,
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

// Helper function to count words in markdown content
function countWords(markdown: string): number {
  if (!markdown || markdown.trim() === "") return 0;
  
  // Remove markdown syntax for more accurate word count
  const text = markdown
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, "")
    // Remove inline code
    .replace(/`[^`]+`/g, "")
    // Remove links but keep the text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove images
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    // Remove headings markers
    .replace(/^#{1,6}\s+/gm, "")
    // Remove bold/italic markers
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    // Remove blockquote markers
    .replace(/^>\s+/gm, "")
    // Remove list markers
    .replace(/^[\*\-\+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    // Remove horizontal rules
    .replace(/^[\*\-_]{3,}$/gm, "")
    .trim();

  let count = 0;

  // CJK (Chinese, Japanese, Korean) character ranges
  const cjkRegex = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g;
  
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
    .map(word => 
      // Remove punctuation from the beginning and end of each word
      word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    )
    .filter(word => word.length > 0);
  
  count += words.length;

  return count;
}

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const { setIsSaving: setGlobalIsSaving, setWordCount } = usePageSettings();
  const { getConfirmation } = useConfirmation();
  const { mutateAsync: updatePage } = useUpdatePage();
  // State for loading page content once on mount
  const [pageContent, setPageContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  const { data: pages, isLoading: isLoadingPages } = useGetPages(null);
  const [lastPageId, setLastPageId] = useLocalStorage<string | null>(
    "lastPageId",
    null
  );

  useEffect(() => {
    if (id) {
      setLastPageId(id);
    }
  }, [id, setLastPageId]);

  useEffect(() => {
    if (isError) {
      setLastPageId(null);
    }
  }, [isError, setLastPageId]);

  // Fetch page content once on mount or when ID changes
  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function loadPage() {
      setIsLoading(true);
      setIsError(false);

      try {
        // const page = {
        //   content: await fetch("/sample.md").then((res) => res.text()),
        // };
        const page = await getPage(id!);
        if (!cancelled) {
          const content = page.content || "";
          setPageContent(content);
          setIsLoading(false);
          // Update initial word count
          setWordCount(countWords(content));
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
  }, [id, setWordCount]);

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
      // Update word count
      setWordCount(countWords(content));
    },
    [debouncedSave, setWordCount]
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

  if (isError || pageContent === null) {
    return <EditorNotFoundState />;
  }

  // Pass raw markdown content to the editor
  // Content is loaded once on mount, editor manages state from there
  return (
    <>
      <MountedEditor
        content={pageContent}
        className="w-full h-full"
        onContentChange={handleContentChange}
        autoFocus={true}
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
      content: "# ", // Empty heading 1
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
