import { Menubar as MenubarPrimitive } from "radix-ui";
import { useTranslation } from "react-i18next";
import { Check, Minus, Square, X } from "lucide-react";
import { useDevToolsEnabled } from "@/lib/devTools";

const invoke = (channel: string) => (window as any).tasfer?.invoke(channel);

// Under a tiling window manager (i3, sway, …) minimize hides the window with no
// taskbar to restore it and maximize is meaningless, so the main process drops
// those native capabilities and signals us to omit the matching buttons.
const isTilingWm = (window as any).tasfer?.tilingWm === true;

export function ElectronMenuBar() {
  const { t } = useTranslation();
  // Mirrors the persisted setting; toggling routes through the main process,
  // which broadcasts the new value back into this flag.
  const devToolsEnabled = useDevToolsEnabled();

  return (
    <div className="flex items-center h-9 shrink-0 w-full bg-background border-b" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
      <MenubarPrimitive.Root className="flex items-center h-full text-xs text-muted-foreground px-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <Menu label={t("menu.file", "File")}>
          <Item label={t("menu.quit", "Quit")} shortcut="Ctrl+Q" onSelect={() => invoke("app:quit")} />
        </Menu>
        <Menu label={t("menu.view", "View")}>
          <Item label={t("menu.reload", "Reload")} shortcut="Ctrl+R" onSelect={() => invoke("app:reload")} />
          <Item label={t("menu.forceReload", "Force Reload")} shortcut="Ctrl+Shift+R" onSelect={() => invoke("app:force-reload")} />
          <Item label={t("menu.toggleDevTools", "Toggle Developer Tools")} shortcut="Ctrl+Shift+I" onSelect={() => invoke("app:toggle-devtools")} />
          <Item label={t("settings.devTools.title", "Tasfer Inspector")} checked={devToolsEnabled} onSelect={() => invoke("devtools:toggle")} />
          <Separator />
          <Item label={t("menu.resetZoom", "Reset Zoom")} shortcut="Ctrl+0" onSelect={() => invoke("app:reset-zoom")} />
          <Item label={t("menu.zoomIn", "Zoom In")} shortcut="Ctrl+=" onSelect={() => invoke("app:zoom-in")} />
          <Item label={t("menu.zoomOut", "Zoom Out")} shortcut="Ctrl+-" onSelect={() => invoke("app:zoom-out")} />
          <Separator />
          <Item label={t("menu.fullscreen", "Toggle Fullscreen")} shortcut="F11" onSelect={() => invoke("app:toggle-fullscreen")} />
        </Menu>
      </MenubarPrimitive.Root>

      {/* Window controls — replaces native titleBarOverlay */}
      <div className="flex items-center ms-auto h-full" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {!isTilingWm && (
          <button
            onClick={() => invoke("app:minimize")}
            className="inline-flex items-center justify-center h-full w-11 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Minus className="size-3.5" />
          </button>
        )}
        {!isTilingWm && (
          <button
            onClick={() => invoke("app:maximize")}
            className="inline-flex items-center justify-center h-full w-11 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Square className="size-3" />
          </button>
        )}
        <button
          onClick={() => invoke("app:close")}
          className="inline-flex items-center justify-center h-full w-11 text-muted-foreground hover:bg-destructive hover:text-white transition-colors"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function Menu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <MenubarPrimitive.Menu>
      <MenubarPrimitive.Trigger className="flex items-center px-2.5 py-1 rounded-sm cursor-default select-none outline-none hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground">
        {label}
      </MenubarPrimitive.Trigger>
      <MenubarPrimitive.Portal>
        <MenubarPrimitive.Content
          align="start"
          sideOffset={4}
          className="animate-in fade-in-0 zoom-in-95 z-50 min-w-[200px] rounded-md bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {children}
        </MenubarPrimitive.Content>
      </MenubarPrimitive.Portal>
    </MenubarPrimitive.Menu>
  );
}

function Item({ label, shortcut, checked, onSelect }: { label: string; shortcut?: string; checked?: boolean; onSelect: () => void }) {
  return (
    <MenubarPrimitive.Item
      className="flex items-center gap-4 rounded-sm px-2 py-1.5 text-sm cursor-default select-none outline-none focus:bg-accent focus:text-accent-foreground"
      onSelect={onSelect}
    >
      {checked !== undefined && (
        <Check className={`size-3.5 ${checked ? "opacity-100" : "opacity-0"}`} />
      )}
      <span className="flex-1">{label}</span>
      {shortcut && <span className="text-xs text-muted-foreground ms-auto">{shortcut}</span>}
    </MenubarPrimitive.Item>
  );
}

function Separator() {
  return <MenubarPrimitive.Separator className="bg-border -mx-1 my-1 h-px" />;
}
