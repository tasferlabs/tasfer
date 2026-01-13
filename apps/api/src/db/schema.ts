import {
  bigint,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

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

