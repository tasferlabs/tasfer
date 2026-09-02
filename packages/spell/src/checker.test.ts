import { anchorRange, findRawBlock } from "./anchor";
import { type FlagRef, SpellChecker, type SpellTransport } from "./checker";
import type { CheckBlock, CheckedBlock, CheckPriority, Flag } from "./protocol";
import { createHarness, type Harness } from "./test-harness";
import type { Decoration, RangeDecoration } from "@tasfer/editor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CheckCall {
  blocks: readonly CheckBlock[];
  priority: CheckPriority;
  resolve: (results: readonly CheckedBlock[]) => void;
}

/**
 * Set-backed transport: every Latin/Arabic word not in `known` is flagged,
 * skip spans honoured. `manual` holds results back until the test releases
 * them (for the stale-version scenario).
 */
function fakeTransport(
  known: Iterable<string>,
  opts: { manual?: boolean } = {},
) {
  const dict = new Set(known);
  const calls: CheckCall[] = [];
  const suggestCalls: string[] = [];
  const invalidators = new Set<(words?: readonly string[]) => void>();

  const flagsFor = (b: CheckBlock): Flag[] => {
    const out: Flag[] = [];
    const re = /[\p{L}\p{M}']+/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b.text))) {
      const from = m.index;
      const to = from + m[0].length;
      if (b.skip.some(([s, e]) => from < e && to > s)) continue;
      if (dict.has(m[0])) continue;
      const script = /\p{Script=Arabic}/u.test(m[0]) ? "arab" : "latn";
      out.push({ from, to, word: m[0], script });
    }
    return out;
  };
  const compute = (blocks: readonly CheckBlock[]): CheckedBlock[] =>
    blocks.map((b) => ({
      blockId: b.blockId,
      version: b.version,
      flags: flagsFor(b),
    }));

  const transport: SpellTransport = {
    check: (req) =>
      new Promise((resolve) => {
        const call: CheckCall = {
          blocks: req.blocks,
          priority: req.priority,
          resolve,
        };
        calls.push(call);
        if (!opts.manual) resolve(compute(req.blocks));
      }),
    suggest: (word) => {
      suggestCalls.push(word);
      return Promise.resolve([`${word}!`]);
    },
    onInvalidate: (cb) => {
      invalidators.add(cb);
      return () => invalidators.delete(cb);
    },
  };
  return {
    transport,
    calls,
    suggestCalls,
    compute,
    dict,
    invalidate: (words?: readonly string[]) =>
      invalidators.forEach((cb) => cb(words)),
  };
}

const KNOWN = [
  "Hello",
  "world",
  "here",
  "Another",
  "line",
  "Visit",
  "and",
  "is",
  "One",
  "Two",
  "Three",
  "the",
  "a",
  "typed",
  "هذا",
  "هنا",
];

describe("SpellChecker", () => {
  let h: Harness;
  let checker: SpellChecker | null = null;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    checker?.dispose();
    checker = null;
    h?.destroy();
    vi.useRealTimers();
  });

  function setup(
    markdown: string,
    t: ReturnType<typeof fakeTransport>,
    extra: Partial<ConstructorParameters<typeof SpellChecker>[0]> = {},
  ) {
    h = createHarness(markdown);
    spy = vi.spyOn(h.editor.view, "setDecorations");
    checker = new SpellChecker({
      editor: h.editor,
      doc: h.doc,
      docId: "doc-1",
      transport: t.transport,
      color: () => "#e00",
      isEnabled: () => true,
      ignoredInDocument: () => new Set(),
      flagAllCaps: () => false,
      lenientArabic: () => false,
      schedule: (cb) => setTimeout(cb, 0),
      ...extra,
    });
    return checker;
  }

  const lastDecos = (): readonly Decoration[] => {
    const call = spy.mock.calls.at(-1);
    return (call?.[1] as readonly Decoration[] | undefined) ?? [];
  };
  const settle = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  const type = (text: string) => {
    for (const ch of text) h.editor.change((c) => c.insertText(ch));
  };

  it("publishes char-anchored wavy underlines on the spell layer after start()", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("Hello wrold here\n\nAnothr line", t);
    c.start();
    await settle(10);
    expect(t.calls[0]?.priority).toBe("initial");
    const call = spy.mock.calls.at(-1)!;
    expect(call[0]).toBe("spell");
    const decos = lastDecos() as RangeDecoration[];
    expect(decos).toHaveLength(2);
    for (const d of decos) {
      expect(d.kind).toBe("range");
      expect(d.style).toEqual({ type: "underline", line: "wavy" });
      expect(d.color).toBe("#e00");
      expect(d.opacity).toBe(1);
      expect("afterCharId" in d.range.from).toBe(true);
      expect("afterCharId" in d.range.to).toBe(true);
    }
    const [b0] = h.blockIds;
    const raw = findRawBlock(h.doc.getRawBlocks(), b0)!;
    expect(decos[0].range).toEqual(anchorRange(raw, 6, 11));
    expect(c.count()).toBe(2);
    expect(c.flags().map((f) => f.word)).toEqual(["wrold", "Anothr"]);
  });

  it("drops a result whose version is stale", async () => {
    const t = fakeTransport(KNOWN, { manual: true });
    const c = setup("Hello wrold", t);
    c.start();
    await settle(0);
    expect(t.calls).toHaveLength(1);
    const stale = t.calls[0];
    // Edit the block before the result lands → its version moves on.
    h.editor.setCaret({ block: h.blockIds[0], offset: 0 });
    type("X");
    stale.resolve(t.compute(stale.blocks));
    await settle(0);
    expect(c.flags()).toHaveLength(0);
    // The edit queued a fresh caret-priority check; its result is accepted.
    await settle(130);
    const fresh = t.calls.at(-1)!;
    expect(fresh).not.toBe(stale);
    expect(fresh.priority).toBe("caret");
    fresh.resolve(t.compute(fresh.blocks));
    await settle(10);
    expect(c.flags().map((f) => f.word)).toEqual(["XHello", "wrold"]);
  });

  it("hides the word being typed, then reveals it after the grace period", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("Hello world", t, { caretGraceMs: 500 });
    c.start();
    await settle(10);
    expect(c.count()).toBe(0);
    h.editor.setCaret({ block: h.blockIds[0], offset: 11 });
    type(" wrold");
    // Debounced caret check lands, but the caret is still inside the word.
    await settle(130);
    expect(t.calls.at(-1)?.priority).toBe("caret");
    expect(c.flags()).toHaveLength(1); // known internally…
    expect(lastDecos()).toHaveLength(0); // …but not painted yet.
    await settle(400); // past the 500 ms grace
    expect(lastDecos()).toHaveLength(1);
    expect(c.count()).toBe(1);
  });

  it("does not hide the caret word when the caret got there by a move", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("Hello wrold here", t);
    c.start();
    await settle(10);
    expect(c.count()).toBe(1);
    h.editor.setCaret({ block: h.blockIds[0], offset: 8 });
    await settle(10);
    expect(lastDecos()).toHaveLength(1);
    expect(c.flagAt("caret")?.word).toBe("wrold");
  });

  it("flushes the caret block immediately after a boundary character", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("Hello world", t);
    c.start();
    await settle(10);
    const before = t.calls.length;
    h.editor.setCaret({ block: h.blockIds[0], offset: 11 });
    type(" wrold ");
    // No debounce wait: each space flushed the block at once (two spaces typed).
    expect(t.calls.length).toBe(before + 2);
    expect(t.calls.at(-1)?.priority).toBe("caret");
    await settle(10);
    // The caret sits after the space, outside the word → painted at once.
    expect(lastDecos()).toHaveLength(1);
    expect(c.count()).toBe(1);
  });

  it("removes a flag the instant the user types into its word", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("Hello wrold here", t);
    c.start();
    await settle(10);
    expect(c.count()).toBe(1);
    h.editor.setCaret({ block: h.blockIds[0], offset: 8 }); // inside "wrold"
    await settle(10);
    h.editor.change((cc) => cc.insertText("z"));
    // Synchronous: gone before any timer fires.
    expect(c.flags()).toHaveLength(0);
    await settle(0);
    expect(lastDecos()).toHaveLength(0);
  });

  it("dropWord removes matching flags across blocks synchronously", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("wrold one\n\ntwo wrold\n\nAnothr", t);
    c.start();
    await settle(10);
    expect(c.count()).toBe(5);
    c.dropWord("wrold");
    expect(c.flags().map((f) => f.word)).toEqual(["one", "two", "Anothr"]);
    await settle(0);
    expect(lastDecos()).toHaveLength(3);
    expect(c.count()).toBe(3);
  });

  it("next/prev walk flags in document order and wrap on request", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("aaa Hello bbb\n\nHello\n\nccc world ddd", t);
    c.start();
    await settle(10);
    // The Markdown parser keeps the blank separator paragraphs, so pick the
    // blocks by content rather than by index.
    const byText = (t: string) =>
      h.editor.query
        .blocks({ from: "start", to: "end" })
        .find((b) => b.text === t)!.id;
    const b0 = byText("aaa Hello bbb");
    const b2 = byText("ccc world ddd");
    const words = (f: FlagRef | null) => f?.word;
    expect(words(c.next({ block: b0, offset: 0 }))).toBe("bbb");
    expect(words(c.next({ block: b0, offset: 10 }))).toBe("ccc");
    expect(words(c.next({ block: b2, offset: 4 }))).toBe("ddd");
    expect(c.next({ block: b2, offset: 12 })).toBeNull();
    expect(words(c.next({ block: b2, offset: 12 }, true))).toBe("aaa");
    expect(words(c.prev({ block: b2, offset: 12 }))).toBe("ccc");
    expect(words(c.prev({ block: b2, offset: 0 }))).toBe("bbb");
    expect(c.prev({ block: b0, offset: 0 })).toBeNull();
    expect(words(c.prev({ block: b0, offset: 0 }, true))).toBe("ddd");
    expect(words(c.next("start"))).toBe("bbb");
    expect(words(c.prev("end"))).toBe("ccc");
  });

  it("sends link/code/math runs as skip spans and never flags inside them", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup(
      "Visit [wrold](https://example.com) and `wrold` here wrold",
      t,
    );
    c.start();
    await settle(10);
    const req = t.calls[0].blocks[0];
    expect(req.text).toBe("Visit wrold and wrold here wrold");
    expect(req.skip).toEqual([
      [6, 11],
      [16, 21],
    ]);
    expect(c.flags().map((f) => [f.from, f.to])).toEqual([[27, 32]]);
  });

  it("skips code and other non-prose blocks by type", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("Hello wrold\n\n```\nwrold wrold\n```\n\n---\n\nAnothr", t);
    c.start();
    await settle(10);
    const types = h.editor.query
      .blocks({ from: "start", to: "end" })
      .map((b) => b.type);
    expect(types).toContain("code");
    const requested = t.calls.flatMap((call) =>
      call.blocks.map((b) => b.blockId),
    );
    const code = h.editor.query
      .blocks({ from: "start", to: "end" })
      .find((b) => b.type === "code")!;
    expect(requested).not.toContain(code.id);
    expect(c.flags().map((f) => f.word)).toEqual(["wrold", "Anothr"]);
  });

  it("re-checks a block edited by a remote peer at remote priority", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("Hello world", t);
    c.start();
    await settle(10);
    expect(c.count()).toBe(0);
    const peer = createHarness(
      { bytes: h.doc.encodeState() },
      { peerId: "peer-b" },
    );
    try {
      peer.editor.setCaret({ block: peer.blockIds[0], offset: 11 });
      peer.editor.change((cc) => cc.insertText(" wrold"));
      const before = t.calls.length;
      h.receive(peer.localOps);
      expect(h.editor.query.block({ block: h.blockIds[0] })?.text).toBe(
        "Hello world wrold",
      );
      await settle(310);
      expect(t.calls.length).toBe(before + 1);
      expect(t.calls.at(-1)?.priority).toBe("remote");
      await settle(10);
      expect(c.flags().map((f) => f.word)).toEqual(["wrold"]);
      expect(lastDecos()).toHaveLength(1);
    } finally {
      peer.destroy();
    }
  });

  it("ignoreOnce hides one occurrence until the word changes", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("wrold and wrold", t);
    c.start();
    await settle(10);
    expect(c.count()).toBe(2);
    const first = c.flags()[0];
    c.ignoreOnce(first);
    await settle(0);
    expect(c.count()).toBe(1);
    expect(c.flags().map((f) => f.from)).toEqual([10]);
    expect(c.flagAt({ block: h.blockIds[0], offset: 2 })).toBeNull();
  });

  it("caches suggestions and de-duplicates in-flight requests", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("wrold", t);
    c.start();
    await settle(10);
    const f = c.flags()[0];
    const [a, b] = await Promise.all([c.suggest(f), c.suggest(f)]);
    expect(a).toEqual(["wrold!"]);
    expect(b).toEqual(a);
    await c.suggest(f);
    expect(t.suggestCalls).toEqual(["wrold"]);
  });

  it("rescans on transport invalidation and drops newly accepted words", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("wrold Anothr", t);
    c.start();
    await settle(10);
    expect(c.count()).toBe(2);
    t.dict.add("wrold");
    t.invalidate(["wrold"]);
    expect(c.flags().map((f) => f.word)).toEqual(["Anothr"]);
    await settle(10);
    expect(c.flags().map((f) => f.word)).toEqual(["Anothr"]);
  });

  it("reports the count through onFlagsChange", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("wrold", t);
    const seen: number[] = [];
    c.onFlagsChange((n) => seen.push(n));
    c.start();
    await settle(10);
    c.dropWord("wrold");
    await settle(0);
    expect(seen).toEqual([1, 0]);
  });

  it("stop() clears the layer; dispose() detaches from the editor", async () => {
    const t = fakeTransport(KNOWN);
    const c = setup("Hello wrold", t);
    const clear = vi.spyOn(h.editor.view, "clearDecorations");
    c.start();
    await settle(10);
    expect(c.count()).toBe(1);
    c.stop();
    expect(clear).toHaveBeenCalledWith("spell");
    expect(c.count()).toBe(0);
    c.dispose();
    const calls = t.calls.length;
    h.editor.setCaret({ block: h.blockIds[0], offset: 11 });
    type(" Anothr ");
    await settle(1000);
    expect(t.calls.length).toBe(calls);
    checker = null;
  });
});
