/**
 * Legacy default for schema-optional document APIs.
 *
 * `baseSchema` is the intentionally small, explicitly composable core schema.
 * Existing parser/serializer consumers, however, historically got math support
 * when they omitted a schema. Keep that compatibility contract in one place so
 * explicit schemas remain authoritative and the core schema stays math-free.
 */

import { getBaseDataSchema } from "./baseDataSchema";
import { mathDataExtension } from "./math/data";
import type { DataSchema } from "./sync/schema";

// eslint-disable-next-line local/no-global-mutable-state -- write-once immutable compatibility schema shared by schema-optional APIs.
let cachedCompatibilityDataSchema: DataSchema | null = null;

export function getCompatibilityDataSchema(): DataSchema {
  return (cachedCompatibilityDataSchema ??=
    getBaseDataSchema().extend(mathDataExtension()));
}
