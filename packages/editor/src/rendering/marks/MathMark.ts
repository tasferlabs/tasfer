/**
 * math → a replacement renderer (draws a MathJax SVG instead of glyphs).
 *
 * Inline math is a replacement mark: it measures as an atomic unit (the full
 * SVG width) and paints the rendered formula — a behavior-preserving move of
 * the former `batch.isMath` branch out of `renderLine`.
 */

import { getInlineMathDims, getInlineMathImage } from "../../math";
import { Mark, type MarkReplacement, type MarkStyle } from "./Mark";

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

export class MathMark extends Mark {
  readonly type = "math";
  readonly togglable = false; // needs LaTeX — applied via the math action
  readonly replacement = inlineMathReplacement;
  style(): MarkStyle {
    return {};
  }
}
