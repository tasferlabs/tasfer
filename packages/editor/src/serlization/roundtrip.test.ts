import { loadPage } from "./loadPage";
import { serializeToMarkdown } from "./serializer";
import { serializeToText } from "./textSerializer";
import { describe, expect, it } from "vitest";

const ROUNDTRIP_DOCS: Array<[string, string]> = [
  ["heading+para", "# Title\nHello **bold** and *it* and `code`"],
  [
    "lists",
    "- one\n- two\n  - nested\n1. first\n2. second\n- [ ] todo\n- [x] done",
  ],
  ["hr+math", "---\n$$\nx^2\n$$"],
  ["link", "see [docs](https://example.com) now"],
  ["inline math", "value $a+b$ here"],
  [
    "custom image",
    '<img src="assets/abc.png" alt="pic" width="300" height="200" data-object-fit="contain" />',
  ],
  ["default image", "![alt text](assets/xyz.png)"],
];

describe("markdown round-trip via codecs", () => {
  for (const [name, md] of ROUNDTRIP_DOCS) {
    it(name, () => {
      const page = loadPage(md);
      const out = serializeToMarkdown(page.blocks);
      expect(out).toBe(md);
    });
  }

  it("default markdown image parses and round-trips through block", () => {
    const page = loadPage("![alt text](assets/xyz.png)");
    const img = page.blocks[0] as { type: string; url: string; alt?: string };
    expect(img.type).toBe("image");
    expect(img.url).toBe("assets/xyz.png");
    expect(img.alt).toBe("alt text");
  });

  it("default-shaped <img> collapses to markdown syntax", () => {
    const page = loadPage(
      '<img src="assets/abc.png" alt="pic" data-width="full" height="220" data-object-fit="cover" />',
    );
    expect(serializeToMarkdown(page.blocks)).toBe("![pic](assets/abc.png)");
  });

  it("link format spans survive import", () => {
    const page = loadPage("see [docs](https://example.com) now");
    const block = page.blocks[0] as {
      formats: Array<{ format: { type: string; url?: string } }>;
    };
    const link = block.formats.find((f) => f.format.type === "link");
    expect(link?.format.url).toBe("https://example.com");
  });

  it("unknown html tags stay literal text", () => {
    const page = loadPage("<video src='x'>\nand a < b inline");
    expect(page.blocks[0].type).toBe("paragraph");
    const out = serializeToText(page.blocks);
    expect(out).toBe("<video src='x'>\nand a < b inline");
  });

  it("mapAssetUrl rewrites image refs", () => {
    const page = loadPage(
      '<img src="assets/abc.png" alt="pic" width="300" height="200" data-object-fit="contain" />',
    );
    const out = serializeToMarkdown(page.blocks, undefined, {
      mapAssetUrl: (url) => `./images/${url.split("/").pop()}`,
    });
    expect(out).toContain('src="./images/abc.png"');
  });

  it("text serialization matches legacy shape", () => {
    const page = loadPage("# Title\n- [x] done\n---\n![alt](u.png)");
    expect(serializeToText(page.blocks)).toBe("Title\n[x] done\n---\nalt");
  });
});
