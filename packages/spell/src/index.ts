/**
 * @tasfer/spell — opt-in spellcheck for @tasfer/editor.
 *
 * Engine-facing half only (no React, no DOM requirement): the prose
 * tokenizer, script routing and normalisation, the engine contract, the
 * main↔worker protocol, the per-editor {@link SpellChecker} that turns
 * worker results into range decorations, and the `REPLACE_WORD` action.
 *
 * Hosts wire the worker (`@tasfer/spell/worker` + `@tasfer/spell/hunspell`),
 * dictionaries, storage and UI themselves — see the README.
 *
 * This module imports only the public `@tasfer/editor` root; never a deep
 * subpath (enforced by src/boundary.test.ts).
 */

export * from "./actions";
export * from "./anchor";
export * from "./checker";
export * from "./engine";
export * from "./protocol";
export * from "./script";
export * from "./tokenizer";
