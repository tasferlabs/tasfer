# Database Migrations

Local-first means every user's device has its own SQLite database. There's no central server to migrate — the app migrates itself on startup.

## How It Works

Schema version is tracked via SQLite's built-in `PRAGMA user_version` — a persistent integer stored in the DB file.

On startup, `Engine.init()` calls `runMigrations()` which:

1. Reads the current `user_version` from the DB
2. Runs each migration the DB hasn't seen yet (sequential, forward-only)
3. Stamps the DB with the latest `SCHEMA_VERSION`

```
SCHEMA_VERSION = 4

user_version = 1  →  run migration 2, 3, 4          →  user_version = 4
user_version = 4  →  nothing to do                   →  user_version = 4
user_version = 0  →  run migration 1, 2, 3, 4        →  user_version = 4
```

## Adding a Migration

1. Open `apps/web/src/platform/engine.ts`
2. Bump `SCHEMA_VERSION` by 1
3. Add a new `if (user_version < N)` block inside `runMigrations()`
4. Write the migration as a private method

```ts
const SCHEMA_VERSION = 2; // was 1

private async runMigrations(): Promise<void> {
  const [{ user_version }] = await this.driver.db.execute<{ user_version: number }>(
    "PRAGMA user_version",
  );

  if (user_version < 1) {
    await this.migrateOpsUniqueConstraint();
  }
  if (user_version < 2) {
    await this.migrateAddSomeColumn();
  }

  if (user_version < SCHEMA_VERSION) {
    await this.driver.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}
```

## Rules

- **Forward-only** — no rollbacks. You can't coordinate across peers' devices.
- **Idempotent** — migrations should be safe to re-run (use `IF NOT EXISTS`, `IF EXISTS`).
- **Prefer additive changes** — `ALTER TABLE ADD COLUMN`, new tables, new op types. These don't break older app versions on other devices.
- **Avoid destructive changes** — renaming or dropping columns breaks peers that haven't updated yet.
- **Table constraint changes** — SQLite can't `ALTER TABLE ADD CONSTRAINT`. Use the create-copy-drop-rename pattern (see migration 1 as an example).
- **New CRDT op types** — older peers should store unknown ops (forward-compatible), not reject them. When that peer updates, the ops are already there.

## Existing Migrations

| Version | Description |
| ------- | ----------- |
| 1       | Add `UNIQUE(page_id, peer_id, counter)` constraint to `ops` table |
| 2       | Add `avatar` column to `space_members` table |
| 3       | Drop `snapshots` table (version history derived from ops) |
| 4       | Rename ops columns: `page_id` → `scope_id`, `counter` → `clock`. Fix `timestamp` to be wall-clock only (reset counter-based values to 0) |
