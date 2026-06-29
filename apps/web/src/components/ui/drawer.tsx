import * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";

import { cn } from "@/lib/utils";
import useKeyboardInset from "@/app/hooks/useKeyboardInset";

// Input types that do NOT raise the soft keyboard, so focusing them should not
// expand the drawer.
const NON_KEYBOARD_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "image",
]);

/**
 * Whether focusing `node` raises the soft keyboard: a text-like `<input>`, a
 * `<textarea>`, or any contenteditable surface (which is how our editor takes
 * text input). Used to expand the drawer on focus, since keyboard-height
 * detection is unreliable on some platforms (e.g. iOS native posts no inset).
 */
function raisesKeyboard(node: EventTarget | null): boolean {
  const el = node as HTMLElement | null;
  if (!el || el.nodeType !== 1) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    return !NON_KEYBOARD_INPUT_TYPES.has((el as HTMLInputElement).type);
  }
  return el.isContentEditable === true;
}

function Drawer({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn(
        "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-black/10 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-50",
        className
      )}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  // Mobile bottom drawer geometry, driven by the live keyboard inset:
  //   • Keyboard closed — leave a gap above the drawer (a peek of background, so
  //     it reads as a tall sheet rather than a full-screen takeover).
  //   • Keyboard open — expand to the top edge and reserve the keyboard's height
  //     as bottom padding, so content (and footers) stay above it. A `fixed`
  //     drawer does not follow the visual viewport on iOS, hence the manual
  //     reservation. The inset is 0 on desktop and iOS native (its WebView
  //     resizes), where this collapses to the plain safe-area sheet.
  const keyboardInset = useKeyboardInset();
  const keyboardOpen = keyboardInset > 0;
  const safeTop = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";

  // Keyboard-height detection is unreliable on some platforms, so also expand
  // the moment a text input or the editor inside the drawer takes focus — the
  // keyboard is about to open and the field needs the room. `onFocus`/`onBlur`
  // bubble in React, so these fire for any focusable descendant.
  const [inputFocused, setInputFocused] = React.useState(false);
  const handleFocus = React.useCallback((event: React.FocusEvent) => {
    if (raisesKeyboard(event.target)) setInputFocused(true);
  }, []);
  const handleBlur = React.useCallback((event: React.FocusEvent) => {
    // Stay expanded if focus is moving to another text field (e.g. tabbing
    // between inputs); collapse once it leaves editable content.
    if (!raisesKeyboard(event.relatedTarget)) setInputFocused(false);
  }, []);

  // Expand (flush to the top) when the keyboard is open OR an input is focused.
  const expanded = keyboardOpen || inputFocused;
  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          // Bottom drawers are near-full-screen on mobile so content (and any
          // text input) still has room once the soft keyboard opens, matching
          // the command palette. The top offset (`--drawer-top`) leaves a peek
          // of background when the keyboard is closed and collapses to 0 when it
          // opens; height is `auto` so the top/bottom edges define it. At md+
          // they collapse back to a bottom sheet.
          "bg-background flex h-full flex-col text-sm data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:top-[var(--drawer-top,0px)] data-[vaul-drawer-direction=bottom]:h-auto data-[vaul-drawer-direction=bottom]:rounded-t-xl data-[vaul-drawer-direction=bottom]:border-t data-[vaul-drawer-direction=bottom]:md:top-auto data-[vaul-drawer-direction=bottom]:md:h-full data-[vaul-drawer-direction=bottom]:md:mt-24 data-[vaul-drawer-direction=bottom]:md:max-h-[90vh] data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=left]:rounded-r-xl data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=right]:rounded-l-xl data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[95vh] data-[vaul-drawer-direction=top]:rounded-b-xl data-[vaul-drawer-direction=top]:border-b data-[vaul-drawer-direction=left]:sm:max-w-sm data-[vaul-drawer-direction=right]:sm:max-w-sm group/drawer-content fixed z-50",
          className
        )}
        style={
          {
            // Top offset for the mobile bottom drawer (see `top-[var(--drawer-top)]`
            // above; the md+ sheet resets `top` to auto so this is ignored there).
            // Collapsed: notch + a peek. Expanded: flush to the top to reclaim it.
            "--drawer-top": expanded ? "0px" : `calc(${safeTop} + 2rem)`,
            // Clear the notch only when expanded flush to the top; otherwise the
            // top offset already sits below it.
            paddingTop: expanded ? safeTop : undefined,
            // While the keyboard is open, reserve its height so content stays
            // above it; otherwise fall back to the safe-area inset (home indicator).
            paddingBottom: keyboardOpen
              ? `${keyboardInset}px`
              : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
          } as React.CSSProperties
        }
        {...props}
        onFocus={handleFocus}
        onBlur={handleBlur}
      >
        <div className="bg-muted mx-auto mt-4 hidden h-1.5 w-[100px] shrink-0 rounded-full group-data-[vaul-drawer-direction=bottom]/drawer-content:block bg-muted mx-auto hidden shrink-0 group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />
        <div className="flex-1 overflow-y-auto flex flex-col">{children}</div>
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        "gap-0.5 p-4  group-data-[vaul-drawer-direction=top]/drawer-content:text-center md:gap-1.5 md:text-start flex flex-col",
        className
      )}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("gap-2 p-4 mt-auto flex flex-col", className)}
      {...props}
    />
  );
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-foreground font-medium", className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
