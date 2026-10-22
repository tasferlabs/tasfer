import { clsx } from "clsx";
import { shortcutKeycaps } from "@/shortcuts/keycaps";
import { useShortcutBindings } from "@/shortcuts/ShortcutsContext";

const keycapClass =
  "rounded border border-border bg-muted px-1.5 py-0.5 font-[inherit] text-[0.7rem] leading-none text-muted-foreground";

/**
 * A keyboard chord drawn as one keycap per key, e.g. ["⌘", "."] or
 * ["Ctrl", "Shift", "R"]. Splitting the keys keeps a punctuation key
 * readable as a key rather than stray punctuation after the modifier. Always
 * laid out left-to-right so the modifier comes first in an RTL UI too.
 */
export function ShortcutKeys({
  keys,
  className,
}: {
  keys: readonly string[];
  className?: string;
}) {
  return (
    <span
      className={clsx("inline-flex items-center gap-0.5", className)}
      dir="ltr"
    >
      {keys.map((key, i) => (
        <kbd key={i} className={keycapClass}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

/**
 * The first chord a command is bound to, as keycaps — so a hint follows the
 * person's own binding. Renders nothing for a command left without one.
 */
export function CommandKeys({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  const shortcuts = useShortcutBindings();
  const chord = shortcuts.bindings(id)[0];
  if (!chord) return null;
  return (
    <ShortcutKeys
      keys={shortcutKeycaps(chord, shortcuts.apple)}
      className={className}
    />
  );
}
