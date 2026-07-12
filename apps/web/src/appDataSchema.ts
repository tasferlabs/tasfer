/**
 * Canvas-free persistence/serialization schema shared by import/export paths,
 * title derivation, reducers, and workers. Interactive input facets are added
 * only by `appSchema`; the public editor's base schema remains math-free.
 */

import { baseDataSchema } from "@cypherkit/editor";
import { mathDataExtension } from "@cypherkit/editor/math/data";

export const appDataSchema = baseDataSchema.extend(mathDataExtension());
