/**
 * The sidebar lists spaces in the order `spaces.list` returns them until the
 * person drags one. That order used to be `created_at` — when the space reached
 * THIS device — so two devices that received the same spaces in a different
 * order listed them differently. It is now the author's creation time, which
 * travels in the op log and is the same everywhere.
 */

import { describe, expect, it } from "vitest";
import { Engine } from "./engine";
import { memoryEngine as device } from "./memoryEngine.testing";
import type { SpaceOperation } from "./types";

const AUTHOR = "author-key";

/** The ops a space's author emits on creation, plus our device's membership. */
function spaceOps(
  spaceId: string,
  name: string,
  at: number | undefined,
  member: string,
): SpaceOperation[] {
  return [
    {
      op: "space_set",
      field: "name",
      value: name,
      id: `${AUTHOR}:1`,
      clock: { counter: 1, peerId: AUTHOR },
      spaceId,
      ...(at === undefined ? {} : { at }),
    },
    {
      op: "member_add",
      publicKey: member,
      name: "Me",
      id: `${AUTHOR}:2`,
      clock: { counter: 2, peerId: AUTHOR },
      spaceId,
      at: (at ?? 0) + 1,
    },
  ] as SpaceOperation[];
}

const SPACES = [
  { id: "sp-untitled", name: "Untitled", at: 1_000 },
  { id: "sp-one", name: "1", at: 2_000 },
  { id: "sp-two", name: "2", at: 3_000 },
];

async function names(engine: Engine): Promise<string[]> {
  return (await engine.spaces.list()).map((s) => s.name);
}

describe("space list order", () => {
  it("is the same on devices that received the spaces in different orders", async () => {
    const phone = await device();
    const laptop = await device();

    for (const s of SPACES) {
      await phone.engine.handleRemoteSpaceOps(
        s.id,
        spaceOps(s.id, s.name, s.at, phone.publicKey),
      );
    }
    for (const s of [...SPACES].reverse()) {
      await laptop.engine.handleRemoteSpaceOps(
        s.id,
        spaceOps(s.id, s.name, s.at, laptop.publicKey),
      );
    }

    expect(await names(phone.engine)).toEqual(["Untitled", "1", "2"]);
    expect(await names(laptop.engine)).toEqual(["Untitled", "1", "2"]);
  });

  it("does not move a space when it is renamed or someone joins it later", async () => {
    const d = await device();
    for (const s of SPACES) {
      await d.engine.handleRemoteSpaceOps(
        s.id,
        spaceOps(s.id, s.name, s.at, d.publicKey),
      );
    }
    await d.engine.handleRemoteSpaceOps("sp-untitled", [
      {
        op: "space_set",
        field: "name",
        value: "Renamed",
        id: `${AUTHOR}:3`,
        clock: { counter: 3, peerId: AUTHOR },
        spaceId: "sp-untitled",
        at: 9_000,
      },
    ] as SpaceOperation[]);

    expect(await names(d.engine)).toEqual(["Renamed", "1", "2"]);
  });

  it("lists spaces made before ops carried a time first, by id", async () => {
    const a = await device();
    const b = await device();
    const legacy = [
      { id: "sp-old-b", name: "Old B", at: undefined },
      { id: "sp-old-a", name: "Old A", at: undefined },
    ];
    for (const s of [...SPACES, ...legacy]) {
      await a.engine.handleRemoteSpaceOps(
        s.id,
        spaceOps(s.id, s.name, s.at, a.publicKey),
      );
    }
    for (const s of [...legacy, ...SPACES].reverse()) {
      await b.engine.handleRemoteSpaceOps(
        s.id,
        spaceOps(s.id, s.name, s.at, b.publicKey),
      );
    }

    const expected = ["Old A", "Old B", "Untitled", "1", "2"];
    expect(await names(a.engine)).toEqual(expected);
    expect(await names(b.engine)).toEqual(expected);
  });

  it("orders a space created on this device by its own creation time", async () => {
    const d = await device();
    await d.engine.handleRemoteSpaceOps(
      "sp-future",
      spaceOps("sp-future", "Future", Date.now() + 60_000, d.publicKey),
    );
    await d.engine.spaces.create("Mine");
    await d.engine.handleRemoteSpaceOps(
      "sp-past",
      spaceOps("sp-past", "Past", 1_000, d.publicKey),
    );

    expect(await names(d.engine)).toEqual(["Past", "Mine", "Future"]);
  });

  it("backfills the creation time for spaces already on an upgraded device", async () => {
    const d = await device();
    for (const s of [...SPACES].reverse()) {
      await d.engine.handleRemoteSpaceOps(
        s.id,
        spaceOps(s.id, s.name, s.at, d.publicKey),
      );
    }
    // Back to a database from before the column existed.
    await d.driver.db.exec(`
      CREATE TABLE spaces_old AS
        SELECT id, name, archived_at, archive_stamp, archive_by, created_at, personal
          FROM spaces;
      DROP TABLE spaces;
      ALTER TABLE spaces_old RENAME TO spaces;
    `);

    const upgraded = new Engine(d.driver);
    await upgraded.init();

    expect(await names(upgraded)).toEqual(["Untitled", "1", "2"]);
  });
});
