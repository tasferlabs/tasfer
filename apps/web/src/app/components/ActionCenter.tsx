import { Command } from "cmdk";
import { AnimatePresence, motion } from "framer-motion";
import {
  Calendar,
  ChevronLeft,
  Moon,
  Plus,
  Settings,
  Sun,
  Trash2,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useCreatePage, useSearchPages, type ISearchPage } from "../api/pages.api";
import { TitlePreview } from "../TitlePreview";
import { useSpaces } from "../contexts/SpaceContext";
import { useTheme } from "../hooks/useTheme";
import { useQueryClient } from "@tanstack/react-query";
import useResponsive from "../hooks/useResponsive";
import {
  frecencyBoost,
  frecencyValue,
  scoreMatch,
  type FrecencyEntry,
} from "@/lib/actionRanking";

const groupHeadingClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/70 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide";

const itemClass =
  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm cursor-pointer select-none data-[selected=true]:bg-accent";

const mobileItemClass =
  "flex items-center gap-3 rounded-xl px-3 py-3 text-base cursor-pointer select-none data-[selected=true]:bg-accent active:bg-accent";

const iconBoxClass =
  "flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-muted/60 text-muted-foreground";

/** Most recent pages to surface when the palette opens with no query. */
const RECENT_LIMIT = 7;

/** localStorage key for per-item usage stats that drive frecency ranking. */
const FRECENCY_KEY = "tasfer:action-center:frecency";
type FrecencyStore = Record<string, FrecencyEntry>;

function loadFrecency(): FrecencyStore {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(FRECENCY_KEY)
        : null;
    return raw ? (JSON.parse(raw) as FrecencyStore) : {};
  } catch {
    return {};
  }
}

/** A quick-action row, defined as data so it can be ranked alongside pages. */
interface ActionItem {
  /** Stable id, also used as the cmdk value and frecency key. */
  id: string;
  label: string;
  keywords: string[];
  icon: ReactNode;
  run: () => void;
}

/** A page or action with its computed relevance score for the current query. */
type ScoredPage = { page: ISearchPage; id: string; score: number };
type ScoredAction = { action: ActionItem; id: string; score: number };

/**
 * Best text-match score for a page across its title and breadcrumb path, with a
 * body-match fallback. A page the engine returned always scores above zero so a
 * body-only hit is never silently dropped from the list.
 */
function scorePage(page: ISearchPage, query: string): number {
  let score = scoreMatch(page.title ?? "", query);
  if (page.path) {
    for (const seg of page.path) {
      score = Math.max(score, scoreMatch(seg.title, query) * 0.6);
    }
  }
  if (page.snippet) score = Math.max(score, 0.4);
  // The engine only returns pages that matched something; keep them visible.
  return Math.max(score, 0.15);
}

/** Best text-match score for an action across its label and keywords. */
function scoreAction(action: ActionItem, query: string): number {
  let score = scoreMatch(action.label, query);
  for (const kw of action.keywords) {
    score = Math.max(score, scoreMatch(kw, query) * 0.9);
  }
  return score;
}

/**
 * A body-match preview: the excerpt from the engine with each occurrence of the
 * query highlighted. Matching is case-insensitive and mirrors the engine's own
 * substring search, so the highlighted spans always line up with why the page
 * was returned.
 */
function MatchSnippet({ snippet, query }: { snippet: string; query: string }) {
  const q = query.trim();
  const parts: ReactNode[] = [];
  if (q) {
    const lower = snippet.toLowerCase();
    const lq = q.toLowerCase();
    let i = 0;
    let key = 0;
    while (i < snippet.length) {
      const idx = lower.indexOf(lq, i);
      if (idx < 0) {
        parts.push(snippet.slice(i));
        break;
      }
      if (idx > i) parts.push(snippet.slice(i, idx));
      parts.push(
        <mark
          key={key++}
          className="rounded-[2px] bg-primary/20 px-0.5 font-medium text-foreground"
        >
          {snippet.slice(idx, idx + q.length)}
        </mark>,
      );
      i = idx + q.length;
    }
  } else {
    parts.push(snippet);
  }
  return (
    <div className="mt-0.5 truncate text-xs text-muted-foreground">{parts}</div>
  );
}

export function ActionCenter() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { activeSpaceId } = useSpaces();
  const { setTheme, effectiveTheme } = useTheme();
  const queryClient = useQueryClient();
  const isMobile = useResponsive("(max-width: 768px)");

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Per-item usage stats. Loaded once and updated on each selection; drives the
  // frecency component of the ranking so frequently-used items float up.
  const [frecency, setFrecency] = useState<FrecencyStore>(loadFrecency);

  const { data: pages } = useSearchPages(open ? activeSpaceId : null, search);

  const createPage = useCreatePage({
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      navigate(`/page/${page.id}`);
    },
  });

  const bumpFrecency = useCallback((id: string) => {
    setFrecency((prev) => {
      const entry = prev[id];
      const next: FrecencyStore = {
        ...prev,
        [id]: { count: (entry?.count ?? 0) + 1, last: Date.now() },
      };
      try {
        localStorage.setItem(FRECENCY_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage failures (private mode, quota); ranking still works.
      }
      return next;
    });
  }, []);

  const runAction = useCallback(
    (id: string, fn: () => void) => {
      bumpFrecency(id);
      setOpen(false);
      fn();
    },
    [bumpFrecency],
  );

  const actions = useMemo<ActionItem[]>(
    () => [
      {
        id: "new-page",
        label: t("page.newPageTitle", "New Page"),
        keywords: [
          "create",
          t("common.createKw", "create"),
          "new",
          t("common.newKw", "new"),
          "page",
          t("common.pageKw", "page"),
          "add",
          t("common.add", "add"),
        ],
        icon: <Plus size={16} />,
        run: () => {
          if (activeSpaceId)
            createPage.mutate({
              title: "",
              parentId: null,
              spaceId: activeSpaceId,
            });
        },
      },
      {
        id: "calendar",
        label: t("nav.goToCalendar", "Go to Calendar"),
        keywords: [
          "calendar",
          t("calendar.calendarKw", "calendar"),
          "schedule",
          t("calendar.scheduleKw", "schedule"),
          "events",
          t("calendar.eventsKw", "events"),
        ],
        icon: <Calendar size={16} />,
        run: () => navigate("/calendar"),
      },
      {
        id: "bin",
        label: t("nav.goToBin", "Go to Bin"),
        keywords: [
          "bin",
          t("bin.binKw", "bin"),
          "trash",
          t("common.trashKw", "trash"),
          "archive",
          t("common.archiveKw", "archive"),
          "deleted",
          t("common.deletedKw", "deleted"),
        ],
        icon: <Trash2 size={16} />,
        run: () => navigate("/bin"),
      },
      {
        id: "settings",
        label: t("nav.goToSettings", "Go to Settings"),
        keywords: [
          "settings",
          t("settings.settingsKw", "settings"),
          "preferences",
          t("settings.preferencesKw", "preferences"),
          "account",
          t("common.account", "account"),
        ],
        icon: <Settings size={16} />,
        run: () => navigate("/settings"),
      },
      {
        id: "toggle-theme",
        label:
          effectiveTheme === "dark"
            ? t("settings.theme.switchToLight", "Switch to Light Mode")
            : t("settings.theme.switchToDark", "Switch to Dark Mode"),
        keywords: [
          "theme",
          t("settings.theme.themeKw", "theme"),
          "dark",
          t("settings.theme.darkKw", "dark"),
          "light",
          t("settings.theme.lightKw", "light"),
          "mode",
          t("settings.theme.modeKw", "mode"),
          "appearance",
          t("settings.appearanceKw", "appearance"),
        ],
        icon: effectiveTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />,
        run: () => setTheme(effectiveTheme === "dark" ? "light" : "dark"),
      },
    ],
    [t, effectiveTheme, activeSpaceId, createPage, navigate, setTheme],
  );

  // Rank pages and actions for the current query. With a query, every item is
  // scored by text match plus a frecency boost and merged into one ordered
  // list. With no query we split into "recent" pages and actions, each ordered
  // by frecency so the palette opens on what the user reaches for most.
  const { unified, recentPages, recentActions } = useMemo(() => {
    const q = search.trim();
    const hasQuery = q.length > 0;
    const now = Date.now();
    const boost = (id: string) => {
      const entry = frecency[id];
      return entry ? frecencyBoost(frecencyValue(entry, now)) : 0;
    };

    const scoredPages: ScoredPage[] = [];
    for (const page of pages ?? []) {
      const id = `page-${page.id}`;
      const base = scorePage(page, q);
      if (hasQuery && base <= 0) continue;
      scoredPages.push({ page, id, score: base + boost(id) });
    }

    const scoredActions: ScoredAction[] = [];
    for (const action of actions) {
      const base = scoreAction(action, q);
      if (hasQuery && base <= 0) continue;
      scoredActions.push({ action, id: action.id, score: base + boost(action.id) });
    }

    if (hasQuery) {
      const merged = [
        ...scoredPages.map((p) => ({ kind: "page" as const, ...p })),
        ...scoredActions.map((a) => ({ kind: "action" as const, ...a })),
      ].sort((a, b) => b.score - a.score);
      return { unified: merged, recentPages: [], recentActions: [] };
    }

    // Empty query: pages arrive in recency order from the engine; a stable sort
    // by frecency keeps that order as the tiebreaker.
    scoredPages.sort((a, b) => b.score - a.score);
    scoredActions.sort((a, b) => b.score - a.score);
    return {
      unified: [],
      recentPages: scoredPages.slice(0, RECENT_LIMIT),
      recentActions: scoredActions,
    };
  }, [search, pages, actions, frecency]);

  // Global keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        e.stopPropagation();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // Reset search when closing
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  // Reset scroll when search changes
  useEffect(() => {
    listRef.current?.scrollTo(0, 0);
  }, [search]);

  // Auto-focus input on mobile when opened
  useEffect(() => {
    if (open && isMobile) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, isMobile]);

  const renderPageItem = (page: ISearchPage, cls: string) => {
    // The body snippet only earns its space when it explains the match. If the
    // title already contains the query, the title is the visible reason and the
    // excerpt is redundant, so show the snippet for body-only matches.
    const q = search.trim().toLowerCase();
    const titleMatched =
      q.length > 0 && (page.title ?? "").toLowerCase().includes(q);
    return (
    <Command.Item
      key={`page-${page.id}`}
      value={`page-${page.id}`}
      onSelect={() =>
        runAction(`page-${page.id}`, () => navigate(`/page/${page.id}`))
      }
      className={cls}
    >
      <span
        className="shrink-0 inline-block w-3 h-3 rounded-full"
        style={{
          backgroundColor: (() => {
            const c =
              page.color ??
              (page.path &&
                [...page.path].reverse().find((p) => p.color)?.color);
            return c || "var(--page-color-default)";
          })(),
          opacity:
            page.color || (page.path && page.path.some((p) => p.color))
              ? 1
              : 0.3,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="truncate">
          <TitlePreview title={page.title} titleMd={page.titleMd} />
        </div>
        {page.path && page.path.length > 0 && (
          <div className="text-xs text-muted-foreground truncate">
            {page.path.map((p, i) => (
              <Fragment key={p.id}>
                {i > 0 && " / "}
                <TitlePreview
                  title={p.title}
                  titleMd={p.titleMd}
                  mathFontSize={12}
                />
              </Fragment>
            ))}
          </div>
        )}
        {page.snippet && !titleMatched && (
          <MatchSnippet snippet={page.snippet} query={search} />
        )}
      </div>
    </Command.Item>
    );
  };

  const renderActionItem = (action: ActionItem, cls: string) => (
    <Command.Item
      key={action.id}
      value={action.id}
      keywords={action.keywords}
      onSelect={() => runAction(action.id, action.run)}
      className={cls}
    >
      <div className={iconBoxClass}>{action.icon}</div>
      <span>{action.label}</span>
    </Command.Item>
  );

  const hasQuery = search.trim().length > 0;

  const renderList = (cls: string) => {
    if (hasQuery) {
      return (
        <Command.Group
          heading={t("common.results", "Results")}
          className={groupHeadingClass}
        >
          {unified.map((item) =>
            item.kind === "page"
              ? renderPageItem(item.page, cls)
              : renderActionItem(item.action, cls),
          )}
        </Command.Group>
      );
    }
    return (
      <>
        {recentPages.length > 0 && (
          <Command.Group
            heading={t("common.recent", "Recent")}
            className={groupHeadingClass}
          >
            {recentPages.map((p) => renderPageItem(p.page, cls))}
          </Command.Group>
        )}
        <Command.Group
          heading={t("common.actions", "Actions")}
          className={groupHeadingClass}
        >
          {recentActions.map((a) => renderActionItem(a.action, cls))}
        </Command.Group>
      </>
    );
  };

  if (isMobile) {
    return (
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8, pointerEvents: "none" }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="fixed inset-0 z-50 bg-background flex flex-col"
            style={{
              paddingTop:
                "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
              paddingBottom:
                "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
            }}
          >
            <Command shouldFilter={false} className="flex flex-col flex-1 min-h-0">
              <div className="flex items-center gap-2 px-2 shrink-0 h-12">
                <button
                  onClick={() => setOpen(false)}
                  className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-muted-foreground active:bg-accent"
                >
                  <ChevronLeft size={22} />
                </button>
                <Command.Input
                  ref={inputRef}
                  value={search}
                  onValueChange={setSearch}
                  placeholder={t(
                    "editor.searchPagesActions",
                    "Search pages, actions...",
                  )}
                  className="flex-1 h-10 bg-transparent text-base outline-none placeholder:text-muted-foreground"
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="shrink-0 px-3 h-9 text-sm text-muted-foreground active:text-foreground"
                  >
                    {t("common.cancel", "Cancel")}
                  </button>
                )}
              </div>
              <div className="border-b border-border" />
              <Command.List ref={listRef} className="flex-1 overflow-y-auto p-2">
                <Command.Empty className="py-12 text-center text-sm text-muted-foreground">
                  {t("common.noResultsFound", "No results found")}
                </Command.Empty>
                {renderList(mobileItemClass)}
              </Command.List>
            </Command>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label={t("editor.actionCenter", "Action Center")}
      overlayClassName="fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
      contentClassName="fixed top-[20%] left-1/2 z-50 w-full max-w-[560px] -translate-x-1/2 bg-background ring-foreground/10 rounded-xl ring-1 shadow-lg overflow-hidden outline-none"
      shouldFilter={false}
    >
      <Command.Input
        value={search}
        onValueChange={setSearch}
        placeholder={t("editor.searchPagesActions", "Search pages, actions...")}
        className="h-12 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List ref={listRef} className="max-h-[340px] overflow-y-auto p-2">
        <Command.Empty className="py-8 text-center text-sm text-muted-foreground">
          {t("common.noResultsFound", "No results found")}
        </Command.Empty>
        {renderList(itemClass)}
      </Command.List>

      {/* Footer */}
      <div className="border-t border-border px-4 py-2 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px]">
            ↑↓
          </kbd>
          {t("page.navigateKw", "navigate")}
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px]">
            ↵
          </kbd>
          {t("common.selectKw", "select")}
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px]">
            esc
          </kbd>
          {t("common.closeKw", "close")}
        </span>
      </div>
    </Command.Dialog>
  );
}
