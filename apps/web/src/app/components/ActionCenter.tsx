import { Command } from "cmdk";
import { Calendar, ChevronLeft, Moon, Plus, Settings, Sun } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useCreatePage, useSearchPages } from "../api/pages.api";
import { useSpaces } from "../contexts/SpaceContext";
import { useTheme } from "../hooks/useTheme";
import { useQueryClient } from "@tanstack/react-query";
import useResponsive from "../hooks/useResponsive";

const groupHeadingClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/70 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide";

const itemClass =
  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm cursor-pointer select-none data-[selected=true]:bg-accent";

const mobileItemClass =
  "flex items-center gap-3 rounded-xl px-3 py-3 text-base cursor-pointer select-none data-[selected=true]:bg-accent active:bg-accent";

const iconBoxClass =
  "flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-muted/60 text-muted-foreground";

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
  const mobileContainerRef = useRef<HTMLDivElement>(null);

  // Keep mobile overlay mounted during close animation
  const [mobileVisible, setMobileVisible] = useState(false);
  const [mobileAnimating, setMobileAnimating] = useState(false);

  useEffect(() => {
    if (open && isMobile) {
      setMobileVisible(true);
      // Trigger enter animation on next frame
      requestAnimationFrame(() => requestAnimationFrame(() => setMobileAnimating(true)));
    } else if (!open && isMobile) {
      setMobileAnimating(false);
    }
  }, [open, isMobile]);

  const handleMobileTransitionEnd = useCallback(() => {
    if (!mobileAnimating) {
      setMobileVisible(false);
    }
  }, [mobileAnimating]);

  const { data: pages } = useSearchPages(open ? activeSpaceId : null, search);

  const createPage = useCreatePage({
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      navigate(`/page/${page.id}`);
    },
  });

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

  const runAction = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  if (isMobile) {
    if (!mobileVisible && !open) return null;

    return (
      <div
        ref={mobileContainerRef}
        onTransitionEnd={handleMobileTransitionEnd}
        className="fixed inset-0 z-50 bg-background flex flex-col"
        style={{
          paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
          paddingBottom: "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
          opacity: mobileAnimating ? 1 : 0,
          transform: mobileAnimating ? "translateY(0)" : "translateY(8px)",
          transition: "opacity 0.2s ease, transform 0.2s ease",
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
              placeholder={t("editor.searchPagesActions", "Search pages, actions...")}
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

            {pages && pages.length > 0 && (
              <Command.Group
                heading={t("page.pages", "Pages")}
                className={groupHeadingClass}
              >
                {pages.map((page) => (
                  <Command.Item
                    key={page.id}
                    value={`page-${page.id}`}
                    onSelect={() => runAction(() => navigate(`/page/${page.id}`))}
                    className={mobileItemClass}
                  >
                    <span
                      className="shrink-0 inline-block w-3 h-3 rounded-full"
                      style={{
                        backgroundColor: (() => {
                          const c =
                            page.color ??
                            (page.path &&
                              [...page.path].reverse().find((p) => p.color)?.color);
                          return c || "var(--primary)";
                        })(),
                        opacity:
                          page.color ||
                          (page.path && page.path.some((p) => p.color))
                            ? 1
                            : 0.3,
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">
                        {page.title || t("common.untitled", "Untitled")}
                      </div>
                      {page.path && page.path.length > 0 && (
                        <div className="text-xs text-muted-foreground truncate">
                          {page.path
                            .map((p) => p.title || t("common.untitled", "Untitled"))
                            .join(" / ")}
                        </div>
                      )}
                    </div>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group
              heading={t("common.actions", "Actions")}
              className={groupHeadingClass}
            >
              <Command.Item
                value="new-page"
                keywords={["create", t("common.createKw", "create"), "new", t("common.newKw", "new"), "page", t("common.pageKw", "page"), "add", t("common.add", "add")]}
                onSelect={() => runAction(() => { if (activeSpaceId) createPage.mutate({ title: "", parentId: null, spaceId: activeSpaceId }); })}
                className={mobileItemClass}
              >
                <div className={iconBoxClass}><Plus size={16} /></div>
                <span>{t("page.newPageTitle", "New Page")}</span>
              </Command.Item>

              <Command.Item
                value="calendar"
                keywords={["calendar", t("calendar.calendarKw", "calendar"), "schedule", t("calendar.scheduleKw", "schedule"), "events", t("calendar.eventsKw", "events")]}
                onSelect={() => runAction(() => navigate("/calendar"))}
                className={mobileItemClass}
              >
                <div className={iconBoxClass}><Calendar size={16} /></div>
                <span>{t("nav.goToCalendar", "Go to Calendar")}</span>
              </Command.Item>

              <Command.Item
                value="settings"
                keywords={["settings", t("settings.settingsKw", "settings"), "preferences", t("settings.preferencesKw", "preferences"), "account", t("common.account", "account")]}
                onSelect={() => runAction(() => navigate("/settings"))}
                className={mobileItemClass}
              >
                <div className={iconBoxClass}><Settings size={16} /></div>
                <span>{t("nav.goToSettings", "Go to Settings")}</span>
              </Command.Item>

              <Command.Item
                value="toggle-theme"
                keywords={["theme", t("settings.theme.themeKw", "theme"), "dark", t("settings.theme.darkKw", "dark"), "light", t("settings.theme.lightKw", "light"), "mode", t("settings.theme.modeKw", "mode"), "appearance", t("settings.appearanceKw", "appearance")]}
                onSelect={() => runAction(() => setTheme(effectiveTheme === "dark" ? "light" : "dark"))}
                className={mobileItemClass}
              >
                <div className={iconBoxClass}>{effectiveTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</div>
                <span>{effectiveTheme === "dark" ? t("settings.theme.switchToLight", "Switch to Light Mode") : t("settings.theme.switchToDark", "Switch to Dark Mode")}</span>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
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

        {pages && pages.length > 0 && (
          <Command.Group
            heading={t("page.pages", "Pages")}
            className={groupHeadingClass}
          >
            {pages.map((page) => (
              <Command.Item
                key={page.id}
                value={`page-${page.id}`}
                onSelect={() => runAction(() => navigate(`/page/${page.id}`))}
                className={itemClass}
              >
                <span
                  className="shrink-0 inline-block w-3 h-3 rounded-full"
                  style={{
                    backgroundColor: (() => {
                      const c =
                        page.color ??
                        (page.path &&
                          [...page.path].reverse().find((p) => p.color)?.color);
                      return c || "var(--primary)";
                    })(),
                    opacity:
                      page.color ||
                      (page.path && page.path.some((p) => p.color))
                        ? 1
                        : 0.3,
                  }}
                />
                <div className="flex-1 min-w-0">
                  <div className="truncate">
                    {page.title || t("common.untitled", "Untitled")}
                  </div>
                  {page.path && page.path.length > 0 && (
                    <div className="text-xs text-muted-foreground truncate">
                      {page.path
                        .map((p) => p.title || t("common.untitled", "Untitled"))
                        .join(" / ")}
                    </div>
                  )}
                </div>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        <Command.Group
          heading={t("common.actions", "Actions")}
          className={groupHeadingClass}
        >
          <Command.Item
            value="new-page"
            keywords={["create", t("common.createKw", "create"), "new", t("common.newKw", "new"), "page", t("common.pageKw", "page"), "add", t("common.add", "add")]}
            onSelect={() => runAction(() => { if (activeSpaceId) createPage.mutate({ title: "", parentId: null, spaceId: activeSpaceId }); })}
            className={itemClass}
          >
            <div className={iconBoxClass}><Plus size={16} /></div>
            <span>{t("page.newPageTitle", "New Page")}</span>
          </Command.Item>

          <Command.Item
            value="calendar"
            keywords={["calendar", t("calendar.calendarKw", "calendar"), "schedule", t("calendar.scheduleKw", "schedule"), "events", t("calendar.eventsKw", "events")]}
            onSelect={() => runAction(() => navigate("/calendar"))}
            className={itemClass}
          >
            <div className={iconBoxClass}><Calendar size={16} /></div>
            <span>{t("nav.goToCalendar", "Go to Calendar")}</span>
          </Command.Item>

          <Command.Item
            value="settings"
            keywords={["settings", t("settings.settingsKw", "settings"), "preferences", t("settings.preferencesKw", "preferences"), "account", t("common.account", "account")]}
            onSelect={() => runAction(() => navigate("/settings"))}
            className={itemClass}
          >
            <div className={iconBoxClass}><Settings size={16} /></div>
            <span>{t("nav.goToSettings", "Go to Settings")}</span>
          </Command.Item>

          <Command.Item
            value="toggle-theme"
            keywords={["theme", t("settings.theme.themeKw", "theme"), "dark", t("settings.theme.darkKw", "dark"), "light", t("settings.theme.lightKw", "light"), "mode", t("settings.theme.modeKw", "mode"), "appearance", t("settings.appearanceKw", "appearance")]}
            onSelect={() => runAction(() => setTheme(effectiveTheme === "dark" ? "light" : "dark"))}
            className={itemClass}
          >
            <div className={iconBoxClass}>{effectiveTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</div>
            <span>{effectiveTheme === "dark" ? t("settings.theme.switchToLight", "Switch to Light Mode") : t("settings.theme.switchToDark", "Switch to Dark Mode")}</span>
          </Command.Item>
        </Command.Group>
      </Command.List>

      {/* Footer */}
      <div className="border-t border-border px-4 py-2 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px]">↑↓</kbd>
          {t("page.navigateKw", "navigate")}
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px]">↵</kbd>
          {t("common.selectKw", "select")}
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px]">esc</kbd>
          {t("common.closeKw", "close")}
        </span>
      </div>
    </Command.Dialog>
  );
}
