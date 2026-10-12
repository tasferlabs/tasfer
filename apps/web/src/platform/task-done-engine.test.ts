/**
 * A task ticked off on the calendar: stored on the page, read back by the
 * calendar and the page itself, the same on a device that only received the
 * ops, and kept when the task moves to another space.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { DbDriver, DbRow, Driver } from "./driver";
import { WebCryptoDriver } from "./adapters/web-crypto";
import { Engine } from "./engine";
import type { SpaceOperation } from "./types";

function memoryDb(): DbDriver {
  const db = new DatabaseSync(":memory:");
  const bind = (params: unknown[] = []) =>
    params.map((p) => (typeof p === "boolean" ? Number(p) : p)) as never[];
  const driver: DbDriver = {
    query: async <T extends DbRow = DbRow>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...bind(params)) as T[],
    mutate: async (sql, params) => {
      const r = db.prepare(sql).run(...bind(params));
      return {
        changes: Number(r.changes),
        lastInsertRowId: Number(r.lastInsertRowid),
      };
    },
    exec: async (sql) => {
      db.exec(sql);
    },
    transaction: async (fn) => {
      db.exec("BEGIN");
      try {
        const out = await fn(driver);
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return driver;
}

async function device(): Promise<{
  engine: Engine;
  publicKey: string;
  driver: Driver;
}> {
  const driver: Driver = {
    db: memoryDb(),
    fs: {
      read: async () => null,
      write: async () => {},
      delete: async () => {},
      list: async () => [],
      exists: async () => false,
    },
    crypto: new WebCryptoDriver(),
    network: {
      setLocalId: () => {},
      registerTopicKey: () => {},
      unregisterTopicKey: () => {},
      join: async () => {
        throw new Error("offline");
      },
      destroy: async () => {},
    },
    basePath: "test",
  };
  const engine = new Engine(driver);
  await engine.init();
  const { publicKey } = await engine.identity.get();
  return { engine, publicKey, driver };
}

const AUTHOR = "author-key";
const SPACE = "sp-cal";
let counter = 0;

function op(partial: Record<string, unknown>): SpaceOperation {
  counter++;
  return {
    ...partial,
    id: `${AUTHOR}:${counter}`,
    clock: { counter, peerId: AUTHOR },
    spaceId: SPACE,
    at: 1_000 + counter,
  } as SpaceOperation;
}

async function joinedDevice() {
  const d = await device();
  await d.engine.handleRemoteSpaceOps(SPACE, [
    op({ op: "space_set", field: "name", value: "Cal" }),
    op({ op: "member_add", publicKey: d.publicKey, name: "Me" }),
  ]);
  return d;
}

const DAY = 86_400_000;
const WEEK_START = Date.parse("2026-10-12T00:00:00Z"); // Monday

describe("task done", () => {
  it("ticks a task off and back on", async () => {
    const { engine } = await joinedDevice();
    const page = await engine.pages.create({
      title: "Call the bank",
      parentId: null,
      spaceId: SPACE,
      scheduledAt: "2026-10-13T09:00:00.000Z",
      duration: 30,
      task: true,
    });
    const week = () => engine.pages.calendar(WEEK_START, WEEK_START + 7 * DAY);

    expect((await week())[0].done).toBe(false);
    await engine.pages.update({ id: page.id, done: true });
    expect((await week())[0].done).toBe(true);
    expect((await engine.pages.get(page.id)).done).toBe(true);

    await engine.pages.update({ id: page.id, done: false });
    expect((await week())[0].done).toBe(false);
  });

  it("shows done from replicated ops", async () => {
    const { engine } = await joinedDevice();
    await engine.handleRemoteSpaceOps(SPACE, [
      op({
        op: "page_add",
        pageId: "task1",
        parentId: null,
        order: 1,
        task: true,
        scheduledAt: "2026-10-13T09:00:00.000Z",
        duration: 30,
      }),
      op({ op: "page_set", pageId: "task1", field: "done", value: true }),
    ]);
    const [entry] = await engine.pages.calendar(
      WEEK_START,
      WEEK_START + 7 * DAY,
    );
    expect(entry.done).toBe(true);
  });

  it("stays done when moved to another space", async () => {
    const { engine } = await joinedDevice();
    const page = await engine.pages.create({
      title: "Renew passport",
      parentId: null,
      spaceId: SPACE,
      scheduledAt: "2026-10-13T09:00:00.000Z",
      task: true,
    });
    await engine.pages.update({ id: page.id, done: true });
    const other = await engine.spaces.create("Other");

    const movedId = await engine.pages.recreateInSpace({
      sourceId: page.id,
      spaceId: other.id,
      parentId: null,
    });
    expect((await engine.pages.get(movedId)).done).toBe(true);
  });
});
