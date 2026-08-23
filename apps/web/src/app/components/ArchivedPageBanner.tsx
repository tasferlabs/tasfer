import { DateTime } from "luxon";
import { Archive, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { ArchivedPageRef } from "../api/pages.api";

interface ArchivedPageBannerProps {
  page: ArchivedPageRef;
  onRestore: () => void;
  restoring: boolean;
}

/**
 * Takes over the top action bar for a page the app no longer shows. The
 * breadcrumb has nothing useful to say about a page you can't navigate to, and
 * the canvas gives no sign that typing does nothing — so the bar names the
 * state and carries the one action that ends it.
 *
 * Sized for the bar's single row; the bar tints itself to match (see
 * .appHeaderArchived).
 */
export function ArchivedPageBanner({
  page,
  onRestore,
  restoring,
}: ArchivedPageBannerProps) {
  const { t, i18n } = useTranslation();
  // The page can be hidden by its own archive, by its space's, or by both. Name
  // whichever one the reader has to undo.
  const pageArchived = page.restoreRootId !== null;
  const withSpace = !!page.archivedSpaceId;
  // Luxon defaults to the system locale, which is not what the app is set to.
  // An unparseable timestamp drops the meta line rather than printing a raw
  // ISO string, which would sit LTR in the middle of an RTL row.
  const archivedAt = DateTime.fromISO(page.archivedAt);
  const archivedAgo = archivedAt.isValid
    ? (archivedAt.toRelative({ locale: i18n.language }) ??
      archivedAt.toLocaleString(DateTime.DATE_MED, { locale: i18n.language }))
    : null;

  const title = !pageArchived
    ? t("archive.bannerTitleSpace", "This page's space is archived")
    : withSpace
      ? t("archive.bannerTitleBoth", "This page and its space are archived")
      : t("archive.bannerTitle", "This page is archived");

  return (
    <div
      role="status"
      // Text strip, not a control row: the desktop title bar keeps its drag
      // region across the banner (see .appHeaderSlot in Layout.module.css).
      data-window-drag
      className="flex min-w-0 flex-1 items-center gap-2.5"
    >
      <Archive className="size-4 shrink-0 text-warning" aria-hidden />
      <span className="truncate text-[13px] font-semibold text-foreground">
        {title}
      </span>
      {/* Drops out first on a narrow bar: the button and the state it describes
          matter more than when it happened. */}
      {archivedAgo && (
        <span className="hidden truncate text-[12px] text-muted-foreground sm:inline">
          {t("archive.bannerMeta", "Read-only · archived {{time}}", {
            time: archivedAgo,
          })}
        </span>
      )}
      <Button
        size="sm"
        onClick={onRestore}
        disabled={restoring}
        className="ms-auto shrink-0"
      >
        <RotateCcw className="me-1.5 size-4" />
        {pageArchived
          ? t("archive.restorePage", "Restore page")
          : t("archive.restoreSpace", "Restore space")}
      </Button>
    </div>
  );
}
