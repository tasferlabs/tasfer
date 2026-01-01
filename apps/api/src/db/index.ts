import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/cypher";

const db = drizzle({
  connection: connectionString,
  schema,
});

export default db;

