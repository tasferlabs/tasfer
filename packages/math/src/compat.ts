/**
 * Legacy default for schema-optional document APIs.
 *
 * Before math became an opt-in feature, the parser/serializer entry points got
 * math support when they omitted a schema. They now default to the math-free
 * `getBaseDataSchema()`, so a host that never installs math never pulls the math
 * codecs — or `@tasfer/tex` — into its bundle.
 *
 * Callers that relied on the old implicit behavior pass this schema explicitly:
 *
 *   parsePage(tokens, getCompatibilityDataSchema())
 *
 * It lives behind the `@tasfer/math` entry precisely so core can no
 * longer reach it.
 */

import { mathDataExtension } from "./data";
import { renderToSVG } from "./math";
import { getBaseDataSchema } from "@tasfer/editor/baseDataSchema";
import type { ReplacementRenderer } from "@tasfer/editor/serlization/codecs/types";
import type { DataSchema } from "@tasfer/editor/sync/schema";

// eslint-disable-next-line local/no-global-mutable-state -- write-once immutable compatibility schema shared by schema-optional APIs.
let cachedCompatibilityDataSchema: DataSchema | null = null;

/**
 * The base data schema with math added. Pass it to the parsing and
 * serializing functions that take an optional schema when your documents may
 * contain math; without a schema they no longer understand math. Every call
 * returns the same schema.
 */
export function getCompatibilityDataSchema(): DataSchema {
  return (cachedCompatibilityDataSchema ??=
    getBaseDataSchema().extend(mathDataExtension()));
}

/**
 * Draws math as inline SVG in HTML export. Pass it as `renderReplacement`.
 * Without it, a block equation exports as `<code>` holding its LaTeX, and
 * inline math as `<code>$…$</code>`. Throws for any type other than `"math"`.
 *
 * ```ts
 * const html = serializeToHTML(blocks, {
 *   schema: getCompatibilityDataSchema(),
 *   renderReplacement: mathReplacementRenderer,
 * });
 * ```
 */
export function mathReplacementRenderer(
  ...[type, source, displayMode]: Parameters<ReplacementRenderer>
): ReturnType<ReplacementRenderer> {
  if (type !== "math") throw new Error(`No renderer for ${type}`);
  return renderToSVG(source, displayMode);
}
