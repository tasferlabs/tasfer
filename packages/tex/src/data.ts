/**
 * Canvas-free math document surface.
 *
 * Persistence, parsing, canonical printing, and source normalization can use
 * this entry without evaluating the layout or paint pipeline exported by the
 * package root.
 */

export * from "./document";
export { balanceBraces, escapeStrayCloseBraces } from "./edit/brace";
export { canRenderMathChar } from "./edit/char";
export { needsCommandSeparator } from "./parse/parser";
export {
  accentCommands,
  isAccentCommand,
  isStackCommand,
  isStretchyAccentCommand,
  isWrapperCommand,
  stackCommands,
  wrapperCommands,
} from "./vocabulary";
