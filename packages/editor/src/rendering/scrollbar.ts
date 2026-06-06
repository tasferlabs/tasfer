import { getDefaultDirection } from "../rtl";
import type {
  EditorState,
  SearchHighlight,
  ViewportState,
} from "../state-types";
import { getEditorStyles } from "../styles";
import {
  awarenessCursorToPosition,
  type AwarenessState,
} from "../sync/awareness";
import { getBlockHeight } from "./renderer";

export interface ScrollbarState {
  readonly isDragging: boolean;
  readonly thumbPosition: number; // 0 to 1
  readonly thumbSize: number; // 0 to 1
  readonly isVisible: boolean;
  readonly isHovered: boolean;
  readonly fadeOpacity: number; // 0 to 1
  readonly lastInteraction: number;
  readonly dragStartOffset: number; // Offset from thumb top to mouse Y when drag started
}

export interface ScrollbarStyles {
  readonly width: number;
  readonly minThumbHeight: number;
  readonly padding: number;
  readonly thumbColor: string;
  readonly thumbHoverColor: string;
  readonly thumbActiveColor: string;
  readonly trackColor: string;
  readonly borderRadius: number;
  readonly fadeDelay: number; // ms before starting to fade
  readonly fadeDuration: number; // ms to complete fade
  readonly touchTargetWidth: number; // Wider hit area for touch devices
}

// Detect if device has touch support
function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
}

// Get safe area inset bottom value
function getSafeAreaInsetBottom(): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return 0;
  }

  // Try to get from CSS custom property first (Android injects this)
  const cssVar = getComputedStyle(document.documentElement)
    .getPropertyValue("--safe-area-inset-bottom")
    .trim();

  if (cssVar) {
    const parsed = parseFloat(cssVar);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }

  // For iOS, we need to get the env() value via a computed style trick
  // Create a temporary element to measure the safe area
  const testEl = document.createElement("div");
  testEl.style.position = "fixed";
  testEl.style.bottom = "0";
  testEl.style.paddingBottom = "env(safe-area-inset-bottom, 0px)";
  testEl.style.visibility = "hidden";
  testEl.style.pointerEvents = "none";
  document.body.appendChild(testEl);

  const computedPadding = getComputedStyle(testEl).paddingBottom;
  const inset = parseFloat(computedPadding) || 0;

  document.body.removeChild(testEl);

  return inset;
}

// Cache the safe area inset value with window dimensions for invalidation
let cachedSafeAreaInsetBottom: number | null = null;
let cachedWindowWidth: number | null = null;
let cachedWindowHeight: number | null = null;

// Track keyboard state - when keyboard is open, don't apply safe area inset
let isKeyboardOpen = false;

export function setKeyboardOpen(open: boolean): void {
  isKeyboardOpen = open;
}

export function getSafeAreaBottom(): number {
  // Don't apply safe area when keyboard is open (keyboard covers the home indicator area)
  if (isKeyboardOpen) {
    return 0;
  }

  if (typeof window === "undefined") {
    return 0;
  }

  // Invalidate cache if window dimensions changed (orientation change)
  if (
    cachedSafeAreaInsetBottom === null ||
    cachedWindowWidth !== window.innerWidth ||
    cachedWindowHeight !== window.innerHeight
  ) {
    cachedSafeAreaInsetBottom = getSafeAreaInsetBottom();
    cachedWindowWidth = window.innerWidth;
    cachedWindowHeight = window.innerHeight;
  }
  return cachedSafeAreaInsetBottom;
}

// Allow updating the cached value (call on orientation change)
export function updateSafeAreaCache(): void {
  cachedSafeAreaInsetBottom = null;
  cachedWindowWidth = null;
  cachedWindowHeight = null;
}

/**
 * Get CSS custom property value from the document root
 */
function getCSSVariable(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallback;
  }

  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();

  return value || fallback;
}

/**
 * Get scrollbar styles from CSS variables
 */
export function getScrollbarStyles(): ScrollbarStyles {
  return {
    width: isTouchDevice() ? 8 : 12,
    minThumbHeight: 40,
    padding: 4,
    thumbColor: getCSSVariable(
      "--editor-scrollbar-thumb",
      "rgba(128, 128, 128, 0.5)",
    ),
    thumbHoverColor: getCSSVariable(
      "--editor-scrollbar-thumb-hover",
      "rgba(128, 128, 128, 0.7)",
    ),
    thumbActiveColor: getCSSVariable(
      "--editor-scrollbar-thumb-active",
      "rgba(128, 128, 128, 0.9)",
    ),
    trackColor: getCSSVariable(
      "--editor-scrollbar-track",
      "rgba(0, 0, 0, 0.05)",
    ),
    borderRadius: 6,
    fadeDelay: 1000,
    fadeDuration: 300,
    touchTargetWidth: 32, // Wider hit area for touch devices (invisible)
  };
}

// Export default for backwards compatibility
export const defaultScrollbarStyles: ScrollbarStyles = getScrollbarStyles();

export function createInitialScrollbarState(): ScrollbarState {
  return {
    isDragging: false,
    thumbPosition: 0,
    thumbSize: 1,
    isVisible: false,
    isHovered: false,
    fadeOpacity: 0,
    lastInteraction: 0,
    dragStartOffset: 0,
  };
}

export interface ScrollbarBounds {
  readonly trackX: number;
  readonly trackY: number;
  readonly trackWidth: number;
  readonly trackHeight: number;
  readonly thumbX: number;
  readonly thumbY: number;
  readonly thumbWidth: number;
  readonly thumbHeight: number;
}

export function calculateScrollbarBounds(
  viewport: ViewportState,
  documentHeight: number,
  _state: ScrollbarState,
  styles: ScrollbarStyles = getScrollbarStyles(),
): ScrollbarBounds {
  const trackWidth = styles.width;
  const safeAreaBottom = getSafeAreaBottom();
  const trackHeight = viewport.height - styles.padding * 2 - safeAreaBottom;
  const trackX =
    getDefaultDirection() === "rtl"
      ? styles.padding
      : viewport.width - trackWidth - styles.padding;
  const trackY = styles.padding;

  // Calculate thumb size based on viewport/document ratio
  const viewportRatio = viewport.height / documentHeight;
  const thumbHeight = Math.max(
    styles.minThumbHeight,
    trackHeight * viewportRatio,
  );

  // Calculate thumb position
  const maxScroll = documentHeight - viewport.height;
  const scrollRatio = maxScroll > 0 ? viewport.scrollY / maxScroll : 0;
  const maxThumbY = trackHeight - thumbHeight;
  const thumbY = trackY + maxThumbY * scrollRatio;

  const thumbX = trackX;
  const thumbWidth = trackWidth;

  return {
    trackX,
    trackY,
    trackWidth,
    trackHeight,
    thumbX,
    thumbY,
    thumbWidth,
    thumbHeight,
  };
}

export function renderScrollbar(
  ctx: CanvasRenderingContext2D,
  viewport: ViewportState,
  documentHeight: number,
  state: EditorState,
  remoteAwareness: Map<string, AwarenessState>,
  styles = getScrollbarStyles(),
): void {
  // Don't render if document fits in viewport
  if (documentHeight <= viewport.height) {
    return;
  }

  const scrollbarState = state.view.scrollbar;
  // Update fade opacity
  const timeSinceInteraction = Date.now() - scrollbarState.lastInteraction;
  let opacity = scrollbarState.fadeOpacity;

  if (scrollbarState.isDragging || scrollbarState.isHovered) {
    opacity = 1;
  } else if (timeSinceInteraction < styles.fadeDelay) {
    opacity = 1;
  } else if (timeSinceInteraction < styles.fadeDelay + styles.fadeDuration) {
    const fadeProgress =
      (timeSinceInteraction - styles.fadeDelay) / styles.fadeDuration;
    opacity = 1 - fadeProgress;
  } else {
    opacity = 0;
  }

  // Don't render if fully faded
  if (opacity <= 0) {
    return;
  }

  const bounds = calculateScrollbarBounds(
    viewport,
    documentHeight,
    scrollbarState,
    styles,
  );

  // iOS-style: Scale up when dragging (larger and more prominent)
  const scale = scrollbarState.isDragging && isTouchDevice() ? 1.5 : 1.0;
  const scaledWidth = bounds.thumbWidth * scale;
  const scaledTrackWidth = bounds.trackWidth * scale;
  const widthDiff = scaledWidth - bounds.thumbWidth;
  const trackWidthDiff = scaledTrackWidth - bounds.trackWidth;
  // Expand towards content: left in LTR, right in RTL (RTL scrollbar is on the left)
  const rtl = getDefaultDirection() === "rtl";
  const thumbX = rtl ? bounds.thumbX : bounds.thumbX - widthDiff;
  const trackX = rtl ? bounds.trackX : bounds.trackX - trackWidthDiff;

  ctx.save();
  ctx.globalAlpha = opacity;

  // Draw track (optional, subtle background) - scales with thumb when active
  ctx.fillStyle = styles.trackColor;
  ctx.beginPath();
  ctx.roundRect(
    trackX,
    bounds.trackY,
    scaledTrackWidth,
    bounds.trackHeight,
    styles.borderRadius,
  );
  ctx.fill();

  // Draw thumb
  let thumbColor = styles.thumbColor;
  if (scrollbarState.isDragging) {
    thumbColor = styles.thumbActiveColor;
  } else if (scrollbarState.isHovered) {
    thumbColor = styles.thumbHoverColor;
  }

  ctx.fillStyle = thumbColor;
  ctx.beginPath();
  ctx.roundRect(
    thumbX,
    bounds.thumbY,
    scaledWidth,
    bounds.thumbHeight,
    styles.borderRadius,
  );
  ctx.fill();

  ctx.restore();

  // Render peer markers on scrollbar
  if (remoteAwareness && remoteAwareness.size > 0) {
    const peerMarkers = calculatePeerMarkers(
      remoteAwareness,
      state,
      viewport,
      documentHeight,
    );
    renderScrollbarPeerMarkers(
      ctx,
      viewport,
      documentHeight,
      peerMarkers,
      styles,
      opacity,
      scale,
    );
  }

  // Render search match markers on scrollbar
  const { highlights: searchHighlights, activeIndex: activeSearchIndex } =
    state.ui.search;
  if (searchHighlights.length > 0) {
    renderScrollbarSearchMarkers(
      ctx,
      state,
      viewport,
      documentHeight,
      searchHighlights,
      activeSearchIndex,
      styles,
      scale,
    );
  }
}

export function isPointInScrollbar(
  x: number,
  y: number,
  viewport: ViewportState,
  documentHeight: number,
  styles: ScrollbarStyles = getScrollbarStyles(),
): boolean {
  if (documentHeight <= viewport.height) {
    return false;
  }

  // Visual scrollbar is always styles.width, but use wider hit area on touch devices
  const visualWidth = styles.width;
  const hitWidth = isTouchDevice()
    ? Math.max(visualWidth, styles.touchTargetWidth)
    : visualWidth;

  const rtl = getDefaultDirection() === "rtl";
  const trackY = styles.padding;
  const safeAreaBottom = getSafeAreaBottom();
  const trackHeight = viewport.height - styles.padding * 2 - safeAreaBottom;

  let hitLeft: number;
  let hitRight: number;

  if (rtl) {
    // Scrollbar on the left — extend hit area to the right (towards content)
    hitLeft = styles.padding;
    hitRight = styles.padding + hitWidth;
  } else {
    // Scrollbar on the right — extend hit area to the left (towards content)
    hitLeft = viewport.width - hitWidth - styles.padding;
    hitRight = viewport.width - styles.padding;
  }

  return (
    x >= hitLeft && x <= hitRight && y >= trackY && y <= trackY + trackHeight
  );
}

export function isPointInThumb(
  x: number,
  y: number,
  viewport: ViewportState,
  documentHeight: number,
  scrollbarState: ScrollbarState,
  styles: ScrollbarStyles = getScrollbarStyles(),
  buffer: number = 0,
): boolean {
  if (documentHeight <= viewport.height) {
    return false;
  }

  const bounds = calculateScrollbarBounds(
    viewport,
    documentHeight,
    scrollbarState,
    styles,
  );

  // Apply buffer to expand the hit area on all sides
  return (
    x >= bounds.thumbX - buffer &&
    x <= bounds.thumbX + bounds.thumbWidth + buffer &&
    y >= bounds.thumbY - buffer &&
    y <= bounds.thumbY + bounds.thumbHeight + buffer
  );
}

export function updateScrollbarHover(
  scrollbarState: ScrollbarState,
  isHovered: boolean,
): ScrollbarState {
  if (scrollbarState.isHovered === isHovered) {
    return scrollbarState;
  }

  return {
    ...scrollbarState,
    isHovered,
    lastInteraction: Date.now(),
  };
}

export function startScrollbarDrag(
  scrollbarState: ScrollbarState,
  mouseY: number,
  viewport: ViewportState,
  documentHeight: number,
  styles: ScrollbarStyles = getScrollbarStyles(),
): ScrollbarState {
  // Calculate current thumb position
  const bounds = calculateScrollbarBounds(
    viewport,
    documentHeight,
    scrollbarState,
    styles,
  );

  // Save the offset from the thumb's top to where the mouse clicked
  const dragStartOffset = mouseY - bounds.thumbY;

  return {
    ...scrollbarState,
    isDragging: true,
    lastInteraction: Date.now(),
    dragStartOffset,
  };
}

export function endScrollbarDrag(
  scrollbarState: ScrollbarState,
): ScrollbarState {
  return {
    ...scrollbarState,
    isDragging: false,
    lastInteraction: Date.now(),
    dragStartOffset: 0,
  };
}

export function updateScrollFromThumbDrag(
  mouseY: number,
  viewport: ViewportState,
  documentHeight: number,
  scrollbarState: ScrollbarState,
  styles: ScrollbarStyles = getScrollbarStyles(),
): number {
  const trackY = styles.padding;
  const safeAreaBottom = getSafeAreaBottom();
  const trackHeight = viewport.height - styles.padding * 2 - safeAreaBottom;

  // Calculate thumb size
  const viewportRatio = viewport.height / documentHeight;
  const thumbHeight = Math.max(
    styles.minThumbHeight,
    trackHeight * viewportRatio,
  );

  // Calculate max positions
  const maxThumbY = trackHeight - thumbHeight;
  const maxScroll = documentHeight - viewport.height;

  // Calculate where the thumb should be based on mouse, accounting for the drag offset
  // This prevents the thumb from "jumping" when you first click on it
  const relativeMouseY = mouseY - trackY - scrollbarState.dragStartOffset;
  const thumbYFromMouse = Math.max(0, Math.min(maxThumbY, relativeMouseY));

  // Calculate scroll position
  const scrollRatio = maxThumbY > 0 ? thumbYFromMouse / maxThumbY : 0;
  const newScrollY = Math.max(0, Math.min(maxScroll, scrollRatio * maxScroll));

  return newScrollY;
}

export function updateScrollFromTrackClick(
  mouseY: number,
  viewport: ViewportState,
  documentHeight: number,
  scrollbarState: ScrollbarState,
  styles: ScrollbarStyles = getScrollbarStyles(),
): number {
  const bounds = calculateScrollbarBounds(
    viewport,
    documentHeight,
    scrollbarState,
    styles,
  );

  const maxScroll = documentHeight - viewport.height;

  // Click above thumb - scroll up one page
  if (mouseY < bounds.thumbY) {
    return Math.max(0, viewport.scrollY - viewport.height);
  }
  // Click below thumb - scroll down one page
  else if (mouseY > bounds.thumbY + bounds.thumbHeight) {
    return Math.min(maxScroll, viewport.scrollY + viewport.height);
  }

  return viewport.scrollY;
}

export function updateScrollFromWheel(
  deltaY: number,
  viewport: ViewportState,
  documentHeight: number,
  scrollbarState: ScrollbarState,
): { scrollY: number; scrollbarState: ScrollbarState } {
  const maxScroll = documentHeight - viewport.height;
  const newScrollY = Math.max(
    0,
    Math.min(maxScroll, viewport.scrollY + deltaY),
  );

  return {
    scrollY: newScrollY,
    scrollbarState: {
      ...scrollbarState,
      lastInteraction: Date.now(),
    },
  };
}

export function updateScrollbarFadeOpacity(
  scrollbarState: ScrollbarState,
  styles: ScrollbarStyles = getScrollbarStyles(),
): ScrollbarState {
  const timeSinceInteraction = Date.now() - scrollbarState.lastInteraction;
  let opacity = scrollbarState.fadeOpacity;

  if (scrollbarState.isDragging || scrollbarState.isHovered) {
    opacity = 1;
  } else if (timeSinceInteraction < styles.fadeDelay) {
    opacity = 1;
  } else if (timeSinceInteraction < styles.fadeDelay + styles.fadeDuration) {
    const fadeProgress =
      (timeSinceInteraction - styles.fadeDelay) / styles.fadeDuration;
    opacity = 1 - fadeProgress;
  } else {
    opacity = 0;
  }

  if (opacity === scrollbarState.fadeOpacity) {
    return scrollbarState;
  }

  return {
    ...scrollbarState,
    fadeOpacity: opacity,
  };
}

// Peer position marker on scrollbar
export interface PeerMarker {
  color: string;
  ratio: number; // 0-1 position in document
}

export function renderScrollbarPeerMarkers(
  ctx: CanvasRenderingContext2D,
  viewport: ViewportState,
  documentHeight: number,
  markers: PeerMarker[],
  styles: ScrollbarStyles = getScrollbarStyles(),
  opacity: number = 1,
  scale: number = 1,
): void {
  if (documentHeight <= viewport.height || markers.length === 0) {
    return;
  }

  const trackWidth = styles.width * scale;
  const safeAreaBottom = getSafeAreaBottom();
  const trackHeight = viewport.height - styles.padding * 2 - safeAreaBottom;
  const trackWidthDiff = trackWidth - styles.width;
  const rtl = getDefaultDirection() === "rtl";
  const trackX = rtl
    ? styles.padding
    : viewport.width - styles.width - styles.padding - trackWidthDiff;
  const trackY = styles.padding;

  const markerHeight = 3;
  const markerWidth = trackWidth;

  ctx.save();
  ctx.globalAlpha = opacity;

  for (const marker of markers) {
    const y = trackY + marker.ratio * trackHeight - markerHeight / 2;

    ctx.fillStyle = marker.color;
    ctx.beginPath();
    ctx.roundRect(trackX, y, markerWidth, markerHeight, markerHeight / 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Render search match markers on the scrollbar track.
 */
function renderScrollbarSearchMarkers(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  viewport: ViewportState,
  documentHeight: number,
  highlights: readonly SearchHighlight[],
  activeIndex: number,
  styles: ScrollbarStyles = getScrollbarStyles(),
  scale: number = 1,
): void {
  if (documentHeight <= viewport.height || highlights.length === 0) {
    return;
  }

  const editorStyles = getEditorStyles(state);
  const maxWidth =
    viewport.width -
    (editorStyles.canvas.paddingLeft + editorStyles.canvas.paddingRight);

  // Build a map of blockIndex -> documentY for each unique block in highlights
  const blockYMap = new Map<number, number>();
  const visibleBlocks = state.view.visibleBlocks;

  let currentY = editorStyles.canvas.paddingTop;
  for (let i = 0; i < visibleBlocks.length; i++) {
    const block = visibleBlocks[i];
    blockYMap.set(block.originalIndex, currentY);
    currentY += getBlockHeight(
      state.blockViews,
      block,
      maxWidth,
      editorStyles,
      i === 0,
    );
  }

  const trackWidth = styles.width * scale;
  const safeAreaBottom = getSafeAreaBottom();
  const trackHeight = viewport.height - styles.padding * 2 - safeAreaBottom;
  const trackWidthDiff = trackWidth - styles.width;
  const rtl = getDefaultDirection() === "rtl";
  const trackX = rtl
    ? styles.padding
    : viewport.width - styles.width - styles.padding - trackWidthDiff;
  const trackY = styles.padding;

  const markerHeight = 2;
  const markerWidth = trackWidth;

  ctx.save();

  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    const blockDocY = blockYMap.get(h.blockIndex);
    if (blockDocY === undefined) continue;

    const ratio = Math.max(0, Math.min(1, blockDocY / documentHeight));
    const y = trackY + ratio * trackHeight - markerHeight / 2;

    const isActive = i === activeIndex;
    ctx.fillStyle = isActive
      ? "rgba(255, 150, 50, 0.95)"
      : "rgba(255, 200, 50, 0.8)";
    ctx.beginPath();
    ctx.roundRect(trackX, y, markerWidth, markerHeight, markerHeight / 2);
    ctx.fill();
  }

  ctx.restore();
}

// Momentum scrolling state
export interface MomentumState {
  velocity: number; // pixels per millisecond
  lastTime: number;
  isActive: boolean;
}

export function createInitialMomentumState(): MomentumState {
  return {
    velocity: 0,
    lastTime: Date.now(),
    isActive: false,
  };
}

// Apply momentum with friction
export function applyMomentum(
  scrollY: number,
  momentumState: MomentumState,
  documentHeight: number,
  viewportHeight: number,
): { scrollY: number; momentumState: MomentumState; isActive: boolean } {
  if (!momentumState.isActive || Math.abs(momentumState.velocity) < 0.01) {
    return {
      scrollY,
      momentumState: { ...momentumState, isActive: false, velocity: 0 },
      isActive: false,
    };
  }

  const currentTime = Date.now();
  const deltaTime = currentTime - momentumState.lastTime;

  // Apply velocity with friction (deceleration)
  const friction = 0.95; // Adjust for feel (0.9-0.98 typical range)
  const decayFactor = Math.pow(friction, deltaTime / 16); // Normalize to 60fps
  const newVelocity = momentumState.velocity * decayFactor;

  // Calculate new scroll position
  const maxScroll = documentHeight - viewportHeight;
  let newScrollY = scrollY + newVelocity * deltaTime;

  // Clamp to bounds - no rubber band
  newScrollY = Math.max(0, Math.min(maxScroll, newScrollY));

  // Stop momentum if we hit a boundary
  if (newScrollY === 0 || newScrollY === maxScroll) {
    return {
      scrollY: newScrollY,
      momentumState: { ...momentumState, isActive: false, velocity: 0 },
      isActive: false,
    };
  }

  return {
    scrollY: newScrollY,
    momentumState: {
      velocity: newVelocity,
      lastTime: currentTime,
      isActive: Math.abs(newVelocity) >= 0.01,
    },
    isActive: Math.abs(newVelocity) >= 0.01,
  };
}

/**
 * Calculate peer marker positions for the scrollbar.
 * Returns ratios (0-1) representing each peer's position in the document.
 */
function calculatePeerMarkers(
  remoteAwareness: Map<string, AwarenessState>,
  state: EditorState,
  viewport: ViewportState,
  documentHeight: number,
  styles = getEditorStyles(state),
): PeerMarker[] {
  const markers: PeerMarker[] = [];
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  for (const [_peerId, awareness] of remoteAwareness) {
    if (!awareness.cursor) continue;

    const position = awarenessCursorToPosition(
      awareness.cursor,
      state.document.page,
    );
    if (!position) continue;

    const block = state.document.page.blocks[position.blockIndex];
    if (!block || block.deleted) continue;

    // Calculate document Y position (cumulative height up to this block)
    let documentY = styles.canvas.paddingTop;
    const visibleBlocks = state.view.visibleBlocks;

    for (let i = 0; i < visibleBlocks.length; i++) {
      const visibleBlock = visibleBlocks[i];
      if (visibleBlock.originalIndex >= position.blockIndex) break;
      documentY += getBlockHeight(
        state.blockViews,
        visibleBlock,
        maxWidth,
        styles,
        i === 0,
      );
    }

    // Calculate ratio
    const ratio = Math.max(0, Math.min(1, documentY / documentHeight));
    markers.push({ color: awareness.user.color, ratio });
  }

  return markers;
}
