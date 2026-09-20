import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DateTime } from "luxon";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Lock,
  PencilLine,
  RotateCcw,
  UserPlus,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { TimelineIcon } from "../../components/TimelineIcon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getPlatform } from "@/platform";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { TopActionBarPortal } from "../../layout/TopActionBarSlot";
import { TitlePreview } from "../../TitlePreview";
import { useSpaces } from "../../contexts/SpaceContext";
import useResponsive from "../../hooks/useResponsive";
import useLocalStorage from "../../hooks/useLocalStorage";
import {
  useGetArchivedPages,
  useRestorePage,
  type ArchivedPageItem,
} from "../../api/pages.api";
import {
  useGetArchivedSpaces,
  useGetSpaceHistory,
  useUnarchiveSpace,
  type ArchivedSpaceItem,
  type SpaceHistoryEntry,
} from "../../api/spaces.api";
import TimelinePreview from "./TimelinePreview";
import clsx from "clsx";
import type { TFunction } from "i18next";
import style from "./TimelinePage.module.css";

/**
 * A single Timeline row: an archived space or page, which can be restored, or
 * a change to a space's settings, which is only a record.
 */
type TimelineEntry =
  | { kind: "space"; at: string; space: ArchivedSpaceItem }
  | { kind: "page"; at: string; page: ArchivedPageItem }
  | { kind: "setting"; at: string; change: SpaceHistoryEntry };

const settingIcons = {
  created: FolderPlus,
  renamed: PencilLine,
  madePersonal: Lock,
  memberJoined: UserPlus,
} satisfies Record<SpaceHistoryEntry["kind"], unknown>;

/** What a settings change did, as one line. */
function describeChange(t: TFunction, change: SpaceHistoryEntry): string {
  // The starter space is created without a name.
  const named = (name: string) => name || t("space.untitled", "Untitled space");
  switch (change.kind) {
    case "created":
      return change.personal
        ? t("timeline.createdPersonal", "Created personal space “{{name}}”", {
            name: named(change.name),
          })
        : t("timeline.created", "Created space “{{name}}”", {
            name: named(change.name),
          });
    case "renamed":
      return t("timeline.renamed", "Renamed “{{from}}” to “{{to}}”", {
        from: named(change.from),
        to: named(change.to),
      });
    case "madePersonal":
      return t("timeline.madePersonal", "Made “{{name}}” personal", {
        name: named(change.name),
      });
    case "memberJoined":
      return t("timeline.memberJoined", "{{member}} joined “{{name}}”", {
        member: change.memberName,
        name: named(change.name),
      });
  }
}

/**
 * Which of this person's devices joined. Many devices share a person's name, so
 * the note they wrote is what tells them apart.
 */
function joinedDeviceNote(change: SpaceHistoryEntry): string | null {
  return change.kind === "memberJoined" ? change.memberNote : null;
}

/**
 * Who made a settings change. A join already names the person, so it gets no
 * author line.
 */
function describeAuthor(
  t: TFunction,
  change: SpaceHistoryEntry,
): string | null {
  if (change.kind === "memberJoined") return null;
  if (change.byYou) return t("timeline.byYou", "You");
  return change.byName ?? t("timeline.byUnknown", "Someone");
}

export default function TimelinePage() {
  const { t, i18n } = useTranslation();
  const { spaces } = useSpaces();
  const isMobile = useResponsive("(max-width: 768px)");
  const isFine = useResponsive("(pointer: fine)");

  const { data: archived, isLoading } = useGetArchivedPages();
  const { data: archivedSpaces, isLoading: spacesLoading } =
    useGetArchivedSpaces();
  const { data: history, isLoading: historyLoading } = useGetSpaceHistory();
  const queryClient = useQueryClient();

  // A device note shows on join rows, and can be edited on any of this
  // person's devices, so re-read the history when one changes.
  useEffect(
    () =>
      getPlatform().devices.onChange(() => {
        queryClient.invalidateQueries({ queryKey: ["spaces", "history"] });
      }),
    [queryClient],
  );
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
  const [listWidth, setListWidth] = useLocalStorage("archive-list-width", 320);
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

  // The Timeline is one chronological stream: archived spaces and pages and
  // space settings changes are interleaved purely by when they happened,
  // newest first. ISO-8601 timestamps compare correctly as strings, so no Date
  // parsing is needed.
  const entries = useMemo<TimelineEntry[]>(() => {
    const out: TimelineEntry[] = [];
    for (const space of archivedSpaces ?? []) {
      out.push({ kind: "space", at: space.archivedAt, space });
    }
    for (const page of archived ?? []) {
      out.push({ kind: "page", at: page.archivedAt, page });
    }
    for (const change of history ?? []) {
      out.push({ kind: "setting", at: change.at, change });
    }
    out.sort((a, b) => b.at.localeCompare(a.at));
    return out;
  }, [archived, archivedSpaces, history]);

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

  // Drop the selection if its page is no longer archived (restored here or by a peer).
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

  const isEmpty =
    !isLoading && !spacesLoading && !historyLoading && entries.length === 0;
  const relative = (iso: string) =>
    DateTime.fromISO(iso).toRelative({ locale: i18n.language }) ?? "";

  function handleRestore(id: string) {
    restorePage({ id });
    if (selectedId === id) setSelectedId(null);
  }

  const list = (
    <TooltipProvider delayDuration={300}>
      <div
        className={style.list}
        role="listbox"
        aria-label={t("timeline.title", "Timeline")}
      >
        {entries.map((entry) => {
          if (entry.kind === "setting") {
            const { change } = entry;
            const Icon = settingIcons[change.kind];
            const author = describeAuthor(t, change);
            const note = joinedDeviceNote(change);
            return (
              <div
                key={`setting-${change.spaceId}-${change.id}`}
                className={clsx(style.row, style.settingRow)}
              >
                <div className={style.rowMain}>
                  <Icon className={style.settingIcon} aria-hidden />
                  <span className={style.settingText}>
                    {note ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className={clsx(style.settingTitle, style.hasNote)}
                          >
                            {describeChange(t, change)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{note}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className={style.settingTitle}>
                        {describeChange(t, change)}
                      </span>
                    )}
                    <span className={style.rowMeta}>
                      {author && (
                        <>
                          {author}
                          <span className={style.mobileDot} aria-hidden>
                            {" · "}
                          </span>
                        </>
                      )}
                      {relative(change.at)}
                    </span>
                  </span>
                </div>
              </div>
            );
          }

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
                    {relative(space.archivedAt)}
                  </span>
                </div>
                <button
                  type="button"
                  className={style.restore}
                  onClick={() => unarchiveSpace(space.id)}
                  disabled={isRestoringSpace}
                  title={t("archive.restoreSpace", "Restore space")}
                  aria-label={t("archive.restoreSpace", "Restore space")}
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
              className={clsx(
                style.row,
                style.pageRow,
                isActive && style.rowActive,
              )}
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
                  <TitlePreview title={page.title} titleMd={page.titleMd} />
                </span>
                {space && <span className={style.rowSpace}>{space}</span>}
                <span className={style.rowMeta}>
                  {relative(page.archivedAt)}
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
                title={t("archive.restorePage", "Restore page")}
                aria-label={t("archive.restorePage", "Restore page")}
              >
                <RotateCcw className={style.restoreIcon} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );

  // Touch-first list. Each row's single job is to open the item; restore is a
  // deliberate action inside the drawer, so there is no inline button to mis-tap.
  const mobileList = (
    <ul
      className={style.mobileList}
      aria-label={t("timeline.title", "Timeline")}
    >
      {entries.map((entry) => {
        if (entry.kind === "setting") {
          const { change } = entry;
          const Icon = settingIcons[change.kind];
          // Touch has no hover, so the device note sits in the sub line.
          const author = describeAuthor(t, change) ?? joinedDeviceNote(change);
          return (
            <li key={`setting-${change.spaceId}-${change.id}`}>
              <div className={clsx(style.mobileRow, style.mobileRowStatic)}>
                <Icon className={style.mobileIcon} aria-hidden />
                <span className={style.mobileText}>
                  <span
                    className={clsx(style.mobileTitle, style.mobileTitleWrap)}
                  >
                    {describeChange(t, change)}
                  </span>
                  <span className={style.mobileSub}>
                    {author && (
                      <>
                        <span className={style.mobileSubLabel}>{author}</span>
                        <span className={style.mobileDot} aria-hidden>
                          ·
                        </span>
                      </>
                    )}
                    <span className={style.mobileTime}>
                      {relative(change.at)}
                    </span>
                  </span>
                </span>
              </div>
            </li>
          );
        }

        const isSpace = entry.kind === "space";
        const accent = entry.kind === "page" ? entry.page.color : undefined;
        const title = isSpace ? (
          entry.space.name || t("space.untitled", "Untitled space")
        ) : (
          <TitlePreview title={entry.page.title} titleMd={entry.page.titleMd} />
        );
        // Second line: an owning-space label for pages, a type label for spaces.
        const label =
          entry.kind === "page"
            ? entry.page.spaceId
              ? (spaceName.get(entry.page.spaceId) ?? null)
              : null
            : t("archive.typeSpace", "Space");
        const time = t("archive.archivedAgo", "Archived {{time}}", {
          time: relative(entry.at),
        });
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
        <span className={style.headerTitle} data-window-drag>
          {t("timeline.title", "Timeline")}
        </span>
        {!isMobile && selected && (
          <div className={style.headerPreview}>
            <span className={style.headerSelMeta}>
              {t("archive.archivedAgo", "Archived {{time}}", {
                time:
                  DateTime.fromISO(selected.archivedAt).toRelative({
                    locale: i18n.language,
                  }) ?? "",
              })}
            </span>
            <Button
              size="sm"
              onClick={() => handleRestore(selected.id)}
              disabled={isPending}
            >
              <RotateCcw className="me-1.5 h-4 w-4" />
              {t("archive.restore", "Restore")}
            </Button>
          </div>
        )}
      </TopActionBarPortal>

      {isEmpty ? (
        <div className={style.empty}>
          <span className={style.emptyIcon}>
            <TimelineIcon width={28} height={28} />
          </span>
          <p className={style.emptyTitle}>
            {t("timeline.empty", "Nothing here yet")}
          </p>
          <p className={style.emptyHint}>
            {t(
              "timeline.emptyHint",
              "Changes to your spaces show up here. So do pages and spaces you archive, and you can restore them.",
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
                <TimelinePreview
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
                    {t("archive.archivedAgo", "Archived {{time}}", {
                      time:
                        DateTime.fromISO(selectedSpace.archivedAt).toRelative({
                          locale: i18n.language,
                        }) ?? "",
                    })}
                  </p>
                  <p className={style.spaceSheetHint}>
                    {t(
                      "archive.spaceRestoreHint",
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
                    {t("archive.restore", "Restore")}
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
                aria-label={t("timeline.resizeList", "Resize list")}
              />
            )}
            {selected ? (
              <TimelinePreview
                item={selected}
                restoring={isPending}
                onRestore={() => handleRestore(selected.id)}
                showHeader={false}
              />
            ) : (
              <div className={style.previewEmpty}>
                <span className={style.emptyIcon}>
                  <TimelineIcon width={24} height={24} />
                </span>
                <p>
                  {t(
                    "timeline.selectPrompt",
                    "Select an archived page to preview it",
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
