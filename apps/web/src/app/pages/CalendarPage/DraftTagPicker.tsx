import { Fragment, useState } from "react";
import { ChevronRight, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  useGetPages,
  useSearchPages,
  type IListPage,
  type ISearchPage,
} from "../../api/pages.api";
import { cn } from "@/lib/utils";
import { TitlePreview } from "../../TitlePreview";
import style from "./CalendarPage.module.css";

/** The slice of a page the drill path needs; ancestors carry no list metadata. */
type DrillEntry = {
  id: string;
  title: string;
  titleMd?: string;
  color?: string | null;
};

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
 * draft is open, so a fresh draft starts back at the top level. When it mounts
 * with a selection already made (e.g. picked via DraftParentSearch), the drill
 * path opens to the selection's ancestors so it appears selected in context.
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
  const [drillPath, setDrillPath] = useState<DrillEntry[]>(() =>
    (value?.path ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      titleMd: p.titleMd,
      color: p.color,
    })),
  );
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
      titleMd: page.titleMd,
      parentId: page.parentId,
      color: page.color ?? null,
      path: base.map((p) => ({
        id: p.id,
        title: p.title,
        titleMd: p.titleMd,
        color: p.color,
      })),
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
              <TitlePreview
                title={page.title}
                titleMd={page.titleMd}
                mathFontSize={12}
              />
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

/**
 * Search mode of the draft parent picker: swaps in for the tag rows while the
 * user types, showing a flat, keyboard-navigable list over ALL pages in the
 * space with each result's ancestor path. Unlike the drill-down (where tapping
 * a branch opens it), any result — branch or leaf — is directly selectable.
 * Selecting hands the page back to the host, which returns to browse mode;
 * DraftTagPicker then remounts with the drill path opened to the selection.
 */
export function DraftParentSearch({
  spaceId,
  onSelect,
  onCancel,
}: {
  spaceId: string | null;
  onSelect: (page: ISearchPage) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const { data: results } = useSearchPages(spaceId, query);
  // Results shrink as the query narrows; keep the highlight on a real row.
  const active = Math.min(activeIndex, (results?.length ?? 0) - 1);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // Back out of search only — stop the popover's window-level Escape
      // listener from closing the whole draft.
      e.stopPropagation();
      onCancel();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(Math.min(active + 1, (results?.length ?? 0) - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(Math.max(active - 1, 0));
    } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
      // Plain Enter picks the highlighted result; Ctrl/Cmd+Enter stays the
      // popover-wide save shortcut.
      e.preventDefault();
      const page = results?.[active];
      if (page) onSelect(page);
    }
  };

  return (
    <div className={style.parentSearch}>
      <div className={style.parentSearchInputRow}>
        <Search size={14} className={style.previewRowIcon} />
        <input
          autoFocus
          className={style.parentSearchInput}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t("editor.searchPages", "Search pages...")}
        />
        <button
          type="button"
          className={style.parentSearchClear}
          onClick={onCancel}
          aria-label={t("common.cancel", "Cancel")}
        >
          <X size={14} />
        </button>
      </div>
      {results &&
        (results.length === 0 ? (
          <div className={style.parentSearchEmpty}>
            {t("page.noPagesFound", "No pages found")}
          </div>
        ) : (
          <div className={style.parentSearchResults} role="listbox">
            {results.map((page, i) => {
              const resolvedColor =
                page.color ??
                (page.path
                  ? [...page.path].reverse().find((p) => p.color)?.color
                  : null);
              return (
                <button
                  key={page.id}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={cn(
                    style.parentSearchItem,
                    i === active && style.parentSearchItemActive,
                  )}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => onSelect(page)}
                >
                  <span
                    className={style.draftTagDot}
                    style={{
                      backgroundColor:
                        resolvedColor || "var(--page-color-default)",
                      opacity: resolvedColor ? 1 : 0.3,
                    }}
                  />
                  <span className={style.parentSearchTitle}>
                    <TitlePreview
                      title={page.title}
                      titleMd={page.titleMd}
                      mathFontSize={12}
                    />
                  </span>
                  {page.path && page.path.length > 0 && (
                    <span className={style.parentSearchPath}>
                      {page.path.map((s, j) => (
                        <Fragment key={s.id}>
                          {j > 0 && " / "}
                          <TitlePreview
                            title={s.title}
                            titleMd={s.titleMd}
                            mathFontSize={11}
                          />
                        </Fragment>
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
    </div>
  );
}
