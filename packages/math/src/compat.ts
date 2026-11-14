/**
 * Legacy default for schema-optional document APIs.
 *
 * Before math became an opt-in feature, the parser/serializer entry points got
 * math support when they omitted a schema. They now default to the math-free
 * `getBaseDataSchema()`, so a host that never installs math never pulls the math
 * codecs — or `@tasfer/tex` — into its bundle.
 *
 * Callers that relied on the old implicit behavior pass a math schema
 * explicitly:
 *
 *   parsePage(tokens, getBaseDataSchema().extend(mathDataExtension()))
 *
 * `getCompatibilityDataSchema` is a cached shortcut for that schema, used
 * inside this package only; it is not on the public entries.
 */

import { mathDataExtension } from "./data";
import { renderToSVG } from "./math";
import { getBaseDataSchema } from "@tasfer/editor/baseDataSchema";
import type { ReplacementRenderer } from "@tasfer/editor/serlization/codecs/types";
import type { DataSchema } from "@tasfer/editor/sync/schema";

// eslint-disable-next-line local/no-global-mutable-state -- write-once immutable compatibility schema shared by schema-optional APIs.
let cachedCompatibilityDataSchema: DataSchema | null = null;

/**
 * The base data schema with math added, built once and reused. Internal: hosts
 * build the same schema with `getBaseDataSchema().extend(mathDataExtension())`.
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
 * import { getBaseDataSchema, serializeToHTML } from "@tasfer/editor";
 * import { mathReplacementRenderer } from "@tasfer/math";
 * import { mathDataExtension } from "@tasfer/math/data";
 *
 * const html = serializeToHTML(blocks, {
 *   schema: getBaseDataSchema().extend(mathDataExtension()),
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
