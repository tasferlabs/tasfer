/**
 * Image-resize handle drag fires a detent haptic (`DRAG_DETENT`) each time the
 * width snaps into — or releases from — one of its two pinned widths: full-bleed
 * and the content/padding width (where it flips to `contain`). Free dragging
 * between those detents stays silent, so the gesture taps only at the milestones
 * the user can feel clicking into place — the image-handle counterpart to the
 * caret's character/line boundary tap.
 */
import { DRAG_DETENT } from "../action-bus";
import { createChromeRegionRegistry } from "../events/chromeRegions";
import { createInteractionSession } from "../events/interaction-session";
import type { NodeRegionCtx } from "../rendering/nodes";
import type { Block, Page } from "../serlization/loadPage";
import type { EditorState, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getEditorStyles } from "../styles";
import { generateNKeysBetween } from "../sync/fractional-index";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  // The region hit-test consults scrollbar chrome, whose safe-area probe appends
  // a measuring node to document.body; the headless stub omits it.
  const doc = globalThis.document as unknown as { body?: unknown };
  if (!doc.body) doc.body = { appendChild: () => {}, removeChild: () => {} };
});

const viewport: ViewportState = {
  width: 600,
  height: 800,
  scrollY: 0,
  documentHeight: 1000,
};

function imagePage(): Page {
  const [orderKey] = generateNKeysBetween(null, null, 1);
  const block = {
    id: "img0",
    orderKey,
    type: "image",
    url: "blob:test",
    width: "full",
    height: 336,
    objectFit: "cover",
    alt: "",
  } as unknown as Block;
  return { id: "page", title: "", blocks: [block] };
}

/**
 * Build the image-resize region for a full-bleed first image, grab its left
 * handle, and return everything a hand-driven drag needs. The drag is driven by
 * calling the region's onStart/onMove directly (as the event layer does), with
 * the grabbed hit parked on `session.captured` so onMove can read its `start`.
 */
function grabLeftHandle() {
  const page = imagePage();
  const state = createInitialState(page);
  const styles = getEditorStyles(state);
  const { paddingLeft, paddingRight, paddingTop } = styles.canvas;
  const maxWidth = viewport.width - (paddingLeft + paddingRight);

  const node = state.nodes.get("image");
  if (!node?.regions) throw new Error("image node has no regions");
  const c: NodeRegionCtx = {
    block: page.blocks[0],
    blockIndex: 0,
    maxWidth,
    isFirst: true,
    styles,
    marks: state.marks,
    state,
    viewport,
    origin: { x: paddingLeft, y: paddingTop },
  };
  const region = node.regions(c).find((r) => r.id === "image-resize");
  if (!region?.drag) throw new Error("no image-resize drag region");

  // The left handle bar sits inset from the left edge and vertically centered on
  // the drawn image box (a full-bleed cover image is exactly block.height tall).
  const { vertical } = styles.imageResize.dragHandles;
  const blockHeight = (page.blocks[0] as { height: number }).height;
  const grab = {
    x: vertical.inset + vertical.thickness / 2,
    y: blockHeight / 2,
  };
  const hit = region.hitTest(grab, "touch");
  if (!hit) throw new Error("grab did not land on the left handle");

  const session = createInteractionSession(createChromeRegionRegistry());
  const started = region.drag.onStart(hit, grab, {
    state,
    viewport,
    session,
  } as never) as { state: EditorState };
  // Park the grabbed hit (now carrying its `.start` descriptor) where onMove
  // looks for it, mirroring beginRegionInteraction.
  (session as unknown as { captured: unknown }).captured = { hit };

  let detents = 0;
  state.actionBus.register(DRAG_DETENT, () => {
    detents += 1;
  });

  let cur = started.state;
  const move = (x: number) => {
    const res = region.drag!.onMove({ x, y: grab.y }, {
      state: cur,
      viewport,
      session,
    } as never) as { state: EditorState };
    cur = res.state;
  };

  // The resize math measures deltaX from the grab point and (left handle)
  // shrinks width by 2·deltaX from the full viewport width. Solving for the two
  // snap widths gives the pointer x that lands exactly on each detent.
  const paddingSpan = paddingLeft + paddingRight;
  return {
    move,
    detents: () => detents,
    currentWidth: () =>
      (cur.document.page.blocks[0] as { width: number | "full" }).width,
    // Pins width to maxWidth (padding/contain detent).
    paddingDetentX: grab.x + paddingSpan / 2,
    // Well inside maxWidth − snapThreshold: a free contain width, no detent.
    freeWidthX: grab.x + paddingSpan / 2 + 80,
    // Back to deltaX ≈ 0: snaps to full-bleed.
    fullDetentX: grab.x,
  };
}

describe("image-resize handle drag detents", () => {
  it("taps when the width snaps to the padding (contain) detent", () => {
    const drag = grabLeftHandle();
    drag.move(drag.paddingDetentX);
    expect(drag.detents()).toBe(1);
    expect(drag.currentWidth()).not.toBe("full");
  });

  it("does not tap while dragging freely between detents", () => {
    const drag = grabLeftHandle();
    drag.move(drag.paddingDetentX); // full → padding: one tap
    drag.move(drag.freeWidthX); // padding → free: one tap
    const afterFirstTwo = drag.detents();
    expect(afterFirstTwo).toBe(2);

    // Staying in the free range across several moves adds no further taps.
    drag.move(drag.freeWidthX - 10);
    drag.move(drag.freeWidthX - 20);
    expect(drag.detents()).toBe(afterFirstTwo);
  });

  it("taps again when the width snaps back to full-bleed", () => {
    const drag = grabLeftHandle();
    drag.move(drag.freeWidthX); // full → free: one tap
    expect(drag.detents()).toBe(1);
    drag.move(drag.fullDetentX); // free → full: one tap
    expect(drag.detents()).toBe(2);
    expect(drag.currentWidth()).toBe("full");
  });
});
