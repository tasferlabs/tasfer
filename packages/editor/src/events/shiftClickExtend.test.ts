/**
 * Regression: ⇧-click extends, and is never counted as a double/triple click.
 *
 * A click run continues when a press lands within 5px of the last one inside
 * the double-click window — less than one glyph. Extending a selection by a
 * character or two therefore put the ⇧-press inside that window, where it was
 * read as a double-click and selected the word instead of moving the focus;
 * the press after it took the whole line. Shift means "extend", so it never
 * counts toward a run.
 */

import { loadPage } from "../serlization/loadPage";
import type {
  EditorState,
  MouseEvent as EditorMouseEvent,
  ViewportState,
} from "../state-types";
import { createInitialState } from "../state-utils";
import { getEditorStyles } from "../styles";
import { createChromeRegionRegistry } from "./chromeRegions";
import { handleEvents } from "./events";
import { createInteractionSession } from "./interaction-session";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  const d = (globalThis as unknown as { document: Record<string, unknown> })
    .document;
  if (!d.body) d.body = { appendChild: () => {}, removeChild: () => {} };
});

const viewport: ViewportState = {
  width: 800,
  height: 1000,
  scrollY: 0,
  documentHeight: 2000,
};

function stateOf(): EditorState {
  const base = createInitialState(loadPage("hello there world", undefined), {});
  return { ...base, view: { ...base.view, isFocused: true } };
}

function mouse(
  x: number,
  y: number,
  shiftKey = false,
): EditorMouseEvent & { type: string } {
  return {
    type: "mousedown",
    x,
    y,
    button: 0,
    shiftKey,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

function press(
  state: EditorState,
  session: ReturnType<typeof createInteractionSession>,
  x: number,
  shift = false,
): EditorState {
  const styles = getEditorStyles(state);
  return handleEvents(
    state,
    viewport,
    { start: 0, end: 1, startY: styles.canvas.paddingTop },
    [
      mouse(styles.canvas.paddingLeft + x, styles.canvas.paddingTop + 5, shift),
    ] as never,
    viewport.documentHeight,
    { left: 0, top: 0 },
    session,
  ).state;
}

describe("shift-click extension", () => {
  it("extends from the anchor even a few pixels from the press before it", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    let state = press(stateOf(), session, 40);
    const anchored = state.document.cursor?.position.textIndex ?? -1;
    expect(anchored).toBeGreaterThan(0);

    // Well inside the run's 5px window — which is narrower than one glyph, so
    // it is exactly where a press that extends by a character or two lands.
    state = press(state, session, 43, true);

    const selection = state.document.selection;
    // The anchor stayed put, and no word boundary was taken: a double-click
    // read would have snapped both ends to the word under the press and
    // recorded it as the gesture's `initialBoundary`.
    expect(selection?.anchor.textIndex).toBe(anchored);
    expect(selection?.initialBoundary).toBeUndefined();
  });

  it("still counts an unmodified press, so double-click keeps selecting a word", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    let state = press(stateOf(), session, 40);
    state = press(state, session, 41);

    const selection = state.document.selection;
    expect(selection?.isCollapsed).toBe(false);
    expect(selection?.initialBoundary).toBeDefined();
  });
});
