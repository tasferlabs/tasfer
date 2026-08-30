/**
 * Opt-in table feature bundle.
 *
 * The `table` *type* is described by the engine (`BLOCK_REGISTRY.table` fixes
 * the CRDT shape so a table syncs and validates everywhere), but nothing else
 * about it is: this package owns the GFM round-trip, the grid CRDT and the
 * painter. Compose it into a schema:
 *
 *   const schema = baseSchema.use(tableExtension());
 *
 * Without it a table block still round-trips through Markdown and syncs
 * unharmed; it renders as an `UnknownNode` placeholder — the same "preserve and
 * degrade" contract every unregistered block type gets.
 *
 * Headless hosts (workers, the CLI, Markdown tooling) want
 * {@link tableDataExtension} from `@tasfer/table/data` instead, which carries
 * no canvas code — and, with it, no clipboard adapter: what a selected range
 * copies as is a main-thread question (see `./content-selection`).
 */

import { tableContentSelectionKind } from "./content-selection";
import { type TableBlockAttrs, tableDataExtension } from "./data";
import { createTableInputRule, type TableInputOptions } from "./input";
import { TableNode } from "./TableNode";
import type { FeatureInputRule } from "@tasfer/editor/feature-facets";
import type { BlockSpec } from "@tasfer/editor/schema";
import type { StructuredKindSpec } from "@tasfer/editor/sync/schema";

export type TableFeatureExtension = {
  readonly name: "table";
  readonly nodes: readonly [BlockSpec<"table", TableBlockAttrs>];
  readonly structuredKinds: readonly StructuredKindSpec[];
  readonly inputRules: readonly FeatureInputRule[];
};

/** What a host can turn on when it installs the table feature. */
export type TableFeatureOptions = TableInputOptions;

/**
 * Build a fresh, instance-safe table feature bundle.
 *
 * Everything optional is off unless asked for, so `tableExtension()` keeps
 * meaning exactly what it did. Opt cells into markdown auto-format with:
 *
 *   const schema = baseSchema.use(tableExtension({ markdownShortcuts: true }));
 */
export function tableExtension(
  options: TableFeatureOptions = {},
): TableFeatureExtension {
  const data = tableDataExtension();
  return {
    name: "table",
    nodes: [{ ...data.blocks[0], node: new TableNode() }],
    structuredKinds: [...data.structuredKinds, tableContentSelectionKind],
    inputRules: [createTableInputRule(options)],
  };
}
