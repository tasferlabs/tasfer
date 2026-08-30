import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronRight, FileText, History, Search, X } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import {
  getPages,
  useSearchPages,
  type IListPage,
  type ISearchPage,
} from "../../api/pages.api";
import {
  forgetParent,
  getRecentParents,
  type RecentParent,
} from "@/lib/parentUsage";
import {
  getRememberedChoice,
  rememberChoice,
  REMEMBER_KEYS,
} from "@/lib/rememberedChoice";
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

/** How many shortcut tags the "Recent" row offers before it starts scrolling. */
const RECENT_LIMIT = 6;

/** One tag in the picker: a live page row, plus the shortcut that surfaced it. */
type Tag = { page: IListPage; recent?: RecentParent };

/** One rendered row of tags — the shortcut row, or a level of the drill path. */
type TagRowModel = {
  key: string;
  recent: boolean;
  tags: Tag[];
  inheritedColor: string | null;
  openId: string | null;
  /** Index into the drill path; the shortcut row has none. */
  levelIndex?: number;
};

/**
 * A Google-Calendar-style drill-down parent picker for the event draft. The
 * draft's parent page is chosen from horizontally-scrollable rows of "tags":
 *
 *   • A "Recent" row leads with the parents this device files events under most
 *     (see `@/lib/parentUsage`), so the page a run of events belongs under is
 *     one tap away instead of a drill from the top every time.
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
 * The rows are one keyboard widget rather than a run of tab stops: Tab moves in
 * and out of the picker as a whole, and the arrow keys move between tags. With
 * dozens of pages in a space, tabbing tag by tag would bury the rest of the
 * draft behind them.
 *
 * Drill state is intentionally local and ephemeral: the picker is mounted only
 * while a draft is open, so a fresh draft starts back at the top level. When it
 * mounts with a selection already made (e.g. picked via DraftParentSearch, or
 * pre-filled from the last used parent), the drill path opens to the selection's
 * ancestors so it appears selected in context.
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
  const { t } = useTranslation();
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
  const levels: (string | null)[] = useMemo(
    () => [null, ...drillPath.map((p) => p.id)],
    [drillPath],
  );

  // Whether the shortcut row is showing. Folding it away is a standing choice
  // about this device's picker, not one draft's, so it outlives the draft.
  const [recentOpen, setRecentOpen] = useState(
    () =>
      getRememberedChoice(REMEMBER_KEYS.recentParents, ["open", "closed"]) !==
      "closed",
  );
  const toggleRecent = useCallback(() => {
    setRecentOpen((open) => {
      rememberChoice(REMEMBER_KEYS.recentParents, open ? "closed" : "open");
      return !open;
    });
  }, []);

  // The tree folds the same way, for the opposite habit: someone who files from
  // the shortcuts (or from search) can put the whole drill-down away.
  const [treeOpen, setTreeOpen] = useState(
    () =>
      getRememberedChoice(REMEMBER_KEYS.parentTree, ["open", "closed"]) !==
      "closed",
  );
  const toggleTree = useCallback(() => {
    setTreeOpen((open) => {
      rememberChoice(REMEMBER_KEYS.parentTree, open ? "closed" : "open");
      return !open;
    });
  }, []);

  // The shortcut row is offered for a NEW page only. Re-parenting an existing
  // one must never offer a page inside its own subtree — that would cut the
  // subtree loose — and a stored shortcut carries no live ancestor chain to
  // prove it isn't one. The drill rows get that for free by hiding `excludeId`.
  const recents = useMemo(
    () => (excludeId ? [] : getRecentParents(spaceId, { limit: RECENT_LIMIT })),
    [spaceId, excludeId],
  );

  // One query per drill row, plus one per distinct shortcut parent: a shortcut
  // reads its live title, color and children out of its own parent's row, so a
  // renamed page shows its new name and a deleted one drops out by itself. The
  // keys match useGetPages, so rows the sidebar or a sibling picker already
  // loaded come from cache.
  const loadParents = useMemo(() => {
    const ids = [...levels];
    for (const r of recents)
      if (!ids.includes(r.parentId)) ids.push(r.parentId);
    return ids;
  }, [levels, recents]);

  const results = useQueries({
    queries: loadParents.map((parentId) => ({
      queryKey: ["pages", { spaceId, parentId, includeTasks: false }],
      queryFn: () => getPages(spaceId!, parentId),
      enabled: !!spaceId,
    })),
  });

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, IListPage[] | undefined>();
    loadParents.forEach((parentId, i) => map.set(parentId, results[i]?.data));
    return map;
  }, [loadParents, results]);

  // A shortcut whose page is gone frees its slot for a live one. Only act once
  // the row it would live in has actually loaded — an absent row means "not
  // known yet", not "deleted".
  useEffect(() => {
    if (!spaceId) return;
    for (const r of recents) {
      const siblings = childrenOf.get(r.parentId);
      if (siblings && !siblings.some((p) => p.id === r.id)) {
        forgetParent(spaceId, r.id);
      }
    }
  }, [spaceId, recents, childrenOf]);

  const recentTags: Tag[] = useMemo(() => {
    const tags: Tag[] = [];
    for (const r of recents) {
      const live = childrenOf.get(r.parentId)?.find((p) => p.id === r.id);
      if (live) tags.push({ page: live, recent: r });
    }
    return tags;
  }, [recents, childrenOf]);

  const allRows: TagRowModel[] = useMemo(() => {
    const built: TagRowModel[] = [];

    if (recentTags.length > 0) {
      built.push({
        key: "__recent__",
        recent: true,
        tags: recentTags,
        inheritedColor: null,
        openId: null,
      });
    }

    // Color inherited by each row's tags when they have no color of their own,
    // matching the sidebar: a page falls back to its nearest colored ancestor.
    // Row 0 (top level) has no ancestor, so it inherits nothing.
    let inherited: string | null = null;
    levels.forEach((parentId, i) => {
      const rowInherited = inherited;
      const opened = drillPath[i];
      if (opened) inherited = opened.color ?? inherited;
      const pages = childrenOf.get(parentId);
      const visible = excludeId
        ? pages?.filter((p) => p.id !== excludeId)
        : pages;
      if (!visible || visible.length === 0) return;
      built.push({
        key: parentId ?? "__root__",
        recent: false,
        tags: visible.map((page) => ({ page })),
        inheritedColor: i === 0 ? null : rowInherited,
        openId: drillPath[i]?.id ?? null,
        levelIndex: i,
      });
    });

    return built;
  }, [recentTags, childrenOf, levels, drillPath, excludeId]);

  const treeRows = useMemo(() => allRows.filter((r) => !r.recent), [allRows]);

  // What is actually on screen — and so what the arrow keys move through. A
  // folded section keeps its rows out of the grid rather than stepping the
  // cursor through tags nobody can see.
  const rows: TagRowModel[] = useMemo(() => {
    const shown = allRows.filter((r) => (r.recent ? recentOpen : treeOpen));
    // Folding away every section must not fold away the answer: an event filed
    // under a page the draft never showed is the one thing this picker owes the
    // user. The chosen parent stays on screen as a row of its own — tapping it
    // clears the choice, exactly as tapping it anywhere else would.
    if (
      value &&
      !shown.some((r) => r.tags.some((t) => t.page.id === value.id))
    ) {
      shown.push({
        key: "__selection__",
        recent: false,
        tags: [
          {
            page: {
              id: value.id,
              title: value.title ?? "",
              titleMd: value.titleMd ?? undefined,
              parentId: value.parentId,
              order: 0,
              // Unknown, and moot: a lone selection is nothing to drill from.
              hasChildren: false,
              spaceId: value.spaceId,
              color: value.color,
            },
          },
        ],
        inheritedColor:
          [...(value.path ?? [])].reverse().find((p) => p.color)?.color ?? null,
        openId: null,
      });
    }
    return shown;
  }, [allRows, recentOpen, treeOpen, value]);

  // ── Roving focus ──
  //
  // One tab stop for the whole picker; the arrows move between tags. The stop
  // sits on the chosen parent when there is one, so tabbing in lands on the
  // answer rather than at the far left of a long row.
  const [cursor, setCursor] = useState<{ row: number; col: number } | null>(
    null,
  );
  // Set only while a key is moving the cursor, so pointer and Tab focus update
  // the roving index without the effect yanking focus back.
  const keyNavRef = useRef(false);
  const recentRowId = useId();
  const treeGroupId = useId();
  const buttonsRef = useRef(new Map<string, HTMLButtonElement | null>());

  const selectedPos = useMemo(() => {
    if (!value) return null;
    for (let row = 0; row < rows.length; row++) {
      const col = rows[row]!.tags.findIndex((tag) => tag.page.id === value.id);
      if (col >= 0) return { row, col };
    }
    return null;
  }, [rows, value]);

  // Rows come and go as branches open and close, so a stored cursor is clamped
  // back onto a tag that exists rather than trusted.
  const raw = cursor ?? selectedPos ?? { row: 0, col: 0 };
  const row = Math.min(raw.row, Math.max(0, rows.length - 1));
  const col = Math.min(raw.col, Math.max(0, (rows[row]?.tags.length ?? 1) - 1));

  useEffect(() => {
    if (!keyNavRef.current) return;
    keyNavRef.current = false;
    const el = buttonsRef.current.get(`${row}:${col}`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [row, col]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const rowTags = rows[row]?.tags.length ?? 0;
      if (rowTags === 0) return;
      // Rows read start-to-end, so "next" follows the writing direction.
      const forward = i18next.dir() === "rtl" ? "ArrowLeft" : "ArrowRight";
      const back = forward === "ArrowRight" ? "ArrowLeft" : "ArrowRight";

      let next: { row: number; col: number } | null = null;
      if (e.key === forward) {
        next = { row, col: Math.min(col + 1, rowTags - 1) };
      } else if (e.key === back) {
        next = { row, col: Math.max(col - 1, 0) };
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const nextRow = Math.min(
          Math.max(row + (e.key === "ArrowDown" ? 1 : -1), 0),
          rows.length - 1,
        );
        next = {
          row: nextRow,
          col: Math.min(col, (rows[nextRow]?.tags.length ?? 1) - 1),
        };
      } else if (e.key === "Home") {
        next = { row, col: 0 };
      } else if (e.key === "End") {
        next = { row, col: rowTags - 1 };
      }
      if (!next) return;

      e.preventDefault();
      keyNavRef.current = true;
      setCursor(next);
    },
    [rows, row, col],
  );

  // A selection can also arrive from outside the rows: a new draft opens
  // pre-tagged with the last parent it was filed under, with the picker already
  // mounted, so it cannot reopen the branch by remounting the way a search pick
  // does. When the chosen page's own row isn't open, reopen the path down to it
  // — a parent lit nowhere reads as no parent at all, and the shortcut row it
  // would otherwise show in can be folded away.
  const valueId = value?.id;
  const valueParentId = value?.parentId ?? null;
  const valuePath = value?.path;
  // Before paint, so a pre-filled parent is never briefly stranded in the lone
  // selection row on its way to being lit in the tree.
  useLayoutEffect(() => {
    if (!valueId || levels.includes(valueParentId)) return;
    const next = (valuePath ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      titleMd: p.titleMd,
      color: p.color,
    }));
    setDrillPath((prev) =>
      prev.length === next.length && prev.every((p, i) => p.id === next[i]!.id)
        ? // An ancestor chain that doesn't lead to the page (a stale stored
          // path) would otherwise re-run this forever.
          prev
        : next,
    );
  }, [valueId, valueParentId, valuePath, levels]);

  // ── Picking ──

  const select = (page: IListPage, ancestors: DrillEntry[]) => {
    // Select it, and — if it has sub-pages — open them as the next row so a
    // deeper choice stays one tap away without losing this one.
    setDrillPath(
      page.hasChildren
        ? [
            ...ancestors,
            {
              id: page.id,
              title: page.title,
              titleMd: page.titleMd,
              color: page.color,
            },
          ]
        : ancestors,
    );
    onChange({
      id: page.id,
      title: page.title,
      titleMd: page.titleMd,
      parentId: page.parentId,
      spaceId: page.spaceId ?? null,
      color: page.color ?? null,
      path: ancestors.map((p) => ({
        id: p.id,
        title: p.title,
        titleMd: p.titleMd,
        color: p.color,
      })),
    });
  };

  const pick = (rowModel: TagRowModel, tag: Tag) => {
    // Tapping the current choice again undoes it: no parent, and the branch it
    // opened collapses with it.
    if (value?.id === tag.page.id) {
      setDrillPath(
        rowModel.levelIndex === undefined
          ? []
          : drillPath.slice(0, rowModel.levelIndex),
      );
      onChange(null);
      return;
    }
    if (rowModel.levelIndex !== undefined) {
      // Anything drilled BELOW this level is replaced by this new choice.
      select(tag.page, drillPath.slice(0, rowModel.levelIndex));
      return;
    }
    // A shortcut jumps straight to a page that may sit deep in the tree, so it
    // brings the whole branch with it: the rows reopen down the page's ancestor
    // chain, leaving it selected in context rather than out of nowhere.
    select(
      tag.page,
      (tag.recent?.path ?? []).map((p) => ({
        id: p.id,
        title: p.title,
        titleMd: p.titleMd,
        color: p.color,
      })),
    );
  };

  // Both sections are disclosures over the same question, so each row is drawn
  // the same way wherever it sits; `rowIndex` is its place in the visible grid,
  // which is what the arrow keys move through.
  const renderRow = (rowModel: TagRowModel, rowIndex: number) => (
    <div
      key={rowModel.key}
      id={rowModel.recent ? recentRowId : undefined}
      className={cn(
        style.draftTagRow,
        !rowModel.recent &&
          rowModel.levelIndex !== undefined &&
          rowModel.levelIndex !== 0 &&
          style.draftTagRowNested,
      )}
    >
      {rowModel.tags.map((tag, colIndex) => {
        const page = tag.page;
        const isSelected = page.id === value?.id;
        const isOpen = page.id === rowModel.openId;
        const inherited = tag.recent
          ? ([...tag.recent.path].reverse().find((p) => p.color)?.color ?? null)
          : rowModel.inheritedColor;
        const resolvedColor = page.color ?? inherited;
        const key = `${rowIndex}:${colIndex}`;
        return (
          <button
            key={page.id}
            ref={(el) => {
              buttonsRef.current.set(key, el);
            }}
            type="button"
            tabIndex={rowIndex === row && colIndex === col ? 0 : -1}
            aria-pressed={isSelected}
            className={cn(
              style.draftTag,
              isSelected && style.draftTagSelected,
              isOpen && style.draftTagOpen,
            )}
            onFocus={() => setCursor({ row: rowIndex, col: colIndex })}
            onClick={() => pick(rowModel, tag)}
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
            {!rowModel.recent && page.hasChildren && (
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

  return (
    <div
      className={style.draftTagLevels}
      role="group"
      aria-label={t("calendar.parentPage", "Parent page")}
      onKeyDown={handleKeyDown}
    >
      {recentTags.length > 0 && (
        <button
          type="button"
          className={style.draftTagRowLabel}
          aria-expanded={recentOpen}
          // Only while the row it names is actually in the tree.
          aria-controls={recentOpen ? recentRowId : undefined}
          onClick={toggleRecent}
        >
          <History size={11} aria-hidden />
          {t("common.recent", "Recent")}
          <ChevronRight
            size={12}
            className={cn(
              style.draftTagChevron,
              recentOpen && style.draftTagChevronOpen,
            )}
          />
        </button>
      )}
      {rows
        .filter((r) => r.recent)
        .map((rowModel) => renderRow(rowModel, rows.indexOf(rowModel)))}

      {treeRows.length > 0 && (
        <button
          type="button"
          className={cn(
            style.draftTagRowLabel,
            // Only needs the gap when there is something above to part from.
            recentTags.length > 0 && style.draftTagRowLabelParted,
          )}
          aria-expanded={treeOpen}
          aria-controls={treeOpen ? treeGroupId : undefined}
          onClick={toggleTree}
        >
          <FileText size={11} aria-hidden />
          {t("page.pages", "Pages")}
          <ChevronRight
            size={12}
            className={cn(
              style.draftTagChevron,
              treeOpen && style.draftTagChevronOpen,
            )}
          />
        </button>
      )}
      {treeOpen && (
        <div id={treeGroupId} className={style.draftTagLevelGroup}>
          {rows
            .filter((r) => !r.recent && r.key !== "__selection__")
            .map((rowModel) => renderRow(rowModel, rows.indexOf(rowModel)))}
        </div>
      )}

      {/* The chosen parent, when neither section is showing it. */}
      {rows
        .filter((r) => r.key === "__selection__")
        .map((rowModel) => renderRow(rowModel, rows.indexOf(rowModel)))}
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
