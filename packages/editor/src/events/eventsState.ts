export let autoScrollState: {
  isActive: boolean;
  startTime: number;
  currentSpeedMultiplier: number;
  lastMouseX: number;
  lastMouseY: number;
} = {
  isActive: false,
  startTime: 0,
  currentSpeedMultiplier: 1,
  lastMouseX: 0,
  lastMouseY: 0,
};
// Scrollbar long-press state for iOS-style behavior

export let scrollbarPressState: {
  isPressingThumb: boolean;
  startTime: number;
  canvasX: number;
  canvasY: number;
} | null = null;

export function activateScroll(
  currentTime: number,
  canvasX: number,
  canvasY: number,
) {
  scrollbarPressState = {
    isPressingThumb: true,
    startTime: currentTime,
    canvasX,
    canvasY,
  };
}

export function clearScrollPress() {
  scrollbarPressState = null;
}
