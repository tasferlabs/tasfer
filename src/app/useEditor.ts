import { useEffect, useRef, useState } from "react";
import { createEditor } from "../editor";
import type { EditorHookState } from "./types";

export function useEditor(
  path: string
): React.RefObject<HTMLCanvasElement | null> {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<EditorHookState>({
    editor: null,
    isInitialized: false,
    isError: false,
  });

  const editorRef = useRef<ReturnType<typeof createEditor> | null>(null);

  // Initialize editor when canvas is available
  useEffect(() => {
    if (!canvasRef.current || state.isInitialized) return;

    try {
      const editor = createEditor(canvasRef.current);
      editorRef.current = editor;

      editor.load(path).then(() => {
        setState({
          editor,
          isInitialized: true,
          isError: false,
        });
        editor.start();
      });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isEror: true,
      }));
    }
  }, [state.isInitialized]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (editorRef.current) {
        editorRef.current.destroy();
        editorRef.current = null;
      }
    };
  }, []);

  return canvasRef;
}
