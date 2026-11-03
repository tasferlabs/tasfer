import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetParent,
  getLastParent,
  getRecentParents,
  PARENT_USAGE_PREF_PREFIX,
  PREFILL_FRESH_MS,
  readLegacyParentUsage,
  recordParentUse,
} from "./parentUsage";
import { FakeOwnPrefs } from "./fakeOwnPrefs.testing";

let prefs: FakeOwnPrefs;

const DAY = 86_400_000;
const page = (id: string, parentId: string | null = null) => ({
  id,
  parentId,
  path: [],
});

describe("parentUsage", () => {
  beforeEach(() => {
    prefs = new FakeOwnPrefs("laptop");
  });

  it("ranks a frequently used parent above a once-used newer one", () => {
    const now = 1_000 * DAY;
    for (let i = 0; i < 5; i++) {
      recordParentUse(prefs, "s1", page("work"), now - DAY);
    }
    recordParentUse(prefs, "s1", page("errands"), now);

    const recents = getRecentParents(prefs, "s1", { now });
    expect(recents.map((r) => r.id)).toEqual(["work", "errands"]);
    expect(recents[0]!.count).toBe(5);
  });

  it("lets a stale favourite decay behind what is used now", () => {
    const now = 1_000 * DAY;
    for (let i = 0; i < 4; i++) {
      recordParentUse(prefs, "s1", page("old"), now - 60 * DAY);
    }
    for (let i = 0; i < 2; i++) {
      recordParentUse(prefs, "s1", page("current"), now);
    }

    expect(getRecentParents(prefs, "s1", { now }).map((r) => r.id)).toEqual([
      "current",
      "old",
    ]);
  });

  it("keeps spaces apart", () => {
    const now = 1_000 * DAY;
    recordParentUse(prefs, "s1", page("a"), now);
    recordParentUse(prefs, "s2", page("b"), now);

    expect(getRecentParents(prefs, "s1", { now }).map((r) => r.id)).toEqual([
      "a",
    ]);
    expect(getRecentParents(prefs, "s2", { now }).map((r) => r.id)).toEqual([
      "b",
    ]);
  });

  it("remembers the parent's own parent and ancestor chain", () => {
    const now = 1_000 * DAY;
    recordParentUse(
      prefs,
      "s1",
      {
        id: "standup",
        parentId: "team",
        path: [
          { id: "work", title: "Work" },
          { id: "team", title: "Team" },
        ],
      },
      now,
    );

    const [entry] = getRecentParents(prefs, "s1", { now });
    expect(entry!.parentId).toBe("team");
    expect(entry!.path.map((p) => p.id)).toEqual(["work", "team"]);
  });

  it("pre-fills the last parent only while the choice is fresh", () => {
    const now = 1_000 * DAY;
    recordParentUse(prefs, "s1", page("work"), now);

    expect(getLastParent(prefs, "s1", { now })?.id).toBe("work");
    expect(
      getLastParent(prefs, "s1", { now: now + PREFILL_FRESH_MS - 1 })?.id,
    ).toBe("work");
    expect(
      getLastParent(prefs, "s1", { now: now + PREFILL_FRESH_MS + 1 }),
    ).toBeNull();
  });

  it("pre-fills the most recent parent, not the most used one", () => {
    const now = 1_000 * DAY;
    for (let i = 0; i < 9; i++)
      recordParentUse(prefs, "s1", page("work"), now - 1_000);
    recordParentUse(prefs, "s1", page("errands"), now);

    expect(getLastParent(prefs, "s1", { now })?.id).toBe("errands");
  });

  it("keeps the last-used parent in the row even when it is outscored", () => {
    const now = 1_000 * DAY;
    // Three long-standing favourites, then a page used once just now.
    for (const id of ["a", "b", "c"]) {
      for (let i = 0; i < 8; i++)
        recordParentUse(prefs, "s1", page(id), now - 1_000);
    }
    recordParentUse(prefs, "s1", page("just-now"), now);

    const row = getRecentParents(prefs, "s1", { now, limit: 3 });
    expect(row.length).toBe(3);
    expect(row.map((r) => r.id)).toContain("just-now");
  });

  it("forgets a parent that no longer exists", () => {
    const now = 1_000 * DAY;
    recordParentUse(prefs, "s1", page("gone"), now);
    recordParentUse(prefs, "s1", page("kept"), now);

    forgetParent(prefs, "s1", "gone");

    expect(getRecentParents(prefs, "s1", { now }).map((r) => r.id)).toEqual([
      "kept",
    ]);
  });

  it("caps how many parents one space keeps", () => {
    const now = 1_000 * DAY;
    for (let i = 0; i < 40; i++) {
      recordParentUse(prefs, "s1", page(`p${i}`), now - i * 1_000);
    }

    expect(getRecentParents(prefs, "s1", { now, limit: 100 }).length).toBe(24);
  });

  it("ignores a malformed value synced from another device", () => {
    prefs.set(PARENT_USAGE_PREF_PREFIX + "s1.phone", {
      broken: { count: "lots" },
      kept: { count: 1, last: 5, parentId: null, path: [] },
    });

    expect(getRecentParents(prefs, "s1", { now: 10 }).map((r) => r.id)).toEqual(
      ["kept"],
    );
    prefs.set(PARENT_USAGE_PREF_PREFIX + "s1.phone", ["not", "a", "space"]);
    expect(getRecentParents(prefs, "s1")).toEqual([]);
  });

  it("writes one key per space and device", () => {
    recordParentUse(prefs, "s1", page("a"), 1);
    recordParentUse(prefs, "s2", page("b"), 1);

    expect(Object.keys(prefs.getSnapshot().values).sort()).toEqual([
      PARENT_USAGE_PREF_PREFIX + "s1.laptop",
      PARENT_USAGE_PREF_PREFIX + "s2.laptop",
    ]);
  });

  it("keeps both devices' counts when they file at the same time", () => {
    const phone = new FakeOwnPrefs("phone");
    const now = 1_000 * DAY;
    for (let i = 0; i < 3; i++) recordParentUse(prefs, "s1", page("work"), now);
    recordParentUse(phone, "s1", page("work"), now + 1);
    recordParentUse(phone, "s1", page("errands"), now + 2);

    // Neither saw the other's writes until now.
    prefs.syncFrom(phone);
    phone.syncFrom(prefs);

    for (const device of [prefs, phone]) {
      const recents = getRecentParents(device, "s1", { now: now + 2 });
      expect(recents.map((r) => [r.id, r.count])).toEqual([
        ["work", 4],
        ["errands", 1],
      ]);
      expect(getLastParent(device, "s1", { now: now + 2 })?.id).toBe("errands");
    }
  });

  it("forgets only on this device, and skips what another still holds", () => {
    const phone = new FakeOwnPrefs("phone");
    recordParentUse(prefs, "s1", page("gone"), 1);
    recordParentUse(phone, "s1", page("gone"), 1);
    recordParentUse(phone, "s1", page("kept"), 1);
    prefs.syncFrom(phone);

    forgetParent(prefs, "s1", "gone");

    // The phone's copy is still there until the phone notices too.
    expect(getRecentParents(prefs, "s1", { now: 1 }).map((r) => r.id)).toEqual([
      "gone",
      "kept",
    ]);
    expect(
      getRecentParents(prefs, "s1", { now: 1, skip: new Set(["gone"]) }).map(
        (r) => r.id,
      ),
    ).toEqual(["kept"]);
  });

  it("pre-fills the parent used before one known to be gone", () => {
    const now = 1_000 * DAY;
    recordParentUse(prefs, "s1", page("kept"), now - 1);
    recordParentUse(prefs, "s1", page("gone"), now);

    expect(
      getLastParent(prefs, "s1", { now, skip: new Set(["gone"]) })?.id,
    ).toBe("kept");
  });

  it("waits for the stored tally before counting a use", async () => {
    prefs.unload();
    recordParentUse(prefs, "s1", page("new"), 2);

    // The register lands with this device's earlier counts in it.
    prefs.load({
      [PARENT_USAGE_PREF_PREFIX + "s1.laptop"]: {
        old: { count: 3, last: 1, parentId: null, path: [] },
      },
    });
    await prefs.whenLoaded();
    await Promise.resolve();

    expect(
      getRecentParents(prefs, "s1", { now: 2 }).map((r) => [r.id, r.count]),
    ).toEqual([
      ["old", 3],
      ["new", 1],
    ]);
  });

  it("writes nothing until this device's key is known", () => {
    const unknown = new FakeOwnPrefs(null);
    recordParentUse(unknown, "s1", page("work"), 1);
    expect(unknown.getSnapshot().values).toEqual({});
  });

  it("adopts the old browser stats as this device's tally per space", () => {
    const legacy = JSON.stringify({
      s1: { a: { count: 2, last: 1, parentId: null, path: [] } },
      s2: { b: { count: 1, last: 1, parentId: null, path: [] } },
    });

    expect(readLegacyParentUsage(legacy, "laptop")).toEqual([
      [
        PARENT_USAGE_PREF_PREFIX + "s1.laptop",
        { a: { count: 2, last: 1, parentId: null, path: [] } },
      ],
      [
        PARENT_USAGE_PREF_PREFIX + "s2.laptop",
        { b: { count: 1, last: 1, parentId: null, path: [] } },
      ],
    ]);
  });
});
