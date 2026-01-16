import path from "path";
import { fileURLToPath } from "url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/cypher";

async function runMigrations() {
  console.log("Running migrations...");

  const pool = new pg.Pool({
    connectionString,
  });
  const db = drizzle({ client: pool });

  // Path relative to this file's location (dist/db/) -> dist/drizzle/
  const migrationsFolder = path.join(__dirname, "..", "drizzle");
  await migrate(db, { migrationsFolder });

  console.log("Migrations completed successfully");
  await pool.end();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
