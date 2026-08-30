import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetParent,
  getLastParent,
  getRecentParents,
  PREFILL_FRESH_MS,
  recordParentUse,
} from "./parentUsage";

// The module talks to `localStorage`; the node test environment has none.
function installStorage() {
  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } satisfies Partial<Storage> as Storage;
}

const DAY = 86_400_000;
const page = (id: string, parentId: string | null = null) => ({
  id,
  parentId,
  path: [],
});

describe("parentUsage", () => {
  beforeEach(installStorage);

  it("ranks a frequently used parent above a once-used newer one", () => {
    const now = 1_000 * DAY;
    for (let i = 0; i < 5; i++) {
      recordParentUse("s1", page("work"), now - DAY);
    }
    recordParentUse("s1", page("errands"), now);

    const recents = getRecentParents("s1", { now });
    expect(recents.map((r) => r.id)).toEqual(["work", "errands"]);
    expect(recents[0]!.count).toBe(5);
  });

  it("lets a stale favourite decay behind what is used now", () => {
    const now = 1_000 * DAY;
    for (let i = 0; i < 4; i++) {
      recordParentUse("s1", page("old"), now - 60 * DAY);
    }
    for (let i = 0; i < 2; i++) {
      recordParentUse("s1", page("current"), now);
    }

    expect(getRecentParents("s1", { now }).map((r) => r.id)).toEqual([
      "current",
      "old",
    ]);
  });

  it("keeps spaces apart", () => {
    const now = 1_000 * DAY;
    recordParentUse("s1", page("a"), now);
    recordParentUse("s2", page("b"), now);

    expect(getRecentParents("s1", { now }).map((r) => r.id)).toEqual(["a"]);
    expect(getRecentParents("s2", { now }).map((r) => r.id)).toEqual(["b"]);
  });

  it("remembers the parent's own parent and ancestor chain", () => {
    const now = 1_000 * DAY;
    recordParentUse(
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

    const [entry] = getRecentParents("s1", { now });
    expect(entry!.parentId).toBe("team");
    expect(entry!.path.map((p) => p.id)).toEqual(["work", "team"]);
  });

  it("pre-fills the last parent only while the choice is fresh", () => {
    const now = 1_000 * DAY;
    recordParentUse("s1", page("work"), now);

    expect(getLastParent("s1", now)?.id).toBe("work");
    expect(getLastParent("s1", now + PREFILL_FRESH_MS - 1)?.id).toBe("work");
    expect(getLastParent("s1", now + PREFILL_FRESH_MS + 1)).toBeNull();
  });

  it("pre-fills the most recent parent, not the most used one", () => {
    const now = 1_000 * DAY;
    for (let i = 0; i < 9; i++)
      recordParentUse("s1", page("work"), now - 1_000);
    recordParentUse("s1", page("errands"), now);

    expect(getLastParent("s1", now)?.id).toBe("errands");
  });

  it("keeps the last-used parent in the row even when it is outscored", () => {
    const now = 1_000 * DAY;
    // Three long-standing favourites, then a page used once just now.
    for (const id of ["a", "b", "c"]) {
      for (let i = 0; i < 8; i++) recordParentUse("s1", page(id), now - 1_000);
    }
    recordParentUse("s1", page("just-now"), now);

    const row = getRecentParents("s1", { now, limit: 3 });
    expect(row.length).toBe(3);
    expect(row.map((r) => r.id)).toContain("just-now");
  });

  it("forgets a parent that no longer exists", () => {
    const now = 1_000 * DAY;
    recordParentUse("s1", page("gone"), now);
    recordParentUse("s1", page("kept"), now);

    forgetParent("s1", "gone");

    expect(getRecentParents("s1", { now }).map((r) => r.id)).toEqual(["kept"]);
  });

  it("caps how many parents one space keeps", () => {
    const now = 1_000 * DAY;
    for (let i = 0; i < 40; i++) {
      recordParentUse("s1", page(`p${i}`), now - i * 1_000);
    }

    expect(getRecentParents("s1", { now, limit: 100 }).length).toBe(24);
  });

  it("survives unusable storage", () => {
    (globalThis as any).localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };

    expect(() => recordParentUse("s1", page("work"))).not.toThrow();
    expect(getRecentParents("s1")).toEqual([]);
    expect(getLastParent("s1")).toBeNull();
  });
});
