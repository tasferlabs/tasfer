import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { uploadImage } from "../api/images.api";
import { useSpaces } from "../contexts/SpaceContext";
import { useActiveEditor } from "../contexts/ActiveEditorContext";
import type { ActiveEditorHandle } from "../contexts/ActiveEditorContext";
import type { DocPoint } from "@cypherkit/editor";
import {
  importFilesToSpace,
  isImportableSpaceFile,
  NoImportablePagesError,
} from "@/lib/spaceImport";

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i;

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSION.test(file.name);
}

/** Whether a drag carries OS files (vs. an in-app dnd-kit drag). */
function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

/**
 * Classify a drag from its item metadata — file contents aren't readable during
 * drag, but `kind`/`type` are. "image" routes to the in-document drop indicator;
 * everything else ("doc") routes to the space import overlay. A mixed drag (an
 * image alongside other files) reads as "doc" so the full-window prompt shows.
 */
function dragKind(e: React.DragEvent): "image" | "doc" {
  const items = Array.from(e.dataTransfer.items).filter(
    (i) => i.kind === "file",
  );
  if (items.length === 0) return "doc";
  const allImages = items.every((i) => i.type.startsWith("image/"));
  return allImages ? "image" : "doc";
}

/**
 * Upload dropped images and insert them at `at` (the gap the drop indicator
 * marked). Uploads run together, then insert in reverse against the fixed anchor
 * so the images keep their dropped order.
 */
async function insertImagesAt(
  editor: ActiveEditorHandle,
  files: File[],
  at: DocPoint,
): Promise<void> {
  const uploads = await Promise.all(files.map(uploadImage));
  for (let i = uploads.length - 1; i >= 0; i--) {
    const uploaded = uploads[i];
    editor.change((c) =>
      c.insertBlock(
        {
          type: "image",
          url: uploaded.url,
          alt: uploaded.fileName,
          objectFit: "contain",
        },
        at,
      ),
    );
  }
}

type DropNotice =
  { kind: "importing" } | { kind: "error"; message: string } | null;

interface UseFileDropImport {
  /**
   * The active file drag, or null. "doc" drives the full-window import overlay;
   * "image" shows no overlay (the in-canvas insertion line is the affordance).
   */
  dragKind: "image" | "doc" | null;
  /** Transient status surfaced to the user (import progress / errors). */
  notice: DropNotice;
  /** Spread onto the window-spanning drop-zone element. */
  dropZoneProps: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  /** State for the "which space?" picker (only used with multiple spaces). */
  spacePicker: {
    open: boolean;
    onSelect: (spaceId: string) => void;
    onCancel: () => void;
  };
}

/**
 * Window-level file drag-and-drop. Dropped markdown/text/ZIP files import as
 * pages into a space (a full-window overlay invites the drop anywhere; a picker
 * resolves which space when there's more than one). Dropped images insert into
 * the open document at the point a live insertion line marks — the same line a
 * block reorder shows. Mounted once at the app root.
 */
export function useFileDropImport(): UseFileDropImport {
  const { t } = useTranslation();
  const { spaces, activeSpaceId } = useSpaces();
  const { editor } = useActiveEditor();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [dragKindState, setDragKind] = useState<"image" | "doc" | null>(null);
  const [notice, setNotice] = useState<DropNotice>(null);
  const [pendingSpaceFiles, setPendingSpaceFiles] = useState<File[] | null>(
    null,
  );

  // Latest editor read inside stable drop handlers without re-binding them.
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // dragenter/dragleave fire per descendant (sidebar, canvas, overlays);
  // counting depth keeps state stable as the pointer crosses child boundaries.
  const dragDepth = useRef(0);

  /** The editor handle when it can receive a dropped image, else null. */
  const insertableEditor = useCallback((): ActiveEditorHandle | null => {
    const ed = editorRef.current;
    return ed && !ed.state.isReadonlyBase ? ed : null;
  }, []);

  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showError = useCallback((message: string) => {
    setNotice({ kind: "error", message });
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(
    () => () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
    },
    [],
  );

  const importToSpace = useCallback(
    async (files: File[], spaceId: string) => {
      setNotice({ kind: "importing" });
      try {
        const result = await importFilesToSpace(files, spaceId);
        queryClient.invalidateQueries({ queryKey: ["pages"] });
        if (result.firstPageId) {
          setNotice(null);
          navigate(`/page/${result.firstPageId}`);
        } else {
          showError(t("import.nothingImported", "Nothing could be imported"));
        }
      } catch (err) {
        showError(
          err instanceof NoImportablePagesError
            ? t(
                "import.noImportablePages",
                "No importable pages found in the ZIP file",
              )
            : t("import.failed", "Import failed"),
        );
      }
    },
    [navigate, queryClient, showError, t],
  );

  const endDrag = useCallback(() => {
    dragDepth.current = 0;
    setDragKind(null);
    editorRef.current?.view.showDropIndicator(null);
  }, []);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
  }, []);

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      // Both dragover and drop must preventDefault, or the browser navigates to
      // the dropped file instead of letting us handle it.
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";

      const kind = dragKind(e);
      setDragKind(kind);
      // Drive the in-canvas insertion line for an image; the engine clears it
      // when the pointer leaves the canvas (e.g. over the sidebar).
      if (kind === "image") {
        insertableEditor()?.view.showDropIndicator({
          x: e.clientX,
          y: e.clientY,
        });
      } else {
        editorRef.current?.view.showDropIndicator(null);
      }
    },
    [insertableEditor],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) endDrag();
    },
    [endDrag],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();

      const dropped = Array.from(e.dataTransfer.files);
      const images = dropped.filter(isImageFile);
      const docs = dropped.filter(
        (f) => !isImageFile(f) && isImportableSpaceFile(f),
      );

      // Resolve the insertion point before clearing the indicator.
      const ed = insertableEditor();
      const at =
        images.length > 0 && ed
          ? ed.view.showDropIndicator({ x: e.clientX, y: e.clientY })
          : null;
      endDrag();

      if (images.length > 0) {
        if (ed && at) {
          void insertImagesAt(ed, images, at).catch(() =>
            showError(t("image.uploadFailed", "Failed to upload image")),
          );
        } else {
          showError(
            t("import.cannotAddImageHere", "Drop the image onto a page"),
          );
        }
      }

      if (docs.length > 0) {
        if (spaces.length > 1) {
          setPendingSpaceFiles(docs);
        } else if (activeSpaceId) {
          void importToSpace(docs, activeSpaceId);
        }
      }

      if (images.length === 0 && docs.length === 0) {
        showError(
          t(
            "import.unsupportedFile",
            "Drop an image, or a .md, .txt, or .zip file",
          ),
        );
      }
    },
    [
      activeSpaceId,
      endDrag,
      importToSpace,
      insertableEditor,
      showError,
      spaces.length,
      t,
    ],
  );

  const onPickSpace = useCallback(
    (spaceId: string) => {
      const files = pendingSpaceFiles;
      setPendingSpaceFiles(null);
      if (files) void importToSpace(files, spaceId);
    },
    [pendingSpaceFiles, importToSpace],
  );

  return {
    dragKind: dragKindState,
    notice,
    dropZoneProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
    spacePicker: {
      open: pendingSpaceFiles !== null,
      onSelect: onPickSpace,
      onCancel: () => setPendingSpaceFiles(null),
    },
  };
}
