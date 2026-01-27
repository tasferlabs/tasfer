import protobuf from "protobufjs";
import { brotliCompressSync, brotliDecompressSync } from "zlib";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Block types (matching web app types)
interface HLC {
  counter: number;
  peerId: string;
}

interface TextFormat {
  type: "bold" | "italic" | "strikethrough" | "code" | "link";
  url?: string;
}

interface CharRun {
  peerId: string;
  startCounter: number;
  text: string;
  deletedMask?: number[];
}

interface FormatSpan {
  startCharId: string;
  endCharId: string;
  format: TextFormat;
  clock: HLC;
}

interface BlockBase {
  id: string;
  deleted?: boolean;
  afterId?: string | null;
}

interface TextBlockBase extends BlockBase {
  charRuns: CharRun[];
  formats: FormatSpan[];
}

interface Heading extends TextBlockBase {
  type: "heading1" | "heading2" | "heading3";
}

interface Paragraph extends TextBlockBase {
  type: "paragraph";
}

interface BulletListItem extends TextBlockBase {
  type: "bullet_list";
  indent: number;
}

interface NumberedListItem extends TextBlockBase {
  type: "numbered_list";
  indent: number;
}

interface TodoListItem extends TextBlockBase {
  type: "todo_list";
  indent: number;
  checked: boolean;
}

interface Image extends BlockBase {
  type: "image";
  url: string;
  alt?: string;
  width?: number | "full";
  height?: number;
  objectFit?: "cover" | "contain";
}

interface Line extends BlockBase {
  type: "line";
}

type Block =
  | Heading
  | Paragraph
  | BulletListItem
  | NumberedListItem
  | TodoListItem
  | Image
  | Line;

// Block type to enum mapping
const blockTypeToEnum: Record<string, number> = {
  paragraph: 1,
  heading1: 2,
  heading2: 3,
  heading3: 4,
  bullet_list: 5,
  numbered_list: 6,
  todo_list: 7,
  image: 8,
  line: 9,
};

const enumToBlockType: Record<number, string> = {
  1: "paragraph",
  2: "heading1",
  3: "heading2",
  4: "heading3",
  5: "bullet_list",
  6: "numbered_list",
  7: "todo_list",
  8: "image",
  9: "line",
};

// Format type to enum mapping
const formatTypeToEnum: Record<string, number> = {
  bold: 1,
  italic: 2,
  strikethrough: 3,
  code: 4,
  link: 5,
};

const enumToFormatType: Record<number, string> = {
  1: "bold",
  2: "italic",
  3: "strikethrough",
  4: "code",
  5: "link",
};

// Object fit to enum mapping
const objectFitToEnum: Record<string, number> = {
  cover: 1,
  contain: 2,
};

const enumToObjectFit: Record<number, string> = {
  1: "cover",
  2: "contain",
};

// Load proto schema
const root = protobuf.loadSync(
  path.join(__dirname, "../proto/snapshot.proto")
);
const PageSnapshot = root.lookupType("snapshot.PageSnapshot");

// Convert TypeScript format to Protobuf format
function formatToProto(format: TextFormat): object {
  return {
    type: formatTypeToEnum[format.type] || 0,
    url: format.url,
  };
}

// Convert Protobuf format to TypeScript format
function protoToFormat(proto: {
  type: number;
  url?: string;
}): TextFormat {
  const type = enumToFormatType[proto.type] as TextFormat["type"];
  return {
    type: type || "bold",
    ...(proto.url && { url: proto.url }),
  };
}

// Convert TypeScript HLC to Protobuf HLC
function hlcToProto(hlc: HLC): object {
  return {
    counter: hlc.counter,
    peerId: hlc.peerId,
  };
}

// Convert Protobuf HLC to TypeScript HLC
function protoToHlc(proto: {
  counter: number | Long;
  peerId: string;
}): HLC {
  return {
    counter:
      typeof proto.counter === "number"
        ? proto.counter
        : (proto.counter as Long).toNumber(),
    peerId: proto.peerId,
  };
}

// Long type for protobuf
interface Long {
  toNumber(): number;
}

// Convert TypeScript CharRun to Protobuf CharRun
function charRunToProto(charRun: CharRun): object {
  // Convert number[] to Uint8Array for protobuf
  let deletedMask: Uint8Array | undefined;
  if (charRun.deletedMask) {
    if (Array.isArray(charRun.deletedMask)) {
      deletedMask = new Uint8Array(charRun.deletedMask);
    } else if (typeof charRun.deletedMask === "object") {
      // Handle object like {0: 1, 1: 0, ...} from JSON serialization
      const values = Object.values(charRun.deletedMask) as number[];
      deletedMask = new Uint8Array(values);
    }
  }

  return {
    peerId: charRun.peerId,
    startCounter: charRun.startCounter,
    text: charRun.text,
    ...(deletedMask && { deletedMask }),
  };
}

// Convert Protobuf CharRun to TypeScript CharRun
function protoToCharRun(proto: {
  peerId: string;
  startCounter: number | Long;
  text: string;
  deletedMask?: Uint8Array;
}): CharRun {
  return {
    peerId: proto.peerId,
    startCounter:
      typeof proto.startCounter === "number"
        ? proto.startCounter
        : (proto.startCounter as Long).toNumber(),
    text: proto.text,
    ...(proto.deletedMask && { deletedMask: Array.from(proto.deletedMask) }),
  };
}

// Convert TypeScript format span to Protobuf format span
function formatSpanToProto(span: FormatSpan): object {
  return {
    startCharId: span.startCharId,
    endCharId: span.endCharId,
    format: formatToProto(span.format),
    clock: hlcToProto(span.clock),
  };
}

// Convert Protobuf format span to TypeScript format span
function protoToFormatSpan(proto: {
  startCharId: string;
  endCharId: string;
  format: { type: number; url?: string };
  clock: { counter: number | Long; peerId: string };
}): FormatSpan {
  return {
    startCharId: proto.startCharId,
    endCharId: proto.endCharId,
    format: protoToFormat(proto.format),
    clock: protoToHlc(proto.clock),
  };
}

// Convert TypeScript Block[] to Protobuf format
function blocksToProto(blocks: Block[]): object {
  return {
    blocks: blocks.map((block) => {
      const base = {
        id: block.id,
        deleted: block.deleted || false,
        afterId: block.afterId,
      };

      // Text blocks (paragraph, heading)
      if (
        block.type === "paragraph" ||
        block.type === "heading1" ||
        block.type === "heading2" ||
        block.type === "heading3"
      ) {
        const textBlock = block as TextBlockBase & { type: string };
        return {
          ...base,
          textBlock: {
            type: blockTypeToEnum[block.type],
            charRuns: textBlock.charRuns.map(charRunToProto),
            formats: textBlock.formats.map(formatSpanToProto),
          },
        };
      }

      // List blocks (bullet_list, numbered_list, todo_list)
      if (
        block.type === "bullet_list" ||
        block.type === "numbered_list" ||
        block.type === "todo_list"
      ) {
        const listBlock = block as BulletListItem | NumberedListItem | TodoListItem;
        return {
          ...base,
          listBlock: {
            type: blockTypeToEnum[block.type],
            charRuns: listBlock.charRuns.map(charRunToProto),
            formats: listBlock.formats.map(formatSpanToProto),
            indent: listBlock.indent || 0,
            checked: "checked" in listBlock ? listBlock.checked : false,
          },
        };
      }

      // Image block
      if (block.type === "image") {
        const imageBlock = block as Image;
        return {
          ...base,
          imageBlock: {
            url: imageBlock.url,
            alt: imageBlock.alt,
            width: imageBlock.width === "full" ? undefined : imageBlock.width,
            widthFull: imageBlock.width === "full",
            height: imageBlock.height,
            objectFit: imageBlock.objectFit
              ? objectFitToEnum[imageBlock.objectFit]
              : 0,
          },
        };
      }

      // Line block
      if (block.type === "line") {
        return {
          ...base,
          lineBlock: {},
        };
      }

      return base;
    }),
  };
}

// Protobuf block type
interface ProtoBlock {
  id: string;
  deleted: boolean;
  afterId?: string;
  textBlock?: {
    type: number;
    charRuns: Array<{
      peerId: string;
      startCounter: number | Long;
      text: string;
      deletedMask?: Uint8Array;
    }>;
    formats: Array<{
      startCharId: string;
      endCharId: string;
      format: { type: number; url?: string };
      clock: { counter: number | Long; peerId: string };
    }>;
  };
  listBlock?: {
    type: number;
    charRuns: Array<{
      peerId: string;
      startCounter: number | Long;
      text: string;
      deletedMask?: Uint8Array;
    }>;
    formats: Array<{
      startCharId: string;
      endCharId: string;
      format: { type: number; url?: string };
      clock: { counter: number | Long; peerId: string };
    }>;
    indent: number;
    checked: boolean;
  };
  imageBlock?: {
    url: string;
    alt?: string;
    width?: number;
    widthFull: boolean;
    height?: number;
    objectFit: number;
  };
  lineBlock?: object;
}

// Convert Protobuf format to TypeScript Block[]
function protoToBlocks(proto: { blocks: ProtoBlock[] }): Block[] {
  return proto.blocks.map((protoBlock) => {
    const base: BlockBase = {
      id: protoBlock.id,
      ...(protoBlock.deleted && { deleted: true }),
      ...(protoBlock.afterId && { afterId: protoBlock.afterId }),
    };

    // Text block
    if (protoBlock.textBlock) {
      const blockType = enumToBlockType[protoBlock.textBlock.type] as
        | "paragraph"
        | "heading1"
        | "heading2"
        | "heading3";
      return {
        ...base,
        type: blockType,
        charRuns: protoBlock.textBlock.charRuns.map(protoToCharRun),
        formats: protoBlock.textBlock.formats.map(protoToFormatSpan),
      } as Heading | Paragraph;
    }

    // List block
    if (protoBlock.listBlock) {
      const blockType = enumToBlockType[protoBlock.listBlock.type] as
        | "bullet_list"
        | "numbered_list"
        | "todo_list";
      const listBase = {
        ...base,
        type: blockType,
        charRuns: protoBlock.listBlock.charRuns.map(protoToCharRun),
        formats: protoBlock.listBlock.formats.map(protoToFormatSpan),
        indent: protoBlock.listBlock.indent || 0,
      };

      if (blockType === "todo_list") {
        return {
          ...listBase,
          checked: protoBlock.listBlock.checked || false,
        } as TodoListItem;
      }

      return listBase as BulletListItem | NumberedListItem;
    }

    // Image block
    if (protoBlock.imageBlock) {
      const img = protoBlock.imageBlock;
      return {
        ...base,
        type: "image" as const,
        url: img.url,
        ...(img.alt && { alt: img.alt }),
        ...(img.widthFull
          ? { width: "full" as const }
          : img.width && { width: img.width }),
        ...(img.height && { height: img.height }),
        ...(img.objectFit &&
          enumToObjectFit[img.objectFit] && {
            objectFit: enumToObjectFit[img.objectFit] as "cover" | "contain",
          }),
      } as Image;
    }

    // Line block
    if (protoBlock.lineBlock) {
      return {
        ...base,
        type: "line" as const,
      } as Line;
    }

    // Fallback to empty paragraph
    return {
      ...base,
      type: "paragraph" as const,
      charRuns: [],
      formats: [],
    } as Paragraph;
  });
}

/**
 * Encode blocks to compressed binary (Protocol Buffers + Brotli)
 */
export function encodeSnapshot(blocks: Block[]): Buffer {
  const protoObj = blocksToProto(blocks);
  const errMsg = PageSnapshot.verify(protoObj);
  if (errMsg) {
    throw new Error(`Invalid snapshot data: ${errMsg}`);
  }
  const message = PageSnapshot.create(protoObj);
  const buffer = PageSnapshot.encode(message).finish();
  return brotliCompressSync(Buffer.from(buffer));
}

/**
 * Decode compressed binary to blocks
 */
export function decodeSnapshot(compressed: Buffer): Block[] {
  const buffer = brotliDecompressSync(compressed);
  const message = PageSnapshot.decode(buffer);
  const protoObj = PageSnapshot.toObject(message, {
    longs: Number,
    enums: Number,
    defaults: true,
  }) as { blocks: ProtoBlock[] };
  return protoToBlocks(protoObj);
}

export type { Block };
