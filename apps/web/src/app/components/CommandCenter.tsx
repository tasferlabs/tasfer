import { Command } from "cmdk";
import {
  Calendar,
  Moon,
  Plus,
  Settings,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  useCreatePage,
  useSearchPages,
} from "../api/pages.api";
import { useSpaces } from "../contexts/SpaceContext";
import { useTheme } from "../hooks/useTheme";
import { useQueryClient } from "@tanstack/react-query";

const groupHeadingClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/70 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide";

const itemClass =
  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm cursor-pointer select-none data-[selected=true]:bg-accent";

const iconBoxClass =
  "flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-muted/60 text-muted-foreground";

export function CommandCenter() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { activeSpaceId } = useSpaces();
  const { setTheme, effectiveTheme } = useTheme();
  const queryClient = useQueryClient();

  const { data: pages } = useSearchPages(
    open ? activeSpaceId : null,
    search
  );

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

  const runAction = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label={t("Command Center")}
      overlayClassName="fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
      contentClassName="fixed top-[20%] left-1/2 z-50 w-full max-w-[560px] -translate-x-1/2 bg-background ring-foreground/10 rounded-xl ring-1 shadow-lg overflow-hidden outline-none"
      shouldFilter={false}
    >
      <Command.Input
        value={search}
        onValueChange={setSearch}
        placeholder={t("Search pages, actions...")}
        className="h-12 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-[340px] overflow-y-auto p-2">
        <Command.Empty className="py-8 text-center text-sm text-muted-foreground">
          {t("No results found")}
        </Command.Empty>

        {/* Pages */}
        {pages && pages.length > 0 && (
          <Command.Group heading={t("Pages")} className={groupHeadingClass}>
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
                    backgroundColor: page.color || "var(--primary)",
                    opacity: page.color ? 1 : 0.3,
                  }}
                />
                <div className="flex-1 min-w-0">
                  <div className="truncate">
                    {page.title || t("Untitled")}
                  </div>
                  {page.path && page.path.length > 0 && (
                    <div className="text-xs text-muted-foreground truncate">
                      {page.path
                        .map((p) => p.title || t("Untitled"))
                        .join(" / ")}
                    </div>
                  )}
                </div>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {/* Actions */}
        <Command.Group heading={t("Actions")} className={groupHeadingClass}>
          <Command.Item
            value="new-page"
            keywords={["create", t("create"), "new", t("new"), "page", t("page"), "add", t("add")]}
            onSelect={() =>
              runAction(() => {
                if (activeSpaceId) {
                  createPage.mutate({
                    title: "",
                    parentId: null,
                    spaceId: activeSpaceId,
                  });
                }
              })
            }
            className={itemClass}
          >
            <div className={iconBoxClass}>
              <Plus size={16} />
            </div>
            <span>{t("New Page")}</span>
          </Command.Item>

          <Command.Item
            value="calendar"
            keywords={["calendar", t("calendar"), "schedule", t("schedule"), "events", t("events")]}
            onSelect={() => runAction(() => navigate("/calendar"))}
            className={itemClass}
          >
            <div className={iconBoxClass}>
              <Calendar size={16} />
            </div>
            <span>{t("Go to Calendar")}</span>
          </Command.Item>

          <Command.Item
            value="settings"
            keywords={["settings", t("settings"), "preferences", t("preferences"), "account", t("account")]}
            onSelect={() => runAction(() => navigate("/settings"))}
            className={itemClass}
          >
            <div className={iconBoxClass}>
              <Settings size={16} />
            </div>
            <span>{t("Go to Settings")}</span>
          </Command.Item>

          <Command.Item
            value="toggle-theme"
            keywords={["theme", t("theme"), "dark", t("dark"), "light", t("light"), "mode", t("mode"), "appearance", t("appearance")]}
            onSelect={() =>
              runAction(() =>
                setTheme(effectiveTheme === "dark" ? "light" : "dark")
              )
            }
            className={itemClass}
          >
            <div className={iconBoxClass}>
              {effectiveTheme === "dark" ? (
                <Sun size={16} />
              ) : (
                <Moon size={16} />
              )}
            </div>
            <span>
              {effectiveTheme === "dark"
                ? t("Switch to Light Mode")
                : t("Switch to Dark Mode")}
            </span>
          </Command.Item>
        </Command.Group>
      </Command.List>

      {/* Footer */}
      <div className="border-t border-border px-4 py-2 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px]">
            ↑↓
          </kbd>
          {t("navigate")}
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px]">
            ↵
          </kbd>
          {t("select")}
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px]">
            esc
          </kbd>
          {t("close")}
        </span>
      </div>
    </Command.Dialog>
  );
}
