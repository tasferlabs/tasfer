/**
 * The `\` command catalog — the data behind the Corca-style autocomplete that
 * pops up when you type `\` inside a math chip. Each entry is a LaTeX construct
 * with empty `{}` slots; selecting it inserts the `latex` verbatim and drops the
 * caret in the first slot (those slots render as faint placeholder boxes — see
 * the layout engine's `placeholder` box — so the user sees exactly where to type
 * next).
 *
 * This is engine-side, not host-side, on purpose: it's pure, canvas-free data
 * (so it's unit-testable and every entry can be validated against the parser),
 * and the LaTeX vocabulary is the engine's domain. The host owns only the
 * popover chrome that renders these previews and drives the insert.
 */
import { isValidLatex } from "@cypherkit/tex";

export interface MathCommand {
  /** Stable id (also the canonical command keyword, e.g. `int`). */
  readonly id: string;
  /** Human-readable label shown beside the preview. */
  readonly name: string;
  /** Extra search terms (the id is always matched too). */
  readonly keywords: readonly string[];
  /** The literal text inserted, with empty `{}` slots for the caret to fill. */
  readonly latex: string;
}

/**
 * Offset within a command's `latex` to place the caret after inserting — the
 * inside of the first empty `{}` slot, or the end if the command has no slots
 * (e.g. `\alpha`). Computed rather than stored so the catalog stays terse.
 */
export function mathCommandCaretOffset(latex: string): number {
  const i = latex.indexOf("{}");
  return i >= 0 ? i + 1 : latex.length;
}

// Curated for breadth + a rich preview list (mirrors the constructs Corca
// surfaces). Kept LaTeX-valid — `math-commands.test.ts` asserts every `latex`
// parses with no unknown commands, so a typo can't ship a red placeholder.
const COMMANDS: readonly MathCommand[] = [
  // Fractions & roots
  {
    id: "frac",
    name: "Fraction",
    keywords: ["fraction", "over", "/"],
    latex: "\\frac{}{}",
  },
  {
    id: "sqrt",
    name: "Square root",
    keywords: ["root", "radical"],
    latex: "\\sqrt{}",
  },
  {
    id: "nthroot",
    name: "Nth root",
    keywords: ["root", "radical", "cube"],
    latex: "\\sqrt[]{}",
  },
  {
    id: "binom",
    name: "Binomial",
    keywords: ["binomial", "choose", "combination"],
    latex: "\\binom{}{}",
  },

  // Scripts
  {
    id: "^",
    name: "Superscript",
    keywords: ["power", "exponent", "sup"],
    latex: "^{}",
  },
  { id: "_", name: "Subscript", keywords: ["index", "sub"], latex: "_{}" },
  {
    id: "subsup",
    name: "Sub- & superscript",
    keywords: ["index", "power"],
    latex: "_{}^{}",
  },

  // Big operators
  {
    id: "sum",
    name: "Summation",
    keywords: ["sum", "sigma", "series"],
    latex: "\\sum_{}^{}",
  },
  {
    id: "prod",
    name: "Product",
    keywords: ["product", "pi"],
    latex: "\\prod_{}^{}",
  },
  {
    id: "coprod",
    name: "Coproduct",
    keywords: ["coproduct", "amalgamation"],
    latex: "\\coprod_{}^{}",
  },
  {
    id: "bigcup",
    name: "Big union",
    keywords: ["union", "bigcup"],
    latex: "\\bigcup_{}^{}",
  },
  {
    id: "bigcap",
    name: "Big intersection",
    keywords: ["intersection", "bigcap"],
    latex: "\\bigcap_{}^{}",
  },
  { id: "lim", name: "Limit", keywords: ["limit"], latex: "\\lim_{}" },
  { id: "int", name: "Integral", keywords: ["integral"], latex: "\\int_{}^{}" },
  {
    id: "iint",
    name: "Double integral",
    keywords: ["integral", "double"],
    latex: "\\iint_{}^{}",
  },
  {
    id: "iiint",
    name: "Triple integral",
    keywords: ["integral", "triple"],
    latex: "\\iiint_{}^{}",
  },
  {
    id: "oint",
    name: "Contour integral",
    keywords: ["integral", "contour", "loop"],
    latex: "\\oint_{}^{}",
  },
  {
    id: "oiint",
    name: "Surface integral",
    keywords: ["integral", "surface", "closed", "double", "cyclic"],
    latex: "\\oiint_{}^{}",
  },
  {
    id: "oiiint",
    name: "Volume integral",
    keywords: ["integral", "volume", "closed", "triple", "cyclic"],
    latex: "\\oiiint_{}^{}",
  },

  // Matrices
  {
    id: "matrix",
    name: "Matrix (2×2)",
    keywords: ["matrix", "grid"],
    latex: "\\begin{matrix}{}&{}\\\\{}&{}\\end{matrix}",
  },
  {
    id: "pmatrix",
    name: "Parenthesis matrix",
    keywords: ["matrix", "vector", "parenthesis"],
    latex: "\\begin{pmatrix}{}&{}\\\\{}&{}\\end{pmatrix}",
  },
  {
    id: "bmatrix",
    name: "Bracket matrix",
    keywords: ["matrix", "bracket"],
    latex: "\\begin{bmatrix}{}&{}\\\\{}&{}\\end{bmatrix}",
  },
  {
    id: "vmatrix",
    name: "Determinant",
    keywords: ["matrix", "determinant", "vertical"],
    latex: "\\begin{vmatrix}{}&{}\\\\{}&{}\\end{vmatrix}",
  },
  {
    id: "Bmatrix",
    name: "Brace matrix",
    keywords: ["matrix", "brace", "set"],
    latex: "\\begin{Bmatrix}{}&{}\\\\{}&{}\\end{Bmatrix}",
  },
  {
    id: "Vmatrix",
    name: "Norm matrix",
    keywords: ["matrix", "norm", "double"],
    latex: "\\begin{Vmatrix}{}&{}\\\\{}&{}\\end{Vmatrix}",
  },
  {
    id: "cases",
    name: "Cases",
    keywords: ["cases", "piecewise", "system"],
    latex: "\\begin{cases}{}&{}\\\\{}&{}\\end{cases}",
  },
  {
    id: "aligned",
    name: "Aligned equations",
    keywords: ["aligned", "align", "system", "equations"],
    latex: "\\begin{aligned}{}&={}\\\\{}&={}\\end{aligned}",
  },

  // Accents
  {
    id: "vec",
    name: "Vector",
    keywords: ["vector", "arrow"],
    latex: "\\vec{}",
  },
  { id: "hat", name: "Hat", keywords: ["hat", "circumflex"], latex: "\\hat{}" },
  { id: "bar", name: "Bar", keywords: ["bar", "mean"], latex: "\\bar{}" },
  { id: "dot", name: "Dot", keywords: ["dot", "derivative"], latex: "\\dot{}" },
  {
    id: "ddot",
    name: "Double dot",
    keywords: ["dot", "ddot", "acceleration"],
    latex: "\\ddot{}",
  },
  { id: "tilde", name: "Tilde", keywords: ["tilde"], latex: "\\tilde{}" },
  {
    id: "widehat",
    name: "Wide hat",
    keywords: ["hat", "wide", "angle"],
    latex: "\\widehat{}",
  },
  {
    id: "widetilde",
    name: "Wide tilde",
    keywords: ["tilde", "wide"],
    latex: "\\widetilde{}",
  },
  {
    id: "overline",
    name: "Overline",
    keywords: ["overline", "bar"],
    latex: "\\overline{}",
  },
  {
    id: "underline",
    name: "Underline",
    keywords: ["underline"],
    latex: "\\underline{}",
  },

  // Structures
  { id: "boxed", name: "Boxed", keywords: ["box", "frame", "border"], latex: "\\boxed{}" },
  {
    id: "overbrace",
    name: "Overbrace",
    keywords: ["brace", "over", "group"],
    latex: "\\overbrace{}^{}",
  },
  {
    id: "underbrace",
    name: "Underbrace",
    keywords: ["brace", "under", "group"],
    latex: "\\underbrace{}_{}",
  },
  {
    id: "overset",
    name: "Over",
    keywords: ["overset", "stack", "above"],
    latex: "\\overset{}{}",
  },
  {
    id: "underset",
    name: "Under",
    keywords: ["underset", "stack", "below"],
    latex: "\\underset{}{}",
  },
  {
    id: "stackrel",
    name: "Stacked relation",
    keywords: ["stackrel", "stack", "over"],
    latex: "\\stackrel{}{}",
  },

  // Relations & operators
  {
    id: "times",
    name: "Times",
    keywords: ["times", "multiply", "cross"],
    latex: "\\times",
  },
  {
    id: "div",
    name: "Divide",
    keywords: ["divide", "division"],
    latex: "\\div",
  },
  {
    id: "pm",
    name: "Plus-minus",
    keywords: ["plusminus", "pm"],
    latex: "\\pm",
  },
  {
    id: "cdot",
    name: "Dot product",
    keywords: ["dot", "multiply", "centered"],
    latex: "\\cdot",
  },
  {
    id: "leq",
    name: "Less or equal",
    keywords: ["leq", "le", "less"],
    latex: "\\leq",
  },
  {
    id: "geq",
    name: "Greater or equal",
    keywords: ["geq", "ge", "greater"],
    latex: "\\geq",
  },
  {
    id: "neq",
    name: "Not equal",
    keywords: ["neq", "ne", "not"],
    latex: "\\neq",
  },
  {
    id: "approx",
    name: "Approximately",
    keywords: ["approx", "almost"],
    latex: "\\approx",
  },
  {
    id: "equiv",
    name: "Equivalent",
    keywords: ["equiv", "congruent"],
    latex: "\\equiv",
  },
  {
    id: "propto",
    name: "Proportional",
    keywords: ["proportional", "varies"],
    latex: "\\propto",
  },
  {
    id: "infty",
    name: "Infinity",
    keywords: ["infinity", "inf"],
    latex: "\\infty",
  },
  {
    id: "partial",
    name: "Partial",
    keywords: ["partial", "derivative"],
    latex: "\\partial",
  },
  {
    id: "nabla",
    name: "Nabla",
    keywords: ["nabla", "del", "gradient"],
    latex: "\\nabla",
  },
  {
    id: "forall",
    name: "For all",
    keywords: ["forall", "every"],
    latex: "\\forall",
  },
  {
    id: "exists",
    name: "Exists",
    keywords: ["exists", "some"],
    latex: "\\exists",
  },
  {
    id: "in",
    name: "Element of",
    keywords: ["in", "element", "member"],
    latex: "\\in",
  },
  { id: "subset", name: "Subset", keywords: ["subset"], latex: "\\subset" },
  {
    id: "subseteq",
    name: "Subset or equal",
    keywords: ["subset", "subseteq"],
    latex: "\\subseteq",
  },
  {
    id: "notin",
    name: "Not an element of",
    keywords: ["notin", "not", "element"],
    latex: "\\notin",
  },
  {
    id: "emptyset",
    name: "Empty set",
    keywords: ["empty", "emptyset", "null"],
    latex: "\\emptyset",
  },
  { id: "cup", name: "Union", keywords: ["union", "cup"], latex: "\\cup" },
  {
    id: "cap",
    name: "Intersection",
    keywords: ["intersection", "cap"],
    latex: "\\cap",
  },
  {
    id: "setminus",
    name: "Set minus",
    keywords: ["setminus", "difference", "complement"],
    latex: "\\setminus",
  },
  {
    id: "oplus",
    name: "Direct sum",
    keywords: ["oplus", "circle", "xor"],
    latex: "\\oplus",
  },
  {
    id: "otimes",
    name: "Tensor product",
    keywords: ["otimes", "circle", "kronecker"],
    latex: "\\otimes",
  },

  // Arrows
  { id: "to", name: "Arrow", keywords: ["arrow", "to", "maps"], latex: "\\to" },
  {
    id: "Rightarrow",
    name: "Implies",
    keywords: ["implies", "arrow"],
    latex: "\\Rightarrow",
  },
  {
    id: "leftrightarrow",
    name: "If and only if",
    keywords: ["iff", "arrow", "biconditional"],
    latex: "\\leftrightarrow",
  },
  {
    id: "mapsto",
    name: "Maps to",
    keywords: ["mapsto", "arrow"],
    latex: "\\mapsto",
  },

  // Functions
  { id: "sin", name: "Sine", keywords: ["sin", "trig"], latex: "\\sin" },
  { id: "cos", name: "Cosine", keywords: ["cos", "trig"], latex: "\\cos" },
  { id: "tan", name: "Tangent", keywords: ["tan", "trig"], latex: "\\tan" },
  { id: "sec", name: "Secant", keywords: ["sec", "trig"], latex: "\\sec" },
  { id: "csc", name: "Cosecant", keywords: ["csc", "cosec", "trig"], latex: "\\csc" },
  { id: "cot", name: "Cotangent", keywords: ["cot", "trig"], latex: "\\cot" },
  { id: "sinh", name: "Hyperbolic sine", keywords: ["sinh", "hyperbolic"], latex: "\\sinh" },
  { id: "cosh", name: "Hyperbolic cosine", keywords: ["cosh", "hyperbolic"], latex: "\\cosh" },
  { id: "tanh", name: "Hyperbolic tangent", keywords: ["tanh", "hyperbolic"], latex: "\\tanh" },
  { id: "log", name: "Logarithm", keywords: ["log"], latex: "\\log" },
  { id: "ln", name: "Natural log", keywords: ["ln", "log"], latex: "\\ln" },
  { id: "exp", name: "Exponential", keywords: ["exp", "exponential"], latex: "\\exp" },
  { id: "max", name: "Maximum", keywords: ["max", "maximum"], latex: "\\max_{}" },
  { id: "min", name: "Minimum", keywords: ["min", "minimum"], latex: "\\min_{}" },
  { id: "det", name: "Determinant", keywords: ["det", "determinant"], latex: "\\det" },
  { id: "gcd", name: "GCD", keywords: ["gcd", "greatest", "divisor"], latex: "\\gcd" },

  // Greek — lowercase
  { id: "alpha", name: "Alpha", keywords: ["greek"], latex: "\\alpha" },
  { id: "beta", name: "Beta", keywords: ["greek"], latex: "\\beta" },
  { id: "gamma", name: "Gamma", keywords: ["greek"], latex: "\\gamma" },
  { id: "delta", name: "Delta", keywords: ["greek"], latex: "\\delta" },
  { id: "epsilon", name: "Epsilon", keywords: ["greek"], latex: "\\epsilon" },
  {
    id: "varepsilon",
    name: "Epsilon (variant)",
    keywords: ["greek", "epsilon"],
    latex: "\\varepsilon",
  },
  { id: "zeta", name: "Zeta", keywords: ["greek"], latex: "\\zeta" },
  { id: "eta", name: "Eta", keywords: ["greek"], latex: "\\eta" },
  { id: "theta", name: "Theta", keywords: ["greek"], latex: "\\theta" },
  { id: "iota", name: "Iota", keywords: ["greek"], latex: "\\iota" },
  { id: "kappa", name: "Kappa", keywords: ["greek"], latex: "\\kappa" },
  { id: "lambda", name: "Lambda", keywords: ["greek"], latex: "\\lambda" },
  { id: "mu", name: "Mu", keywords: ["greek"], latex: "\\mu" },
  { id: "nu", name: "Nu", keywords: ["greek"], latex: "\\nu" },
  { id: "xi", name: "Xi", keywords: ["greek"], latex: "\\xi" },
  { id: "pi", name: "Pi", keywords: ["greek"], latex: "\\pi" },
  { id: "rho", name: "Rho", keywords: ["greek"], latex: "\\rho" },
  { id: "sigma", name: "Sigma", keywords: ["greek"], latex: "\\sigma" },
  { id: "tau", name: "Tau", keywords: ["greek"], latex: "\\tau" },
  { id: "upsilon", name: "Upsilon", keywords: ["greek"], latex: "\\upsilon" },
  { id: "phi", name: "Phi", keywords: ["greek"], latex: "\\phi" },
  {
    id: "varphi",
    name: "Phi (variant)",
    keywords: ["greek", "phi"],
    latex: "\\varphi",
  },
  { id: "chi", name: "Chi", keywords: ["greek"], latex: "\\chi" },
  { id: "psi", name: "Psi", keywords: ["greek"], latex: "\\psi" },
  { id: "omega", name: "Omega", keywords: ["greek"], latex: "\\omega" },

  // Greek — uppercase
  {
    id: "Gamma",
    name: "Gamma (uppercase)",
    keywords: ["greek"],
    latex: "\\Gamma",
  },
  {
    id: "Delta",
    name: "Delta (uppercase)",
    keywords: ["greek", "change"],
    latex: "\\Delta",
  },
  {
    id: "Theta",
    name: "Theta (uppercase)",
    keywords: ["greek"],
    latex: "\\Theta",
  },
  {
    id: "Lambda",
    name: "Lambda (uppercase)",
    keywords: ["greek"],
    latex: "\\Lambda",
  },
  { id: "Xi", name: "Xi (uppercase)", keywords: ["greek"], latex: "\\Xi" },
  { id: "Pi", name: "Pi (uppercase)", keywords: ["greek", "product"], latex: "\\Pi" },
  {
    id: "Sigma",
    name: "Sigma (uppercase)",
    keywords: ["greek"],
    latex: "\\Sigma",
  },
  {
    id: "Upsilon",
    name: "Upsilon (uppercase)",
    keywords: ["greek"],
    latex: "\\Upsilon",
  },
  { id: "Phi", name: "Phi (uppercase)", keywords: ["greek"], latex: "\\Phi" },
  { id: "Psi", name: "Psi (uppercase)", keywords: ["greek"], latex: "\\Psi" },
  {
    id: "Omega",
    name: "Omega (uppercase)",
    keywords: ["greek", "ohm"],
    latex: "\\Omega",
  },
];

export const MATH_COMMANDS = COMMANDS;

/**
 * Filter + rank the catalog by `query` (the text typed after `\`, letters only).
 * An empty query returns the whole catalog in its curated order. Otherwise rank:
 * exact id > id prefix > keyword prefix > name word-prefix > substring — so
 * typing `int` surfaces `\int` first, then `\iint`/`\iiint`, etc.
 */
export function filterMathCommands(query: string): MathCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...COMMANDS];

  const scored: { cmd: MathCommand; score: number }[] = [];
  for (const cmd of COMMANDS) {
    const score = scoreCommand(cmd, q);
    if (score > 0) scored.push({ cmd, score });
  }
  // Stable sort: higher score first, original order within a score.
  return scored
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.cmd);
}

function scoreCommand(cmd: MathCommand, q: string): number {
  const id = cmd.id.toLowerCase();
  if (id === q) return 100;
  if (id.startsWith(q)) return 80;

  const name = cmd.name.toLowerCase();
  if (name.split(/\s+/).some((w) => w.startsWith(q))) return 50;
  if (cmd.keywords.some((k) => k.toLowerCase().startsWith(q))) return 40;

  if (id.includes(q) || name.includes(q)) return 20;
  if (cmd.keywords.some((k) => k.toLowerCase().includes(q))) return 10;
  return 0;
}

/** Whether every catalog entry parses cleanly (used by the test suite). */
export function allMathCommandsValid(): boolean {
  return COMMANDS.every((c) => isValidLatex(c.latex));
}
