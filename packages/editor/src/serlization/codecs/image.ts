/**
 * Codec for the image block.
 *
 * The escape-hatch rule, stated once: emit native markdown (`![alt](url)`)
 * when the block is losslessly representable in markdown, fall back to an
 * `<img>` HTML tag when it carries props markdown can't express
 * (width/height/objectFit). A future video block is the degenerate case of
 * the same rule — always the HTML branch.
 *
 * All emitted urls go through `ctx.mapAssetUrl`, so export flows decide what
 * an asset reference becomes (kept as-is, bundle-relative path, data URI).
 */

import { IMAGE_DEFAULT_HEIGHT } from "../../constants";
import type { Image } from "../../rendering/nodes/ImageNode";
import type { Block } from "../loadPage";
import {
  IMAGE_ALT_END,
  IMAGE_END,
  IMAGE_START,
  NEWLINE,
  TEXT,
  type VisibleToken,
} from "../tokenizer";
import { escapeAttr } from "./inline";
import type { BlockCodec, InputCtx, OutputCtx, ParsedTag } from "./types";

/**
 * Whether an image block is in default visual state (cover mode, full width,
 * default height) and thus losslessly representable as `![alt](url)`.
 * Serialization policy — lives with the codec, not the canvas node.
 */
export function isImageDefault(block: Image): boolean {
  const width = block.width ?? "full";
  const height = block.height ?? IMAGE_DEFAULT_HEIGHT;
  const objectFit = block.objectFit ?? "cover";

  return (
    width === "full" && height === IMAGE_DEFAULT_HEIGHT && objectFit === "cover"
  );
}

export const imageCodec: BlockCodec = {
  types: ["image"],

  markdown: {
    tokens: [IMAGE_START],
    htmlTags: ["img"],

    output(block: Block, ctx: OutputCtx): string {
      const b = block as Image;
      const alt = b.alt || "";
      const src = ctx.mapAssetUrl(b.url);

      // If image is in default state, use markdown syntax
      if (isImageDefault(b)) {
        return `![${alt}](${src})`;
      }

      // Otherwise, use HTML tag with custom properties
      const width = b.width ?? "full";
      const height = b.height ?? IMAGE_DEFAULT_HEIGHT;
      const objectFit = b.objectFit ?? "cover";

      const widthAttr =
        width === "full" ? 'data-width="full"' : `width="${width}"`;
      const heightAttr = `height="${height}"`;
      const objectFitAttr = `data-object-fit="${objectFit}"`;
      const altAttr = alt ? ` alt="${alt}"` : "";

      return `<img src="${src}"${altAttr} ${widthAttr} ${heightAttr} ${objectFitAttr} />`;
    },

    // ![alt](url)
    input(ctx: InputCtx): Block {
      ctx.match(IMAGE_START); // Consume ![

      let altText = "";
      let imageUrl = "";

      // Get alt text
      if (!ctx.isEnd() && ctx.check(TEXT)) {
        ctx.advance();
        altText = (ctx.previous() as VisibleToken).content;
      }

      // Consume ](
      ctx.match(IMAGE_ALT_END);

      // Get URL
      if (!ctx.isEnd() && ctx.check(TEXT)) {
        ctx.advance();
        imageUrl = (ctx.previous() as VisibleToken).content;
      }

      // Consume )
      ctx.match(IMAGE_END);

      // Consume optional newline
      ctx.match(NEWLINE);

      const image: Image = {
        id: ctx.nextBlockId(),
        type: "image",
        url: imageUrl,
        alt: altText,
        // Default properties - not specified in markdown
      };
      return image;
    },

    // <img src="url" alt="alt" width="..." height="..." data-object-fit="..." />
    inputTag(tag: ParsedTag, ctx: InputCtx): Block {
      const { attrs } = tag;

      const widthRaw = attrs["width"] ?? attrs["data-width"];
      const width = widthRaw
        ? widthRaw === "full"
          ? ("full" as const)
          : parseInt(widthRaw, 10)
        : undefined;
      const height = attrs["height"]
        ? parseInt(attrs["height"], 10)
        : undefined;
      const objectFit = attrs["data-object-fit"]
        ? (attrs["data-object-fit"] as "cover" | "contain")
        : undefined;

      // Consume optional newline
      ctx.match(NEWLINE);

      const image: Image = {
        id: ctx.nextBlockId(),
        type: "image",
        url: attrs["src"] ?? "",
        alt: attrs["alt"] ?? "",
        width,
        height,
        objectFit,
      };
      return image;
    },
  },

  html: {
    output(block: Block, ctx: OutputCtx): string {
      const b = block as Image;
      const src = ctx.mapAssetUrl(b.url);
      const alt = b.alt ? escapeAttr(b.alt) : "";
      const styles: string[] = [
        "max-width:100%",
        "height:auto",
        "display:block",
        "margin:1em auto",
      ];

      if (!isImageDefault(b)) {
        if (typeof b.width === "number") styles.push(`width:${b.width}px`);
        const fit = b.objectFit ?? "cover";
        styles.push(`object-fit:${fit}`);
      }

      return `<img src="${escapeAttr(src)}" alt="${alt}" style="${styles.join(";")}" />`;
    },
  },

  text: {
    output(block: Block): string {
      return (block as Image).alt || "";
    },
  },

  assetRefs(block: Block): string[] {
    const url = (block as Image).url;
    return url ? [url] : [];
  },
};
