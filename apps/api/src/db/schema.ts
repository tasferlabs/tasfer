import {
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const pages = pgTable("pages", {
  id: varchar("id", { length: 30 }).primaryKey(),
  title: text("title"),
  content: text("content"),
  parentId: varchar("parentId", { length: 30 }),
  order: integer("order").notNull().default(0),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});
