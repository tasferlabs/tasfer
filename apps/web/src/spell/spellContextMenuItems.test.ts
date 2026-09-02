import { describe, expect, it, vi } from "vitest";
import type { FlagRef } from "@tasfer/spell";
import {
  buildSpellMenuItems,
  spellMenuItems,
  type SpellMenuHandle,
  type SpellMenuT,
} from "./spellContextMenuItems";

const t: SpellMenuT = (_key, defaultValue) => defaultValue;

const flag: FlagRef = {
  from: 4,
  to: 9,
  word: "teh",
  script: "latn",
  blockId: "b1",
  version: 1,
  range: {
    from: { block: "b1", offset: 4 },
    to: { block: "b1", offset: 9 },
  } as unknown as FlagRef["range"],
};

function fakeHandle(
  suggestions: Promise<string[]>,
  atCaret: FlagRef | null = flag,
) {
  const handle: SpellMenuHandle = {
    flagAtCaret: vi.fn(() => atCaret),
    suggest: vi.fn(() => suggestions),
    apply: vi.fn(),
    addToDictionary: vi.fn(),
    ignoreOnce: vi.fn(),
    ignoreInDocument: vi.fn(),
  };
  return handle;
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("buildSpellMenuItems", () => {
  it("lists at most five suggestions, then add / ignore / ignore-on-page", () => {
    const handle = fakeHandle(Promise.resolve([]));
    const items = buildSpellMenuItems(
      handle,
      flag,
      ["the", "tea", "ten", "tech", "tee", "teak"],
      t,
    );
    expect(ids(items)).toEqual([
      "spell-suggest-0",
      "spell-suggest-1",
      "spell-suggest-2",
      "spell-suggest-3",
      "spell-suggest-4",
      "spell-add",
      "spell-ignore",
      "spell-ignore-page",
    ]);
    expect(items[0].label).toBe("the");
    items[1].action?.();
    expect(handle.apply).toHaveBeenCalledWith(flag, "tea");
    items[5].action?.();
    expect(handle.addToDictionary).toHaveBeenCalledWith(flag);
    items[6].action?.();
    expect(handle.ignoreOnce).toHaveBeenCalledWith(flag);
    items[7].action?.();
    expect(handle.ignoreInDocument).toHaveBeenCalledWith(flag);
  });

  it("shows an inert pending row while suggestions are unknown", () => {
    const items = buildSpellMenuItems(
      fakeHandle(Promise.resolve([])),
      flag,
      null,
      t,
    );
    expect(ids(items)[0]).toBe("spell-looking-up");
    expect(items[0].action).toBeUndefined();
    expect(items[0].disabled).toBeFalsy();
    expect(items[0].label).toBe("Looking up…");
  });

  it("shows an inert 'no suggestions' row for an empty list", () => {
    const items = buildSpellMenuItems(
      fakeHandle(Promise.resolve([])),
      flag,
      [],
      t,
    );
    expect(ids(items)).toEqual([
      "spell-none",
      "spell-add",
      "spell-ignore",
      "spell-ignore-page",
    ]);
    expect(items[0].action).toBeUndefined();
  });
});

describe("spellMenuItems", () => {
  it("resolves empty when no word is flagged at the caret", async () => {
    const handle = fakeHandle(Promise.resolve(["x"]), null);
    expect(
      await spellMenuItems(handle, t, { awaitSuggestionsMs: null }),
    ).toEqual([]);
    expect(handle.suggest).not.toHaveBeenCalled();
  });

  it("web mode: returns the pending row at once and reports the final group later", async () => {
    let resolve!: (s: string[]) => void;
    const pending = new Promise<string[]>((r) => (resolve = r));
    const handle = fakeHandle(pending);
    const onResolve = vi.fn();
    const first = await spellMenuItems(handle, t, {
      awaitSuggestionsMs: null,
      onResolve,
    });
    expect(ids(first)[0]).toBe("spell-looking-up");
    expect(onResolve).not.toHaveBeenCalled();
    resolve(["the"]);
    await pending;
    await Promise.resolve();
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(ids(onResolve.mock.calls[0][0])).toEqual([
      "spell-suggest-0",
      "spell-add",
      "spell-ignore",
      "spell-ignore-page",
    ]);
  });

  it("web mode: an already-cached lookup skips the pending row", async () => {
    const handle = fakeHandle(Promise.resolve(["the"]));
    const items = await spellMenuItems(handle, t, { awaitSuggestionsMs: null });
    expect(ids(items)[0]).toBe("spell-suggest-0");
  });

  it("native mode: waits up to the cap, then presents without a dead pending row", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<string[]>(() => {});
      const handle = fakeHandle(never);
      const result = spellMenuItems(handle, t, { awaitSuggestionsMs: 150 });
      await vi.advanceTimersByTimeAsync(150);
      expect(ids(await result)).toEqual([
        "spell-add",
        "spell-ignore",
        "spell-ignore-page",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("native mode: suggestions inside the cap are included", async () => {
    const handle = fakeHandle(Promise.resolve(["the", "tea"]));
    const items = await spellMenuItems(handle, t, { awaitSuggestionsMs: 150 });
    expect(ids(items)).toEqual([
      "spell-suggest-0",
      "spell-suggest-1",
      "spell-add",
      "spell-ignore",
      "spell-ignore-page",
    ]);
  });

  it("uses an explicit flag over the caret word", async () => {
    const other: FlagRef = { ...flag, word: "wrold", from: 20, to: 25 };
    const handle = fakeHandle(Promise.resolve(["world"]));
    const items = await spellMenuItems(handle, t, {
      awaitSuggestionsMs: 150,
      flag: other,
    });
    expect(handle.flagAtCaret).not.toHaveBeenCalled();
    expect(handle.suggest).toHaveBeenCalledWith(other);
    items[0].action?.();
    expect(handle.apply).toHaveBeenCalledWith(other, "world");
  });
});
