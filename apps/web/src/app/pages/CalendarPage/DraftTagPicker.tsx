import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGetPages, type IListPage, type ISearchPage } from "../../api/pages.api";
import { cn } from "@/lib/utils";
import style from "./CalendarPage.module.css";

/**
 * A Google-Calendar-style drill-down parent picker for the event draft. The
 * draft's parent page is chosen from horizontally-scrollable rows of "tags":
 *
 *   • Row 0 lists the space's top-level pages.
 *   • Tapping a tag that HAS sub-pages drills in — a new row of that page's
 *     children drops down below (the deeper rows above it stay, so the drill
 *     path reads top-to-bottom). Drilling does NOT select it. Tapping the same
 *     open tag again collapses it, so a drill-down can be undone.
 *   • Only a LEAF (a page with no sub-pages) becomes the selected parent; tap it
 *     again to deselect (back to root / no parent).
 *
 * State is intentionally local and ephemeral: the picker is mounted only while a
 * draft is open, so a fresh draft always starts back at the top level.
 */
export function DraftTagPicker({
  spaceId,
  value,
  onChange,
}: {
  spaceId: string | null;
  value: ISearchPage | null;
  onChange: (page: ISearchPage | null) => void;
}) {
  // The pages we've drilled into (each has children). `drillPath[i]` is the
  // opened page whose children fill row `i + 1`; row 0 is always the top level.
  const [drillPath, setDrillPath] = useState<IListPage[]>([]);
  const levels: (string | null)[] = [null, ...drillPath.map((p) => p.id)];

  // Color inherited by each row's tags when they have no color of their own,
  // matching the sidebar: a page falls back to its nearest colored ancestor.
  // Row 0 (top level) has no ancestor, so it inherits nothing.
  const rowInheritedColors: (string | null)[] = [null];
  let inherited: string | null = null;
  for (const p of drillPath) {
    inherited = p.color ?? inherited;
    rowInheritedColors.push(inherited);
  }

  const pick = (levelIndex: number, page: IListPage) => {
    // Anything drilled BELOW this level is replaced by this new choice.
    const base = drillPath.slice(0, levelIndex);
    if (page.hasChildren) {
      // Tapping the already-open branch again closes it, so the user can back
      // out of a drill-down they've changed their mind about.
      if (drillPath[levelIndex]?.id === page.id) {
        setDrillPath(base);
        return;
      }
      // Open this branch: its children appear as the next row. Navigating away
      // from a previously chosen leaf clears the selection.
      setDrillPath([...base, page]);
      if (value) onChange(null);
      return;
    }
    // Leaf: select it as the parent (or toggle it off), and close deeper rows.
    setDrillPath(base);
    if (value?.id === page.id) {
      onChange(null);
      return;
    }
    onChange({
      id: page.id,
      title: page.title,
      parentId: page.parentId,
      color: page.color ?? null,
      path: base.map((p) => ({ id: p.id, title: p.title, color: p.color })),
    });
  };

  return (
    <div className={style.draftTagLevels}>
      {levels.map((parentId, i) => (
        <TagRow
          key={parentId ?? "__root__"}
          spaceId={spaceId}
          parentId={parentId}
          selectedId={value?.id ?? null}
          openId={drillPath[i]?.id ?? null}
          inheritedColor={rowInheritedColors[i]}
          onPick={(page) => pick(i, page)}
        />
      ))}
    </div>
  );
}

function TagRow({
  spaceId,
  parentId,
  selectedId,
  openId,
  inheritedColor,
  onPick,
}: {
  spaceId: string | null;
  parentId: string | null;
  selectedId: string | null;
  openId: string | null;
  inheritedColor: string | null;
  onPick: (page: IListPage) => void;
}) {
  const { t } = useTranslation();
  const { data: pages } = useGetPages(spaceId, parentId);
  if (!pages || pages.length === 0) return null;

  return (
    <div className={style.draftTagRow}>
      {pages.map((page) => {
        const isSelected = page.id === selectedId;
        const isOpen = page.id === openId;
        const resolvedColor = page.color ?? inheritedColor;
        return (
          <button
            key={page.id}
            type="button"
            className={cn(
              style.draftTag,
              isSelected && style.draftTagSelected,
              isOpen && style.draftTagOpen,
            )}
            onClick={() => onPick(page)}
          >
            <span
              className={style.draftTagDot}
              style={{
                backgroundColor: resolvedColor || "var(--page-color-default)",
                opacity: resolvedColor ? 1 : 0.3,
              }}
            />
            <span className={style.draftTagLabel}>
              {page.title || t("common.untitled", "Untitled")}
            </span>
            {page.hasChildren && (
              <ChevronRight size={13} className={style.draftTagChevron} />
            )}
          </button>
        );
      })}
    </div>
  );
}
