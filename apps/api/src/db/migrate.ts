import path from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { getRootDir } from "../lib/paths.js";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/cypher";

async function runMigrations() {
  console.log("Running migrations...");

  const pool = new pg.Pool({
    connectionString,
  });
  const db = drizzle({ client: pool });

  const migrationsFolder = path.join(getRootDir(), "drizzle");
  await migrate(db, { migrationsFolder });

  console.log("Migrations completed successfully");
  await pool.end();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
