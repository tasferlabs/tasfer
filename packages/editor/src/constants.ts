export const DOUBLE_CLICK_TIME = 500;
export const CLICK_DISTANCE_THRESHOLD = 5;
export const TAP_DISTANCE_THRESHOLD = 30;
export const LONG_PRESS_DURATION = 400;
export const MOVEMENT_THRESHOLD = 10;
// Max net finger travel (start → release) for a touch to still count as a tap.
// Tap qualification uses net displacement, not the sticky "has moved" flag, so a
// transient jitter spike that returns near the origin — common on Android, which
// smooths touch coordinates less than iOS — does not silently disqualify the tap.
// Kept under TAP_DISTANCE_THRESHOLD (30) so a real scroll still isn't a tap.
export const TAP_MOVE_TOLERANCE = 12;
export const TAP_MAX_DURATION = 500;
export const EDGE_SCROLL_THRESHOLD = 80;
export const EDGE_SCROLL_SPEED = 12;
export const EDGE_SCROLL_MAX_SPEED = 100_000;
export const EDGE_SCROLL_ACCELERATION_RATE = 2.5;
export const CONTEXT_MENU_DURATION = 600;
// Grace period before a blur clears the selection. A blur that immediately
// bounces back to the input must NOT destroy a freshly made selection: on
// Android, the WebView synthesizes mouse/click events after `touchend` that move
// focus to <body> and straight back, so a double-tap word selection would
// otherwise be wiped milliseconds after it appears. Genuine focus loss (no
// refocus within this window) still clears, imperceptibly late.
export const BLUR_SELECTION_CLEAR_DELAY = 250;
export const IMAGE_DEFAULT_HEIGHT = 220;
export const SCROLLBAR_HOLD_DURATION = 150; // Shorter than long press, iOS feels snappy
export const SCROLLBAR_TOUCH_BUFFER = 16; // Pixels of buffer area around the thumb for touch detection
export const SELECTION_HANDLE_TOUCH_TARGET = 44; // Touch target size for selection handles (iOS HIG minimum)
export const CURSOR_DRAG_ACTIVATION_DELAY = 200; // ms before cursor drag activates (shorter than context menu)
export const CURSOR_TOUCH_RADIUS = 30; // px proximity to cursor to trigger drag mode
// Width (px) of the block-reorder grab band inside the left gutter, measured
// from the content edge (paddingLeft) outward. A pointer in this band over a
// block hits the reorder drag handle.
export const BLOCK_DRAG_HANDLE_HIT_WIDTH = 28;
// Visual size of the painted reorder grip within the hit band.
export const BLOCK_DRAG_HANDLE_GRIP_WIDTH = 16;
export const BLOCK_DRAG_HANDLE_GRIP_HEIGHT = 18;
