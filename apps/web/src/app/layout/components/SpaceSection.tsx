import { useDraggable } from "@dnd-kit/core";
import clsx from "clsx";
import { Ellipsis, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import { Button } from "../../../components/ui/button";
import Icons from "../../components/uiKit/Icons/Icons";
import { useImportDialog } from "../../components/ImportDialogProvider";
import type { ISpace } from "../../api/spaces.api";
import {
  useIsSpaceCollapsed,
  useSpacePrefs,
  useSpacePrefsLoaded,
} from "../../contexts/SpacePrefsContext";
import { useRevealRequest } from "../../contexts/TreeExpandContext";
import { useIsSpaceSyncing } from "../../contexts/SyncActivityContext";
import style from "../Layout.module.css";
import { PagesArea } from "./PagesArea";
import { SpaceDropZone } from "./SpaceDropZone";

/**
 * One space in the sidebar: a draggable, collapsible header followed by its
 * pages. Dragging the header reorders spaces (handled in SidebarContent);
 * clicking it collapses/expands the space. Both behaviours are per-device.
 */
export function SpaceSection({
  space,
  isCreating,
  onSpaceSettings,
  onInviteMembers,
  onArchive,
  onAddPage,
}: {
  space: ISpace;
  isCreating: boolean;
  onSpaceSettings: (spaceId: string) => void;
  onInviteMembers: (spaceId: string) => void;
  onArchive: (spaceId: string) => void;
  onAddPage: (spaceId: string) => void;
}) {
  const { t } = useTranslation();
  const { openImport } = useImportDialog();
  const prefs = useSpacePrefs();
  const collapsed = useIsSpaceCollapsed(space.id);
  const syncing = useIsSpaceSyncing(space.id);
  const name = space.name || t("common.untitled", "Untitled");

  // A page opened from outside the sidebar has to be reachable there, so its
  // space opens even when it was collapsed. Each request is acted on once —
  // after that the person can collapse the space again and it stays closed.
  const reveal = useRevealRequest();
  const prefsLoaded = useSpacePrefsLoaded();
  const handledRevealRef = useRef(0);
  useEffect(() => {
    if (!prefsLoaded || reveal?.spaceId !== space.id) return;
    if (handledRevealRef.current === reveal.nonce) return;
    handledRevealRef.current = reveal.nonce;
    if (collapsed) prefs.expand(space.id);
  }, [reveal, prefsLoaded, collapsed, prefs, space.id]);

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `space-${space.id}`,
    data: { type: "spaceLink", spaceId: space.id, name },
  });

  // A reorder ends with a synthetic click on the handle; suppress the toggle
  // so dragging a space doesn't also collapse/expand it (mirrors PageLink).
  const wasDraggingRef = useRef(false);
  useEffect(() => {
    if (isDragging) wasDraggingRef.current = true;
  }, [isDragging]);

  function handleToggle() {
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false;
      return;
    }
    prefs.toggleCollapsed(space.id);
  }

  return (
    <>
      <SpaceDropZone beforeSpaceId={space.id} />
      <div
        className={clsx(
          style.appSidebarSection,
          isDragging && style.appSidebarSectionDragging,
        )}
      >
        <Button
          type="button"
          variant="unstyled"
          size="unstyled"
          ref={setNodeRef}
          className={clsx(style.appSidebarSectionHandle, "justify-start")}
          onClick={handleToggle}
          aria-expanded={!collapsed}
          {...listeners}
          {...attributes}
        >
          <span className={style.appSidebarSectionTitle}>
            <span className={style.appSidebarSectionIcon}>
              <Icons.Box className={style.appSidebarSpaceGlyph} />
              <Icons.ChevronRight
                className={clsx(
                  style.appSidebarCollapseIcon,
                  !collapsed && style.appSidebarCollapseIconOpen,
                )}
              />
            </span>
            <span className="truncate">{name}</span>
          </span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="unstyled"
              size="unstyled"
              className={style.appSidebarSectionButton}
            >
              <Ellipsis className="size-5" />
              <span className="sr-only">
                {t("space.settings", "Space settings")}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => onSpaceSettings(space.id)}>
              {t("space.settings", "Space settings")}
            </DropdownMenuItem>
            {!space.personal && (
              <DropdownMenuItem onSelect={() => onInviteMembers(space.id)}>
                {t("share.inviteMembers", "Invite members")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => openImport(space.id)}>
              {t("space.import", "Import")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onArchive(space.id)}>
              {t("space.archiveSpace", "Archive space")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="unstyled"
          size="unstyled"
          className={style.appSidebarSectionButton}
          onClick={() => onAddPage(space.id)}
          disabled={isCreating}
        >
          <Plus className="size-5" />
          <span className="sr-only">{t("page.addPage", "Add page")}</span>
        </Button>
        {syncing && (
          <>
            <span className={style.appSidebarSectionSyncBar} aria-hidden />
            <span role="status" className="sr-only">
              {t("space.syncing", "Syncing changes")}
            </span>
          </>
        )}
      </div>
      {!collapsed && <PagesArea parentId={null} spaceId={space.id} />}
    </>
  );
}
