import { Button } from "@/components/ui/button";
import { RelativeDate } from "@/components/ui/relative-date";
import type { Block } from "@/deserializer/loadPage";
import { ChevronRight, FileText, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MountedEditor } from "../MountedEditor";

interface SnapshotPreviewProps {
  snapshot: {
    id: string;
    createdAt: Date;
    blockCount: number;
    blocks: Block[];
  };
  onBack: () => void;
  onRestore: () => void;
}

export function SnapshotPreview({
  snapshot,
  onBack,
  onRestore,
}: SnapshotPreviewProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col h-full flex-1">
      {/* Header */}

      {/* Editor Preview */}
      <div className="flex-1 overflow-hidden bg-background">
        <MountedEditor
          snapshot={snapshot.blocks}
          pageId={`preview-${snapshot.id}`}
          readonly
          className="h-full"
        />
      </div>

      <div className="flex items-center  gap-4 justify-between p-4 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-t">
        <Button onClick={onRestore} size={"lg"}>
          <RotateCcw className="h-3.5 w-3.5 me-1.5" />
          {t("common.restore", "Restore")}
        </Button>

        <div className="flex items-center justify-between gap-2 flex-1">
          <div className="flex items-center gap-4">
            <div>
              <h3 className="text-sm font-medium">{t("common.preview", "Preview")}</h3>
              <div className="flex gap-2">
                <RelativeDate
                  date={snapshot.createdAt}
                  className="text-xs text-muted-foreground"
                />

                <div className="flex items-center gap-1 text-xs text-muted-foreground me-2">
                  <FileText className="h-3 w-3" />
                  <span>
                    {snapshot.blockCount}{" "}
                    {snapshot.blockCount === 1 ? t("blocks.blockKw", "block") : t("blocks.blocksKw", "blocks")}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <Button variant="ghost" size="icon" onClick={onBack}>
            <ChevronRight className="h-4 w-4 rtl:-scale-x-100" />
          </Button>
        </div>
      </div>
    </div>
  );
}
