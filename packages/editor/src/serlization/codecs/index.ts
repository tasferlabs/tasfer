/**
 * Codec registry — block type → BlockCodec, plus the markdown input dispatch
 * tables derived from codec declarations.
 *
 * Like BLOCK_REGISTRY in sync/block-registry.ts, these are immutable
 * module-level tables built once from static descriptors — configuration, not
 * shared mutable state, so multiple editor instances can't clobber each other.
 */

import type { Block } from "../loadPage";
import type { TokenType } from "../tokenizer";
import { imageCodec } from "./image";
import { lineCodec } from "./line";
import { listCodec } from "./list";
import { mathCodec } from "./math";
import { textCodec } from "./text";
import type { BlockCodec } from "./types";

export { isImageDefault } from "./image";
export type {
  BlockCodec,
  HtmlCodec,
  InputCtx,
  MarkdownCodec,
  OutputCtx,
  ParsedTag,
  SerialFormat,
  TextCodec,
} from "./types";

/** The built-in block codecs, in dispatch-priority order. */
export const ALL_CODECS: readonly BlockCodec[] = [
  textCodec,
  listCodec,
  imageCodec,
  lineCodec,
  mathCodec,
];

/** Parser fallback: unclaimed block starts parse as paragraph text. */
export const fallbackCodec: BlockCodec = textCodec;

function buildTypeMap(): ReadonlyMap<string, BlockCodec> {
  const map = new Map<string, BlockCodec>();
  for (const codec of ALL_CODECS) {
    for (const type of codec.types) {
      map.set(type, codec);
    }
  }
  return map;
}

function buildTokenDispatch(): ReadonlyMap<TokenType, BlockCodec> {
  const map = new Map<TokenType, BlockCodec>();
  for (const codec of ALL_CODECS) {
    for (const token of codec.markdown.tokens ?? []) {
      map.set(token, codec);
    }
  }
  return map;
}

function buildHtmlTagDispatch(): ReadonlyMap<string, BlockCodec> {
  const map = new Map<string, BlockCodec>();
  for (const codec of ALL_CODECS) {
    for (const tag of codec.markdown.htmlTags ?? []) {
      map.set(tag.toLowerCase(), codec);
    }
  }
  return map;
}

const CODEC_BY_TYPE = buildTypeMap();

/** Block-start token → codec whose markdown.input claims it. */
export const MARKDOWN_TOKEN_DISPATCH = buildTokenDispatch();

/** HTML tag name (lowercase) → codec whose markdown.inputTag claims it. */
export const HTML_TAG_DISPATCH = buildHtmlTagDispatch();

export function getBlockCodec(type: string): BlockCodec | undefined {
  return CODEC_BY_TYPE.get(type);
}

/**
 * Collect every asset reference owned by the given blocks (deleted blocks
 * skipped), deduplicated in document order. Replaces ad-hoc
 * `block.type === "image"` walks in export flows — a future video block's
 * refs are picked up here with no caller changes.
 */
export function collectAssetRefs(blocks: Block[]): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const block of blocks) {
    if (block.deleted) continue;
    const codec = CODEC_BY_TYPE.get(block.type);
    if (!codec?.assetRefs) continue;
    for (const ref of codec.assetRefs(block)) {
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}
