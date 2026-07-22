import { action, createActionBus } from "./action-bus";
import { getBaseDataSchema } from "./baseDataSchema";
import type { FeatureFacetSource, SyntaxRule } from "./feature-facets";
import { mathDataExtension } from "./math/data";
import { mathExtension } from "./math-extension";
import { baseSchema } from "./schema";
import { loadPage, type Mark } from "./serlization/loadPage";
import type { EditorState, Operation } from "./state-types";
import { createInitialState } from "./state-utils";
import type { ContentSelection } from "./structured-selection";
import type { StructuredDocument } from "./sync/structured-content";
import { describe, expect, it } from "vitest";

const STATE = { marker: "initial" } as unknown as EditorState;
const OP = { op: "test" } as unknown as Operation;

describe("cross-type feature facets (withFeatures)", () => {
  it("is immutable and orders rules by priority then installation", () => {
    const first = {
      inputRules: [
        {
          id: "first",
          phase: "after-insert",
          priority: 10,
          apply: () => undefined,
        },
        {
          id: "second",
          phase: "after-insert",
          priority: 10,
          apply: () => undefined,
        },
      ],
    } as const satisfies FeatureFacetSource;
    const base = getBaseDataSchema();
    const used = base.withFeatures(first).withFeatures({
      inputRules: [
        {
          id: "lower",
          phase: "after-insert",
          priority: -1,
          apply: () => undefined,
        },
      ],
    });

    expect(base.inputRules("after-insert")).toEqual([]);
    expect(used.inputRules("after-insert").map((rule) => rule.id)).toEqual([
      "first",
      "second",
      "lower",
    ]);
  });

  it("replaces a repeated input-rule id at the later installation position", () => {
    const first = {
      id: "shortcut",
      phase: "after-insert",
      priority: 5,
      apply: () => undefined,
    } as const;
    const schema = getBaseDataSchema()
      .withFeatures({
        inputRules: [
          first,
          { id: "other", phase: "after-insert", apply: () => undefined },
        ],
      })
      .withFeatures({
        inputRules: [{ ...first, priority: 0 }],
      });

    expect(schema.inputRules("after-insert").map((rule) => rule.id)).toEqual([
      "other",
      "shortcut",
    ]);
  });

  it("threads input state/ops and stops when a rule handles the phase", () => {
    const calls: string[] = [];
    const changed = { marker: "changed" } as unknown as EditorState;
    const schema = getBaseDataSchema().withFeatures({
      inputRules: [
        {
          id: "observe",
          phase: "after-insert",
          priority: 20,
          apply: ({ state, input }) => {
            calls.push(`observe:${input}`);
            expect(state).toBe(STATE);
            return { state: changed, ops: [OP] };
          },
        },
        {
          id: "claim",
          phase: "after-insert",
          priority: 10,
          apply: ({ state }) => {
            calls.push("claim");
            expect(state).toBe(changed);
            return { state, ops: [], handled: true };
          },
        },
        {
          id: "unreached",
          phase: "after-insert",
          apply: () => {
            calls.push("unreached");
            return undefined;
          },
        },
      ],
    });

    const result = schema.runInputRules("after-insert", STATE, "$$");
    expect(calls).toEqual(["observe:$$", "claim"]);
    expect(result).toEqual({ state: changed, ops: [OP], handled: true });
  });

  it("queries input ownership without applying the rule", () => {
    let applied = false;
    const schema = getBaseDataSchema().withFeatures({
      inputRules: [
        {
          id: "structured-input",
          phase: "before-insert",
          owns: ({ state, input }) => state === STATE && input === "x",
          apply: ({ state }) => {
            applied = true;
            return { state, ops: [], handled: true };
          },
        },
      ],
    });

    expect(schema.ownsInput("before-insert", STATE, "x")).toBe(true);
    expect(schema.ownsInput("before-insert", STATE, "y")).toBe(false);
    expect(applied).toBe(false);
  });

  it("registers feature action hooks in deterministic order", () => {
    const seen: string[] = [];
    const signal = action("feature-test");
    const schema = getBaseDataSchema().withFeatures({
      actions: [
        {
          id: "later",
          priority: 1,
          register(bus) {
            bus.register(signal, () => {
              seen.push("later");
            });
          },
        },
        {
          id: "first",
          priority: 2,
          register(bus) {
            bus.register(signal, () => {
              seen.push("first");
            });
          },
        },
      ],
    });
    const bus = createActionBus();

    schema.registerActions(bus);
    bus.notify(signal);
    expect(seen).toEqual(["first", "later"]);
  });

  it("deep-merges theme defaults in installation order", () => {
    const schema = getBaseDataSchema()
      .withFeatures({
        theme: {
          id: "math-theme",
          tokens: { accent: "green" },
          styles: {
            blocks: { math: { padding: 12, color: "black" } },
          },
          strings: { math: { placeholder: "Equation" } },
        },
      })
      .withFeatures({
        theme: {
          id: "host-feature-theme",
          styles: { blocks: { math: { color: "navy" } } },
          nodeStrings: { math: { error: "Invalid equation" } },
        },
      });

    expect(schema.resolveThemeDefaults()).toEqual({
      tokens: { accent: "green" },
      styles: {
        blocks: { math: { padding: 12, color: "navy" } },
      },
      strings: { math: { placeholder: "Equation" } },
      nodeStrings: { math: { error: "Invalid equation" } },
    });
  });

  it("layers installed feature theme defaults below host overrides", () => {
    const schema = baseSchema.use({
      theme: {
        id: "surface-defaults",
        styles: { canvas: { paddingTop: 33, paddingBottom: 44 } },
      },
    });
    const state = createInitialState(loadPage("", schema.data), {
      schema: schema.data,
      theme: { styles: { canvas: { paddingTop: 55 } } },
    });

    expect(state.resolvedStyles.canvas.paddingTop).toBe(55);
    expect(state.resolvedStyles.canvas.paddingBottom).toBe(44);
  });

  it("rejects bundles still carrying relocated facet lists", () => {
    const schema = getBaseDataSchema();
    for (const key of [
      "markdownSyntax",
      "contentSelections",
      "contentSelectionResolvers",
      "structuredMarks",
      "structuredContentClones",
    ]) {
      const stale = { [key]: [] } as unknown as FeatureFacetSource;
      expect(() => schema.withFeatures(stale)).toThrow(key);
      expect(() => schema.extend(stale as never)).toThrow(key);
    }
  });

  it("rejects cross-type facets handed to extend() instead of withFeatures()", () => {
    const schema = getBaseDataSchema();
    for (const [key, value] of [
      ["inputRules", []],
      ["actions", []],
      ["theme", { id: "stale-theme" }],
    ] as const) {
      expect(() => schema.extend({ [key]: value } as never)).toThrow(
        new RegExp(`${key}.*withFeatures`),
      );
    }
    // withFeatures() itself keeps accepting them, of course.
    expect(() => schema.withFeatures({ inputRules: [] })).not.toThrow();
  });
});

describe("spec-carried facets", () => {
  const mention = {
    id: "mention",
    scope: "inline",
    match: () => undefined,
  } as const satisfies SyntaxRule;

  it("derives one ordered syntax list from the registered specs", () => {
    const schema = getBaseDataSchema().extend({
      marks: [
        {
          type: "mention",
          markdownSyntax: [
            mention,
            {
              id: "hashtag",
              scope: "inline",
              priority: 10,
              match: () => undefined,
            },
          ],
        },
      ],
    });

    expect(schema.syntaxRules("inline").map((rule) => rule.id)).toEqual([
      "hashtag",
      "mention",
    ]);
    expect(getBaseDataSchema().syntaxRules()).toEqual([]);
  });

  it("replaces an overridden spec's facets wholesale", () => {
    const schema = getBaseDataSchema()
      .extend({
        marks: [
          {
            type: "mention",
            markdownSyntax: [
              mention,
              { id: "hashtag", scope: "inline", match: () => undefined },
            ],
          },
        ],
      })
      .extend({
        marks: [
          {
            type: "mention",
            markdownSyntax: [
              {
                id: "mention",
                scope: "inline",
                match: () => ({
                  length: 1,
                  tokens: [{ type: "mention_start", raw: "@" }],
                }),
              },
            ],
          },
        ],
      });

    // The overriding spec's rule set wins wholesale: no stale "hashtag" rule
    // survives from the replaced registration.
    expect(schema.syntaxRules().map((rule) => rule.id)).toEqual(["mention"]);
    expect(
      schema.matchSyntax("inline", {
        source: "@x",
        offset: 0,
        startOfLine: false,
      })?.match.tokens[0]?.raw,
    ).toBe("@");
  });

  it("rejects one syntax rule id registered by two different specs", () => {
    expect(() =>
      getBaseDataSchema().extend({
        marks: [
          { type: "mention", markdownSyntax: [mention] },
          { type: "hashtag", markdownSyntax: [mention] },
        ],
      }),
    ).toThrow(/registered by more than one spec/);
  });

  it("runs block syntax only at line start and rejects invalid matches", () => {
    const schema = getBaseDataSchema().extend({
      marks: [
        {
          type: "display",
          markdownSyntax: [
            {
              id: "display",
              scope: "block",
              match: () => ({
                length: 0,
                tokens: [{ type: "display_math" }],
              }),
            },
          ],
        },
      ],
    });

    expect(
      schema.matchSyntax("block", {
        source: "x$$",
        offset: 1,
        startOfLine: false,
      }),
    ).toBeNull();
    expect(() =>
      schema.matchSyntax("block", {
        source: "$$",
        offset: 0,
        startOfLine: true,
      }),
    ).toThrow(/display.*invalid match/);
  });

  it("dispatches structured-mark behavior by the mark spec's own type", () => {
    // The facet only ever sees the stored mark + the block's attachments, so
    // the fake resolves from its own attrs — proving the ctx is passed through
    // and the dispatch keys on the SPEC's type, not on anything in the ctx.
    const mark = { type: "wiki", attrs: { page: "page" } } as unknown as Mark;
    const pageOf = (m: Mark) => (m.attrs as { page: string }).page;
    const schema = getBaseDataSchema().extend({
      marks: [
        {
          type: "wiki",
          structured: {
            resolve: ({ mark: m }) => `wiki:${pageOf(m)}`,
            references: ({ mark: m }) => [`ref:${pageOf(m)}`],
          },
        },
      ],
    });

    expect(
      schema.resolveStructuredMark("wiki", {
        mark,
        attachments: undefined,
      }),
    ).toBe("wiki:page");
    expect(
      schema.resolveStructuredMark("strong", {
        mark,
        attachments: undefined,
      }),
    ).toBeUndefined();
    expect(
      schema.structuredMarkReferences("wiki", {
        mark,
        attachments: undefined,
      }),
    ).toEqual(["ref:page"]);
    expect(
      schema.structuredMarkReferences("strong", {
        mark,
        attachments: undefined,
      }),
    ).toEqual([]);
  });

  it("dispatches structured selection serialization by document kind", () => {
    const schema = getBaseDataSchema().extend({
      structuredKinds: [
        {
          kind: "diagram",
          contentSelection: ({ selection }) => ({
            plainText: `${selection.anchor.kind}->${selection.focus.kind}`,
          }),
        },
      ],
    });
    const document = {
      version: 1,
      kind: "diagram",
      rootId: "root",
      nodes: {},
    } satisfies StructuredDocument;
    const selection = {
      anchor: {
        kind: "gap",
        blockId: "block",
        contentId: "root",
        parentId: "root",
        slot: "children",
        afterNodeId: null,
        affinity: "forward",
      },
      focus: {
        kind: "text",
        blockId: "block",
        contentId: "root",
        nodeId: "label",
        field: "text",
        afterCharId: "peer:1",
        affinity: "backward",
      },
    } satisfies ContentSelection;

    expect(schema.serializeContentSelection(document, selection)).toEqual({
      plainText: "gap->text",
    });
    expect(
      schema.serializeContentSelection(
        { ...document, kind: "uninstalled" },
        selection,
      ),
    ).toBeUndefined();
  });

  it("dispatches structured selection resolution by document kind", () => {
    const schema = getBaseDataSchema().extend({
      structuredKinds: [
        {
          kind: "diagram",
          resolveSelection: ({ selection }) => ({
            anchor: selection.focus,
            focus: selection.anchor,
          }),
        },
      ],
    });
    const document = {
      version: 1,
      kind: "diagram",
      rootId: "root",
      nodes: {},
    } satisfies StructuredDocument;
    const anchor = {
      kind: "gap",
      blockId: "block",
      contentId: "root",
      parentId: "root",
      slot: "children",
      afterNodeId: null,
      affinity: "forward",
    } as const;
    const focus = { ...anchor, affinity: "backward" } as const;

    expect(schema.resolveContentSelection(document, { anchor, focus })).toEqual(
      { anchor: focus, focus: anchor },
    );
    expect(
      schema.resolveContentSelection(
        { ...document, kind: "uninstalled" },
        { anchor, focus },
      ),
    ).toBeUndefined();
  });

  it("merges disjoint kind adapters and rejects a duplicated one", () => {
    const withSelection = getBaseDataSchema().extend({
      structuredKinds: [
        { kind: "diagram", contentSelection: () => ({ plainText: "d" }) },
      ],
    });
    const withBoth = withSelection.extend({
      structuredKinds: [{ kind: "diagram", clone: () => undefined }],
    });
    const document = {
      version: 1,
      kind: "diagram",
      rootId: "root",
      nodes: {},
    } satisfies StructuredDocument;

    expect(
      withBoth.serializeContentSelection(document, {} as ContentSelection),
    ).toEqual({ plainText: "d" });
    expect(Object.isFrozen(withBoth.structuredKind("diagram"))).toBe(true);
    expect(() =>
      withBoth.extend({
        structuredKinds: [
          { kind: "diagram", contentSelection: () => undefined },
        ],
      }),
    ).toThrow(/two contentSelection serializers/);
    expect(() =>
      withBoth.extend({
        structuredKinds: [{ kind: "diagram", clone: () => undefined }],
      }),
    ).toThrow(/two clone adapters/);
    const withResolver = withBoth.extend({
      structuredKinds: [{ kind: "diagram", resolveSelection: () => undefined }],
    });
    expect(() =>
      withResolver.extend({
        structuredKinds: [
          { kind: "diagram", resolveSelection: () => undefined },
        ],
      }),
    ).toThrow(/two selection resolvers/);
    const withSource = withResolver.extend({
      structuredKinds: [{ kind: "diagram", source: () => undefined }],
    });
    expect(() =>
      withSource.extend({
        structuredKinds: [{ kind: "diagram", source: () => undefined }],
      }),
    ).toThrow(/two source adapters/);
    expect(() =>
      getBaseDataSchema().extend({
        structuredKinds: [{ kind: "", clone: () => undefined }],
      }),
    ).toThrow(/empty kind/);
  });

  it("keeps unscoped syntax rules globally priority-ordered across scopes", () => {
    const schema = getBaseDataSchema().extend({
      marks: [
        {
          type: "mention",
          markdownSyntax: [
            {
              id: "low-block",
              scope: "block",
              priority: 1,
              match: () => undefined,
            },
            {
              id: "high-inline",
              scope: "inline",
              priority: 10,
              match: () => undefined,
            },
          ],
        },
      ],
    });

    expect(schema.syntaxRules().map((rule) => rule.id)).toEqual([
      "high-inline",
      "low-block",
    ]);
  });

  it("replaces an overridden BLOCK spec's facets wholesale too", () => {
    const custom = {
      id: "math.custom-fence",
      scope: "block",
      priority: 100,
      match: () => undefined,
    } as const satisfies SyntaxRule;
    const base = getBaseDataSchema().extend(mathDataExtension());
    const overridden = base.extend({
      blocks: [{ ...mathDataExtension().blocks[0], markdownSyntax: [custom] }],
    });

    expect(overridden.syntaxRules().map((rule) => rule.id)).toEqual([
      "math.custom-fence",
      "math.inline-dollar-delimiter",
    ]);
  });

  it("preserves facets and dispatch order across derivation chains", () => {
    const schema = getBaseDataSchema()
      .extend({
        marks: [{ type: "mention", markdownSyntax: [mention] }],
        structuredKinds: [
          { kind: "diagram", contentSelection: () => ({ plainText: "d" }) },
        ],
      })
      .withFeatures({
        inputRules: [
          { id: "rule", phase: "before-insert", apply: () => undefined },
        ],
      })
      .restrict({ marks: [] });
    const document = {
      version: 1,
      kind: "diagram",
      rootId: "root",
      nodes: {},
    } satisfies StructuredDocument;

    expect(schema.syntaxRules().map((rule) => rule.id)).toEqual(["mention"]);
    expect(schema.inputRules("before-insert").map((rule) => rule.id)).toEqual([
      "rule",
    ]);
    expect(
      schema.serializeContentSelection(document, {} as ContentSelection),
    ).toEqual({ plainText: "d" });
  });

  it("gives extend(mathDataExtension) and use(mathExtension) the same data dispatch", () => {
    const data = getBaseDataSchema().extend(mathDataExtension());
    const full = baseSchema.use(mathExtension()).data;

    expect(data.syntaxRules().map((rule) => rule.id)).toEqual(
      full.syntaxRules().map((rule) => rule.id),
    );
    expect(data.syntaxRules().map((rule) => rule.id)).toEqual([
      "math.display-dollar-fence",
      "math.inline-dollar-delimiter",
    ]);
    expect(data.structuredMark("math")).toBeDefined();
    expect(full.structuredMark("math")).toBeDefined();

    // The clipboard selection serializer is interactive-only: the worker-safe
    // data extension registers the kind's clone and source adapters, the full
    // extension additionally installs the selection serializer/resolver.
    expect(data.structuredKind("math")?.clone).toBeDefined();
    expect(data.structuredKind("math")?.source).toBeDefined();
    expect(data.structuredKind("math")?.contentSelection).toBeUndefined();
    expect(data.structuredKind("math")?.resolveSelection).toBeUndefined();
    expect(full.structuredKind("math")?.clone).toBeDefined();
    expect(full.structuredKind("math")?.source).toBeDefined();
    expect(full.structuredKind("math")?.contentSelection).toBeDefined();
    expect(full.structuredKind("math")?.resolveSelection).toBeDefined();
    const document = {
      version: 1,
      kind: "math",
      rootId: "root",
      nodes: {},
    } satisfies StructuredDocument;
    const emptySelection = {} as ContentSelection;
    expect(
      data.serializeContentSelection(document, emptySelection),
    ).toBeUndefined();

    // The full schema installs math's live input rules; the data schema none.
    expect(data.inputRules("before-insert")).toEqual([]);
    expect(data.inputRules("after-insert")).toEqual([]);
    expect(full.inputRules("before-insert").map((rule) => rule.id)).toEqual([
      "math.inline-tree.input",
      "math.tree.input",
    ]);
    expect(full.inputRules("after-insert").map((rule) => rule.id)).toEqual([
      "math.input.display-dollar-pair",
      "math.input.inline-dollar-pair",
    ]);
  });
});
