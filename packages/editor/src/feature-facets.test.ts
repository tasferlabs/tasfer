import { action, createActionBus } from "./action-bus";
import {
  FeatureFacetRegistry,
  type FeatureFacetSource,
  matchFeatureSyntax,
  runFeatureInputRules,
} from "./feature-facets";
import { baseSchema } from "./schema";
import { loadPage } from "./serlization/loadPage";
import type { EditorState, Operation } from "./state-types";
import { createInitialState } from "./state-utils";
import type { ContentSelection } from "./structured-selection";
import type { StructuredDocument } from "./sync/structured-content";
import { describe, expect, it } from "vitest";

const STATE = { marker: "initial" } as unknown as EditorState;
const OP = { op: "test" } as unknown as Operation;

describe("FeatureFacetRegistry", () => {
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
    const base = new FeatureFacetRegistry();
    const used = base.extend(first).extend({
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

  it("replaces a repeated facet id at the later installation position", () => {
    const registry = new FeatureFacetRegistry()
      .extend({
        markdownSyntax: [
          { id: "math-inline", scope: "inline", match: () => undefined },
          { id: "mention", scope: "inline", match: () => undefined },
        ],
      })
      .extend({
        markdownSyntax: [
          {
            id: "math-inline",
            scope: "inline",
            match: () => ({
              length: 1,
              tokens: [{ type: "math_start", raw: "$" }],
            }),
          },
        ],
      });

    expect(registry.syntaxRules().map((rule) => rule.id)).toEqual([
      "mention",
      "math-inline",
    ]);
    expect(
      matchFeatureSyntax(registry, "inline", {
        source: "$x$",
        offset: 0,
        startOfLine: false,
      })?.match.tokens[0]?.raw,
    ).toBe("$");
  });

  it("threads input state/ops and stops when a rule handles the phase", () => {
    const calls: string[] = [];
    const changed = { marker: "changed" } as unknown as EditorState;
    const registry = new FeatureFacetRegistry().extend({
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

    const result = runFeatureInputRules(registry, "after-insert", STATE, "$$");
    expect(calls).toEqual(["observe:$$", "claim"]);
    expect(result).toEqual({ state: changed, ops: [OP], handled: true });
  });

  it("queries input ownership without applying the rule", () => {
    let applied = false;
    const registry = new FeatureFacetRegistry().extend({
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

    expect(registry.ownsInput("before-insert", STATE, "x")).toBe(true);
    expect(registry.ownsInput("before-insert", STATE, "y")).toBe(false);
    expect(applied).toBe(false);
  });

  it("runs block syntax only at line start and rejects invalid matches", () => {
    const registry = new FeatureFacetRegistry().extend({
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
    });

    expect(
      matchFeatureSyntax(registry, "block", {
        source: "x$$",
        offset: 1,
        startOfLine: false,
      }),
    ).toBeNull();
    expect(() =>
      matchFeatureSyntax(registry, "block", {
        source: "$$",
        offset: 0,
        startOfLine: true,
      }),
    ).toThrow(/display.*invalid match/);
  });

  it("registers feature action hooks in deterministic order", () => {
    const seen: string[] = [];
    const signal = action("feature-test");
    const registry = new FeatureFacetRegistry().extend({
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

    registry.registerActions(bus);
    bus.notify(signal);
    expect(seen).toEqual(["first", "later"]);
  });

  it("dispatches structured selection serialization by document kind", () => {
    const registry = new FeatureFacetRegistry().extend({
      contentSelections: [
        {
          id: "diagram.clipboard",
          kind: "diagram",
          serialize: ({ selection }) => ({
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

    expect(registry.serializeContentSelection(document, selection)).toEqual({
      plainText: "gap->text",
    });
    expect(
      registry.serializeContentSelection(
        { ...document, kind: "uninstalled" },
        selection,
      ),
    ).toBeUndefined();
  });

  it("deep-merges theme defaults in installation order", () => {
    const registry = new FeatureFacetRegistry()
      .extend({
        theme: {
          id: "math-theme",
          tokens: { accent: "green" },
          styles: {
            blocks: { math: { padding: 12, color: "black" } },
          },
          strings: { math: { placeholder: "Equation" } },
        },
      })
      .extend({
        theme: {
          id: "host-feature-theme",
          styles: { blocks: { math: { color: "navy" } } },
          nodeStrings: { math: { error: "Invalid equation" } },
        },
      });

    expect(registry.resolveThemeDefaults()).toEqual({
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
});
