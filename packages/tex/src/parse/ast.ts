/**
 * The parsed math AST. Every node carries a `span` — the half-open `[start,
 * end)` range of the source LaTeX it came from — which is the spine of live
 * editing (hit-testing and caret placement map screen ↔ source through it).
 */
import type { SymbolInfo } from "../data/symbols";

/** Half-open source range `[start, end)` into the original LaTeX string. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A single rendered symbol (letter, digit, operator, named symbol, …). */
export interface AtomNode {
  readonly type: "atom";
  readonly info: SymbolInfo;
  readonly span: Span;
}

/** A `{ … }` group / the top-level body — an ordered run of nodes. */
export interface OrdNode {
  readonly type: "ord";
  readonly body: Node[];
  readonly span: Span;
}

/** A base with an optional superscript and/or subscript. */
export interface SupSubNode {
  readonly type: "supsub";
  readonly base: Node | null;
  readonly sup: Node | null;
  readonly sub: Node | null;
  readonly span: Span;
}

/**
 * The generalized fraction (`\frac`, `\dfrac`, `\binom`, `\cfrac`, `\over`, …).
 * Only `num`/`den` are required; the rest tune the bar, delimiters and style.
 */
export interface FracNode {
  readonly type: "frac";
  readonly num: Node;
  readonly den: Node;
  /** Draw the fraction bar (default true; `\binom`/`\atop` set false). */
  readonly hasRule?: boolean;
  /** Surrounding delimiters (`\binom` ⇒ `(`/`)`); `.`/undefined = none. */
  readonly leftDelim?: string;
  readonly rightDelim?: string;
  /** Force display/text style for the whole fraction (`\dfrac`/`\tfrac`). */
  readonly forceStyle?: "display" | "text";
  /** `\cfrac` — continued fraction (display style + a numerator strut). */
  readonly continued?: boolean;
  readonly span: Span;
}

/** `\sqrt[index]{body}`. */
export interface SqrtNode {
  readonly type: "sqrt";
  readonly index: Node | null;
  readonly body: Node;
  readonly span: Span;
}

/** `\left( … \right)` — auto-sized delimiters around a body. */
export interface LeftRightNode {
  readonly type: "leftright";
  readonly left: string;
  readonly right: string;
  readonly body: Node[];
  readonly span: Span;
}

/** A manually sized delimiter (`\big(`, `\Bigl[`, …). */
export interface SizedDelimNode {
  readonly type: "sizeddelim";
  readonly delim: string;
  readonly size: 1 | 2 | 3 | 4;
  readonly mclass: "mopen" | "mclose" | "mrel" | "mord";
  readonly span: Span;
}

/** An accent over a base (`\hat x`, `\vec v`, `\tilde a`). */
export interface AccentNode {
  readonly type: "accent";
  readonly label: string;
  readonly base: Node;
  /** Stretchy accents (`\widehat`, `\widetilde`) span the whole base. */
  readonly stretchy?: boolean;
  readonly span: Span;
}

/**
 * `\overline` / `\underline` (a full-width rule) or `\overbrace` / `\underbrace`
 * (a stretchy horizontal brace) over/under the body.
 */
export interface OverUnderNode {
  readonly type: "overunder";
  readonly kind: "overline" | "underline" | "overbrace" | "underbrace";
  readonly body: Node;
  readonly span: Span;
}

/**
 * A tabular environment — `\begin{matrix}…\end{matrix}` and friends (`pmatrix`,
 * `bmatrix`, `cases`, `aligned`, `array`, …). `rows` is a list of rows, each an
 * ordered list of cell bodies.
 */
export interface ArrayNode {
  readonly type: "array";
  readonly env: string;
  readonly rows: Node[][];
  /** Column alignment for `\begin{array}{lcr}`; absent for the matrix family. */
  readonly colAlign?: ReadonlyArray<"l" | "c" | "r">;
  readonly span: Span;
}

/**
 * A named math operator (`\sin`, `\log`, `\lim`, `\gcd`, …) — typeset upright in
 * the roman font and classed `mop`. `limits` ops (`\lim`, `\max`, …) stack their
 * scripts above/below in display style.
 */
export interface OpNameNode {
  readonly type: "opname";
  readonly name: string;
  readonly limits: boolean;
  readonly span: Span;
}

/** A font/alphabet command (`\mathbb`, `\mathrm`, `\mathbf`, `\mathcal`, …). */
export interface MathFontNode {
  readonly type: "mathfont";
  readonly variant: string;
  readonly body: Node;
  readonly span: Span;
}

/** `\not` — a slash struck through the following atom (`\not=` ⇒ ≠). */
export interface NotNode {
  readonly type: "not";
  readonly base: Node;
  readonly span: Span;
}

/** Metrics (em, size 1) for a run of text the math fonts have no glyph for —
 *  measured from a host font by `layoutMath`'s text-fallback pass. */
export interface TextFallbackChar {
  readonly width: number;
  readonly ascent: number;
  readonly depth: number;
}

/**
 * A maximal run of characters the math fonts can't render (CJK, Arabic, emoji,
 * …), measured and painted as ONE unit from the host font. Shaping the whole run
 * at once is what lets the browser apply cursive joining (Arabic) and bidi
 * ordering — a per-character split renders Arabic as disconnected, reversed
 * isolated letters. Interior spaces are kept in the run so a multi-word RTL
 * phrase orders correctly; boundary spaces stay outside as kerns. `start`/
 * `length` are code-point indices into `[...TextNode.text]`.
 */
export interface TextFallbackRun {
  readonly start: number;
  readonly length: number;
  /** The shaped substring (`[...text].slice(start, start+length).join("")`). */
  readonly text: string;
  readonly width: number;
  readonly ascent: number;
  readonly depth: number;
  /**
   * Cumulative advance (em, size 1) to each inter-character boundary of the run,
   * in LOGICAL (source) order — `edges[0] === 0`, `edges[length] === width`, so
   * the run has `length + 1` boundaries. Measured per prefix from the host font,
   * so a caret can land BETWEEN the characters of a shaped run (e.g. between two
   * Arabic letters) instead of only at its two ends. Attached by `layoutMath`
   * alongside `width`.
   */
  readonly edges: readonly number[];
  /**
   * Whether this run reads right-to-left (its first strong character is RTL —
   * Arabic/Hebrew). The run still paints as one browser-shaped box; this only
   * tells the caret layer that logical boundary `k` sits at VISUAL offset
   * `width - edges[k]` from the box's left edge, not `edges[k]`.
   */
  readonly rtl: boolean;
}

/** Text-mode run (`\text`, `\textbf`, …) — raw characters set in a roman face. */
export interface TextNode {
  readonly type: "text";
  readonly text: string;
  readonly variant: string;
  readonly span: Span;
  /**
   * Source span of each code point of `text`, aligned with `[...text]`. Lets
   * layout stamp every character its own source offset so the caret can stop
   * between characters inside a `\text{…}` run (both native glyphs and the
   * host-shaped fallback runs), instead of only at the whole node's outer edges.
   */
  readonly charSpans: readonly Span[];
  /**
   * Shaped fallback runs for stretches of characters the math fonts can't render
   * (CJK, Arabic, emoji, …). Each run is measured and painted as a single unit
   * from `fallbackFont`, so the browser shapes it (Arabic cursive joining) and
   * applies bidi ordering; a per-char split breaks both. Attached by `layoutMath`
   * only when a `textFallback` is supplied — so a bare parse stays
   * glyph-metric-free. Chars not covered by a run have native math glyphs (or are
   * boundary spaces) and lay out normally.
   */
  fallbackRuns?: readonly TextFallbackRun[];
  /** CSS font-family the `fallbackRuns` are measured and painted with. */
  fallbackFont?: string;
}

/** An atom-class override (`\mathbin`, `\mathrel`, …, `\mathop`). */
export interface MClassNode {
  readonly type: "mclass";
  readonly mclass:
    "mord" | "mbin" | "mrel" | "mopen" | "mclose" | "mpunct" | "minner" | "mop";
  readonly body: Node;
  readonly span: Span;
}

/** `\overset` / `\underset` / `\stackrel` — a script stacked over/under a base. */
export interface StackNode {
  readonly type: "stack";
  readonly kind: "overset" | "underset" | "stackrel";
  readonly script: Node;
  readonly base: Node;
  readonly span: Span;
}

/** `\boxed` / `\fbox` — the body inside a ruled frame. */
export interface BoxedNode {
  readonly type: "boxed";
  readonly body: Node;
  readonly span: Span;
}

/** `\phantom` / `\hphantom` / `\vphantom` / `\smash` — invisible/dimension tricks. */
export interface PhantomNode {
  readonly type: "phantom";
  readonly kind: "phantom" | "hphantom" | "vphantom" | "smash";
  readonly body: Node;
  readonly span: Span;
}

/** A style switch (`\displaystyle`, …) wrapping the rest of its group. */
export interface StyleNode {
  readonly type: "style";
  readonly style: "display" | "text" | "script" | "scriptscript";
  readonly body: Node[];
  readonly span: Span;
}

/**
 * Transient marker for an infix fraction operator (`\over`, `\choose`, …),
 * replaced by a `frac` node during parse (it never reaches layout).
 */
export interface InfixNode {
  readonly type: "infix";
  readonly form: { hasRule?: boolean; leftDelim?: string; rightDelim?: string };
  readonly span: Span;
}

/** Explicit horizontal space (`\quad`, `\,`, `\;`). Width is in em. */
export interface SpaceNode {
  readonly type: "space";
  readonly width: number;
  readonly span: Span;
}

/** An unrecognized command — rendered as its literal `\name` source, never thrown. */
export interface UnknownNode {
  readonly type: "unknown";
  readonly name: string;
  readonly span: Span;
}

export type Node =
  | AtomNode
  | OrdNode
  | SupSubNode
  | FracNode
  | SqrtNode
  | LeftRightNode
  | SizedDelimNode
  | AccentNode
  | OverUnderNode
  | ArrayNode
  | OpNameNode
  | MathFontNode
  | NotNode
  | TextNode
  | MClassNode
  | StackNode
  | BoxedNode
  | PhantomNode
  | StyleNode
  | InfixNode
  | SpaceNode
  | UnknownNode;
