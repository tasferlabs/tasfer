import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

// CRDT operation types enum
export const operationTypeEnum = pgEnum("operation_type", [
  "text_insert",
  "text_delete",
  "format_set",
  "block_insert",
  "block_delete",
  "block_set",
]);

export const pages = pgTable("pages", {
  id: varchar("id", { length: 30 }).primaryKey(),
  title: text("title"),

  parentId: varchar("parentId", { length: 30 }),
  order: integer("order").notNull().default(0),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const snapshots = pgTable("snapshots", {
  id: varchar("id", { length: 30 }).primaryKey(),
  pageId: varchar("pageId", { length: 30 }).notNull().unique(),
  filePath: text("filePath").notNull(),
  size: integer("size").notNull(),
  // HLC of the latest operation included in this snapshot
  // Used to determine which operations to return and which to garbage collect
  clockWall: bigint("clockWall", { mode: "number" }),
  clockLogical: integer("clockLogical"),
  clockPeerId: varchar("clockPeerId", { length: 16 }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const images = pgTable("images", {
  id: varchar("id", { length: 30 }).primaryKey(),
  fileName: text("fileName").notNull(),
  filePath: text("filePath").notNull(),
  mimeType: text("mimeType").notNull(),
  size: integer("size").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

/**
 * CRDT operations table for efficient storage and delta sync.
 * Each operation is stored as a separate row instead of JSON blob.
 */
export const operations = pgTable(
  "operations",
  {
    // Operation ID: "peerId:counter" format
    id: varchar("id", { length: 64 }).primaryKey(),
    // Page this operation belongs to
    pageId: varchar("pageId", { length: 30 }).notNull(),
    // Operation type
    op: operationTypeEnum("op").notNull(),
    // HLC components for ordering
    clockWall: bigint("clockWall", { mode: "number" }).notNull(),
    clockLogical: integer("clockLogical").notNull(),
    clockPeerId: varchar("clockPeerId", { length: 16 }).notNull(),
    // Operation-specific payload (blockId, chars, charIds, format, value, etc.)
    payload: jsonb("payload").notNull(),
    // When this operation was persisted (for debugging/cleanup)
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    // Index for loading all operations for a page in HLC order
    index("operations_page_clock_idx").on(
      table.pageId,
      table.clockWall,
      table.clockLogical,
      table.clockPeerId
    ),
    // Index for delta sync queries (operations after a certain clock)
    index("operations_page_id_idx").on(table.pageId),
  ]
);
