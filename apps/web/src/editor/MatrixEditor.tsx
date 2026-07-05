import { Grid3x3, Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import useResponsive from "../app/hooks/useResponsive";
import { usePreventMobileKeyboard } from "../app/hooks/usePreventMobileKeyboard";
import { cn } from "@/lib/utils";

/** Clamp bounds for the grid. A matrix stays at least 1×1 (removing it entirely
 *  is a plain text delete, not a resize). The upper cap is deliberately small:
 *  the canvas measures a math block's glyphs up to the caret on every edit
 *  (`measureTextUpToIndex`), which grows super-linearly with the block's length,
 *  so a big grid (e.g. 8×8 ≈ 64 cells) makes editing sluggish. Capping each
 *  dimension keeps a matrix comfortably inside the responsive range. A grid that
 *  is already larger (e.g. imported) can still be shrunk — only growth is
 *  blocked. */
const MIN_DIM = 1;
const MAX_DIM = 6;

interface MatrixEditorProps {
  open: boolean;
  /** Live dimensions of the grid the caret sits in (the source of truth). */
  rows: number;
  cols: number;
  /** Apply a new size to the document. The parent re-reads the grid and feeds the
   *  updated `rows`/`cols` back, so the preview always mirrors the real matrix. */
  onResize: (rows: number, cols: number) => void;
  onClose: () => void;
}

/**
 * The consolidated matrix editor: a grid-shaped preview plus row/column steppers.
 * Increasing a dimension appends empty cells; decreasing trims from the
 * bottom/right. Rendered as a modal dialog on desktop and a bottom drawer on
 * touch — the same "Edit matrix" entry point on the context menu and the mobile
 * toolbar opens it. It never shows raw LaTeX; only the abstract grid shape.
 */
export function MatrixEditor({
  open,
  rows,
  cols,
  onResize,
  onClose,
}: MatrixEditorProps) {
  const { t } = useTranslation();
  const isMobile = useResponsive("(max-width: 768px)");
  // The drawer covers the editor on touch; keep the soft keyboard down while it
  // is up (mirrors the link/image drawers).
  usePreventMobileKeyboard(isMobile && open);

  // Only the floor is clamped here; growth past MAX_DIM is prevented by disabling
  // the increment button, so shrinking an already-oversized grid still steps by
  // one instead of snapping down to the cap.
  const setRows = (next: number) => onResize(Math.max(MIN_DIM, next), cols);
  const setCols = (next: number) => onResize(rows, Math.max(MIN_DIM, next));

  const content = (
    <div className="flex flex-col items-center gap-5 p-4">
      <MatrixPreview rows={rows} cols={cols} />
      <div className="text-xs tabular-nums text-muted-foreground">
        {rows} × {cols}
      </div>
      <div className="flex w-full flex-col gap-3">
        <Stepper
          label={t("editor.math.matrix.rows", "Rows")}
          value={rows}
          onDecrement={() => setRows(rows - 1)}
          onIncrement={() => setRows(rows + 1)}
          decrementLabel={t("editor.math.matrix.removeRow", "Remove row")}
          incrementLabel={t("editor.math.matrix.addRow", "Add row")}
        />
        <Stepper
          label={t("editor.math.matrix.columns", "Columns")}
          value={cols}
          onDecrement={() => setCols(cols - 1)}
          onIncrement={() => setCols(cols + 1)}
          decrementLabel={t("editor.math.matrix.removeColumn", "Remove column")}
          incrementLabel={t("editor.math.matrix.addColumn", "Add column")}
        />
      </div>
    </div>
  );

  const title = t("editor.math.matrix.title", "Edit matrix");
  const description = t(
    "editor.math.matrix.description",
    "Add or remove rows and columns.",
  );

  if (isMobile) {
    return (
      <Drawer
        open={open}
        onOpenChange={(next) => !next && onClose()}
        modal
        dismissible
        shouldScaleBackground={false}
      >
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm">
            <DrawerHeader>
              <DrawerTitle className="flex items-center gap-2">
                <Grid3x3 className="h-4 w-4 text-muted-foreground" />
                {title}
              </DrawerTitle>
              <DrawerDescription>{description}</DrawerDescription>
            </DrawerHeader>
            {content}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-xs sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Grid3x3 className="h-4 w-4 text-muted-foreground" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}

/** A schematic of the grid's shape — one bordered box per cell. Purely the
 *  matrix's dimensions, never its LaTeX content. */
function MatrixPreview({ rows, cols }: { rows: number; cols: number }) {
  return (
    <div
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: rows * cols }, (_, i) => (
        <div
          key={i}
          className="size-5 rounded-sm border border-border bg-muted/50"
        />
      ))}
    </div>
  );
}

interface StepperProps {
  label: string;
  value: number;
  onDecrement: () => void;
  onIncrement: () => void;
  decrementLabel: string;
  incrementLabel: string;
}

function Stepper({
  label,
  value,
  onDecrement,
  onIncrement,
  decrementLabel,
  incrementLabel,
}: StepperProps) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <StepperButton
          aria-label={decrementLabel}
          disabled={value <= MIN_DIM}
          onClick={onDecrement}
        >
          <Minus className="size-4" />
        </StepperButton>
        <span className="w-6 text-center text-sm tabular-nums text-foreground">
          {value}
        </span>
        <StepperButton
          aria-label={incrementLabel}
          disabled={value >= MAX_DIM}
          onClick={onIncrement}
        >
          <Plus className="size-4" />
        </StepperButton>
      </div>
    </div>
  );
}

function StepperButton({
  children,
  disabled,
  onClick,
  ...rest
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      // Keep the editor's stored selection (the matrix anchor) intact — a
      // pointer-down that stole focus would drop the caret out of the grid.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-md border border-border text-foreground transition-colors",
        disabled
          ? "opacity-30"
          : "hover:bg-accent hover:text-accent-foreground active:bg-muted",
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
