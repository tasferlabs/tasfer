import { clsx } from "clsx";
import { commandModifierLabel } from "@/lib/shortcutLabel";

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
 * A chord on the platform's command modifier: ⌘ then `commandKey` on Apple,
 * Ctrl then `commandKey` elsewhere. `commandKey` is the printed key, e.g. "K".
 */
export function CommandShortcutKeys({
  commandKey,
  className,
}: {
  commandKey: string;
  className?: string;
}) {
  return (
    <ShortcutKeys
      keys={[commandModifierLabel(), commandKey]}
      className={className}
    />
  );
}
