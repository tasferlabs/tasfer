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
import Icons from "../../components/uiKit/Icons/Icons";
import { useImportDialog } from "../../components/ImportDialogProvider";
import type { ISpace } from "../../api/spaces.api";
import {
  useIsSpaceCollapsed,
  useSpacePrefs,
} from "../../contexts/SpacePrefsContext";
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
  const name = space.name || t("common.untitled", "Untitled");

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
        <button
          type="button"
          ref={setNodeRef}
          className={style.appSidebarSectionHandle}
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
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger className={style.appSidebarSectionButton}>
            <Ellipsis size={20} />
            <span className="sr-only">
              {t("space.settings", "Space settings")}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => onSpaceSettings(space.id)}>
              {t("space.settings", "Space settings")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onInviteMembers(space.id)}>
              {t("share.inviteMembers", "Invite members")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openImport(space.id)}>
              {t("space.import", "Import")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onArchive(space.id)}>
              {t("space.archiveSpace", "Archive space")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          className={style.appSidebarSectionButton}
          onClick={() => onAddPage(space.id)}
          disabled={isCreating}
        >
          <Plus size={20} />
          <span className="sr-only">{t("page.addPage", "Add page")}</span>
        </button>
      </div>
      {!collapsed && <PagesArea parentId={null} spaceId={space.id} />}
    </>
  );
}
