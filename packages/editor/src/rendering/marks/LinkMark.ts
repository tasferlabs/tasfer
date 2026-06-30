/** link → link color + underline. */

import { type ActionBus, OPEN_LINK } from "../../action-bus";
import {
  type CoordsResolver,
  POINTER_MOVE,
  TEXT_CLICK,
} from "../../actions/pointer-actions";
import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import type { EditorState, LinkHoverState, Position } from "../../state-types";
import { isTextualBlock } from "../../sync/block-registry";
import { findCharInRuns, iterateVisibleChars } from "../../sync/char-runs";
import { Mark, type MarkStyle, type MarkStyleCtx } from "./Mark";

/** Set/clear the engine-owned link-hover tooltip state (inlined here so this
 *  mark stays free of the `state-utils` import chain). */
function setLinkHover(
  state: EditorState,
  linkHover: LinkHoverState | null,
): EditorState {
  return { ...state, ui: { ...state.ui, linkHover } };
}

// `link` is parsed specially (its url arrives after its text), so it declares a
// `toMarkdown` but no paired `tokens`. `html.priority` keeps it outermost (4).
const LINK_CODEC: MarkCodec = {
  type: "link",
  toMarkdown: (t, mark) => (mark.attrs?.url ? `[${t}](${mark.attrs.url})` : t),
  html: {
    priority: 4,
    render: (inner, mark, ctx) =>
      mark.attrs?.url
        ? `<a href="${ctx.escapeAttr(String(mark.attrs.url))}">${inner}</a>`
        : inner,
  },
};

export class LinkMark extends Mark {
  readonly type = "link";
  readonly togglable = false; // needs a url — applied via the link action
  readonly codec = LINK_CODEC;
  style({ styles }: MarkStyleCtx): MarkStyle {
    const link = styles.textFormats.link;
    return {
      color: link.color,
      underline: { color: link.color, thickness: link.underlineThickness },
    };
  }

  /**
   * Register the link mark's pointer handlers:
   *  - `TEXT_CLICK` (claim, priority 100) — Ctrl/Cmd+click on a link opens it.
   *    Dispatches {@link OPEN_LINK} (whose default opens a new tab; a host can
   *    override it to route natively), clears any hover, and claims the click so
   *    the caret isn't placed. Highest priority so it pre-empts node click claims.
   *  - `POINTER_MOVE` (observe, priority 0) — drives the link hover tooltip. Owns
   *    `ui.linkHover` / `ui.isHoveringLinkWithModifier`; the host renders the
   *    tooltip from `ui.linkHover` via {@link overlays} (see CypherLinkMark),
   *    so only the write logic lives here. Dispatched on desktop only.
   */
  registerActions(bus: ActionBus): void {
    bus.registerState(
      TEXT_CLICK,
      (state, { position, modifiers }) => {
        if (!modifiers.ctrlOrMeta) return;
        const link = getLinkAtPosition(position, state);
        if (!link) return;
        // The editor's default opens it in a new tab; a native shell can override
        // OPEN_LINK to route it itself.
        state.actionBus.dispatch(OPEN_LINK, { url: link.url });
        return {
          state: {
            ...state,
            ui: {
              ...state.ui,
              activeMenu: { type: "none" },
              isHoveringLinkWithModifier: false,
            },
          },
          ops: [],
          handled: true,
        };
      },
      100,
    );

    bus.registerState(
      POINTER_MOVE,
      (
        state,
        { textPosition, canvasX, canvasY, viewport, resolveCoords, modifiers },
      ) => ({
        state: computeLinkHover(
          state,
          textPosition,
          canvasX,
          canvasY,
          viewport.scrollY,
          resolveCoords,
          modifiers.ctrlOrMeta,
        ),
        ops: [],
      }),
      0,
    );
  }
}

/**
 * The link hover-tooltip state machine, migrated from the old inline mouse-move
 * block. Pure over {@link EditorState}: given the resolved caret position under
 * the pointer (or null) and the canvas-space pointer coords, it sets/clears
 * `ui.linkHover` and `ui.isHoveringLinkWithModifier`. With the modifier held it
 * suppresses the tooltip (the user means to click-to-open); off a link it keeps
 * the tooltip open while the pointer is over the tooltip box (hysteresis).
 *
 * `canvasX`/`canvasY` must be in the same canvas/container space as the stored
 * `ui.linkHover` anchor (scroll-adjusted, no `containerRect` baked in), so the
 * keep-open hit-test lines up with where the overlay is actually painted.
 */
function computeLinkHover(
  state: EditorState,
  textPosition: Position | null,
  canvasX: number,
  canvasY: number,
  scrollY: number,
  resolveCoords: CoordsResolver,
  ctrlOrMeta: boolean,
): EditorState {
  // Modifier held with a tooltip showing → clear it (user wants to click-open).
  if (ctrlOrMeta && state.ui.linkHover) {
    return setLinkHover(state, null);
  }
  // Don't show the tooltip while a menu is open; clear any stale hover.
  if (state.ui.activeMenu.type !== "none") {
    return state.ui.linkHover ? setLinkHover(state, null) : state;
  }

  const linkData = textPosition ? getLinkAtPosition(textPosition, state) : null;

  if (linkData && textPosition) {
    if (ctrlOrMeta) {
      // Show the pointer cursor (no tooltip) while the modifier is held.
      let next = setLinkHover(state, null);
      return {
        ...next,
        ui: { ...next.ui, isHoveringLinkWithModifier: true },
      };
    }
    const linkStartPos = {
      blockIndex: textPosition.blockIndex,
      textIndex: linkData.startIndex,
    };
    const linkCoords = resolveCoords(linkStartPos);
    if (linkCoords) {
      // Anchor in container space: `linkCoords` is document space, so subtract
      // scrollY to match canvas coords (the overlay adds containerRect itself —
      // don't bake it in here or it's added twice).
      const next = setLinkHover(state, {
        position: textPosition,
        url: linkData.url,
        text: linkData.text,
        x: linkCoords.x,
        y: linkCoords.y - scrollY + linkCoords.height,
        startIndex: linkData.startIndex,
        endIndex: linkData.endIndex,
      });
      return {
        ...next,
        ui: { ...next.ui, isHoveringLinkWithModifier: false },
      };
    }
    return state;
  }

  // Not over a link: keep the tooltip open while the pointer is over it, else clear.
  let next = state;
  if (next.ui.linkHover) {
    const tooltipWidth = 300;
    const tooltipHeight = 120;
    const hover = next.ui.linkHover;
    const isOverTooltip =
      canvasX >= hover.x &&
      canvasX <= hover.x + tooltipWidth &&
      canvasY >= hover.y &&
      canvasY <= hover.y + tooltipHeight;
    if (!isOverTooltip) next = setLinkHover(next, null);
  }
  if (next.ui.isHoveringLinkWithModifier) {
    next = {
      ...next,
      ui: { ...next.ui, isHoveringLinkWithModifier: false },
    };
  }
  return next;
}

/**
 * Get link information at a given position
 * Returns the link data (url, text, start, end) if the position is within a link
 */
export function getLinkAtPosition(
  position: Position,
  state: EditorState,
): {
  url: string;
  text: string;
  startIndex: number;
  endIndex: number;
} | null {
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted) return null;
  if (!block) return null;

  if (!isTextualBlock(block)) return null;

  // Find the char at this position
  let visibleIndex = 0;
  let charIdAtPosition: string | null = null;

  for (const { id } of iterateVisibleChars(block.charRuns)) {
    if (visibleIndex === position.textIndex) {
      charIdAtPosition = id;
      break;
    }
    visibleIndex++;
  }

  if (!charIdAtPosition) return null;

  // Find if this char is within a link format span
  for (const formatSpan of block.formats) {
    if (formatSpan.format.type !== "link") continue;

    // Check if charIdAtPosition is within this span using findCharInRuns
    const startChar = findCharInRuns(block.charRuns, formatSpan.startCharId);
    const endChar = findCharInRuns(block.charRuns, formatSpan.endCharId);
    const charAtPos = findCharInRuns(block.charRuns, charIdAtPosition);

    if (!startChar || !endChar || !charAtPos) continue;

    // Check if charAtPos is between startChar and endChar
    // We need to compare positions by iterating through visible chars
    let startVisIndex = -1;
    let endVisIndex = -1;
    let charAtPosVisIndex = -1;
    visibleIndex = 0;

    for (const { id } of iterateVisibleChars(block.charRuns)) {
      if (id === formatSpan.startCharId) {
        startVisIndex = visibleIndex;
      }
      if (id === formatSpan.endCharId) {
        endVisIndex = visibleIndex;
      }
      if (id === charIdAtPosition) {
        charAtPosVisIndex = visibleIndex;
      }
      visibleIndex++;
    }

    if (
      startVisIndex !== -1 &&
      endVisIndex !== -1 &&
      charAtPosVisIndex !== -1 &&
      charAtPosVisIndex >= startVisIndex &&
      charAtPosVisIndex <= endVisIndex
    ) {
      // Get the text of the link
      const linkText: string[] = [];
      visibleIndex = 0;
      for (const { char } of iterateVisibleChars(block.charRuns)) {
        if (visibleIndex >= startVisIndex && visibleIndex <= endVisIndex) {
          linkText.push(char);
        }
        if (visibleIndex > endVisIndex) break;
        visibleIndex++;
      }

      return {
        url: (formatSpan.format.attrs?.url as string | undefined) || "",
        text: linkText.join(""),
        startIndex: startVisIndex,
        endIndex: endVisIndex + 1,
      };
    }
  }

  return null;
}
