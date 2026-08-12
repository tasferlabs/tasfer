import type { Operation } from "../state-types";
import { buildVersionHistory, type TimedOperation } from "./version-history";
import { describe, expect, it } from "vitest";

const MINUTE = 60 * 1000;

/** `Omit` over a union collapses it; distribute so each member keeps its own fields. */
type OpDraft<T = Operation> = T extends Operation
  ? Omit<T, "id" | "clock" | "pageId">
  : never;

/**
 * Builds a log the way the reducer expects to read one: HLC order, one clock
 * counter per operation, timestamps in whatever the caller pushes forward.
 */
class Log {
  private counter = 0;
  private charCounter = 0;
  readonly ops: TimedOperation[] = [];
  private at = 1_700_000_000_000;

  private push(op: OpDraft, peerId: string) {
    this.counter++;
    this.ops.push({
      op: {
        ...op,
        id: `${peerId}:${this.counter}`,
        clock: { counter: this.counter, peerId },
        pageId: "p1",
      } as Operation,
      timestamp: this.at,
    });
  }

  /** Advance wall-clock time without emitting anything. */
  idle(ms: number): this {
    this.at += ms;
    return this;
  }

  tick(ms = 1000): this {
    this.at += ms;
    return this;
  }

  addBlock(blockId: string, blockType = "paragraph", peerId = "alice"): this {
    this.push(
      { op: "block_insert", blockId, blockType, orderKey: blockId },
      peerId,
    );
    return this;
  }

  type(blockId: string, text: string, peerId = "alice"): this {
    const startCounter = this.charCounter;
    this.charCounter += text.length;
    this.push(
      {
        op: "text_insert",
        blockId,
        afterCharId: null,
        charRuns: [{ peerId, startCounter, text }],
      },
      peerId,
    );
    return this;
  }

  deleteBlock(blockId: string, peerId = "alice"): this {
    this.push({ op: "block_delete", blockId }, peerId);
    return this;
  }
}

/** A block carrying enough text that losing it is a loss. */
function paragraph(log: Log, id: string, text = "a paragraph worth keeping") {
  return log.addBlock(id).type(id, text);
}

describe("buildVersionHistory", () => {
  it("collapses a continuous typing burst into one entry", () => {
    const log = new Log();
    log.addBlock("b1");
    for (let i = 0; i < 40; i++) log.type("b1", "word ").tick(200);

    const entries = buildVersionHistory(log.ops);

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("created");
    expect(entries[0].opCount).toBe(log.ops.length);
  });

  it("starts a new entry after the page sits idle", () => {
    const log = new Log();
    paragraph(log, "b1");
    log.idle(10 * MINUTE);
    paragraph(log, "b2");

    const entries = buildVersionHistory(log.ops);

    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("created");
    expect(entries[1].change.blocksAdded).toBe(1);
  });

  it("keeps a deletion as its own entry instead of burying it in a session", () => {
    const log = new Log();
    paragraph(log, "b1");
    paragraph(log, "b2");
    log.idle(10 * MINUTE);
    log.deleteBlock("b2");
    log.tick();
    paragraph(log, "b3");

    const entries = buildVersionHistory(log.ops);
    const deletion = entries.find((e) => e.kind === "deletion");

    expect(deletion).toBeDefined();
    expect(deletion!.change.blocksRemoved).toBe(1);
    // Isolated: the typing that followed is a separate revert point.
    expect(deletion!.change.charsInserted).toBe(0);
    expect(entries[entries.length - 1].change.blocksAdded).toBe(1);
  });

  it("does not split on deleting a near-empty block", () => {
    const log = new Log();
    paragraph(log, "b1");
    // The line-join case: an empty block appears and is immediately removed.
    log.addBlock("b2").deleteBlock("b2");
    log.type("b1", " and more text typed right after");

    const entries = buildVersionHistory(log.ops);

    expect(entries).toHaveLength(1);
    expect(entries[0].change.blocksRemoved).toBe(1);
  });

  it("splits when a different peer takes over", () => {
    const log = new Log();
    log
      .addBlock("b1", "paragraph", "alice")
      .type("b1", "alice writes a line", "alice");
    log
      .addBlock("b2", "paragraph", "bob")
      .type("b2", "bob writes a line", "bob");

    const entries = buildVersionHistory(log.ops);

    expect(entries).toHaveLength(2);
    expect(entries[0].peerIds).toEqual(["alice"]);
    expect(entries[1].peerIds).toEqual(["bob"]);
  });

  it("folds a trivial edit forward instead of offering it as a revert point", () => {
    const log = new Log();
    paragraph(log, "b1");
    log.idle(10 * MINUTE);
    log.type("b1", "x"); // a one-character fix, on its own island of time
    log.idle(10 * MINUTE);
    paragraph(log, "b2", "a whole new paragraph of real content here");

    const entries = buildVersionHistory(log.ops);

    expect(entries).toHaveLength(2);
    // The typo fix rides along with the work that followed it.
    expect(entries[1].change.charsInserted).toBeGreaterThan(1);
    expect(entries[1].change.blocksAdded).toBe(1);
  });

  it("always reaches both the origin and the current state", () => {
    const log = new Log();
    paragraph(log, "b1");
    for (let i = 0; i < 200; i++) {
      log.idle(10 * MINUTE);
      paragraph(log, `b${i + 2}`);
    }

    const entries = buildVersionHistory(log.ops, { maxEntries: 10 });

    expect(entries.length).toBeLessThanOrEqual(10);
    expect(entries[0].kind).toBe("created");
    expect(entries[entries.length - 1].opIndex).toBe(log.ops.length - 1);
  });

  it("names an entry after the highest-priority block it created", () => {
    const log = new Log();
    paragraph(log, "b1");
    log.idle(10 * MINUTE);
    log
      .addBlock("h1", "heading1")
      .type("h1", "Pricing")
      .addBlock("b2")
      .type("b2", "a much longer body paragraph that would otherwise win");

    const entries = buildVersionHistory(log.ops, {
      blockSubjectPriority: (type) => (type.startsWith("heading") ? 1 : 0),
    });

    expect(entries[1].subject).toBe("Pricing");
  });

  it("tracks the live block count without replaying the reducer", () => {
    const log = new Log();
    paragraph(log, "b1");
    paragraph(log, "b2");
    log.idle(10 * MINUTE);
    log.deleteBlock("b1");

    const entries = buildVersionHistory(log.ops);

    expect(entries[0].blockCount).toBe(2);
    expect(entries[entries.length - 1].blockCount).toBe(1);
  });

  it("keeps a mixed-length deletion as one entry", () => {
    const log = new Log();
    paragraph(log, "b1");
    paragraph(log, "b2", "short"); // below the meaningful-content bar
    paragraph(log, "b3");
    paragraph(log, "b4", "tiny");
    log.idle(10 * MINUTE);
    // Deleting a selection walks every block it covers, long and short alike.
    log.deleteBlock("b1").deleteBlock("b2").deleteBlock("b3").deleteBlock("b4");

    const entries = buildVersionHistory(log.ops);
    const deletions = entries.filter((e) => e.kind === "deletion");

    expect(deletions).toHaveLength(1);
    expect(deletions[0].change.blocksRemoved).toBe(4);
  });

  it("reads a restore as one replacement, not an emptying and a refill", () => {
    const log = new Log();
    paragraph(log, "b1");
    paragraph(log, "b2");
    log.idle(10 * MINUTE);
    // How generateRestoreOperations emits: delete everything live, then insert.
    log.deleteBlock("b1").deleteBlock("b2");
    paragraph(log, "r1");
    paragraph(log, "r2");

    const entries = buildVersionHistory(log.ops);

    expect(entries).toHaveLength(2);
    expect(entries[1].kind).toBe("replaced");
    expect(entries[1].blockCount).toBe(2);
    // The blank page in the middle is never offered as somewhere to go back to.
    expect(entries.some((e) => e.blockCount === 0)).toBe(false);
  });

  it("does not double-count when the bar is raised to fit maxEntries", () => {
    const log = new Log();
    paragraph(log, "b1");
    for (let i = 0; i < 30; i++) {
      log.idle(10 * MINUTE);
      log.type("b1", "a sentence of roughly this length added each round. ");
    }

    const loose = buildVersionHistory(log.ops, { maxEntries: 60 });
    const tight = buildVersionHistory(log.ops, { maxEntries: 4 });

    expect(tight.length).toBeLessThan(loose.length);
    // Folding is a partition either way: the same characters, redistributed.
    const total = (entries: ReturnType<typeof buildVersionHistory>) =>
      entries.reduce((sum, e) => sum + e.change.charsInserted, 0);
    expect(total(tight)).toBe(total(loose));
  });

  it("returns nothing for an empty log", () => {
    expect(buildVersionHistory([])).toEqual([]);
  });
});
