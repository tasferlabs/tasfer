import { useTranslation } from "react-i18next";
import { FolderInput } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ISpace } from "../api/spaces.api";

interface SpacePickerDialogProps {
  open: boolean;
  spaces: ISpace[];
  onSelect: (spaceId: string) => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * Asks which space a set of dropped markdown/text/ZIP files should import into.
 * Only shown when more than one space exists — with a single space the caller
 * imports straight into it without prompting.
 */
export function SpacePickerDialog({
  open,
  spaces,
  onSelect,
  onOpenChange,
}: SpacePickerDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("import.chooseSpace", "Choose a space")}</DialogTitle>
          <DialogDescription>
            {t(
              "import.chooseSpaceDesc",
              "Select which space to import the dropped files into.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          {spaces.map((space) => (
            <button
              key={space.id}
              onClick={() => onSelect(space.id)}
              className="flex items-center gap-3 rounded-lg border-2 border-border p-3 text-start transition-all hover:border-primary hover:bg-accent cursor-pointer"
            >
              <FolderInput className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="font-medium truncate">
                {space.name || t("common.untitled", "Untitled")}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
