import { useTranslation } from "react-i18next";
import { Inbox } from "lucide-react";
import clsx from "clsx";
import type { ISpace } from "../api/spaces.api";
import { SpacePickerDialog } from "../components/SpacePickerDialog";
import type { useFileDropImport } from "../hooks/useFileDropImport";

type FileDrop = ReturnType<typeof useFileDropImport>;

/**
 * The visual layer for window-level file drag-and-drop: the full-window "drop to
 * import" overlay (markdown/text/ZIP → pages), the import status toast, and the
 * space picker. The in-document image insertion line is painted by the editor
 * canvas itself, so it has no chrome here.
 */
export function FileDropChrome({
  fileDrop,
  spaces,
}: {
  fileDrop: FileDrop;
  spaces: ISpace[];
}) {
  return (
    <>
      <DropImportOverlay visible={fileDrop.dragKind === "doc"} />
      <DropNotice notice={fileDrop.notice} />
      <SpacePickerDialog
        open={fileDrop.spacePicker.open}
        spaces={spaces}
        onSelect={fileDrop.spacePicker.onSelect}
        onOpenChange={(open) => {
          if (!open) fileDrop.spacePicker.onCancel();
        }}
      />
    </>
  );
}

function DropImportOverlay({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-background/55 backdrop-blur-[1px] animate-in fade-in-0 duration-150"
      aria-hidden
    >
      {/* Inset ring hugging the window edges — the whole workspace is the target. */}
      <div className="absolute inset-2.5 rounded-[22px] border border-primary/45 ring-1 ring-inset ring-primary/10 bg-primary/[0.04]" />
      <div className="relative flex flex-col items-center gap-4 px-6 text-center">
        <div className="grid size-14 place-items-center rounded-2xl bg-primary/10 ring-1 ring-primary/30">
          <Inbox className="size-7 text-primary" />
        </div>
        <div className="space-y-1">
          <p className="text-xl font-semibold tracking-tight">
            {t("import.dropToImport", "Drop to import")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(
              "import.dropToImportHint",
              "Markdown, text, or ZIP files become pages",
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

function DropNotice({ notice }: { notice: FileDrop["notice"] }) {
  const { t } = useTranslation();
  if (!notice) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 animate-in fade-in-0 slide-in-from-bottom-2 duration-150">
      <div
        className={clsx(
          "flex items-center gap-2 rounded-full border px-4 py-2 text-sm shadow-lg",
          notice.kind === "error"
            ? "border-destructive/40 bg-background text-destructive"
            : "border-border bg-background text-muted-foreground",
        )}
      >
        {notice.kind === "importing" && (
          <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        )}
        <span>
          {notice.kind === "importing"
            ? t("import.importing", "Importing...")
            : notice.message}
        </span>
      </div>
    </div>
  );
}
