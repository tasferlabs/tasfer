import type { ViewportState } from "./types";
import createEditor, { type Editor } from "./index";

export interface MountedEditor {
  readonly editor: Editor;
  /** Resolves once the document is loaded and the render loop has started. */
  readonly ready: Promise<void>;
  /** Container for React portals (e.g., slash command menu) */
  readonly portalContainer: HTMLDivElement;
  destroy: () => void;
}

function getDpr(): number {
  return typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
}

function measure(container: HTMLElement): { width: number; height: number } {
  const rect = container.getBoundingClientRect();
  return {
    width: Math.max(rect.width, 1),
    height: Math.max(rect.height, 1),
  };
}

function sizeCanvasToContainer(
  canvas: HTMLCanvasElement,
  container: HTMLElement
) {
  const { width, height } = measure(container);
  const dpr = getDpr();

  // CSS size (layout pixels)
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  // Backing store size (device pixels)
  canvas.width = Math.max(Math.floor(width * dpr), 1);
  canvas.height = Math.max(Math.floor(height * dpr), 1);

  return { width, height };
}

/**
 * Imperatively mounts the canvas editor into a container element.
 * React/Vue/etc can call this from lifecycle hooks; no framework state required.
 */
export function mountEditor(
  container: HTMLElement,
  opts: { path: string }
): MountedEditor {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.userSelect = "none";
  (canvas.style as unknown as { WebkitUserSelect?: string }).WebkitUserSelect =
    "none";
  (canvas.style as unknown as { MozUserSelect?: string }).MozUserSelect =
    "none";
  (canvas.style as unknown as { msUserSelect?: string }).msUserSelect = "none";
  canvas.setAttribute("draggable", "false");
  const preventSelectStart = (e: Event) => e.preventDefault();
  const preventDragStart = (e: Event) => e.preventDefault();
  canvas.addEventListener("selectstart", preventSelectStart);
  canvas.addEventListener("dragstart", preventDragStart);

  // Create a hidden input element for mobile keyboard support
  // Note: Mobile browsers require the input to receive the touch event to show keyboard
  const hiddenInput = document.createElement("input");
  hiddenInput.type = "text";
  hiddenInput.style.position = "absolute";
  hiddenInput.style.opacity = "0";
  hiddenInput.style.width = "100%";
  hiddenInput.style.height = "100%";
  hiddenInput.style.top = "0";
  hiddenInput.style.left = "0";
  hiddenInput.style.overflow = "hidden";
  hiddenInput.style.border = "none";
  hiddenInput.style.padding = "0";
  hiddenInput.style.margin = "0";
  hiddenInput.style.background = "transparent";
  hiddenInput.style.outline = "none";
  hiddenInput.style.zIndex = "1"; // Above canvas but below UI elements
  hiddenInput.style.pointerEvents = "none"; // Don't intercept touches - we'll focus programmatically
  hiddenInput.style.caretColor = "transparent"; // Hide caret
  hiddenInput.style.color = "transparent"; // Hide text
  hiddenInput.setAttribute("aria-hidden", "true");
  hiddenInput.setAttribute("tabindex", "0");
  hiddenInput.setAttribute("autocomplete", "off");
  hiddenInput.setAttribute("autocorrect", "off");
  hiddenInput.setAttribute("autocapitalize", "off");
  hiddenInput.setAttribute("spellcheck", "false");
  hiddenInput.setAttribute("inputmode", "text");

  // Ensure the canvas is the only scroll surface (container should not scroll)
  container.appendChild(canvas);
  container.appendChild(hiddenInput);

  // Create portal container for React components (like slash command menu)
  const portalContainer = document.createElement("div");
  portalContainer.style.position = "absolute";
  portalContainer.style.top = "0";
  portalContainer.style.left = "0";
  portalContainer.style.width = "100%";
  portalContainer.style.height = "100%";
  portalContainer.style.pointerEvents = "none"; // Allow clicks through except on menu
  portalContainer.style.zIndex = "1000";
  container.appendChild(portalContainer);

  const initial = sizeCanvasToContainer(canvas, container);
  const initialViewport: ViewportState = {
    width: initial.width,
    height: initial.height,
    scrollY: 0,
  };

  const editor = createEditor(canvas, initialViewport, hiddenInput);

  let destroyed = false;
  const resizeObserver = new ResizeObserver(() => {
    if (destroyed) return;
    const next = sizeCanvasToContainer(canvas, container);
    // IMPORTANT: do NOT pass scrollY here — preserve current scroll position.
    editor.updateViewport({ width: next.width, height: next.height });
  });
  resizeObserver.observe(container);

  const ready = editor.load(opts.path).then(() => {
    if (destroyed) return;
    // We don't need React state updates for document height here.
    editor.start(() => {});
  });

  // Handle click outside
  const handleDocumentClick = (e: MouseEvent | TouchEvent) => {
    const target = e.target as Node;
    if (!target) return;

    // If click is on container or hidden input, do nothing (editor handles it)
    if (container.contains(target) || hiddenInput.contains(target)) {
      return;
    }

    if (document.activeElement === hiddenInput) {
      return;
    }

    // Click outside: blur editor
    editor.setFocus(false);
  };

  // Handle hidden input focus/blur (mobile keyboard)
  const handleInputFocus = () => {
    editor.setFocus(true);
  };

  const handleInputBlur = () => {
    // On mobile, if keyboard is dismissed or focus lost, blur editor
    editor.setFocus(false);
  };

  document.addEventListener("mousedown", handleDocumentClick);
  document.addEventListener("touchstart", handleDocumentClick);
  hiddenInput.addEventListener("focus", handleInputFocus);
  hiddenInput.addEventListener("blur", handleInputBlur);

  const destroy = () => {
    destroyed = true;
    resizeObserver.disconnect();
    editor.destroy();

    document.removeEventListener("mousedown", handleDocumentClick);
    document.removeEventListener("touchstart", handleDocumentClick);
    hiddenInput.removeEventListener("focus", handleInputFocus);
    hiddenInput.removeEventListener("blur", handleInputBlur);
    canvas.removeEventListener("selectstart", preventSelectStart);
    canvas.removeEventListener("dragstart", preventDragStart);

    canvas.remove();
    hiddenInput.remove();
    portalContainer.remove();
  };

  return { editor, ready, destroy, portalContainer };
}
