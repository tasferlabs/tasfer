/**
 * Custom inline marks, defined entirely in host code.
 *
 * A custom mark has TWO facets, and you wire them separately:
 *
 *   • DATA   — `defineMark(type)` declares the mark as a valid inline format and
 *              `baseSchema.extend({ marks })` folds it into a fresh, immutable
 *              schema. The canvas-free half (`schema.data`) rides on the `Doc`,
 *              so the mark replicates and persists through the CRDT.
 *   • RENDER — a `Mark` subclass whose `style()` returns the visual channels for
 *              a run (a background chip, an underline, italic, a colour…). The
 *              renderer COMPOSES the styles of every mark on a run, so one word
 *              can be bold + highlighted + underlined at once and each mark just
 *              contributes its own channel.
 *
 * The split is deliberate: two editors on the same page may want to PAINT the
 * same mark differently, so the render facet isn't baked into the shared schema
 * (the project's no-shared-mutable-state rule) — it's passed per editor via
 * `createEditor`'s `marks` option (see main.ts).
 *
 * The rendering `Mark` base class isn't on the package's top-level surface yet,
 * so we reach it through the `@cypherkit/editor/rendering/marks` subpath — the
 * same deep-import style fonts.ts uses for `notifyFontsLoaded`.
 */
import { baseSchema, defineMark } from "@cypherkit/editor";
import {
  Mark,
  type MarkStyle,
  type MarkStyleCtx,
} from "@cypherkit/editor/rendering/marks";

// ── Render facet ─────────────────────────────────────────────────────────────

/**
 * Highlight: a translucent chip painted behind the glyphs (the same `background`
 * channel the built-in `code` mark uses). Marks are togglable by default, so
 * `editor.commands.toggleMark("highlight")` just works.
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

/** One stateless instance per type — safe to share across editor instances. */
export const highlightMark = new HighlightMark();
export const underlineMark = new UnderlineMark();

/**
 * The render-mark list to hand `createEditor`: every built-in mark
 * (`baseSchema.marks`) PLUS our two. This list REPLACES the editor's mark
 * registry, it doesn't add to it — drop the built-ins and bold/italic/links
 * would stop rendering.
 */
export const renderMarks = [...baseSchema.marks, highlightMark, underlineMark];

// ── Data facet ───────────────────────────────────────────────────────────────

/**
 * The schema with both marks declared. `extend()` returns a NEW immutable schema
 * — `baseSchema` is untouched. Pass `schema` to `createEditor` (for the built-in
 * nodes + the data half) and `schema.data` to `createDoc`.
 */
export const schema = baseSchema.extend({
  marks: [defineMark("highlight"), defineMark("underline")],
});
