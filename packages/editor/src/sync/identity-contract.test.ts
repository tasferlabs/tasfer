import type { Block } from "../serlization/loadPage";
import type { ContentEdit } from "../state-types";
import {
  createDeterministicIdentityAllocator,
  type IdentityAllocator,
  parseAllocatedIdentity,
} from "./id";
import type { StructuredDocument } from "./structured-content";
import {
  createCRDTbinding,
  maxOpIdCounter,
  maxPageIdCounter,
  maxStructuredDocumentIdCounter,
} from "./sync";
import { describe, expect, it } from "vitest";

describe("generic identity allocation contract", () => {
  it("allocates deterministic compound identities inside an explicit scope", () => {
    const first = createDeterministicIdentityAllocator("import-fixture", 7);
    const second = createDeterministicIdentityAllocator("import-fixture", 7);

    expect([first.nextId(), first.nextId()]).toEqual([
      "import-fixture:7",
      "import-fixture:8",
    ]);
    expect([second.nextId(), second.nextId()]).toEqual([
      "import-fixture:7",
      "import-fixture:8",
    ]);
  });

  it("rejects ambiguous scopes and unsafe counters", () => {
    expect(() => createDeterministicIdentityAllocator("")).toThrow(/scope/);
    expect(() => createDeterministicIdentityAllocator("bad:scope")).toThrow(
      /scope/,
    );
    expect(() => createDeterministicIdentityAllocator("scope", -1)).toThrow(
      /counter/,
    );
    expect(parseAllocatedIdentity("peer:42")).toEqual({
      origin: "peer",
      counter: 42,
    });
    expect(parseAllocatedIdentity("peer:4:2")).toBeNull();
    expect(parseAllocatedIdentity("peer:-1")).toBeNull();
  });

  it("uses the CRDT binding itself as the allocator for every live feature", () => {
    const binding = createCRDTbinding("page", "author");
    const allocator: IdentityAllocator = binding;

    expect(allocator.nextId()).toBe("author:0");
    expect(binding.nextId()).toBe("author:1");
    binding.advanceIdCounter(40);
    expect(allocator.nextId()).toBe("author:41");
  });

  it("advances past nested node and character identities on page/op load", () => {
    const nested: StructuredDocument = {
      version: 1,
      kind: "fixture",
      rootId: "nested:root",
      nodes: {
        "nested:root": {
          id: "nested:root",
          type: "root",
          placement: { parentId: null, slot: "", orderKey: "" },
          attrs: {},
          textFields: {},
        },
        "nested:30": {
          id: "nested:30",
          type: "leaf",
          placement: {
            parentId: "nested:root",
            slot: "children",
            orderKey: "a0",
          },
          attrs: {},
          textFields: {
            text: [{ peerId: "nested-char", startCounter: 50, text: "xy" }],
          },
        },
      },
    };
    const block = {
      id: "block:4",
      type: "unknown",
      orderKey: "a0",
      structuredContent: { nested },
    } as unknown as Block;
    const init: ContentEdit = {
      op: "content_edit",
      id: "remote:5",
      clock: { counter: 5, peerId: "remote" },
      pageId: "page",
      blockId: block.id,
      contentId: "content:6",
      edit: { kind: "document_init", document: nested },
    };

    expect(maxStructuredDocumentIdCounter(nested)).toBe(51);
    expect(maxPageIdCounter([block])).toBe(51);
    expect(maxOpIdCounter([init])).toBe(51);

    const binding = createCRDTbinding("page", "local");
    binding.advanceIdCounter(maxPageIdCounter([block]));
    expect(binding.nextId()).toBe("local:52");
  });
});
