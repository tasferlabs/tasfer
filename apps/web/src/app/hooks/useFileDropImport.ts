import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { uploadImage } from "../api/images.api";
import { useToast } from "../components/Toast";
import { useSpaces } from "../contexts/SpaceContext";
import { useActiveEditor } from "../contexts/ActiveEditorContext";
import type { ActiveEditorHandle } from "../contexts/ActiveEditorContext";
import type { DocPoint } from "@tasfer/editor";
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

/** Whether a foreground surface owns file-drop interaction. */
function foregroundOwnsFileDrop(e: React.DragEvent): boolean {
  const localTarget =
    e.target instanceof Element &&
    e.target.closest('[data-file-drop-scope="local"]') !== null;
  if (localTarget) return true;

  // Modal floating surfaces make the background inert through the app's shared
  // layered-surface contract. This covers dialogs, drawers, sheets, popovers,
  // menus, and future modal primitives without coupling this hook to any of them.
  // Keep aria-modal as the fallback for custom surfaces outside Radix.
  return (
    document.body.style.pointerEvents === "none" ||
    document.querySelector('[aria-modal="true"]') !== null
  );
}

/**
 * Classify a drag from its item metadata. File contents aren't readable mid-drag,
 * but `kind`/`type` usually are: "image" routes to the in-document insertion line,
 * anything else ("doc") to the space-import overlay, and a mixed drag reads as
 * "doc" so the full-window prompt shows. Mobile is the exception — it withholds
 * item metadata until drop, leaving `items` empty — so this returns "unknown" and
 * the caller falls back to the pointer position to pick an affordance.
 */
function dragKind(e: React.DragEvent): "image" | "doc" | "unknown" {
  const items = Array.from(e.dataTransfer.items).filter(
    (i) => i.kind === "file",
  );
  if (items.length === 0) return "unknown";
  return items.every((i) => i.type.startsWith("image/")) ? "image" : "doc";
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

interface UseFileDropImport {
  /**
   * The active file drag, or null. "doc" drives the full-window import overlay;
   * "image" shows no overlay (the in-canvas insertion line is the affordance).
   */
  dragKind: "image" | "doc" | null;
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
  const { toast } = useToast();
  const { spaces, activeSpaceId } = useSpaces();
  const { editor } = useActiveEditor();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [dragKindState, setDragKind] = useState<"image" | "doc" | null>(null);
  const [pendingSpaceFiles, setPendingSpaceFiles] = useState<File[] | null>(
    null,
  );

  // Latest editor read inside stable drop handlers without re-binding them.
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // Whether a file drag we own is currently showing (drives Escape handling).
  const draggingRef = useRef(false);

  // Safety net for the overlay: while a drag is active the browser fires
  // `dragover` on a timed loop (~every 350ms) even when the pointer is still, so
  // each one re-arms this timer. When the drag ends the events stop and the timer
  // fires — the only reliable cleanup on mobile/cross-app drags, where drop,
  // dragend, and boundary dragleave may never reach us.
  const heartbeat = useRef<ReturnType<typeof setTimeout> | null>(null);

  // True while a drag that started *inside* the page is in flight. OS file drags
  // never fire `dragstart` in our document, so this cleanly rejects in-page drags
  // (e.g. long-pressing an image on mobile) that would otherwise raise the overlay.
  const internalDragRef = useRef(false);

  // Edge auto-scroll during an image drag. A native HTML5 drag emits only
  // `drag*` events (no `pointermove`), so the engine can't see the pointer to
  // auto-scroll itself. `dragover` is the one event guaranteed to fire during a
  // native drag on every platform, so it drives the authoritative scroll tick —
  // crucially on iOS WKWebView, which pauses `requestAnimationFrame` for the
  // duration of the drag. The rAF loop is only a desktop refinement: it keeps
  // scrolling smoothly while the pointer holds still at an edge, in the gaps
  // between the sparse `dragover` heartbeats.
  const edgeScrollRaf = useRef<number | null>(null);
  const lastDragClient = useRef<{ x: number; y: number } | null>(null);
  // When `dragover` last drove a tick — the rAF loop skips a frame right after,
  // so the two drivers never compound into double-speed scrolling.
  const lastDragoverTick = useRef(0);

  /** The editor handle when it can receive a dropped image, else null. */
  const insertableEditor = useCallback((): ActiveEditorHandle | null => {
    const ed = editorRef.current;
    return ed && !ed.state.isReadonlyBase ? ed : null;
  }, []);

  const importToSpace = useCallback(
    async (files: File[], spaceId: string) => {
      const progress = toast.loading(t("import.importing", "Importing..."));
      try {
        const result = await importFilesToSpace(files, spaceId);
        queryClient.invalidateQueries({ queryKey: ["pages"] });
        if (result.firstPageId) {
          progress.dismiss();
          navigate(`/page/${result.firstPageId}`);
        } else {
          progress.update({
            variant: "error",
            message: t("import.nothingImported", "Nothing could be imported"),
          });
        }
      } catch (err) {
        progress.update({
          variant: "error",
          message:
            err instanceof NoImportablePagesError
              ? t(
                  "import.noImportablePages",
                  "No importable pages found in the ZIP file",
                )
              : t("import.failed", "Import failed"),
        });
      }
    },
    [navigate, queryClient, toast, t],
  );

  const edgeScrollTick = useCallback(() => {
    const ed = insertableEditor();
    const client = lastDragClient.current;
    if (ed && client) ed.view.edgeScrollForDrag(client);
  }, [insertableEditor]);

  // rAF loop: continue scrolling between dragover heartbeats while the pointer
  // holds still (desktop). Skips a frame just after a dragover already ticked so
  // the two drivers don't stack; no-ops where rAF is paused during the drag.
  const runEdgeScrollLoop = useCallback(() => {
    if (!draggingRef.current || !lastDragClient.current) {
      edgeScrollRaf.current = null;
      return;
    }
    if (performance.now() - lastDragoverTick.current > 24) edgeScrollTick();
    edgeScrollRaf.current = requestAnimationFrame(runEdgeScrollLoop);
  }, [edgeScrollTick]);

  const startEdgeScroll = useCallback(
    (client: { x: number; y: number }) => {
      lastDragClient.current = client;
      // Authoritative tick, straight off the dragover event — the only driver
      // that fires on iOS, where rAF is paused for the drag's duration.
      edgeScrollTick();
      lastDragoverTick.current = performance.now();
      if (edgeScrollRaf.current === null) {
        edgeScrollRaf.current = requestAnimationFrame(runEdgeScrollLoop);
      }
    },
    [edgeScrollTick, runEdgeScrollLoop],
  );

  const stopEdgeScroll = useCallback(() => {
    if (edgeScrollRaf.current !== null) {
      cancelAnimationFrame(edgeScrollRaf.current);
      edgeScrollRaf.current = null;
    }
    lastDragClient.current = null;
    editorRef.current?.view.edgeScrollForDrag(null);
  }, []);

  const endDrag = useCallback(() => {
    if (heartbeat.current) {
      clearTimeout(heartbeat.current);
      heartbeat.current = null;
    }
    stopEdgeScroll();
    draggingRef.current = false;
    setDragKind(null);
    editorRef.current?.view.showDropIndicator(null);
  }, [stopEdgeScroll]);

  // Track drags that begin inside the page, and guarantee the overlay clears
  // however the drag ends: Escape, a drop anywhere, or the browser cancelling it
  // (`dragend`). These backstop the boundary check in onDragLeave.
  useEffect(() => {
    const onDragStart = () => {
      internalDragRef.current = true;
    };
    const onEnd = () => {
      internalDragRef.current = false;
      endDrag();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && draggingRef.current) endDrag();
    };
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onEnd);
    window.addEventListener("drop", onEnd);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onEnd);
      window.removeEventListener("drop", onEnd);
      window.removeEventListener("keydown", onKeyDown);
      if (heartbeat.current) clearTimeout(heartbeat.current);
      if (edgeScrollRaf.current !== null)
        cancelAnimationFrame(edgeScrollRaf.current);
    };
  }, [endDrag]);

  /** A file drag from outside the page (not an in-page element drag). */
  const isFileImport = useCallback(
    (e: React.DragEvent) => !internalDragRef.current && dragHasFiles(e),
    [],
  );

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!isFileImport(e)) return;
      if (foregroundOwnsFileDrop(e)) {
        endDrag();
        return;
      }
      e.preventDefault();
    },
    [endDrag, isFileImport],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isFileImport(e)) return;
      // Dedicated controls (for example the import dialog's drop box) own both
      // the drop and its visual state. Clear any window-level affordance that
      // appeared while the pointer was travelling to the control.
      if (foregroundOwnsFileDrop(e)) {
        endDrag();
        return;
      }
      // Both dragover and drop must preventDefault, or the browser navigates to
      // the dropped file instead of letting us handle it.
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      draggingRef.current = true;

      // Re-arm the safety net; if dragover stops firing, the drag has ended.
      if (heartbeat.current) clearTimeout(heartbeat.current);
      heartbeat.current = setTimeout(endDrag, 700);

      // Image → in-canvas insertion line; doc → full-window overlay. When the
      // kind is unknown (mobile hides it mid-drag), fall back to the pointer: over
      // the editor canvas the engine returns a drop point, so show the line and
      // treat it as an image; otherwise show the overlay. The drop handler reads
      // the real files and routes correctly regardless of this guess.
      const kind = dragKind(e);
      const at =
        kind === "doc"
          ? null
          : insertableEditor()?.view.showDropIndicator({
              x: e.clientX,
              y: e.clientY,
            });
      if (kind === "doc") editorRef.current?.view.showDropIndicator(null);
      const isImageDrag = at != null || kind === "image";
      setDragKind(isImageDrag ? "image" : "doc");

      // Only image drags scroll the canvas; a doc drag shows the full-window
      // overlay and has no in-document target.
      if (isImageDrag && insertableEditor()) {
        startEdgeScroll({ x: e.clientX, y: e.clientY });
      } else {
        stopEdgeScroll();
      }
    },
    [endDrag, insertableEditor, isFileImport, startEdgeScroll, stopEdgeScroll],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!isFileImport(e)) return;
      if (foregroundOwnsFileDrop(e)) return;
      // dragleave also fires when crossing between child elements, where it
      // reports coordinates inside the viewport. Clear only when the pointer has
      // truly left the window — coordinates at or beyond the viewport edges. The
      // window `drop`/`dragend` listeners backstop any exit this misses.
      const left =
        e.clientX <= 0 ||
        e.clientY <= 0 ||
        e.clientX >= window.innerWidth ||
        e.clientY >= window.innerHeight;
      if (left) endDrag();
    },
    [endDrag, isFileImport],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isFileImport(e)) return;
      if (foregroundOwnsFileDrop(e)) {
        endDrag();
        return;
      }
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

      // An image only lands when it's dropped over the canvas. Dropped anywhere
      // else (the sidebar, a space) it's silently ignored — no valid target is
      // not an error worth interrupting for.
      if (images.length > 0 && ed && at) {
        void insertImagesAt(ed, images, at).catch(() =>
          toast.error(t("image.uploadFailed", "Failed to upload image")),
        );
      }

      if (docs.length > 0) {
        if (spaces.length > 1) {
          setPendingSpaceFiles(docs);
        } else if (activeSpaceId) {
          void importToSpace(docs, activeSpaceId);
        }
      }

      if (images.length === 0 && docs.length === 0) {
        toast.error(
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
      isFileImport,
      toast,
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
    dropZoneProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
    spacePicker: {
      open: pendingSpaceFiles !== null,
      onSelect: onPickSpace,
      onCancel: () => setPendingSpaceFiles(null),
    },
  };
}
