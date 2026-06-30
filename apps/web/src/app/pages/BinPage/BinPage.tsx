import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DateTime } from "luxon";
import { Folder, RotateCcw } from "lucide-react";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { TopActionBarPortal } from "../../layout/TopActionBarSlot";
import { useSpaces } from "../../contexts/SpaceContext";
import useResponsive from "../../hooks/useResponsive";
import useLocalStorage from "../../hooks/useLocalStorage";
import { useP2PPageEventsWithQueryClient } from "../../hooks/useP2PPageEvents";
import {
  useGetArchivedPages,
  useRestorePage,
  type ArchivedPageItem,
} from "../../api/pages.api";
import {
  useGetArchivedSpaces,
  useUnarchiveSpace,
} from "../../api/spaces.api";
import Icons from "../../components/uiKit/Icons/Icons";
import BinPreview from "./BinPreview";
import clsx from "clsx";
import style from "./BinPage.module.css";

interface BinSection {
  spaceId: string | null;
  spaceName: string | null;
  items: ArchivedPageItem[];
}

export default function BinPage() {
  const { t, i18n } = useTranslation();
  const { spaces } = useSpaces();
  const isMobile = useResponsive("(max-width: 768px)");
  const isFine = useResponsive("(pointer: fine)");
  useP2PPageEventsWithQueryClient();

  const { data: archived, isLoading } = useGetArchivedPages();
  const { data: archivedSpaces, isLoading: spacesLoading } =
    useGetArchivedSpaces();
  const { mutate: restorePage, isPending } = useRestorePage();
  const { mutate: unarchiveSpace, isPending: isRestoringSpace } =
    useUnarchiveSpace();

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Resizable list pane, mirroring the main app sidebar. Width is persisted and
  // only adjustable with a fine pointer; coarse pointers fall back to the CSS
  // clamp. The list pane is inline-start, so width grows toward the pointer
  // (flipped in RTL where its inline-start edge is on the right).
  const isRtl = i18n.dir() === "rtl";
  const listPaneRef = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useLocalStorage("bin-list-width", 320);
  const [isResizing, setIsResizing] = useState(false);

  const startResizing = useCallback(() => setIsResizing(true), []);
  const stopResizing = useCallback(() => setIsResizing(false), []);
  const resize = useCallback(
    (e: MouseEvent) => {
      if (!listPaneRef.current) return;
      const rect = listPaneRef.current.getBoundingClientRect();
      // Same as the main app sidebar: track the pointer and let CSS
      // min/max-width clamp the result (flipped in RTL).
      const newWidth = isRtl ? rect.right - e.clientX : e.clientX - rect.left;
      setListWidth(newWidth);
    },
    [isRtl, setListWidth],
  );

  useEffect(() => {
    if (!isResizing) return;
    window.addEventListener("mousemove", resize);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [isResizing, resize, stopResizing]);

  // Group archived pages by their owning space so each space's deleted pages
  // are listed together. Pages with no space fall into an "Other" bucket.
  const sections = useMemo<BinSection[]>(() => {
    if (!archived) return [];
    const spaceName = new Map(spaces.map((s) => [s.id, s.name]));
    const bySpace = new Map<string | null, ArchivedPageItem[]>();
    for (const item of archived) {
      const key = item.spaceId ?? null;
      if (!bySpace.has(key)) bySpace.set(key, []);
      bySpace.get(key)!.push(item);
    }
    return Array.from(bySpace.entries()).map(([spaceId, items]) => ({
      spaceId,
      spaceName: spaceId ? (spaceName.get(spaceId) ?? null) : null,
      items,
    }));
  }, [archived, spaces]);

  const selected = useMemo(
    () => archived?.find((p) => p.id === selectedId) ?? null,
    [archived, selectedId],
  );

  // On large screens, auto-select the first page so the preview pane isn't
  // empty on arrival. On touch the preview is a drawer, so leave it closed.
  useEffect(() => {
    if (isMobile) return;
    if (!selectedId && archived && archived.length > 0) {
      setSelectedId(archived[0].id);
    }
  }, [isMobile, selectedId, archived]);

  // Drop the selection if its page leaves the bin (restored here or by a peer).
  useEffect(() => {
    if (selectedId && archived && !archived.some((p) => p.id === selectedId)) {
      setSelectedId(null);
    }
  }, [archived, selectedId]);

  const hasArchivedSpaces = (archivedSpaces?.length ?? 0) > 0;
  // Headers disambiguate groups; with a Spaces section present, label the page
  // groups too even when there's only one.
  const showHeaders = sections.length > 1 || hasArchivedSpaces;
  const isEmpty =
    !isLoading &&
    !spacesLoading &&
    (!archived || archived.length === 0) &&
    !hasArchivedSpaces;
  const totalCount = (archived?.length ?? 0) + (archivedSpaces?.length ?? 0);

  function handleRestore(id: string) {
    restorePage({ id });
    if (selectedId === id) setSelectedId(null);
  }

  const list = (
    <div
      className={style.list}
      role="listbox"
      aria-label={t("bin.title", "Bin")}
    >
      {hasArchivedSpaces && (
        <section className={style.section}>
          <h2 className={style.sectionHeader}>
            {t("bin.spacesHeader", "Spaces")}
          </h2>
          {archivedSpaces!.map((space) => (
            <div key={space.id} className={clsx(style.row, style.spaceRow)}>
              <Folder className={style.spaceIcon} aria-hidden />
              <span className={style.rowTitle}>
                {space.name || t("space.untitled", "Untitled space")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className={style.spaceRestore}
                onClick={() => unarchiveSpace(space.id)}
                disabled={isRestoringSpace}
                aria-label={t("bin.restoreSpace", "Restore space")}
              >
                <RotateCcw className="me-1.5 h-4 w-4" />
                {t("bin.restore", "Restore")}
              </Button>
            </div>
          ))}
        </section>
      )}
      {sections.map((section) => (
        <section key={section.spaceId ?? "__none__"} className={style.section}>
          {showHeaders && (
            <h2 className={style.sectionHeader}>
              {section.spaceName ?? t("bin.otherSpace", "Other")}
            </h2>
          )}
          {section.items.map((item) => {
            const isActive = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={isActive}
                className={clsx(style.row, isActive && style.rowActive)}
                style={
                  item.color
                    ? ({ "--row-accent": item.color } as React.CSSProperties)
                    : undefined
                }
                onClick={() => setSelectedId(item.id)}
              >
                <span
                  className={style.colorDot}
                  style={
                    item.color ? { backgroundColor: item.color } : undefined
                  }
                  aria-hidden
                />
                <span className={style.rowTitle}>
                  {item.title || t("common.untitled", "Untitled")}
                </span>
                <span className={style.rowMeta}>
                  {DateTime.fromISO(item.archivedAt).toRelative() ?? ""}
                </span>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );

  return (
    <div className={style.container}>
      <TopActionBarPortal>
        <span className={style.headerTitle}>{t("bin.title", "Bin")}</span>
        {!isEmpty && totalCount > 0 && (
          <span className={style.headerCount}>{totalCount}</span>
        )}
        {!isMobile && selected && (
          <div className={style.headerPreview}>
            <span className={style.headerSelMeta}>
              {t("bin.deletedAgo", "Deleted {{time}}", {
                time: DateTime.fromISO(selected.archivedAt).toRelative() ?? "",
              })}
            </span>
            <Button
              size="sm"
              onClick={() => handleRestore(selected.id)}
              disabled={isPending}
            >
              <RotateCcw className="me-1.5 h-4 w-4" />
              {t("bin.restore", "Restore")}
            </Button>
          </div>
        )}
      </TopActionBarPortal>

      {isEmpty ? (
        <div className={style.empty}>
          <span className={style.emptyIcon}>
            <Icons.Trash width={28} height={28} />
          </span>
          <p className={style.emptyTitle}>
            {t("bin.empty", "No deleted pages")}
          </p>
          <p className={style.emptyHint}>
            {t(
              "bin.emptyHint",
              "Pages you delete land here and can be restored.",
            )}
          </p>
        </div>
      ) : isMobile ? (
        <>
          {list}
          <Drawer
            open={selected !== null}
            onOpenChange={(open) => !open && setSelectedId(null)}
          >
            <DrawerContent className={style.drawerContent}>
              <DrawerTitle className="sr-only">
                {selected?.title || t("common.untitled", "Untitled")}
              </DrawerTitle>
              {selected && (
                <BinPreview
                  item={selected}
                  restoring={isPending}
                  onRestore={() => handleRestore(selected.id)}
                />
              )}
            </DrawerContent>
          </Drawer>
        </>
      ) : (
        <div className={clsx(style.split, isResizing && style.resizing)}>
          <div
            ref={listPaneRef}
            className={style.listPane}
            style={isFine ? { width: listWidth } : undefined}
          >
            {list}
          </div>
          <div className={style.previewPane}>
            {isFine && (
              <div
                className={style.resizer}
                onMouseDown={startResizing}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("bin.resizeList", "Resize list")}
              />
            )}
            {selected ? (
              <BinPreview
                item={selected}
                restoring={isPending}
                onRestore={() => handleRestore(selected.id)}
                showHeader={false}
              />
            ) : (
              <div className={style.previewEmpty}>
                <span className={style.emptyIcon}>
                  <Icons.Trash width={24} height={24} />
                </span>
                <p>{t("bin.selectPrompt", "Select a page to preview it")}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
