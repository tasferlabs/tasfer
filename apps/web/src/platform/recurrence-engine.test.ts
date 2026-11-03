/**
 * Repeating events through the engine: occurrences worked out on read, one
 * occurrence moved or cancelled without touching the rest, notes forked on
 * first write, a series split for "this and following", and the same calendar
 * on a device that only received the ops.
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

async function starts(engine: Engine, from = WEEK_START, days = 7) {
  return (await engine.pages.calendar(from, from + days * DAY - 1)).map(
    (e) => e.scheduledAt,
  );
}

describe("repeating events", () => {
  it("lists every occurrence in range, and changes one at a time", async () => {
    const { engine } = await joinedDevice();
    const page = await engine.pages.create({
      title: "Standup",
      parentId: null,
      spaceId: SPACE,
      scheduledAt: "2026-10-12T09:00:00.000Z",
      duration: 15,
      recurrence: "FREQ=DAILY;TZID=UTC",
    });
    expect(await starts(engine)).toHaveLength(7);

    await engine.pages.updateOccurrence({
      seriesId: page.id,
      occurrenceStart: "2026-10-13T09:00:00.000Z",
      scheduledAt: "2026-10-13T11:00:00.000Z",
    });
    await engine.pages.updateOccurrence({
      seriesId: page.id,
      occurrenceStart: "2026-10-14T09:00:00.000Z",
      cancelled: true,
    });
    const week = await engine.pages.calendar(
      WEEK_START,
      WEEK_START + 7 * DAY - 1,
    );
    expect(week.map((e) => e.scheduledAt)).toEqual([
      "2026-10-12T09:00:00.000Z",
      "2026-10-13T11:00:00.000Z",
      "2026-10-15T09:00:00.000Z",
      "2026-10-16T09:00:00.000Z",
      "2026-10-17T09:00:00.000Z",
      "2026-10-18T09:00:00.000Z",
    ]);
    expect(new Set(week.map((e) => e.id)).size).toBe(6);
    expect(
      week.every((e) => e.seriesId === page.id && e.pageId === page.id),
    ).toBe(true);
  });

  it("shows an occurrence moved in from outside the range", async () => {
    const { engine } = await joinedDevice();
    const page = await engine.pages.create({
      title: "Weekly",
      parentId: null,
      spaceId: SPACE,
      scheduledAt: "2026-10-05T09:00:00.000Z",
      recurrence: "FREQ=WEEKLY;TZID=UTC",
    });
    // Next week's occurrence pulled back into this week.
    await engine.pages.updateOccurrence({
      seriesId: page.id,
      occurrenceStart: "2026-10-19T09:00:00.000Z",
      scheduledAt: "2026-10-17T09:00:00.000Z",
    });
    expect(await starts(engine)).toEqual([
      "2026-10-12T09:00:00.000Z",
      "2026-10-17T09:00:00.000Z",
    ]);
  });

  it("gives an occurrence its own notes page, once", async () => {
    const { engine } = await joinedDevice();
    const page = await engine.pages.create({
      title: "Standup",
      parentId: null,
      spaceId: SPACE,
      scheduledAt: "2026-10-12T09:00:00.000Z",
      recurrence: "FREQ=DAILY;TZID=UTC",
    });
    const key = "2026-10-13T09:00:00.000Z";
    const fork = await engine.pages.forkOccurrence(page.id, key);
    expect(await engine.pages.forkOccurrence(page.id, key)).toBe(fork);

    const forked = await engine.pages.get(fork);
    expect(forked.parentId).toBe(page.id);
    expect(forked.recurrenceId).toBe(page.id);
    expect(forked.recurrenceStart).toBe(key);
    expect(forked.scheduledAt).toBeNull();

    const week = await engine.pages.calendar(
      WEEK_START,
      WEEK_START + 7 * DAY - 1,
    );
    const tuesday = week.find((e) => e.occurrenceStart === key)!;
    expect(tuesday.id).toBe(fork);
    expect(tuesday.pageId).toBe(fork);
    expect(week.filter((e) => e.pageId === page.id)).toHaveLength(6);
  });

  it("splits a series for this and following, taking later changes along", async () => {
    const { engine } = await joinedDevice();
    const page = await engine.pages.create({
      title: "Standup",
      parentId: null,
      spaceId: SPACE,
      scheduledAt: "2026-10-12T09:00:00.000Z",
      recurrence: "FREQ=DAILY;COUNT=7;TZID=UTC",
    });
    await engine.pages.updateOccurrence({
      seriesId: page.id,
      occurrenceStart: "2026-10-17T09:00:00.000Z",
      cancelled: true,
    });
    const next = await engine.pages.splitSeries(
      page.id,
      "2026-10-15T09:00:00.000Z",
    );
    expect(next).not.toBe(page.id);

    const week = await engine.pages.calendar(
      WEEK_START,
      WEEK_START + 14 * DAY - 1,
    );
    expect(week.filter((e) => e.seriesId === page.id)).toHaveLength(3);
    // Four left of seven, one of them cancelled.
    expect(
      week.filter((e) => e.seriesId === next).map((e) => e.scheduledAt),
    ).toEqual([
      "2026-10-15T09:00:00.000Z",
      "2026-10-16T09:00:00.000Z",
      "2026-10-18T09:00:00.000Z",
    ]);
  });

  it("moves changes and notes along when the whole series moves", async () => {
    const { engine } = await joinedDevice();
    const page = await engine.pages.create({
      title: "Standup",
      parentId: null,
      spaceId: SPACE,
      scheduledAt: "2026-10-12T09:00:00.000Z",
      recurrence: "FREQ=DAILY;TZID=UTC",
    });
    await engine.pages.updateOccurrence({
      seriesId: page.id,
      occurrenceStart: "2026-10-14T09:00:00.000Z",
      cancelled: true,
    });
    const fork = await engine.pages.forkOccurrence(
      page.id,
      "2026-10-13T09:00:00.000Z",
    );
    await engine.pages.update({
      id: page.id,
      scheduledAt: "2026-10-12T10:00:00.000Z",
    });

    const week = await engine.pages.calendar(
      WEEK_START,
      WEEK_START + 7 * DAY - 1,
    );
    expect(week.map((e) => e.scheduledAt)).not.toContain(
      "2026-10-14T10:00:00.000Z",
    );
    expect(week).toHaveLength(6);
    expect(week.find((e) => e.pageId === fork)?.scheduledAt).toBe(
      "2026-10-13T10:00:00.000Z",
    );
  });

  it("builds the same calendar from replicated ops", async () => {
    const { engine } = await joinedDevice();
    await engine.handleRemoteSpaceOps(SPACE, [
      op({
        op: "page_add",
        pageId: "series1",
        parentId: null,
        order: 1,
        scheduledAt: "2026-10-12T09:00:00.000Z",
        duration: 30,
      }),
      op({
        op: "page_set",
        pageId: "series1",
        field: "recurrence",
        value: "FREQ=WEEKLY;BYDAY=MO,WE;TZID=UTC",
      }),
      op({
        op: "page_set",
        pageId: "series1",
        field: "occurrence.duration|2026-10-14T09:00:00.000Z",
        value: 90,
      }),
      op({
        op: "page_set",
        pageId: "series1",
        field: "occurrence.cancelled|2026-10-19T09:00:00.000Z",
        value: true,
      }),
    ]);
    const twoWeeks = await engine.pages.calendar(
      WEEK_START,
      WEEK_START + 14 * DAY - 1,
    );
    expect(twoWeeks.map((e) => [e.scheduledAt, e.duration])).toEqual([
      ["2026-10-12T09:00:00.000Z", 30],
      ["2026-10-14T09:00:00.000Z", 90],
      ["2026-10-21T09:00:00.000Z", 30],
    ]);
  });
});

describe("repeating tasks", () => {
  it("ticks off one occurrence at a time", async () => {
    const { engine } = await joinedDevice();
    const page = await engine.pages.create({
      title: "Water plants",
      parentId: null,
      spaceId: SPACE,
      task: true,
      scheduledAt: "2026-10-12T09:00:00.000Z",
      recurrence: "FREQ=DAILY;TZID=UTC",
    });
    // A done flag left on the series from before it repeated ticks off none.
    await engine.pages.update({ id: page.id, done: true });
    await engine.pages.updateOccurrence({
      seriesId: page.id,
      occurrenceStart: "2026-10-13T09:00:00.000Z",
      done: true,
    });
    const week = await engine.pages.calendar(
      WEEK_START,
      WEEK_START + 7 * DAY - 1,
    );
    expect(week.every((e) => e.task)).toBe(true);
    expect(week.filter((e) => e.done).map((e) => e.occurrenceStart)).toEqual([
      "2026-10-13T09:00:00.000Z",
    ]);
  });

  it("keeps occurrence notes and split series tasks, out of the tree", async () => {
    const { engine } = await joinedDevice();
    const page = await engine.pages.create({
      title: "Review",
      parentId: null,
      spaceId: SPACE,
      task: true,
      scheduledAt: "2026-10-12T09:00:00.000Z",
      recurrence: "FREQ=DAILY;TZID=UTC",
    });
    const fork = await engine.pages.forkOccurrence(
      page.id,
      "2026-10-13T09:00:00.000Z",
    );
    expect((await engine.pages.get(fork)).task).toBe(true);
    const next = await engine.pages.splitSeries(
      page.id,
      "2026-10-15T09:00:00.000Z",
    );
    expect((await engine.pages.get(next)).task).toBe(true);
    expect(await engine.pages.list(SPACE, null)).toEqual([]);

    // Back to a page: its notes come back into the tree with it.
    await engine.pages.update({ id: page.id, task: false });
    expect((await engine.pages.get(fork)).task).toBe(false);
  });

  it("builds per-occurrence done from replicated ops", async () => {
    const { engine } = await joinedDevice();
    await engine.handleRemoteSpaceOps(SPACE, [
      op({
        op: "page_add",
        pageId: "task1",
        parentId: null,
        order: 1,
        task: true,
        scheduledAt: "2026-10-12T09:00:00.000Z",
      }),
      op({
        op: "page_set",
        pageId: "task1",
        field: "recurrence",
        value: "FREQ=DAILY;COUNT=3;TZID=UTC",
      }),
      op({
        op: "page_set",
        pageId: "task1",
        field: "occurrence.done|2026-10-14T09:00:00.000Z",
        value: true,
      }),
    ]);
    const week = await engine.pages.calendar(
      WEEK_START,
      WEEK_START + 7 * DAY - 1,
    );
    expect(week.map((e) => e.done)).toEqual([false, false, true]);
  });
});
