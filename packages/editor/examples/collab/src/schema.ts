/**
 * Custom schema — a `callout` block type, defined entirely in host code.
 *
 * This is the new extensibility surface: `defineNode` declares a block type's
 * CRDT shape (its replicated attributes), its Markdown/HTML/text round-trip,
 * and how it draws — without touching the editor package. `baseSchema.extend`
 * folds it into a fresh, immutable schema you hand to both `createDoc` (for the
 * data half — `schema.data`) and `createEditor` (for the rendering nodes).
 *
 * v1 custom nodes are LEAF, void blocks (no caret, no nested content). They
 * round-trip through a generic self-closing tag, so a callout serializes to
 * `<x-callout tone="warn" />` and parses straight back — no tokenizer changes.
 */
import { baseSchema, defineNode } from "@cypherkit/editor";

// One declared attribute, `tone`, replicated as a top-level CRDT field. The
// `default` is applied when a callout is created without it; the (optional)
// `validate` runs before a `block_set` is accepted, so a peer can't poke a
// nonsense value into our document.
const TONES = ["note", "tip", "warn"] as const;

export const callout = defineNode("callout", {
  attrs: {
    tone: {
      default: "note",
      validate: (v) => typeof v === "string" && TONES.includes(v as never),
    },
  },
  // `render` configures the generated BoxNode — a styled void box. (Need bespoke
  // canvas drawing, or per-attribute styling? Pass your own `node:` instead; the
  // BoxNode's single style is fixed at construction, so we surface `tone` in the
  // label rather than recoloring per tone.)
  render: {
    height: 48,
    background: "rgba(29, 185, 132, 0.08)",
    borderLeft: { width: 3, color: "#1db984" },
    color: "rgba(40, 90, 70, 0.95)",
    label: (block) => {
      const tone = (block as unknown as { tone?: string }).tone ?? "note";
      const icon = tone === "warn" ? "⚠️" : tone === "tip" ? "💡" : "ℹ️";
      return `${icon}  Callout — tone: ${tone}`;
    },
  },
});

// Immutable derive: the base schema is untouched, `schema` adds `callout`. Two
// editors could legitimately hold different schemas on the same page, so the
// project forbids mutating shared schema state — `extend()` returns a new one.
export const schema = baseSchema.extend({ nodes: [callout] });
