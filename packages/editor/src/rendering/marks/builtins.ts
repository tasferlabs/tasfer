/**
 * The built-in inline marks and the registry-assembly helpers.
 *
 * Each built-in mark is a {@link Mark} subclass in its own file (mirroring the
 * one-file-per-class layout of `rendering/nodes/`), encoding exactly what the
 * renderer used to special-case by name:
 *  - strong       → bold weight (the styles-free `bold` flag; metric-affecting)
 *  - emphasis     → italic
 *  - strike       → strike-through
 *  - code         → a colored chip + fill color
 *  - link         → link color + underline
 *  - math         → a replacement renderer (draws a MathJax SVG instead of glyphs)
 *
 * Hosts compose a {@link MarkRegistry} from these (or a subset / their own
 * subclasses) at mount; `createDefaultMarkRegistry()` builds the full set.
 */

import { CodeMark } from "./CodeMark";
import { EmphasisMark } from "./EmphasisMark";
import { LinkMark } from "./LinkMark";
import { Mark, MarkRegistry } from "./Mark";
import { MathMark } from "./MathMark";
import { StrikeMark } from "./StrikeMark";
import { StrongMark } from "./StrongMark";

/**
 * The built-in marks. Each is constructed fresh here (the built-in marks are
 * stateless, holding only style/paint logic), so importing this module has no
 * side effects.
 */
export function defaultMarks(): Mark[] {
  return [
    new StrongMark(),
    new EmphasisMark(),
    new StrikeMark(),
    new CodeMark(),
    new LinkMark(),
    new MathMark(),
  ];
}

/** Build a registry from an explicit list of marks (host opt-in). */
export function createMarkRegistry(marks: readonly Mark[]): MarkRegistry {
  const registry = new MarkRegistry();
  for (const mark of marks) registry.register(mark);
  return registry;
}

/** Build a registry pre-populated with the built-in marks. */
export function createDefaultMarkRegistry(): MarkRegistry {
  return createMarkRegistry(defaultMarks());
}
