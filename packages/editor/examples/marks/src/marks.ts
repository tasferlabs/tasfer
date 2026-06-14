/**
 * Custom inline marks, defined entirely in host code.
 *
 * A custom mark has TWO facets, declared together in one `defineMark` call:
 *
 *   • DATA   — the mark `type`. `baseSchema.extend({ marks })` folds it into a
 *              fresh, immutable schema; the canvas-free half (`schema.data`)
 *              rides on the `Doc`, so the mark replicates and persists through
 *              the CRDT.
 *   • RENDER — a `Mark` subclass whose `style()` returns the visual channels for
 *              a run (a background chip, an underline, italic, a colour…). The
 *              renderer COMPOSES the styles of every mark on a run, so one word
 *              can be bold + highlighted + underlined at once and each mark just
 *              contributes its own channel. Passed as `defineMark`'s `render`;
 *              `extend()` folds it into `schema.marks` for you.
 *
 * Because `extend()` carries the render facet, `createEditor({ schema })` paints
 * these marks with no separate `marks` option — and you can't accidentally drop
 * the built-ins (bold/italic/links) by forgetting to spread them into a list.
 */
import { baseSchema, defineMark, Mark } from "@cypherkit/editor";
import type { MarkStyle, MarkStyleCtx } from "@cypherkit/editor";

// ── Render facet ─────────────────────────────────────────────────────────────

/**
 * Highlight: a translucent chip painted behind the glyphs (the same `background`
 * channel the built-in `code` mark uses). Marks are togglable by default, so
 * `editor.change((c) => c.toggleMark("highlight"))` just works.
 */
class HighlightMark extends Mark {
  readonly type = "highlight";
  style(): MarkStyle {
    // A literal highlighter colour. A theme-aware mark would read a token off
    // `c.styles` instead (see UnderlineMark below) — here we keep it
    // self-contained so the mark needs no extra theme wiring.
    return {
      background: { color: "rgba(255, 209, 0, 0.4)", padding: 1, borderRadius: 2 },
    };
  }
}

/**
 * Underline: the editor ships no underline mark (bold/italic/strike/code/link
 * are the built-ins), so here's one — it contributes only the `underline`
 * channel, which composes cleanly with any other mark on the run.
 */
class UnderlineMark extends Mark {
  readonly type = "underline";
  style(c: MarkStyleCtx): MarkStyle {
    // Read the resolved text colour off the theme so the underline tracks the
    // active palette (dark mode, themed presets) rather than a hardcoded value.
    return {
      underline: { color: c.styles.blocks.paragraph.color, thickness: 1.5 },
    };
  }
}

// ── Schema ───────────────────────────────────────────────────────────────────

/**
 * The schema with both marks declared — data + render in one `defineMark` call.
 * `extend()` returns a NEW immutable schema (`baseSchema` is untouched) with the
 * render facets folded into `schema.marks`. Pass `schema` to `createEditor` (for
 * the built-in nodes, the data half, and our marks' paint) and `schema.data` to
 * `createDoc`.
 */
export const schema = baseSchema.extend({
  marks: [
    defineMark("highlight", { render: new HighlightMark() }),
    defineMark("underline", { render: new UnderlineMark() }),
  ],
});
