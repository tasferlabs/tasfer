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
 *   • Tapping a tag selects it as the parent — any page can hold sub-pages, so a
 *     branch is as valid a choice as a leaf.
 *   • A tag that HAS sub-pages also drills in on that same tap: a new row of its
 *     children drops down below (the rows above it stay, so the drill path reads
 *     top-to-bottom), leaving a deeper choice one tap away. Picking a child
 *     replaces the selection and closes the rows below it.
 *   • Tapping the selected tag again deselects it (back to root / no parent) and
 *     collapses the branch it opened.
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
  excludeId,
}: {
  spaceId: string | null;
  value: ISearchPage | null;
  onChange: (page: ISearchPage | null) => void;
  /**
   * A page that cannot be the parent — itself, when the picker re-parents an
   * existing page. Hiding it hides its whole subtree too: rows only ever list
   * the children of a page the user drilled into, and a hidden tag can't be.
   */
  excludeId?: string;
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
    // Tapping the current choice again undoes it: no parent, and the branch it
    // opened collapses with it.
    if (value?.id === page.id) {
      setDrillPath(base);
      onChange(null);
      return;
    }
    // Select it, and — if it has sub-pages — open them as the next row so a
    // deeper choice stays one tap away without losing this one.
    setDrillPath(page.hasChildren ? [...base, page] : base);
    onChange({
      id: page.id,
      title: page.title,
      titleMd: page.titleMd,
      parentId: page.parentId,
      spaceId: page.spaceId ?? null,
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
          excludeId={excludeId}
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
  excludeId,
  onPick,
}: {
  spaceId: string | null;
  parentId: string | null;
  selectedId: string | null;
  openId: string | null;
  inheritedColor: string | null;
  excludeId?: string;
  onPick: (page: IListPage) => void;
}) {
  const { data: pages } = useGetPages(spaceId, parentId);
  const visible = excludeId ? pages?.filter((p) => p.id !== excludeId) : pages;
  if (!visible || visible.length === 0) return null;

  return (
    <div className={style.draftTagRow}>
      {visible.map((page) => {
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
              // Selected and open are independent now that a branch can be
              // both: the fill says "this is the parent", the chevron says
              // whether its children are showing below.
              <ChevronRight
                size={13}
                className={cn(
                  style.draftTagChevron,
                  isOpen && style.draftTagChevronOpen,
                )}
              />
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
 * space with each result's ancestor path — flat, so a deep page is reachable
 * without drilling to it. Selecting hands the page back to the host, which
 * returns to browse mode; DraftTagPicker then remounts with the drill path
 * opened to the selection.
 */
export function DraftParentSearch({
  spaceId,
  onSelect,
  onCancel,
  excludeId,
}: {
  spaceId: string | null;
  onSelect: (page: ISearchPage) => void;
  onCancel: () => void;
  /** See {@link DraftTagPicker}; here its descendants have to go too. */
  excludeId?: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // Scoped: the draft is tagged onto a page inside its own space.
  const { data: allResults } = useSearchPages(query, {
    spaceId,
    enabled: !!spaceId,
  });
  const results = excludeId
    ? allResults?.filter(
        (p) =>
          p.id !== excludeId &&
          !p.path?.some((ancestor) => ancestor.id === excludeId),
      )
    : allResults;
  // Results shrink as the query narrows; keep the highlight on a real row.
  const active = Math.min(activeIndex, (results?.length ?? 0) - 1);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // Back out of search only. A host that claims Escape at the window level
      // (the desktop popover does, to close the draft) gets it before this
      // handler and must route it to `onCancel` itself; this covers the rest.
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
