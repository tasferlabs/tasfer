import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DateTime } from "luxon";
import { RotateCcw } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { MountedEditor } from "../../MountedEditor";
import { useGetPageSnapshots, type ArchivedPageItem } from "../../api/pages.api";
import style from "./BinPage.module.css";

interface BinPreviewProps {
  item: ArchivedPageItem;
  onRestore: () => void;
  restoring: boolean;
  /** Render the title/restore header. False when the host shows it elsewhere
   * (e.g. the desktop top action bar). Defaults to true for the mobile drawer. */
  showHeader?: boolean;
}

/**
 * Read-only preview of a deleted page. The page is archived, so it can't be
 * loaded through `pages.get` (which filters `archived_at IS NULL`). Instead we
 * read the latest version snapshot — `pages.snapshots` replays the op log with
 * no archived filter — and render it through the editor's static readonly mount
 * (no sync, no offline store), mirroring SnapshotPreview.
 */
export default function BinPreview({
  item,
  onRestore,
  restoring,
  showHeader = true,
}: BinPreviewProps) {
  const { t } = useTranslation();
  const { data: snapshots, isLoading } = useGetPageSnapshots(item.id);

  // Snapshots come newest-first; index 0 is the most recent full content.
  const blocks = useMemo(() => snapshots?.[0]?.blocks ?? null, [snapshots]);

  const deletedAgo =
    DateTime.fromISO(item.archivedAt).toRelative() ?? item.archivedAt;

  return (
    <div className={style.preview}>
      {showHeader && (
        <header className={style.previewHeader}>
          <span
            className={style.previewColor}
            style={item.color ? { backgroundColor: item.color } : undefined}
            aria-hidden
          />
          <div className={style.previewHeading}>
            <h2 className={style.previewTitle}>
              {item.title || t("common.untitled", "Untitled")}
            </h2>
            <span className={style.previewMeta}>
              {t("bin.deletedAgo", "Deleted {{time}}", { time: deletedAgo })}
            </span>
          </div>
          <Button size="sm" onClick={onRestore} disabled={restoring}>
            <RotateCcw className="me-1.5 h-4 w-4" />
            {t("bin.restore", "Restore")}
          </Button>
        </header>
      )}

      <div className={style.previewBody}>
        {isLoading ? (
          <div className={style.previewState}>{t("common.loading", "Loading…")}</div>
        ) : blocks && blocks.length > 0 ? (
          <MountedEditor
            key={item.id}
            snapshot={blocks}
            pageId={`bin-preview-${item.id}`}
            readonly
            className="h-full"
          />
        ) : (
          <div className={style.previewState}>
            {t("bin.noContent", "This page has no content")}
          </div>
        )}
      </div>
    </div>
  );
}
