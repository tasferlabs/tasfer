import { BookPlus, EyeOff, Loader2, SpellCheck } from "lucide-react";
import type { FlagRef } from "@tasfer/spell";
import type { ContextMenuItem } from "../editor/ContextMenu";
import type { SpellcheckLayerHandle } from "./SpellcheckLayer";

/**
 * The spelling group at the top of the host context menu.
 *
 * Item ids are the stable join key the native menu bridge maps to platform
 * icons (`nativeContextMenu.ts`), so keep them: `spell-suggest-<n>`,
 * `spell-add`, `spell-ignore`, `spell-ignore-page`, `spell-looking-up`,
 * `spell-none`.
 */

/** The translation shape this builder needs — satisfied by i18next's `t`. */
export type SpellMenuT = (
  key: string,
  defaultValue: string,
  options?: Record<string, unknown>,
) => string;

/** The slice of the layer the builder drives; a test can fake it. */
export type SpellMenuHandle = Pick<
  SpellcheckLayerHandle,
  | "flagAtCaret"
  | "suggest"
  | "apply"
  | "addToDictionary"
  | "ignoreOnce"
  | "ignoreInDocument"
>;

export interface SpellMenuOptions {
  /**
   * How long to wait for suggestions before resolving. `null` resolves at
   * once with a pending row (a web menu that re-renders when they land);
   * a number caps the wait for presenters that cannot update after showing
   * (Electron, iOS, Android). Suggestions that arrive after the cap are
   * still reported through `onResolve`.
   */
  awaitSuggestionsMs: number | null;
  /** The word to build for; defaults to the flag at the caret. */
  flag?: FlagRef | null;
  /** Called with the final group once suggestions are known. */
  onResolve?: (items: ContextMenuItem[]) => void;
}

export const MAX_MENU_SUGGESTIONS = 5;

/**
 * Pure builder: the group for one flag and a known (or pending) suggestion
 * list. The rows for pending/empty states carry no action; the web menu
 * hides disabled rows entirely, so they stay enabled-but-inert to be visible.
 */
export function buildSpellMenuItems(
  handle: SpellMenuHandle,
  flag: FlagRef,
  suggestions: readonly string[] | null,
  t: SpellMenuT,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (suggestions === null) {
    items.push({
      id: "spell-looking-up",
      label: t("contextMenu.spellLookingUp", "Looking up…"),
      icon: <Loader2 size={14} className="animate-spin" />,
    });
  } else if (suggestions.length === 0) {
    items.push({
      id: "spell-none",
      label: t("contextMenu.spellNoSuggestions", "No suggestions"),
      icon: <SpellCheck size={14} />,
    });
  } else {
    suggestions.slice(0, MAX_MENU_SUGGESTIONS).forEach((s, i) => {
      items.push({
        id: `spell-suggest-${i}`,
        label: s,
        icon: <SpellCheck size={14} />,
        action: () => handle.apply(flag, s),
      });
    });
  }
  items.push(
    {
      id: "spell-add",
      label: t("contextMenu.spellAddToDictionary", "Add to dictionary"),
      icon: <BookPlus size={14} />,
      action: () => handle.addToDictionary(flag),
    },
    {
      id: "spell-ignore",
      label: t("contextMenu.spellIgnore", "Ignore"),
      icon: <EyeOff size={14} />,
      action: () => handle.ignoreOnce(flag),
    },
    {
      id: "spell-ignore-page",
      label: t("contextMenu.spellIgnorePage", "Ignore all on this page"),
      icon: <EyeOff size={14} />,
      action: () => handle.ignoreInDocument(flag),
    },
  );
  return items;
}

/**
 * Build the group for the flag at the caret (or `opts.flag`). Resolves to an
 * empty array when no misspelled word is there, so callers can always spread
 * the result in front of their own items.
 */
export async function spellMenuItems(
  handle: SpellMenuHandle,
  t: SpellMenuT,
  opts: SpellMenuOptions,
): Promise<ContextMenuItem[]> {
  const flag = opts.flag === undefined ? handle.flagAtCaret() : opts.flag;
  if (!flag) return [];

  let settled = false;
  const lookup = handle.suggest(flag).then(
    (s) => s,
    () => [] as string[],
  );
  const finalItems = lookup.then((s) => {
    settled = true;
    const items = buildSpellMenuItems(handle, flag, s, t);
    opts.onResolve?.(items);
    return items;
  });

  // `null` still yields one task so a cached (already resolved) lookup wins
  // and the pending row is never shown for it.
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), opts.awaitSuggestionsMs ?? 0);
  });
  const raced = await Promise.race([finalItems, timeout]);
  if (raced) return raced;
  if (opts.awaitSuggestionsMs === null) {
    return settled ? finalItems : buildSpellMenuItems(handle, flag, null, t);
  }
  // Timed out on a presenter that cannot update: no dead "Looking up…" row,
  // just the actions that are certain.
  return buildSpellMenuItems(handle, flag, null, t).filter(
    (item) => item.id !== "spell-looking-up",
  );
}
