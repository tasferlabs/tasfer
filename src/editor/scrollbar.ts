import type { ViewportState } from "./types";

export interface ScrollbarState {
  readonly isDragging: boolean;
  readonly thumbPosition: number; // 0 to 1
  readonly thumbSize: number; // 0 to 1
  readonly isVisible: boolean;
  readonly isHovered: boolean;
  readonly fadeOpacity: number; // 0 to 1
  readonly lastInteraction: number;
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
const isTouchDevice = (): boolean => {
  return (
    typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
};

export const defaultScrollbarStyles: ScrollbarStyles = {
  width: 12,
  minThumbHeight: 40,
  padding: 4,
  thumbColor: "rgba(128, 128, 128, 0.5)",
  thumbHoverColor: "rgba(128, 128, 128, 0.7)",
  thumbActiveColor: "rgba(128, 128, 128, 0.9)",
  trackColor: "rgba(0, 0, 0, 0.05)",
  borderRadius: 6,
  fadeDelay: 1000,
  fadeDuration: 300,
  touchTargetWidth: 44, // Wider hit area for touch devices (invisible)
};

export function createInitialScrollbarState(): ScrollbarState {
  return {
    isDragging: false,
    thumbPosition: 0,
    thumbSize: 1,
    isVisible: false,
    isHovered: false,
    fadeOpacity: 0,
    lastInteraction: 0,
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
  _scrollbarState: ScrollbarState,
  styles: ScrollbarStyles = defaultScrollbarStyles
): ScrollbarBounds {
  const trackWidth = styles.width;
  const trackHeight = viewport.height - styles.padding * 2;
  const trackX = viewport.width - trackWidth - styles.padding;
  const trackY = styles.padding;

  // Calculate thumb size based on viewport/document ratio
  const viewportRatio = viewport.height / documentHeight;
  const thumbHeight = Math.max(
    styles.minThumbHeight,
    trackHeight * viewportRatio
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
  scrollbarState: ScrollbarState,
  styles: ScrollbarStyles = defaultScrollbarStyles
): void {
  // Don't render if document fits in viewport
  if (documentHeight <= viewport.height) {
    return;
  }

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
    styles
  );

  ctx.save();
  ctx.globalAlpha = opacity;

  // Draw track (optional, subtle background)
  ctx.fillStyle = styles.trackColor;
  ctx.beginPath();
  ctx.roundRect(
    bounds.trackX,
    bounds.trackY,
    bounds.trackWidth,
    bounds.trackHeight,
    styles.borderRadius
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
    bounds.thumbX,
    bounds.thumbY,
    bounds.thumbWidth,
    bounds.thumbHeight,
    styles.borderRadius
  );
  ctx.fill();

  ctx.restore();
}

export function isPointInScrollbar(
  x: number,
  y: number,
  viewport: ViewportState,
  documentHeight: number,
  styles: ScrollbarStyles = defaultScrollbarStyles
): boolean {
  if (documentHeight <= viewport.height) {
    return false;
  }

  // Visual scrollbar is always styles.width, but use wider hit area on touch devices
  const visualWidth = styles.width;
  const hitWidth = isTouchDevice()
    ? Math.max(visualWidth, styles.touchTargetWidth)
    : visualWidth;

  // Position scrollbar visually at the edge
  const visualTrackX = viewport.width - visualWidth - styles.padding;
  // But extend hit area to the left (invisible)
  const hitTrackX = viewport.width - hitWidth - styles.padding;
  const trackY = styles.padding;
  const trackHeight = viewport.height - styles.padding * 2;

  return (
    x >= hitTrackX &&
    x <= visualTrackX + visualWidth &&
    y >= trackY &&
    y <= trackY + trackHeight
  );
}

export function isPointInThumb(
  x: number,
  y: number,
  viewport: ViewportState,
  documentHeight: number,
  scrollbarState: ScrollbarState,
  styles: ScrollbarStyles = defaultScrollbarStyles
): boolean {
  if (documentHeight <= viewport.height) {
    return false;
  }

  const bounds = calculateScrollbarBounds(
    viewport,
    documentHeight,
    scrollbarState,
    styles
  );

  return (
    x >= bounds.thumbX &&
    x <= bounds.thumbX + bounds.thumbWidth &&
    y >= bounds.thumbY &&
    y <= bounds.thumbY + bounds.thumbHeight
  );
}

export function updateScrollbarHover(
  scrollbarState: ScrollbarState,
  isHovered: boolean
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
  scrollbarState: ScrollbarState
): ScrollbarState {
  return {
    ...scrollbarState,
    isDragging: true,
    lastInteraction: Date.now(),
  };
}

export function endScrollbarDrag(
  scrollbarState: ScrollbarState
): ScrollbarState {
  return {
    ...scrollbarState,
    isDragging: false,
    lastInteraction: Date.now(),
  };
}

export function updateScrollFromThumbDrag(
  mouseY: number,
  viewport: ViewportState,
  documentHeight: number,
  _scrollbarState: ScrollbarState,
  styles: ScrollbarStyles = defaultScrollbarStyles
): number {
  const trackY = styles.padding;
  const trackHeight = viewport.height - styles.padding * 2;

  // Calculate thumb size
  const viewportRatio = viewport.height / documentHeight;
  const thumbHeight = Math.max(
    styles.minThumbHeight,
    trackHeight * viewportRatio
  );

  // Calculate max positions
  const maxThumbY = trackHeight - thumbHeight;
  const maxScroll = documentHeight - viewport.height;

  // Calculate where the thumb should be based on mouse
  const relativeMouseY = mouseY - trackY;
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
  styles: ScrollbarStyles = defaultScrollbarStyles
): number {
  const bounds = calculateScrollbarBounds(
    viewport,
    documentHeight,
    scrollbarState,
    styles
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
  scrollbarState: ScrollbarState
): { scrollY: number; scrollbarState: ScrollbarState } {
  const maxScroll = documentHeight - viewport.height;
  const newScrollY = Math.max(0, Math.min(maxScroll, viewport.scrollY + deltaY));

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
  styles: ScrollbarStyles = defaultScrollbarStyles
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
  viewportHeight: number
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

