/**
 * Regression: a click/drag must hit-test against the live scroll, not a stale
 * paint snapshot.
 *
 * `handleEvents` receives the `visibility` snapshot produced by the last paint.
 * When the scroll has advanced since that paint without an intervening repaint
 * (a programmatic scroll-into-view, a host-restored scroll, momentum), the
 * snapshot's `startY` no longer matches the live `viewport.scrollY`. The hit-
 * test walks from `startY`, so the press resolves to the wrong block/line and
 * the selection anchors on the wrong row — the words above the press are left
 * unselected. handleEvents re-bases the snapshot onto the current scroll to
 * prevent this.
 */
import { getBlockHeight } from "../rendering/renderer";
import { getTextPositionFromViewport } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type {
  EditorState,
  MouseEvent as EditorMouseEvent,
  ViewportState,
  VisibleBlockRange,
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

const LONG =
  "One morning when Gregor Samsa woke from troubled dreams he found himself transformed in his bed into a horrible vermin He lay on his armour-like back and if he lifted his head a little he could see his brown belly slightly domed and divided by arches into stiff sections The bedding was hardly able to cover it and seemed ready to slide off any moment His many legs pitifully thin compared with the size of the rest of him waved about helplessly as he looked";
const MD = `# Metamorphosis\n\n${LONG}\n\nWhat happened to me he thought It was not a dream`;

function mouse(type: string, x: number, y: number): EditorMouseEvent {
  return {
    type,
    x,
    y,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

describe("hit-test against live scroll, not a stale paint snapshot", () => {
  it("anchors on the pressed line after the scroll advanced past the snapshot", () => {
    const state: EditorState = createInitialState(loadPage(MD));
    const styles = getEditorStyles(state);
    const width = 800;
    const maxWidth =
      width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

    // Paragraph (block 1) geometry at scroll 0.
    const blocks = state.view.visibleBlocks;
    let y = styles.canvas.paddingTop;
    const tops: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
      tops.push(y);
      y += getBlockHeight(
        state.nodes,
        state.marks,
        blocks[i],
        maxWidth,
        styles,
        i === 0,
      );
    }
    const paraBlock = blocks[1];
    const node = state.nodes.get(paraBlock.type)!;
    const layout = (
      node as unknown as {
        computeLayout: (...a: unknown[]) => {
          insetY: number;
          lines: {
            y: number;
            height: number;
            startIndex: number;
            endIndex: number;
          }[];
        };
      }
    ).computeLayout(paraBlock, maxWidth, styles, undefined, state.marks);
    const line0 = layout.lines[0];
    const x = styles.canvas.paddingLeft + 30;

    // The view has scrolled down 50px since the last paint. The first line of the
    // paragraph is now painted 50px higher; the user presses on it there.
    const SCROLL = 50;
    const viewport: ViewportState = {
      width,
      height: 2000,
      scrollY: SCROLL,
      documentHeight: 4000,
    };
    const pressY =
      tops[1] + layout.insetY + line0.y + line0.height / 2 - SCROLL;

    // Stale snapshot: painted at scroll 0 (startY = paddingTop, scrollY = 0).
    const staleVisibility: VisibleBlockRange = {
      start: 0,
      end: blocks.length - 1,
      startY: styles.canvas.paddingTop,
      scrollY: 0,
    };

    // Sanity: resolved against the stale snapshot directly, the press lands on
    // the wrong block (the regression we are guarding against).
    const wrong = getTextPositionFromViewport(
      x,
      pressY,
      state,
      viewport,
      undefined,
      staleVisibility,
    );
    expect(wrong?.blockIndex).not.toBe(paraBlock.originalIndex);

    // Through handleEvents (which re-bases the snapshot) the press anchors on the
    // pressed line of the paragraph.
    const session = createInteractionSession(createChromeRegionRegistry());
    const res = handleEvents(
      state,
      viewport,
      staleVisibility,
      [mouse("mousedown", x, pressY)] as never,
      viewport.documentHeight,
      { left: 0, top: 0 },
      session,
    );

    const anchor = res.state.document.selection?.anchor;
    expect(anchor?.blockIndex).toBe(paraBlock.originalIndex);
    expect(anchor!.textIndex).toBeGreaterThanOrEqual(line0.startIndex);
    expect(anchor!.textIndex).toBeLessThanOrEqual(line0.endIndex);
  });
});
