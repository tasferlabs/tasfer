import {
  bigint,
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

// =============================================================================
// Users
// =============================================================================

export const users = pgTable("users", {
  id: varchar("id", { length: 30 }).primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  passwordHash: text("passwordHash").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

// =============================================================================
// Spaces
// =============================================================================

export const spaces = pgTable("spaces", {
  id: varchar("id", { length: 30 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: varchar("description", { length: 500 }).notNull().default(""),
  type: varchar("type", { length: 20 }).notNull(), // "personal" | "group"
  ownerId: varchar("ownerId", { length: 30 }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const spaceMembers = pgTable(
  "space_members",
  {
    id: varchar("id", { length: 30 }).primaryKey(),
    spaceId: varchar("spaceId", { length: 30 }).notNull(),
    userId: varchar("userId", { length: 30 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(), // "owner" | "editor"
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [unique().on(t.spaceId, t.userId)]
);

// =============================================================================
// Pages (modified: added spaceId)
// =============================================================================

export const pages = pgTable("pages", {
  id: varchar("id", { length: 30 }).primaryKey(),
  title: text("title"),
  autoTitle: boolean("autoTitle").notNull().default(true),
  spaceId: varchar("spaceId", { length: 30 }).notNull(),
  parentId: varchar("parentId", { length: 30 }),
  order: integer("order").notNull().default(0),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

// =============================================================================
// Snapshots
// =============================================================================

export const snapshots = pgTable("snapshots", {
  id: varchar("id", { length: 30 }).primaryKey(),
  pageId: varchar("pageId", { length: 30 }).notNull(),
  filePath: text("filePath").notNull(),
  size: integer("size").notNull(),
  clockWall: bigint("clockWall", { mode: "number" }),
  clockLogical: integer("clockLogical"),
  clockPeerId: varchar("clockPeerId", { length: 16 }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

// =============================================================================
// Images (modified: added userId)
// =============================================================================

export const images = pgTable("images", {
  id: varchar("id", { length: 30 }).primaryKey(),
  userId: varchar("userId", { length: 30 }).notNull(),
  fileName: text("fileName").notNull(),
  filePath: text("filePath").notNull(),
  mimeType: text("mimeType").notNull(),
  size: integer("size").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

// =============================================================================
// Page Shares
// =============================================================================

export const pageShares = pgTable(
  "page_shares",
  {
    id: varchar("id", { length: 30 }).primaryKey(),
    pageId: varchar("pageId", { length: 30 }).notNull(),
    userId: varchar("userId", { length: 30 }).notNull(),
    sharedBy: varchar("sharedBy", { length: 30 }).notNull(),
    permission: varchar("permission", { length: 20 }).notNull(), // "view" | "edit"
    includeChildren: boolean("includeChildren").notNull().default(false),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [unique().on(t.pageId, t.userId)]
);

// =============================================================================
// Refresh Tokens
// =============================================================================

export const refreshTokens = pgTable("refresh_tokens", {
  id: varchar("id", { length: 30 }).primaryKey(),
  userId: varchar("userId", { length: 30 }).notNull(),
  tokenHash: varchar("tokenHash", { length: 64 }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});
