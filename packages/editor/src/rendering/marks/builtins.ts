/**
 * The built-in inline marks, as {@link Mark} subclasses.
 *
 * Each encodes exactly what the renderer used to special-case by name:
 *  - strong       → bold weight (the styles-free `bold` flag; metric-affecting)
 *  - emphasis     → italic
 *  - strike       → strike-through
 *  - code         → a colored chip + fill color
 *  - link         → link color + underline
 *  - math         → a replacement renderer (draws a MathJax SVG instead of glyphs)
 *
 * Hosts compose a {@link MarkRegistry} from these (or a subset / their own
 * subclasses) at mount; `createDefaultMarkRegistry()` builds the full set.
 */

import { getInlineMathDims, getInlineMathImage } from "../../math";
import {
  Mark,
  MarkRegistry,
  type MarkReplacement,
  type MarkStyle,
  type MarkStyleCtx,
} from "./Mark";

class StrongMark extends Mark {
  readonly type = "strong";
  readonly bold = true;
  style(): MarkStyle {
    return {};
  }
}

class EmphasisMark extends Mark {
  readonly type = "emphasis";
  style(): MarkStyle {
    return { italic: true };
  }
}

class StrikeMark extends Mark {
  readonly type = "strike";
  style(): MarkStyle {
    return { strikethrough: true };
  }
}

class CodeMark extends Mark {
  readonly type = "code";
  style({ styles }: MarkStyleCtx): MarkStyle {
    const code = styles.textFormats.code;
    return {
      color: code.color,
      background: {
        color: code.backgroundColor,
        padding: code.padding,
        borderRadius: code.borderRadius,
      },
    };
  }
}

class LinkMark extends Mark {
  readonly type = "link";
  readonly togglable = false; // needs a url — applied via the link command
  style({ styles }: MarkStyleCtx): MarkStyle {
    const link = styles.textFormats.link;
    return {
      color: link.color,
      underline: { color: link.color, thickness: link.underlineThickness },
    };
  }
}

/**
 * Inline math: a replacement mark. It measures as an atomic unit (the full SVG
 * width) and paints the rendered formula — a behavior-preserving move of the
 * former `batch.isMath` branch out of `renderLine`.
 */
const inlineMathReplacement: MarkReplacement = {
  measure(text, fontSize) {
    return getInlineMathDims(text, fontSize);
  },
  paint({
    ctx,
    text,
    x,
    y,
    fontSize,
    isRTL,
    hovered,
    dims,
    styles,
    requestRedraw,
  }) {
    const dpr = window.devicePixelRatio || 1;
    const mathStyle = styles.textFormats.inlineMath;
    const mathWidth = dims.width;
    const drawX = isRTL ? x - mathWidth : x;

    if (hovered) {
      const padding = mathStyle.padding;
      ctx.save();
      ctx.fillStyle = mathStyle.hoverBackgroundColor;
      ctx.beginPath();
      ctx.roundRect(
        drawX - padding,
        y - dims.height + dims.depthBelowBaseline - padding,
        mathWidth + padding * 2,
        dims.height + padding * 2,
        mathStyle.borderRadius,
      );
      ctx.fill();
      ctx.restore();
    }

    const image = getInlineMathImage(
      text,
      fontSize,
      dpr,
      styles.blocks.paragraph.color,
      styles.blocks.math.errorBackgroundColor,
      requestRedraw,
    );
    if (image) {
      const imgY = y - dims.height + dims.depthBelowBaseline;
      ctx.drawImage(image.bitmap, drawX, imgY, mathWidth, dims.height);
    }
  },
};

class MathMark extends Mark {
  readonly type = "math";
  readonly togglable = false; // needs LaTeX — applied via the math command
  readonly replacement = inlineMathReplacement;
  style(): MarkStyle {
    return {};
  }
}

export { CodeMark, EmphasisMark, LinkMark, MathMark, StrikeMark, StrongMark };

/** Shared singletons of the stateless built-in marks (safe to share across editors). */
export const strongMark = new StrongMark();
export const emphasisMark = new EmphasisMark();
export const strikeMark = new StrikeMark();
export const codeMark = new CodeMark();
export const linkMark = new LinkMark();
export const mathMark = new MathMark();

function defaultMarks(): Mark[] {
  return [strongMark, emphasisMark, strikeMark, codeMark, linkMark, mathMark];
}

/** Build a registry from an explicit list of marks (host opt-in). */
export function createMarkRegistry(marks: readonly Mark[]): MarkRegistry {
  const registry = new MarkRegistry();
  for (const mark of marks) registry.register(mark);
  return registry;
}

/** Build a registry pre-populated with the built-in marks. */
export function createDefaultMarkRegistry(): MarkRegistry {
  return createMarkRegistry(defaultMarks());
}
