import { describe, expect, it } from "vitest";
import {
  buildSpaceHistory,
  changeTime,
  type SpaceHistoryContext,
  type StoredSpaceOp,
} from "./space-history";
import type { SpaceOperation } from "./types";

const ME = "me-laptop";
const MY_PHONE = "me-phone";
const SARA = "sara-laptop";
const SARA_PHONE = "sara-phone";

let stored = 1_000;
function row(
  peerId: string,
  counter: number,
  partial: Record<string, unknown> & { op: string },
): StoredSpaceOp {
  stored += 1_000;
  return {
    op: {
      ...partial,
      id: `${peerId}:${counter}`,
      clock: { counter, peerId },
      spaceId: "s1",
    } as SpaceOperation,
    storedAt: stored,
  };
}

function ctx(ops: StoredSpaceOp[], extra: Partial<SpaceHistoryContext> = {}) {
  return {
    spaceId: "s1",
    personal: false,
    ops,
    memberNames: new Map([
      [ME, "Me"],
      [SARA, "Sara"],
    ]),
    deviceRoots: new Map([
      [ME, "me-root"],
      [MY_PHONE, "me-root"],
      [SARA, "sara-root"],
      [SARA_PHONE, "sara-root"],
    ]),
    deviceNotes: new Map(),
    ownKeys: new Set([ME]),
    ownRoot: "me-root",
    ...extra,
  } satisfies SpaceHistoryContext;
}

describe("buildSpaceHistory", () => {
  it("reads creation, renames and joins from the log", () => {
    const history = buildSpaceHistory(
      ctx([
        row(ME, 1, { op: "space_set", field: "name", value: "Work" }),
        row(ME, 2, { op: "member_add", publicKey: ME, name: "Me" }),
        row(ME, 3, { op: "member_add", publicKey: SARA, name: "S" }),
        row(SARA, 4, { op: "space_set", field: "name", value: "Office" }),
      ]),
    );
    expect(history.map((e) => e.kind)).toEqual([
      "created",
      "memberJoined",
      "renamed",
    ]);
    expect(history[0]).toMatchObject({ name: "Work", byYou: true });
    // The current member name wins over the one the op was written with.
    expect(history[1]).toMatchObject({ memberName: "Sara", name: "Work" });
    expect(history[2]).toMatchObject({
      from: "Work",
      to: "Office",
      byName: "Sara",
      byYou: false,
    });
  });

  it("shows each person joining once, however many devices they add", () => {
    const history = buildSpaceHistory(
      ctx([
        row(ME, 1, { op: "space_set", field: "name", value: "Work" }),
        row(ME, 2, { op: "member_add", publicKey: ME, name: "Me" }),
        row(ME, 3, { op: "member_add", publicKey: MY_PHONE, name: "Me" }),
        row(SARA, 4, { op: "member_add", publicKey: SARA, name: "Sara" }),
        row(SARA, 5, { op: "member_add", publicKey: SARA_PHONE, name: "Sara" }),
      ]),
    );
    expect(history.map((e) => e.kind)).toEqual(["created", "memberJoined"]);
  });

  it("tells which device joined, only for this person's own devices", () => {
    const history = buildSpaceHistory(
      ctx(
        [
          row(SARA, 1, { op: "space_set", field: "name", value: "Work" }),
          row(SARA, 2, { op: "member_add", publicKey: SARA, name: "Sara" }),
          row(SARA, 3, { op: "member_add", publicKey: ME, name: "Me" }),
          row(ME, 4, {
            op: "member_add",
            publicKey: "tom-laptop",
            name: "Tom",
          }),
        ],
        {
          deviceNotes: new Map([
            [ME, "  Work laptop "],
            ["tom-laptop", "Not mine to label"],
          ]),
        },
      ),
    );
    expect(history.map((e) => e.kind)).toEqual([
      "created",
      "memberJoined",
      "memberJoined",
    ]);
    expect(history[1]).toMatchObject({
      memberKey: ME,
      memberNote: "Work laptop",
    });
    expect(history[2]).toMatchObject({ memberNote: null });
  });

  it("folds the personal flag written at creation into the creation", () => {
    const history = buildSpaceHistory(
      ctx(
        [
          row(ME, 1, { op: "space_set", field: "name", value: "Notes" }),
          row(ME, 2, { op: "space_set", field: "personal", value: true }),
          row(ME, 3, { op: "member_add", publicKey: ME, name: "Me" }),
        ],
        { personal: true },
      ),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: "created", personal: true });
  });

  it("shows a later conversion to personal, once", () => {
    const history = buildSpaceHistory(
      ctx([
        row(ME, 1, { op: "space_set", field: "name", value: "Notes" }),
        row(ME, 2, { op: "member_add", publicKey: ME, name: "Me" }),
        row(ME, 3, { op: "space_set", field: "personal", value: true }),
        row(MY_PHONE, 4, { op: "space_set", field: "personal", value: true }),
      ]),
    );
    expect(history.map((e) => e.kind)).toEqual(["created", "madePersonal"]);
    expect(history[1]).toMatchObject({ name: "Notes", byYou: true });
  });

  it("skips a rename to the name the space already has", () => {
    const history = buildSpaceHistory(
      ctx([
        row(ME, 1, { op: "space_set", field: "name", value: "Work" }),
        row(SARA, 2, { op: "space_set", field: "name", value: "Work" }),
      ]),
    );
    expect(history.map((e) => e.kind)).toEqual(["created"]);
  });

  it("hides members of a personal space who are not this person's", () => {
    const history = buildSpaceHistory(
      ctx(
        [
          row(ME, 1, { op: "space_set", field: "name", value: "Notes" }),
          row(SARA, 2, { op: "member_add", publicKey: SARA, name: "Sara" }),
        ],
        { personal: true },
      ),
    );
    expect(history.map((e) => e.kind)).toEqual(["created"]);
  });
});

describe("changeTime", () => {
  const base = row(ME, 1, { op: "space_set", field: "name", value: "Work" });

  it("uses the author's time when the op carries one", () => {
    expect(changeTime({ ...base, op: { ...base.op, at: 500 } })).toBe(500);
  });

  it("falls back to when this replica stored an older op", () => {
    expect(changeTime(base)).toBe(base.storedAt);
  });

  it("never places a change after it arrived", () => {
    const future = { ...base, op: { ...base.op, at: base.storedAt + 60_000 } };
    expect(changeTime(future)).toBe(base.storedAt);
  });
});
