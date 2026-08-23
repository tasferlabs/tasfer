/** Shared ranking for the math command menus, keyed by which trigger opened them. */

import {
  filterMathCommands,
  MATH_COMMANDS,
  type MathCommand,
} from "@tasfer/math";

/** `\` completes LaTeX control words; `/` searches math elements by name. */
export type MathMenuTrigger = "\\" | "/";
export type MathMenuMode = "names" | "latex";

export function mathMenuMode(trigger: MathMenuTrigger): MathMenuMode {
  return trigger === "/" ? "names" : "latex";
}

/** Localized element name — the label every surface shows for a construct. */
export function mathElementLabel(
  cmd: MathCommand,
  t: (key: string, fallback: string) => string,
): string {
  return t(`editor.math.elements.${cmd.id}`, cmd.name);
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Candidates for a menu query. `latex` mode is the engine's ranking over the
 * whole catalog, so every control word is reachable by typing it. `names` mode
 * (the `/` trigger) narrows to the curated tier and also matches the LOCALIZED
 * element name, so `/كسر` and `/fraction` both reach `\frac`.
 */
export function searchMathCommands(
  query: string,
  mode: MathMenuMode,
  t: (key: string, fallback: string) => string,
): MathCommand[] {
  const curatedIds = new Set(filterMathCommands("").map((cmd) => cmd.id));
  const commands = filterMathCommands(query).filter(
    (cmd) => mode === "latex" || curatedIds.has(cmd.id),
  );
  if (mode === "names" && query) {
    const normalized = normalize(query);
    const existing = new Set(commands.map((cmd) => cmd.id));
    for (const cmd of MATH_COMMANDS) {
      if (!curatedIds.has(cmd.id) || existing.has(cmd.id)) continue;
      const matchesName = [mathElementLabel(cmd, t), cmd.name].some((name) =>
        normalize(name).includes(normalized),
      );
      if (matchesName) commands.push(cmd);
    }
  }
  return commands;
}
