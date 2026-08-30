/**
 * GFM recognition and printing, at the source level.
 *
 * The recognizer decides whether a run of lines is a table at all, which is the
 * one thing that must never be wrong in either direction: claim too much and an
 * ordinary paragraph containing a pipe turns into a grid; claim too little and
 * a real table lands as prose.
 */

import { matchGfmTable, printGfmTable, splitRowForTest } from "./markdown";
import { describe, expect, it } from "vitest";

describe("recognizing a table", () => {
  it("reads a bounded table", () => {
    const matched = matchGfmTable("| a | b |\n| --- | --- |\n| 1 | 2 |\n", 0);

    expect(matched?.table.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(matched?.table.aligns).toEqual([null, null]);
  });

  it("reads a table written without bounding pipes", () => {
    const matched = matchGfmTable("a | b\n--- | ---\n1 | 2", 0);

    expect(matched?.table.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("captures per-column alignment", () => {
    const matched = matchGfmTable("| a | b | c |\n| :-- | :-: | --: |\n", 0);

    expect(matched?.table.aligns).toEqual(["left", "center", "right"]);
  });

  it("stops at a blank line and consumes no further", () => {
    const source = "| a |\n| --- |\n| 1 |\n\nAfter the table.";
    const matched = matchGfmTable(source, 0);

    expect(matched?.table.rows).toEqual([["a"], ["1"]]);
    expect(source.slice(matched!.length)).toBe("\n\nAfter the table.");
  });

  it("pads a short row and truncates a long one", () => {
    const matched = matchGfmTable(
      "| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |",
      0,
    );

    expect(matched?.table.rows).toEqual([
      ["a", "b"],
      ["1", ""],
      ["1", "2"],
    ]);
  });

  it("keeps an escaped pipe as cell content", () => {
    const matched = matchGfmTable("| a \\| b | c |\n| --- | --- |\n", 0);

    expect(matched?.table.rows[0]).toEqual(["a | b", "c"]);
  });

  it("keeps a deliberately empty cell", () => {
    const matched = matchGfmTable("| a || b |\n| --- | --- | --- |\n", 0);

    expect(matched?.table.rows[0]).toEqual(["a", "", "b"]);
  });

  describe("refuses what is not a table", () => {
    it("a paragraph that merely contains a pipe", () => {
      expect(matchGfmTable("a | b\nnot a delimiter\n", 0)).toBeUndefined();
    });

    it("a header and delimiter row of different widths", () => {
      expect(matchGfmTable("| a | b |\n| --- |\n| 1 | 2 |", 0)).toBeUndefined();
    });

    it("a delimiter row with a non-delimiter cell", () => {
      expect(matchGfmTable("| a | b |\n| --- | x |\n", 0)).toBeUndefined();
    });

    it("a single line with no delimiter row under it", () => {
      expect(matchGfmTable("| a | b |", 0)).toBeUndefined();
    });
  });
});

describe("printing a table", () => {
  it("emits a header, a delimiter row, and the body", () => {
    expect(
      printGfmTable(
        [null, null],
        [
          ["a", "b"],
          ["1", "2"],
        ],
      ),
    ).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("encodes alignment in the delimiter row", () => {
    expect(printGfmTable(["left", "center", "right"], [["a", "b", "c"]])).toBe(
      "| a | b | c |\n| :--- | :---: | ---: |",
    );
  });

  it("escapes a pipe and flattens a newline so a cell cannot break the row", () => {
    expect(printGfmTable([null], [["a | b"], ["one\ntwo"]])).toBe(
      "| a \\| b |\n| --- |\n| one two |",
    );
  });

  it("pads a short row so every row has the same width", () => {
    expect(printGfmTable([null, null], [["a", "b"], ["1"]])).toBe(
      "| a | b |\n| --- | --- |\n| 1 |  |",
    );
  });

  it("prints nothing for a table with no columns", () => {
    expect(printGfmTable([], [])).toBe("");
  });

  it("survives a print/parse round trip", () => {
    const printed = printGfmTable(
      [null, "right"],
      [
        ["Fruit", "Price"],
        ["Apples", "1.20"],
      ],
    );

    expect(matchGfmTable(printed, 0)?.table).toEqual({
      aligns: [null, "right"],
      rows: [
        ["Fruit", "Price"],
        ["Apples", "1.20"],
      ],
    });
  });
});

describe("splitting a row", () => {
  it.each([
    ["| a | b |", ["a", "b"]],
    ["a | b", ["a", "b"]],
    ["| a |", ["a"]],
    ["|  |", [""]],
    ["| a \\| b |", ["a | b"]],
  ])("%s", (line, expected) => {
    expect(splitRowForTest(line)).toEqual(expected);
  });
});
