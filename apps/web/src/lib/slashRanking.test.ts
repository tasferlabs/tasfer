import { describe, expect, it } from "vitest";
import { rankSlashItems, scoreSlashItem } from "./slashRanking";

const items = [
  {
    id: "image",
    label: "Image",
    description: "Add a suitable image.",
    keywords: ["image", "img", "picture", "photo", "upload"],
  },
  {
    id: "code",
    label: "Code",
    description: "Editable code block.",
    keywords: ["code", "snippet", "monospace", "```", "pre"],
  },
  {
    id: "table",
    label: "Table",
    description: "Grid of rows and columns.",
    keywords: ["table", "grid", "row", "column"],
  },
  {
    id: "bullet_list",
    label: "Bullet List",
    description: "Create a simple bullet list.",
    keywords: ["bullet", "list", "ul", "-", "unordered"],
  },
  {
    id: "numbered_list",
    label: "Numbered List",
    description: "Create a numbered list.",
    keywords: ["numbered", "list", "ol", "1.", "ordered"],
  },
];

const ids = (query: string) => rankSlashItems(items, query).map((i) => i.id);

describe("rankSlashItems", () => {
  it("returns everything in curated order for an empty query", () => {
    expect(ids("")).toEqual(items.map((i) => i.id));
    expect(ids("   ")).toEqual(items.map((i) => i.id));
  });

  it("puts an exact label match first and ignores mid-word description hits", () => {
    // "suitable" and "editable" contain "table" but are not matches.
    expect(ids("table")).toEqual(["table"]);
    expect(ids("tab")).toEqual(["table"]);
  });

  it("still matches a description at a word boundary, below label matches", () => {
    // "rows" only appears in the Table description.
    expect(ids("rows")).toEqual(["table"]);
    expect(scoreSlashItem(items[2]!, "rows")).toBeLessThan(
      scoreSlashItem(items[2]!, "table"),
    );
  });

  it("ranks a label match above a keyword-only match", () => {
    // "list" is in both list labels; the keyword-only items rank after.
    expect(ids("list").slice(0, 2)).toEqual(["bullet_list", "numbered_list"]);
  });

  it("keeps curated order between equally scored items", () => {
    expect(ids("li")).toEqual(["bullet_list", "numbered_list"]);
  });

  it("tolerates a typo in the label", () => {
    expect(ids("tabel")).toEqual(["table"]);
  });

  it("drops items that do not plausibly match", () => {
    expect(ids("zzzz")).toEqual([]);
  });
});
