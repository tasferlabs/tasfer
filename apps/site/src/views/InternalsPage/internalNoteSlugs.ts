export const INTERNAL_NOTE_SLUGS = [
  "accessibility",
  "compatibility",
  "crdt-compaction",
  "ethical-dilemma-of-tasfer-and-p2p-networks",
  "latex-as-model",
  "manifest",
  "math-block",
  "obsidian",
  "one-interface-mutliple-backends",
  "transition-plan",
] as const;

export type InternalNoteSlug = (typeof INTERNAL_NOTE_SLUGS)[number];
