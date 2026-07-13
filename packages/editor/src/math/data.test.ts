import { getBaseDataSchema } from "../baseDataSchema";
import { createCRDTbinding, createSyncEngine } from "../sync/sync";
import {
  getStructuredMathSource,
  mathContentIdForBlock,
  mathDataExtension,
  parseLegacyMathDocumentInit,
} from "./data";
import { describe, expect, it } from "vitest";

describe("math data extension", () => {
  it("replays structured math through a data-only worker schema", () => {
    const schema = getBaseDataSchema().extend(mathDataExtension());
    const binding = createCRDTbinding("math-worker", "author");
    const author = createSyncEngine(binding, schema);
    const block = author.createBlockInsert("a0", "math", {
      displayMode: true,
    });
    author.emit([block]);

    const contentId = mathContentIdForBlock(block.blockId);
    const init = parseLegacyMathDocumentInit(String.raw`\frac{a}{b}`, {
      contentId,
      identityAllocator: binding,
    });
    author.emit([author.createContentEdit(block.blockId, contentId, init)]);

    const worker = createSyncEngine(
      createCRDTbinding("math-worker", "worker"),
      schema,
    );
    worker.loadOperations(author.getOperations());

    expect(schema.inputRules("before-insert")).toEqual([]);
    expect(schema.inputRules("after-insert")).toEqual([]);
    expect(getStructuredMathSource(worker.getState().blocks[0])).toBe(
      String.raw`\frac{a}{b}`,
    );
  });
});
