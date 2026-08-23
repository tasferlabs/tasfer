/**
 * `insertIntoRuns` is idempotent per character ID.
 *
 * The inverse of `text_delete` re-inserts the ORIGINAL char ids, so undoing a
 * delete reaches the sequence as an insert of characters it still carries as
 * tombstones. Splicing a second copy would leave two chars sharing one id, and
 * every downstream id → ordinal map keeps only the last of them — which silently
 * drops a mark span anchored on that id.
 */

import { resolveMarkRunsFromChars } from "../mark-runs";
import type { Char, MarkSpan } from "../serlization/loadPage";
import {
  charRunsToChars,
  deleteFromRuns,
  getVisibleTextFromRuns,
  insertIntoRuns,
  iterateAllChars,
} from "./char-runs";
import { describe, expect, it } from "vitest";

function char(id: string, value: string): Char {
  return { id, char: value };
}

/** Every character in document order; a tombstone is suffixed with `*`. */
function ids(runs: Parameters<typeof iterateAllChars>[0]): string[] {
  return [...iterateAllChars(runs)].map(
    (c) => `${c.id}${c.deleted ? "*" : ""}`,
  );
}

describe("insertIntoRuns replay", () => {
  it("resurrects a tombstone instead of splicing a second copy", () => {
    const anchor = char("p:10", "￼");
    let runs = insertIntoRuns([], null, [anchor]);
    runs = deleteFromRuns(runs, ["p:10"]);
    runs = insertIntoRuns(runs, null, [anchor]);

    expect(ids(runs)).toEqual(["p:10"]);
    expect(getVisibleTextFromRuns(runs)).toBe("￼");
  });

  it("keeps a mark span resolving across a delete/undo cycle", () => {
    const span: MarkSpan = {
      startCharId: "p:10",
      endCharId: "p:10",
      format: { type: "math", attrs: { contentId: "c1" } },
      clock: { counter: 1, peerId: "p" },
    };
    const anchor = char("p:10", "￼");

    let runs = insertIntoRuns([], null, [anchor]);
    runs = deleteFromRuns(runs, ["p:10"]);
    runs = insertIntoRuns(runs, null, [anchor]);

    const chars = [...iterateAllChars(runs)];
    expect(chars.filter((c) => !c.deleted)).toHaveLength(1);
    expect(resolveMarkRunsFromChars(chars, [span])).toEqual([
      {
        name: "math",
        attrs: { contentId: "c1" },
        startIndex: 0,
        endIndex: 1,
        text: "￼",
      },
    ]);
  });

  it("re-inserting a live character changes nothing", () => {
    const runs = insertIntoRuns([], null, [char("p:1", "a"), char("p:2", "b")]);
    const again = insertIntoRuns(runs, null, [char("p:1", "a")]);

    expect(ids(again)).toEqual(["p:1", "p:2"]);
    expect(getVisibleTextFromRuns(again)).toBe("ab");
  });

  it("restores tombstones and splices new chars in one batch", () => {
    // "ab" typed, "b" deleted, then an undo re-inserts "b" alongside a new "c".
    let runs = insertIntoRuns([], null, [char("p:1", "a"), char("p:2", "b")]);
    runs = deleteFromRuns(runs, ["p:2"]);
    runs = insertIntoRuns(runs, "p:1", [char("p:2", "b"), char("p:3", "c")]);

    expect(ids(runs)).toEqual(["p:1", "p:2", "p:3"]);
    expect(getVisibleTextFromRuns(runs)).toBe("abc");
  });

  it("resurrects in place rather than at the replayed anchor", () => {
    // The tombstone's CRDT position is the one the sequence recorded; an undo
    // must not move it to wherever the inverse op's anchor happens to point.
    let runs = insertIntoRuns([], null, [
      char("p:1", "a"),
      char("p:2", "b"),
      char("p:3", "c"),
    ]);
    runs = deleteFromRuns(runs, ["p:2"]);
    runs = insertIntoRuns(runs, "p:3", [char("p:2", "b")]);

    expect(getVisibleTextFromRuns(runs)).toBe("abc");
  });

  it("applying the same insert twice converges", () => {
    const batch = [char("p:5", "x"), char("p:6", "y")];
    const once = insertIntoRuns(
      insertIntoRuns([], null, [char("p:1", "a")]),
      "p:1",
      batch,
    );
    const twice = insertIntoRuns(once, "p:1", batch);

    expect(charRunsToChars(twice)).toEqual(charRunsToChars(once));
  });
});
