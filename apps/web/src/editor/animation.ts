/**
 * Animation module for smooth cursor and selection transitions
 *
 * Provides smooth interpolation for cursor movement and selection changes
 * using easing functions for a polished user experience.
 */

// Easing function - ease out cubic for smooth deceleration
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// Easing function - ease out quint for even smoother feel
export function easeOutQuint(t: number): number {
  return 1 - Math.pow(1 - t, 5);
}

// Animation configuration
export interface AnimationConfig {
  /** Duration of cursor animation in milliseconds */
  cursorDuration: number;
  /** Duration of selection animation in milliseconds */
  selectionDuration: number;
  /** Threshold below which we snap to target (avoids infinite small movements) */
  snapThreshold: number;
}

export const defaultAnimationConfig: AnimationConfig = {
  cursorDuration: 80, // Fast but smooth
  selectionDuration: 60, // Slightly faster for selection
  snapThreshold: 0.5, // Snap when within 0.5 pixels
};

// Animated cursor position state
export interface AnimatedCursorPosition {
  x: number;
  y: number;
  height: number;
  // Target values (where cursor should end up)
  targetX: number;
  targetY: number;
  targetHeight: number;
  // Animation timing
  animationStart: number;
  isAnimating: boolean;
  // Previous values for interpolation
  startX: number;
  startY: number;
  startHeight: number;
}

// Animated selection rectangle
export interface AnimatedSelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
  // Target values
  targetX: number;
  targetY: number;
  targetWidth: number;
  targetHeight: number;
  // Animation timing
  animationStart: number;
  isAnimating: boolean;
  // Previous values
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

// Module-level animation state (singleton pattern for canvas rendering)
let animatedCursor: AnimatedCursorPosition | null = null;
let animatedSelectionRects: AnimatedSelectionRect[] = [];
let animationConfig = defaultAnimationConfig;

/**
 * Set animation configuration
 */
export function setAnimationConfig(config: Partial<AnimationConfig>): void {
  animationConfig = { ...animationConfig, ...config };
}

/**
 * Get current animation configuration
 */
export function getAnimationConfig(): AnimationConfig {
  return animationConfig;
}

/**
 * Linear interpolation
 */
function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

/**
 * Update cursor target position and start animation if needed
 */
export function updateCursorTarget(
  targetX: number,
  targetY: number,
  targetHeight: number
): void {
  const now = performance.now();

  if (!animatedCursor) {
    // First time - initialize at target position (no animation)
    animatedCursor = {
      x: targetX,
      y: targetY,
      height: targetHeight,
      targetX,
      targetY,
      targetHeight,
      animationStart: now,
      isAnimating: false,
      startX: targetX,
      startY: targetY,
      startHeight: targetHeight,
    };
    return;
  }

  // Check if target changed
  const targetChanged =
    animatedCursor.targetX !== targetX ||
    animatedCursor.targetY !== targetY ||
    animatedCursor.targetHeight !== targetHeight;

  if (targetChanged) {
    // Start new animation from current position
    animatedCursor = {
      ...animatedCursor,
      startX: animatedCursor.x,
      startY: animatedCursor.y,
      startHeight: animatedCursor.height,
      targetX,
      targetY,
      targetHeight,
      animationStart: now,
      isAnimating: true,
    };
  }
}

/**
 * Get current animated cursor position
 * Call this each frame to get interpolated position
 */
export function getAnimatedCursorPosition(): AnimatedCursorPosition | null {
  if (!animatedCursor) return null;

  if (!animatedCursor.isAnimating) {
    return animatedCursor;
  }

  const now = performance.now();
  const elapsed = now - animatedCursor.animationStart;
  const duration = animationConfig.cursorDuration;

  if (elapsed >= duration) {
    // Animation complete - snap to target
    animatedCursor = {
      ...animatedCursor,
      x: animatedCursor.targetX,
      y: animatedCursor.targetY,
      height: animatedCursor.targetHeight,
      isAnimating: false,
    };
    return animatedCursor;
  }

  // Calculate eased progress
  const progress = elapsed / duration;
  const easedProgress = easeOutCubic(progress);

  // Interpolate position
  const newX = lerp(animatedCursor.startX, animatedCursor.targetX, easedProgress);
  const newY = lerp(animatedCursor.startY, animatedCursor.targetY, easedProgress);
  const newHeight = lerp(
    animatedCursor.startHeight,
    animatedCursor.targetHeight,
    easedProgress
  );

  // Check if close enough to snap
  const dx = Math.abs(newX - animatedCursor.targetX);
  const dy = Math.abs(newY - animatedCursor.targetY);
  const dh = Math.abs(newHeight - animatedCursor.targetHeight);

  if (
    dx < animationConfig.snapThreshold &&
    dy < animationConfig.snapThreshold &&
    dh < animationConfig.snapThreshold
  ) {
    animatedCursor = {
      ...animatedCursor,
      x: animatedCursor.targetX,
      y: animatedCursor.targetY,
      height: animatedCursor.targetHeight,
      isAnimating: false,
    };
  } else {
    animatedCursor = {
      ...animatedCursor,
      x: newX,
      y: newY,
      height: newHeight,
    };
  }

  return animatedCursor;
}

/**
 * Check if cursor animation is currently in progress
 */
export function isCursorAnimating(): boolean {
  return animatedCursor?.isAnimating ?? false;
}

/**
 * Reset cursor animation state (e.g., when document changes significantly)
 */
export function resetCursorAnimation(): void {
  animatedCursor = null;
}

/**
 * Update selection rectangles targets and animate
 */
export function updateSelectionTargets(
  targets: Array<{ x: number; y: number; width: number; height: number }>
): void {
  const now = performance.now();

  // If target count changed significantly, reset animation
  if (Math.abs(animatedSelectionRects.length - targets.length) > 2) {
    animatedSelectionRects = targets.map((t) => ({
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      targetX: t.x,
      targetY: t.y,
      targetWidth: t.width,
      targetHeight: t.height,
      animationStart: now,
      isAnimating: false,
      startX: t.x,
      startY: t.y,
      startWidth: t.width,
      startHeight: t.height,
    }));
    return;
  }

  // Match existing rects with new targets
  const newRects: AnimatedSelectionRect[] = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const existing = animatedSelectionRects[i];

    if (existing) {
      // Check if target changed
      const targetChanged =
        existing.targetX !== target.x ||
        existing.targetY !== target.y ||
        existing.targetWidth !== target.width ||
        existing.targetHeight !== target.height;

      if (targetChanged) {
        newRects.push({
          ...existing,
          startX: existing.x,
          startY: existing.y,
          startWidth: existing.width,
          startHeight: existing.height,
          targetX: target.x,
          targetY: target.y,
          targetWidth: target.width,
          targetHeight: target.height,
          animationStart: now,
          isAnimating: true,
        });
      } else {
        newRects.push(existing);
      }
    } else {
      // New rect - start at target (no animation)
      newRects.push({
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height,
        targetX: target.x,
        targetY: target.y,
        targetWidth: target.width,
        targetHeight: target.height,
        animationStart: now,
        isAnimating: false,
        startX: target.x,
        startY: target.y,
        startWidth: target.width,
        startHeight: target.height,
      });
    }
  }

  animatedSelectionRects = newRects;
}

/**
 * Get current animated selection rectangles
 */
export function getAnimatedSelectionRects(): Array<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const now = performance.now();
  const duration = animationConfig.selectionDuration;

  return animatedSelectionRects.map((rect) => {
    if (!rect.isAnimating) {
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }

    const elapsed = now - rect.animationStart;

    if (elapsed >= duration) {
      // Animation complete
      rect.x = rect.targetX;
      rect.y = rect.targetY;
      rect.width = rect.targetWidth;
      rect.height = rect.targetHeight;
      rect.isAnimating = false;
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }

    const progress = elapsed / duration;
    const easedProgress = easeOutCubic(progress);

    const newX = lerp(rect.startX, rect.targetX, easedProgress);
    const newY = lerp(rect.startY, rect.targetY, easedProgress);
    const newWidth = lerp(rect.startWidth, rect.targetWidth, easedProgress);
    const newHeight = lerp(rect.startHeight, rect.targetHeight, easedProgress);

    // Update current values
    rect.x = newX;
    rect.y = newY;
    rect.width = newWidth;
    rect.height = newHeight;

    // Check if close enough to snap
    const dx = Math.abs(newX - rect.targetX);
    const dy = Math.abs(newY - rect.targetY);
    const dw = Math.abs(newWidth - rect.targetWidth);
    const dh = Math.abs(newHeight - rect.targetHeight);

    if (
      dx < animationConfig.snapThreshold &&
      dy < animationConfig.snapThreshold &&
      dw < animationConfig.snapThreshold &&
      dh < animationConfig.snapThreshold
    ) {
      rect.x = rect.targetX;
      rect.y = rect.targetY;
      rect.width = rect.targetWidth;
      rect.height = rect.targetHeight;
      rect.isAnimating = false;
    }

    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
}

/**
 * Check if any selection animation is in progress
 */
export function isSelectionAnimating(): boolean {
  return animatedSelectionRects.some((rect) => rect.isAnimating);
}

/**
 * Reset selection animation state
 */
export function resetSelectionAnimation(): void {
  animatedSelectionRects = [];
}

/**
 * Check if any animation is in progress (cursor or selection)
 */
export function isAnyAnimating(): boolean {
  return isCursorAnimating() || isSelectionAnimating();
}
