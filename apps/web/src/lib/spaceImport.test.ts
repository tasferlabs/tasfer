/**
 * A folder imports exactly like the ZIP of it, so both run through one tree
 * builder. These cover what is specific to folders: the picked folder's own
 * name is a wrapper (like a ZIP root), an extracted export's extra wrapper is
 * dropped, linked images are found wherever they sit, and tool data is skipped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const created: Array<{ id: string; title: string; parentId: string | null }> =
  [];
const written = new Map<string, unknown>();
const uploaded: string[] = [];

vi.mock("@/app/api/pages.api", () => ({
  createPage: vi.fn(
    async (input: { title: string; parentId: string | null }) => {
      const page = {
        id: `p${created.length + 1}`,
        title: input.title,
        parentId: input.parentId,
      };
      created.push(page);
      return page;
    },
  ),
  updatePage: vi.fn(async () => {}),
}));

vi.mock("@/app/api/images.api", () => ({
  uploadImage: vi.fn(async (file: File) => {
    uploaded.push(file.name);
    // The size tells apart two images that share a file name.
    return {
      id: `asset-${file.name}-${file.size}`,
      url: "",
      fileName: file.name,
    };
  }),
}));

vi.mock("@/platform", () => ({
  getPlatform: () => ({
    ops: {
      writeBlocks: async (pageId: string, blocks: unknown) => {
        written.set(pageId, blocks);
      },
    },
  }),
}));

const { importToSpace, NoImportablePagesError } = await import("./spaceImport");

function folder(files: Record<string, string>) {
  return {
    kind: "folder" as const,
    files: Object.entries(files).map(([path, content]) => ({
      path,
      file: new File([content], path.split("/").pop()!),
    })),
  };
}

/** Created pages as "parent title > title" lines, in creation order. */
function tree(): string[] {
  const byId = new Map(created.map((p) => [p.id, p]));
  return created.map((p) => {
    const parent = p.parentId ? byId.get(p.parentId)?.title : null;
    return parent ? `${parent} > ${p.title}` : p.title;
  });
}

beforeEach(() => {
  created.length = 0;
  written.clear();
  uploaded.length = 0;
});

describe("importToSpace with a folder", () => {
  it("imports the folder's contents, with subfolders as nested pages", async () => {
    await importToSpace(
      folder({
        "Notes/Ideas.md": "# Ideas\n\nbody",
        "Notes/plain.txt": "just text",
        "Notes/Work/Plan.md": "# Plan",
      }),
      "space",
    );

    expect(tree()).toEqual(["Work", "Work > Plan", "Ideas", "Plain"]);
  });

  it("skips hidden tool folders and files", async () => {
    await importToSpace(
      folder({
        "Vault/Note.md": "# Note",
        "Vault/.obsidian/workspace.md": "# not a page",
        "Vault/.trash/Old.md": "# not a page",
      }),
      "space",
    );

    expect(tree()).toEqual(["Note"]);
  });

  it("drops the extra wrapper around an extracted export", async () => {
    await importToSpace(
      folder({
        "tasfer-export/Personal/Trip.md": "# Trip\n\n![](./images/a.png)",
        "tasfer-export/images/a.png": "png",
      }),
      "space",
    );

    // Same result as importing the export's ZIP: the space folder is stripped.
    expect(tree()).toEqual(["Trip"]);
    expect(uploaded).toEqual(["a.png"]);
    expect(JSON.stringify(written.get("p1"))).toContain("asset-a.png");
  });

  it("uploads an images folder kept beside the notes", async () => {
    await importToSpace(
      folder({
        "Notes/Trip.md": "# Trip\n\n![](images/b.png)",
        "Notes/images/b.png": "png",
      }),
      "space",
    );

    expect(tree()).toEqual(["Trip"]);
    expect(uploaded).toEqual(["b.png"]);
    expect(JSON.stringify(written.get("p1"))).toContain("asset-b.png");
  });

  it("uploads images kept anywhere, resolved from the linking page", async () => {
    await importToSpace(
      folder({
        "Notes/Work/Plan.md": "# Plan\n\n![](../attachments/chart.png)",
        "Notes/attachments/chart.png": "png",
        "Notes/Home/List.md": '# List\n\n<img src="pics/cat.png">',
        "Notes/Home/pics/cat.png": "png",
      }),
      "space",
    );

    expect([...uploaded].sort()).toEqual(["cat.png", "chart.png"]);
    const pages = new Map(created.map((p) => [p.title, p.id]));
    expect(JSON.stringify(written.get(pages.get("Plan")!))).toContain(
      "asset-chart.png",
    );
    expect(JSON.stringify(written.get(pages.get("List")!))).toContain(
      "asset-cat.png",
    );
  });

  it("keeps two images with one name in different folders apart", async () => {
    await importToSpace(
      folder({
        "Notes/A/One.md": "# One\n\n![](img/x.png)",
        "Notes/A/img/x.png": "1",
        "Notes/B/Two.md": "# Two\n\n![](<img/x.png>)",
        "Notes/B/img/x.png": "22",
      }),
      "space",
    );

    const pages = new Map(created.map((p) => [p.title, p.id]));
    const one = JSON.stringify(written.get(pages.get("One")!));
    const two = JSON.stringify(written.get(pages.get("Two")!));
    expect(uploaded).toEqual(["x.png", "x.png"]);
    expect(one).toContain("asset-x.png-1");
    expect(two).toContain("asset-x.png-2");
  });

  it("falls back to the nearest image with the same name", async () => {
    await importToSpace(
      folder({
        "Notes/Work/Plan.md": "# Plan\n\n![](images/chart%20v2.png)",
        "Notes/Work/assets/chart v2.png": "png",
      }),
      "space",
    );

    expect(uploaded).toEqual(["chart v2.png"]);
    expect(JSON.stringify(written.get("p2"))).toContain("asset-chart v2.png");
  });

  it("uploads only the images a page links to", async () => {
    await importToSpace(
      folder({
        "Notes/Trip.md": "# Trip\n\n![](photos/a.png)",
        "Notes/photos/a.png": "png",
        "Notes/photos/b.png": "png",
      }),
      "space",
    );

    expect(uploaded).toEqual(["a.png"]);
  });

  it("leaves absolute image URLs alone", async () => {
    await importToSpace(
      folder({
        "Notes/Trip.md": "# Trip\n\n![](https://example.com/images/b.png)",
        "Notes/images/b.png": "png",
      }),
      "space",
    );

    expect(JSON.stringify(written.get("p1"))).toContain(
      "https://example.com/images/b.png",
    );
  });

  it("throws when the folder has no markdown or text", async () => {
    await expect(
      importToSpace(folder({ "Photos/a.png": "png" }), "space"),
    ).rejects.toBeInstanceOf(NoImportablePagesError);
  });
});
