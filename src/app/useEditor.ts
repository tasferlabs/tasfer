import type { ViewportState } from "@/editor/types";
import { useCallback, useEffect, useRef, useState } from "react";
import createEditor, { type Editor } from "../editor";
import type { EditorHookState } from "./types";

interface UseEditorReturn {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  editor: ReturnType<typeof createEditor> | null;
  isInitialized: boolean;
  isError: boolean;
  updateViewport: (viewport: ViewportState) => void;
  viewport: ViewportState | null;
  documentHeight: number;
}

export function useEditor(path: string): UseEditorReturn {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [documentHeight, setDocumentHeight] = useState<number>(0);
  const viewportRef = useRef<ViewportState | null>(null);
  const [viewport, setViewport] = useState<ViewportState | null>(null);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  const [state, setState] = useState<EditorHookState>({
    editor: null,
    isInitialized: false,
    isError: false,
  });

  const editorRef = useRef<Editor | null>(null);
  const updateViewport = useCallback((viewport: ViewportState) => {
    setViewport((prev) => {
      const data = { ...(prev || {}), ...viewport };
      viewportRef.current = data;
      return data;
    });
    if (editorRef.current) {
      editorRef.current.updateViewport(viewport);
    }
  }, []);

  // Initialize editor when canvas is available
  useEffect(() => {
    if (!canvasRef.current || state.isInitialized || !viewportRef.current)
      return;

    try {
      const editor = createEditor(canvasRef.current, viewportRef.current);
      editorRef.current = editor;

      editor.load(path).then(() => {
        setState({
          editor,
          isInitialized: true,
          isError: false,
        });
        editor.start(setDocumentHeight);
      });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isError: true,
      }));
    }
  }, [state.isInitialized, viewport]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (editorRef.current) {
        editorRef.current.destroy();
        editorRef.current = null;
      }
    };
  }, []);

  return {
    canvasRef,
    editor: editorRef.current,
    isInitialized: state.isInitialized,
    isError: state.isError,
    updateViewport,
    documentHeight,
    viewport,
  };
}
