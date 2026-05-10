import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import { Button } from "../components/ui/button";
import { Check, CornerDownLeft, Sigma, X } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import useResponsive from "../app/hooks/useResponsive";
import { useTranslation } from "react-i18next";
import { renderToSVG, isValidLatex } from "./mathjax";
import { AnimatePresence, motion } from "framer-motion";

// Common LaTeX snippets for quick insertion
const MATH_SNIPPETS = [
  { label: "Fraction", latex: "\\frac{a}{b}", preview: "\\frac{a}{b}" },
  { label: "Square root", latex: "\\sqrt{x}", preview: "\\sqrt{x}" },
  { label: "Summation", latex: "\\sum_{i=0}^{n}", preview: "\\sum_{i=0}^{n}" },
  { label: "Integral", latex: "\\int_{a}^{b}", preview: "\\int_{a}^{b}" },
  { label: "Limit", latex: "\\lim_{x \\to \\infty}", preview: "\\lim_{x\\to\\infty}" },
  { label: "Matrix", latex: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", preview: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}" },
  { label: "Superscript", latex: "x^{2}", preview: "x^{2}" },
  { label: "Subscript", latex: "x_{i}", preview: "x_{i}" },
] as const;

interface MathBlockEditorProps {
  x: number;
  y: number;
  initialLatex?: string;
  displayMode?: boolean;
  inline?: boolean;
  onSubmit: (latex: string, displayMode: boolean) => void;
  onDelete?: () => void;
  onClose: () => void;
  /** Inline mode only: arrow-out at the start/end of the textarea. */
  onExitArrow?: (direction: "left" | "right") => void;
  collisionBoundary?: HTMLElement | null;
  container?: HTMLElement | null;
}

function MathPreview({
  latex,
  displayMode,
  className,
}: {
  latex: string;
  displayMode: boolean;
  className?: string;
}) {
  const html = useMemo(() => {
    if (!latex.trim()) return "";
    try {
      return renderToSVG(latex, displayMode);
    } catch {
      return "";
    }
  }, [latex, displayMode]);

  const hasError = useMemo(() => {
    if (!latex.trim()) return false;
    return !isValidLatex(latex, displayMode);
  }, [latex, displayMode]);

  if (!latex.trim()) {
    return (
      <div className={className}>
        <div className="flex items-center justify-center h-full min-h-[60px] text-muted-foreground/40 text-sm select-none">
          <Sigma className="size-5 me-2 opacity-50" />
          Preview
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <AnimatePresence mode="wait">
        <motion.div
          key={latex}
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -2 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          className={`math-preview-content flex items-center justify-center min-h-[60px] px-4 py-3 overflow-x-auto ${
            hasError ? "math-preview-error" : ""
          }`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </AnimatePresence>
    </div>
  );
}

function SnippetButton({
  label,
  preview,
  onClick,
}: {
  label: string;
  preview: string;
  onClick: () => void;
}) {
  const html = useMemo(() => {
    try {
      return renderToSVG(preview, false);
    } catch {
      return label;
    }
  }, [preview, label]);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className="group flex flex-col items-center gap-1.5 px-2.5 py-2 rounded-lg
        bg-muted/40 hover:bg-accent border border-transparent hover:border-border/50
        transition-all duration-100 active:scale-[0.97] cursor-pointer select-none"
    >
      <span
        className="math-snippet-preview text-foreground/80 group-hover:text-foreground transition-colors"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <span className="text-[10px] text-muted-foreground/60 group-hover:text-muted-foreground transition-colors font-medium tracking-wide">
        {label}
      </span>
    </button>
  );
}

function MathEditorContent({
  initialLatex = "",
  displayMode: initialDisplayMode = true,
  inline = false,
  onSubmit,
  onDelete,
  onClose,
  onExitArrow,
}: Omit<MathBlockEditorProps, "x" | "y" | "collisionBoundary" | "container">) {
  const { t } = useTranslation();
  const [latex, setLatex] = useState(initialLatex);
  const displayMode = initialDisplayMode;
  const [showSnippets, setShowSnippets] = useState(!initialLatex);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isEditing = Boolean(initialLatex);

  // Focus textarea on mount
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      // Place cursor at end
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }
  }, []);

  const handleSubmit = useCallback(() => {
    if (latex.trim()) {
      onSubmit(latex.trim(), displayMode);
    }
  }, [latex, displayMode, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const isShortcut = e.metaKey || e.ctrlKey;

      // In inline mode, plain Enter confirms (single-line feel).
      if (e.key === "Enter" && (isShortcut || inline) && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (
        inline &&
        onExitArrow &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        !e.shiftKey &&
        !isShortcut
      ) {
        // Arrow out of the popover when caret is at the matching textarea edge,
        // so the user can keep navigating past the chip with arrow keys.
        const ta = textareaRef.current;
        if (ta && ta.selectionStart === ta.selectionEnd) {
          const atStart = ta.selectionStart === 0;
          const atEnd = ta.selectionStart === ta.value.length;
          if (e.key === "ArrowLeft" && atStart) {
            e.preventDefault();
            e.stopPropagation();
            onExitArrow("left");
            return;
          }
          if (e.key === "ArrowRight" && atEnd) {
            e.preventDefault();
            e.stopPropagation();
            onExitArrow("right");
            return;
          }
        }
      } else if (isShortcut) {
        // Keep native textarea shortcuts (undo/redo/copy/paste/select-all)
        // and prevent the canvas-level editor hotkeys from intercepting them.
        e.stopPropagation();
      }
    },
    [handleSubmit, onClose, inline, onExitArrow],
  );

  const insertSnippet = useCallback(
    (snippetLatex: string) => {
      const ta = textareaRef.current;
      if (!ta) {
        setLatex((prev) => prev + snippetLatex);
        return;
      }

      ta.focus();
      document.execCommand("insertText", false, snippetLatex);
    },
    [],
  );

  if (inline) {
    return (
      <div className="math-editor-root math-editor-inline">
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <div className="math-editor-lang-tag math-editor-lang-tag-inline">
            TeX
          </div>
          <textarea
            ref={textareaRef}
            value={latex}
            onChange={(e) => setLatex(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="\frac{a}{b}"
            className="math-editor-textarea math-editor-textarea-inline"
            rows={1}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
          />
          <button
            type="button"
            disabled={!latex.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleSubmit}
            title={t("common.confirm", "Confirm")}
            className="flex items-center justify-center size-6 rounded-md
              text-muted-foreground hover:text-foreground hover:bg-accent
              disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent
              transition-colors cursor-pointer"
          >
            <CornerDownLeft className="size-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="math-editor-root">
      {/* Preview area */}
      <MathPreview
        latex={latex}
        displayMode={displayMode}
        className="math-editor-preview border-b border-border/40"
      />

      {/* LaTeX input */}
      <div className="math-editor-input-area">
        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
          <div className="math-editor-lang-tag">LaTeX</div>
          <div className="flex-1" />
        </div>

        <textarea
          ref={textareaRef}
          value={latex}
          onChange={(e) => setLatex(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="E.g. \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}"
          className="math-editor-textarea"
          rows={2}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
        />

        {/* Keyboard hint */}
        <div className="flex items-center gap-1 px-3 pb-1">
          <span className="text-[10px] text-muted-foreground/40 flex items-center gap-1">
            <CornerDownLeft className="size-2.5" />
            {navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Enter to
            confirm
          </span>
        </div>
      </div>

      {/* Snippets panel */}
      <div className="border-t border-border/40">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowSnippets(!showSnippets)}
          className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-medium
            text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer select-none"
        >
          <span>Symbols</span>
          <svg
            className={`size-3 transition-transform duration-150 ${showSnippets ? "rotate-180" : ""}`}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M3 4.5L6 7.5L9 4.5" />
          </svg>
        </button>

        <AnimatePresence>
          {showSnippets && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="grid grid-cols-4 gap-1.5 px-2.5 pb-2.5">
                {MATH_SNIPPETS.map((snippet) => (
                  <SnippetButton
                    key={snippet.label}
                    label={snippet.label}
                    preview={snippet.preview}
                    onClick={() => insertSnippet(snippet.latex)}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-t border-border/40">
        {isEditing && onDelete && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10 text-xs"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onDelete();
              onClose();
            }}
          >
            <X className="size-3.5 me-1" />
            {t("common.delete", "Delete")}
          </Button>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
        >
          {t("common.cancel", "Cancel")}
        </Button>
        <Button
          size="sm"
          className="text-xs"
          disabled={!latex.trim()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleSubmit}
        >
          <Check className="size-3.5 me-1" />
          {isEditing
            ? t("common.update", "Update")
            : t("common.insert", "Insert")}
        </Button>
      </div>
    </div>
  );
}

export const MathBlockEditor: React.FC<MathBlockEditorProps> = (props) => {
  const {
    x,
    y,
    onClose,
    collisionBoundary,
    container,
    inline = false,
    ...contentProps
  } = props;
  const isMobile = useResponsive("(max-width: 768px)");
  const contentRef = useRef<HTMLDivElement>(null);

  const handlePointerDownOutside = useCallback(
    (event: CustomEvent<{ originalEvent: PointerEvent }>) => {
      const originalEvent = event.detail?.originalEvent;
      const path =
        originalEvent && typeof originalEvent.composedPath === "function"
          ? originalEvent.composedPath()
          : [];

      if (contentRef.current && path.includes(contentRef.current)) {
        event.preventDefault();
        return;
      }

      onClose();
    },
    [onClose],
  );

  if (isMobile && !inline) {
    return (
      <Drawer
        open={true}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle className="flex items-center gap-2">
              <Sigma className="size-4" />
              Math equation
            </DrawerTitle>
          </DrawerHeader>
          <div className="pb-4">
            <MathEditorContent
              {...contentProps}
              inline={inline}
              onClose={onClose}
            />
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover.Root open={true} modal={false}>
      <Popover.Anchor
        style={{
          position: "fixed",
          left: `${x}px`,
          top: `${y}px`,
          width: 1,
          height: 1,
        }}
      />
      <Popover.Portal container={container}>
        <Popover.Content
          ref={contentRef}
          className={`${inline ? "math-editor-popover-inline" : "math-editor-popover"} z-50 select-none pointer-events-auto animate-in fade-in zoom-in-95 duration-150`}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          collisionBoundary={collisionBoundary ?? undefined}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={onClose}
          onPointerDownOutside={handlePointerDownOutside}
        >
          <MathEditorContent
            {...contentProps}
            inline={inline}
            onClose={onClose}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
