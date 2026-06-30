import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DateTime } from "luxon";
import { ChevronRight, FileText, Folder, RotateCcw } from "lucide-react";
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
  type ArchivedSpaceItem,
} from "../../api/spaces.api";
import Icons from "../../components/uiKit/Icons/Icons";
import BinPreview from "./BinPreview";
import clsx from "clsx";
import style from "./BinPage.module.css";

/** A single Bin row: either an archived space or a deleted page. */
type BinEntry =
  | { kind: "space"; archivedAt: string; space: ArchivedSpaceItem }
  | { kind: "page"; archivedAt: string; page: ArchivedPageItem };

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
  // Mobile-only: tapping a space row opens a small restore sheet instead of
  // exposing an inline restore button (which is too easy to mis-tap on touch).
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);

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

  // Resolve a page's owning space to a display label. Archived-space pages are
  // filtered out upstream, so any unresolved space_id is a genuinely space-less
  // page.
  const spaceName = useMemo(
    () => new Map(spaces.map((s) => [s.id, s.name])),
    [spaces],
  );

  // The Bin is one chronological stream: archived spaces and deleted pages are
  // interleaved purely by when they were removed, newest first. ISO-8601
  // timestamps compare correctly as strings, so no Date parsing is needed.
  const entries = useMemo<BinEntry[]>(() => {
    const out: BinEntry[] = [];
    for (const space of archivedSpaces ?? []) {
      out.push({ kind: "space", archivedAt: space.archivedAt, space });
    }
    for (const page of archived ?? []) {
      out.push({ kind: "page", archivedAt: page.archivedAt, page });
    }
    out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
    return out;
  }, [archived, archivedSpaces]);

  const selected = useMemo(
    () => archived?.find((p) => p.id === selectedId) ?? null,
    [archived, selectedId],
  );

  const selectedSpace = useMemo(
    () => archivedSpaces?.find((s) => s.id === selectedSpaceId) ?? null,
    [archivedSpaces, selectedSpaceId],
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

  // Same for the mobile space sheet: close it once the space is restored.
  useEffect(() => {
    if (
      selectedSpaceId &&
      archivedSpaces &&
      !archivedSpaces.some((s) => s.id === selectedSpaceId)
    ) {
      setSelectedSpaceId(null);
    }
  }, [archivedSpaces, selectedSpaceId]);

  const isEmpty = !isLoading && !spacesLoading && entries.length === 0;
  const totalCount = entries.length;

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
      {entries.map((entry) => {
        if (entry.kind === "space") {
          const { space } = entry;
          return (
            <div
              key={`space-${space.id}`}
              className={clsx(style.row, style.spaceRow)}
            >
              <div className={style.rowMain}>
                <Folder className={style.spaceIcon} aria-hidden />
                <span className={style.rowTitle}>
                  {space.name || t("space.untitled", "Untitled space")}
                </span>
                <span className={style.rowMeta}>
                  {DateTime.fromISO(space.archivedAt).toRelative() ?? ""}
                </span>
              </div>
              <button
                type="button"
                className={style.restore}
                onClick={() => unarchiveSpace(space.id)}
                disabled={isRestoringSpace}
                title={t("bin.restoreSpace", "Restore space")}
                aria-label={t("bin.restoreSpace", "Restore space")}
              >
                <RotateCcw className={style.restoreIcon} aria-hidden />
              </button>
            </div>
          );
        }

        const { page } = entry;
        const isActive = page.id === selectedId;
        const space = page.spaceId
          ? (spaceName.get(page.spaceId) ?? null)
          : null;
        // The row itself is the selection target (opens the preview); only the
        // Restore icon is a nested button. A clickable row keeps a single
        // control per action without nesting a button inside a button.
        return (
          <div
            key={`page-${page.id}`}
            role="option"
            aria-selected={isActive}
            tabIndex={0}
            className={clsx(style.row, style.pageRow, isActive && style.rowActive)}
            style={
              page.color
                ? ({ "--row-accent": page.color } as React.CSSProperties)
                : undefined
            }
            onClick={() => setSelectedId(page.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSelectedId(page.id);
              }
            }}
          >
            <div className={style.rowMain}>
              <FileText className={style.pageIcon} aria-hidden />
              <span className={style.rowTitle}>
                {page.title || t("common.untitled", "Untitled")}
              </span>
              {space && <span className={style.rowSpace}>{space}</span>}
              <span className={style.rowMeta}>
                {DateTime.fromISO(page.archivedAt).toRelative() ?? ""}
              </span>
            </div>
            <button
              type="button"
              className={style.restore}
              onClick={(e) => {
                e.stopPropagation();
                handleRestore(page.id);
              }}
              disabled={isPending}
              title={t("bin.restorePage", "Restore page")}
              aria-label={t("bin.restorePage", "Restore page")}
            >
              <RotateCcw className={style.restoreIcon} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );

  // Touch-first list. Each row's single job is to open the item; restore is a
  // deliberate action inside the drawer, so there is no inline button to mis-tap.
  const mobileList = (
    <ul className={style.mobileList} aria-label={t("bin.title", "Bin")}>
      {entries.map((entry) => {
        const isSpace = entry.kind === "space";
        const accent = entry.kind === "page" ? entry.page.color : undefined;
        const title = isSpace
          ? entry.space.name || t("space.untitled", "Untitled space")
          : entry.page.title || t("common.untitled", "Untitled");
        // Second line: an owning-space label for pages, a type label for spaces.
        const label =
          entry.kind === "page"
            ? entry.page.spaceId
              ? (spaceName.get(entry.page.spaceId) ?? null)
              : null
            : t("bin.typeSpace", "Space");
        const time = DateTime.fromISO(entry.archivedAt).toRelative() ?? "";
        return (
          <li key={`${entry.kind}-${isSpace ? entry.space.id : entry.page.id}`}>
            <button
              type="button"
              className={style.mobileRow}
              style={
                accent
                  ? ({ "--row-accent": accent } as React.CSSProperties)
                  : undefined
              }
              onClick={() =>
                isSpace
                  ? setSelectedSpaceId(entry.space.id)
                  : setSelectedId(entry.page.id)
              }
            >
              {isSpace ? (
                <Folder className={style.mobileIcon} aria-hidden />
              ) : (
                <FileText className={style.mobileIcon} aria-hidden />
              )}
              <span className={style.mobileText}>
                <span className={style.mobileTitle}>{title}</span>
                <span className={style.mobileSub}>
                  {label && (
                    <>
                      <span className={style.mobileSubLabel}>{label}</span>
                      <span className={style.mobileDot} aria-hidden>
                        ·
                      </span>
                    </>
                  )}
                  <span className={style.mobileTime}>{time}</span>
                </span>
              </span>
              <ChevronRight className={style.mobileChevron} aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
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
          {mobileList}
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
          <Drawer
            open={selectedSpace !== null}
            onOpenChange={(open) => !open && setSelectedSpaceId(null)}
          >
            <DrawerContent>
              <DrawerTitle className="sr-only">
                {selectedSpace?.name || t("space.untitled", "Untitled space")}
              </DrawerTitle>
              {selectedSpace && (
                <div className={style.spaceSheet}>
                  <span className={style.spaceSheetIcon}>
                    <Folder width={26} height={26} aria-hidden />
                  </span>
                  <h2 className={style.spaceSheetTitle}>
                    {selectedSpace.name ||
                      t("space.untitled", "Untitled space")}
                  </h2>
                  <p className={style.spaceSheetMeta}>
                    {t("bin.deletedAgo", "Deleted {{time}}", {
                      time:
                        DateTime.fromISO(
                          selectedSpace.archivedAt,
                        ).toRelative() ?? "",
                    })}
                  </p>
                  <p className={style.spaceSheetHint}>
                    {t(
                      "bin.spaceRestoreHint",
                      "Restoring brings the space and its pages back.",
                    )}
                  </p>
                  <Button
                    className={style.spaceSheetButton}
                    onClick={() => {
                      unarchiveSpace(selectedSpace.id);
                      setSelectedSpaceId(null);
                    }}
                    disabled={isRestoringSpace}
                  >
                    <RotateCcw className="me-1.5 h-4 w-4" />
                    {t("bin.restore", "Restore")}
                  </Button>
                </div>
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
