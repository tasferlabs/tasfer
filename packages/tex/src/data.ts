/**
 * Canvas-free math document surface.
 *
 * Persistence, parsing, canonical printing, and source normalization can use
 * this entry without evaluating the layout or paint pipeline exported by the
 * package root.
 */

export * from "./document";
export { balanceBraces, escapeStrayCloseBraces } from "./edit/brace";
