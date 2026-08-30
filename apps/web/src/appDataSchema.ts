/**
 * Canvas-free persistence/serialization schema shared by import/export paths,
 * title derivation, reducers, and workers. Interactive input facets are added
 * only by `appSchema`; the public editor's base schema stays free of both the
 * math and table features.
 */

import { baseDataSchema } from "@tasfer/editor";
import { mathDataExtension } from "@tasfer/math/data";
import { tableDataExtension } from "@tasfer/table/data";

export const appDataSchema = baseDataSchema
  .extend(mathDataExtension())
  .extend(tableDataExtension());
