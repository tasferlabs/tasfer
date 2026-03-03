import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileText, FileCode } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePageSettings } from "../contexts/PageSettingsContext";
import useResponsive from "../hooks/useResponsive";
import { serializeToMarkdown } from "@/deserializer/serializer";
import {
  getVisibleTextFromRuns,
  extractTitleFromBlocks,
} from "@/editor/sync/char-runs";
import { isTextualBlock, isListBlock, type Block } from "@/deserializer/loadPage";

function serializeToText(blocks: Block[]): string {
  return blocks
    .map((block) => {
      if (block.type === "line") return "---";
      if (block.type === "image") return block.alt || "";
      if (isTextualBlock(block) || isListBlock(block)) {
        const text = getVisibleTextFromRuns(block.charRuns);
        if (block.type === "todo_list") {
          const checkbox = block.checked ? "[x]" : "[ ]";
          return `${checkbox} ${text}`;
        }
        return text;
      }
      return "";
    })
    .join("\n");
}

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const { t } = useTranslation();
  const { currentBlocks } = usePageSettings();
  const isMobile = useResponsive("(max-width: 768px)");

  const getFileName = (extension: string) => {
    const title = extractTitleFromBlocks(currentBlocks) || "document";
    // Sanitize filename: remove invalid characters and trim
    const sanitized = title
      .replace(/[<>:"/\\|?*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    return `${sanitized || "document"}.${extension}`;
  };

  const downloadFile = (content: string, extension: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = getFileName(extension);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onOpenChange(false);
  };

  const handleExportTxt = () => {
    const content = serializeToText(currentBlocks);
    downloadFile(content, "txt", "text/plain");
  };

  const handleExportMarkdown = () => {
    const content = serializeToMarkdown(currentBlocks);
    downloadFile(content, "md", "text/markdown");
  };

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm pb-6">
            <DrawerHeader>
              <DrawerTitle>{t`Export document`}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4 space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start gap-3 h-auto py-3"
                onClick={handleExportTxt}
              >
                <FileText className="h-5 w-5 text-muted-foreground" />
                <div className="flex flex-col items-start">
                  <span className="font-medium">{t`Plain Text`}</span>
                  <span className="text-xs text-muted-foreground">.txt</span>
                </div>
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-3 h-auto py-3"
                onClick={handleExportMarkdown}
              >
                <FileCode className="h-5 w-5 text-muted-foreground" />
                <div className="flex flex-col items-start">
                  <span className="font-medium">{t`Markdown`}</span>
                  <span className="text-xs text-muted-foreground">.md</span>
                </div>
              </Button>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Export document`}</DialogTitle>
          <DialogDescription>
            {t`Choose a format to export your document`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handleExportTxt}
            className="flex flex-col items-center justify-center p-4 rounded-lg border-2 border-border hover:border-primary hover:bg-accent transition-all cursor-pointer"
          >
            <FileText className="h-8 w-8 mb-2 text-muted-foreground" />
            <span className="font-medium">{t`Plain Text`}</span>
            <span className="text-xs text-muted-foreground">.txt</span>
          </button>
          <button
            onClick={handleExportMarkdown}
            className="flex flex-col items-center justify-center p-4 rounded-lg border-2 border-border hover:border-primary hover:bg-accent transition-all cursor-pointer"
          >
            <FileCode className="h-8 w-8 mb-2 text-muted-foreground" />
            <span className="font-medium">{t`Markdown`}</span>
            <span className="text-xs text-muted-foreground">.md</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
