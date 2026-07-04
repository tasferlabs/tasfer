/**
 * Error-tolerant recursive-descent parser: LaTeX string → math AST.
 *
 * "Error-tolerant" is a hard requirement, not a nicety: while a user types, the
 * source is syntactically incomplete on most keystrokes (`\frac{a}{`, `x^`).
 * The parser therefore NEVER throws — missing arguments become empty groups and
 * unknown commands become visible `unknown` placeholders, so a live preview can
 * render the valid part of every intermediate string.
 */
import { mathSymbols, type SymbolInfo } from "../data/symbols";
import type {
  MClassNode,
  Node,
  PhantomNode,
  Span,
  StyleNode,
} from "./ast";
import { type Token, tokenize } from "./lexer";

export interface ParseOptions {
  /**
   * Source range of a control word the caller marks as "still being typed"
   * (its `\` sits at `literalRange.start`). That one command is parsed as a
   * literal `unknown` placeholder instead of being resolved — so a command en
   * route to a longer one (`\in` heading to `\int`) renders as its source text
   * rather than briefly flashing the `\in` symbol mid-type. Resolve it with
   * {@link pendingCommandRange}; everything else parses normally.
   */
  literalRange?: { start: number; end: number };
}

export function parse(src: string, opts: ParseOptions = {}): Node {
  return new Parser(src, opts).parseRoot();
}

class Parser {
  private readonly toks: Token[];
  private pos = 0;
  private readonly len: number;
  private readonly literalRange?: { start: number; end: number };

  constructor(src: string, opts: ParseOptions = {}) {
    // Pass the in-progress command's `\` offset so the lexer keeps it from
    // merging with a following `\command` into a `\\` line break (which would
    // de-structure the construct — see `tokenize`).
    this.toks = tokenize(src, opts.literalRange?.start);
    this.len = src.length;
    this.literalRange = opts.literalRange;
  }

  private peek(): Token {
    return this.toks[this.pos];
  }
  private next(): Token {
    return this.toks[this.pos++];
  }

  /** Skip whitespace tokens (math mode collapses inter-atom space). */
  private skipSpace(): void {
    while (this.peek().kind === "space") this.pos++;
  }

  parseRoot(): Node {
    const body = this.parseExpression(["eof"]);
    return { type: "ord", body, span: { start: 0, end: this.len } };
  }

  /**
   * Parse a run of atoms until a stop token (or a stop command like `right`),
   * which is left unconsumed for the caller.
   */
  private parseExpression(
    stop: Token["kind"][],
    stopCommand?: string,
  ): Node[] {
    const out: Node[] = [];
    for (;;) {
      this.skipSpace();
      const t = this.peek();
      if (t.kind === "eof" || stop.includes(t.kind)) break;
      if (stopCommand && t.kind === "command" && t.value === stopCommand) break;
      // A style switch (\displaystyle, …) re-styles the rest of this group.
      if (t.kind === "command" && t.value in STYLE_SWITCHES) {
        this.next();
        const rest = this.parseExpression(stop, stopCommand);
        out.push({
          type: "style",
          style: STYLE_SWITCHES[t.value],
          body: rest,
          span: { start: t.start, end: this.peek().start },
        });
        break;
      }
      const atom = this.parseAtomWithScripts();
      if (atom) out.push(atom);
      else if (this.peek() === t) this.pos++; // guard against non-progress
    }
    return resolveInfix(out);
  }

  /**
   * Read a single delimiter following `\left`/`\right`/`\big*`: a literal
   * bracket char, a `.` (null delimiter), or a command like `\langle`.
   */
  private parseDelim(): string {
    this.skipSpace();
    const t = this.peek();
    if (t.kind === "command") {
      this.next();
      return "\\" + t.value;
    }
    if (t.kind === "char" || t.kind === "lbrace" || t.kind === "rbrace") {
      this.next();
      return t.value;
    }
    return "."; // missing delimiter → null delimiter
  }

  /** A base atom plus any trailing ^/_ scripts (and `'` primes). */
  private parseAtomWithScripts(): Node | null {
    const base = this.parseAtom();
    this.skipSpace();
    let k = this.peek().kind;
    if (k !== "sup" && k !== "sub" && !this.isPrime()) return base;

    let sup: Node | null = null;
    let sub: Node | null = null;
    let hadExplicitSup = false;
    const start = base ? base.span.start : this.peek().start;
    let end = base ? base.span.end : start;

    // Append `arg` to the superscript, concatenating into an ord group so a
    // prime run and a following `^` share one superscript (`x'^2`), in source
    // order — mirroring KaTeX's prime handling.
    const appendSup = (arg: Node): void => {
      if (!sup) {
        sup = arg;
        return;
      }
      const body = sup.type === "ord" ? [...sup.body] : [sup];
      body.push(arg);
      sup = { type: "ord", body, span: { start: sup.span.start, end: arg.span.end } };
    };

    while (k === "sup" || k === "sub" || this.isPrime()) {
      if (this.isPrime()) {
        // A run of `'` becomes prime superscripts (TeX's `x'` ⇒ `x^{\prime}`).
        while (this.isPrime()) {
          const p = this.next();
          end = p.end;
          appendSup({ type: "atom", info: mathSymbols["\\prime"], span: span(p) });
        }
      } else {
        const marker = this.next(); // ^ or _
        const arg = this.parseArg();
        end = arg.span.end;
        if (marker.kind === "sup") {
          // First explicit `^` joins any primes; a repeated one (x^a^b) keeps
          // the first, tolerating the error.
          if (!hadExplicitSup) {
            appendSup(arg);
            hadExplicitSup = true;
          }
        } else {
          sub = sub ?? arg;
        }
      }
      this.skipSpace();
      k = this.peek().kind;
    }

    return { type: "supsub", base, sup, sub, span: { start, end } };
  }

  /** The next token is a `'` prime mark. */
  private isPrime(): boolean {
    const t = this.peek();
    return t.kind === "char" && t.value === "'";
  }

  /** A single base unit: a group, a symbol, or a command. */
  private parseAtom(): Node | null {
    this.skipSpace();
    const t = this.peek();
    switch (t.kind) {
      case "lbrace":
        return this.parseGroup();
      case "char":
        this.next();
        return { type: "atom", info: symbolFor(t.value), span: span(t) };
      case "command":
        return this.parseCommand();
      default:
        return null;
    }
  }

  /** `{ … }` → an ord group. Tolerates a missing closing brace. */
  private parseGroup(): Node {
    const open = this.next(); // {
    const body = this.parseExpression(["rbrace"]);
    let end = this.peek().end;
    if (this.peek().kind === "rbrace") this.next();
    else end = body.length ? body[body.length - 1].span.end : open.end;
    return { type: "ord", body, span: { start: open.start, end } };
  }

  private parseCommand(): Node {
    const cmd = this.next();
    const name = cmd.value;

    // A command the caller marked as "still being typed" (its `\` sits at
    // literalRange.start): emit a literal `unknown` placeholder rather than
    // resolving it, so an in-progress command shows as source text (`\in`)
    // instead of flashing its symbol (∈) on the way to `\int`. Deletion and
    // caret navigation parse WITHOUT this flag, so a committed command stays a
    // single atomic token — this only changes how the in-progress one renders.
    if (this.literalRange && cmd.start === this.literalRange.start) {
      return { type: "unknown", name, span: span(cmd) };
    }

    if (name === "begin") return this.parseEnvironment(cmd);

    if (name in MATH_OPERATORS) {
      return { type: "opname", name, limits: MATH_OPERATORS[name], span: span(cmd) };
    }

    if (name in MATH_FONTS) {
      const body = this.parseArg();
      return {
        type: "mathfont",
        variant: MATH_FONTS[name],
        body,
        span: { start: cmd.start, end: body.span.end },
      };
    }

    // `\not`, and its precomposed aliases `\neq`/`\ne` (= `\not=`), strike a
    // slash through the following atom (drawn as a canvas path — no font glyph).
    if (name === "not") {
      const base = this.parseArg();
      return { type: "not", base, span: { start: cmd.start, end: base.span.end } };
    }
    if (name === "neq" || name === "ne") {
      const base: Node = { type: "atom", info: symbolFor("="), span: span(cmd) };
      return { type: "not", base, span: span(cmd) };
    }
    if (name === "notin") {
      const base: Node = { type: "atom", info: mathSymbols["\\in"], span: span(cmd) };
      return { type: "not", base, span: span(cmd) };
    }

    // Fraction family — prefix forms (\dfrac, \binom, \cfrac, …).
    const frac = FRAC_FORMS[name];
    if (frac) {
      const num = this.parseArg();
      const den = this.parseArg();
      return { type: "frac", num, den, ...frac, span: { start: cmd.start, end: den.span.end } };
    }
    // Infix forms (\over, \choose, …) — resolved against the enclosing group.
    if (name in INFIX_FORMS) {
      return { type: "infix", form: INFIX_FORMS[name], span: span(cmd) };
    }

    // Text-mode runs (\text, \textbf, …) — raw characters in a roman face.
    if (name in TEXT_FONTS) {
      const r = this.parseRawTextArg();
      return { type: "text", text: r.text, variant: TEXT_FONTS[name], span: { start: cmd.start, end: r.end } };
    }

    // \operatorname{…} / \operatorname* / \operatornamewithlimits.
    if (name === "operatorname" || name === "operatornamewithlimits") {
      let limits = name === "operatornamewithlimits";
      if (name === "operatorname" && this.peek().kind === "char" && this.peek().value === "*") {
        this.next();
        limits = true;
      }
      const r = this.parseRawTextArg();
      return { type: "opname", name: r.text, limits, span: { start: cmd.start, end: r.end } };
    }

    // Atom-class overrides (\mathbin, \mathrel, …, \mathop).
    if (name in MCLASS_FORMS) {
      const body = this.parseArg();
      return { type: "mclass", mclass: MCLASS_FORMS[name], body, span: { start: cmd.start, end: body.span.end } };
    }

    // Stacking (\overset, \underset, \stackrel).
    if (name === "overset" || name === "underset" || name === "stackrel") {
      const script = this.parseArg();
      const base = this.parseArg();
      return { type: "stack", kind: name, script, base, span: { start: cmd.start, end: base.span.end } };
    }

    if (name === "boxed" || name === "fbox") {
      const body = this.parseArg();
      return { type: "boxed", body, span: { start: cmd.start, end: body.span.end } };
    }

    if (name in PHANTOM_FORMS) {
      const body = this.parseArg();
      return { type: "phantom", kind: PHANTOM_FORMS[name], body, span: { start: cmd.start, end: body.span.end } };
    }
    if (name === "mathstrut") {
      const base: Node = { type: "atom", info: symbolFor("("), span: span(cmd) };
      return { type: "phantom", kind: "vphantom", body: base, span: span(cmd) };
    }

    // Modulo macros.
    if (name === "bmod") {
      const body: Node = { type: "opname", name: "mod", limits: false, span: span(cmd) };
      return { type: "mclass", mclass: "mbin", body, span: span(cmd) };
    }
    if (name === "pmod" || name === "mod" || name === "pod") {
      const arg = this.parseArg();
      return this.makeMod(name, arg, cmd);
    }

    // Explicit spacing (fixed muskip widths, then length-argument kerns).
    if (name in SPACE_WIDTHS) {
      return { type: "space", width: SPACE_WIDTHS[name], span: span(cmd) };
    }
    if (name in LENGTH_KERNS) {
      const w = this.parseLengthArg(LENGTH_KERNS[name]);
      return { type: "space", width: w, span: span(cmd) };
    }

    // Blackboard-bold number-set shortcuts (\R, \N, \Z, …).
    if (name in BLACKBOARD) {
      const body: Node = { type: "atom", info: symbolFor(BLACKBOARD[name]), span: span(cmd) };
      return { type: "mathfont", variant: "AMS-Regular", body, span: span(cmd) };
    }
    // Symbol aliases (\sdot → \cdot, \darr → \downarrow, …).
    if (name in SYMBOL_ALIASES) {
      const info = mathSymbols[SYMBOL_ALIASES[name]];
      if (info) return { type: "atom", info, span: span(cmd) };
    }
    // Logical-connective macros — a spaced relation (\iff, \implies, …).
    if (name in LOGIC_RELS) {
      const info = mathSymbols[LOGIC_RELS[name]];
      if (info) {
        const thick = 5 / 18;
        const sp = (): Node => ({ type: "space", width: thick, span: span(cmd) });
        const body: Node[] = [sp(), { type: "atom", info, span: span(cmd) }, sp()];
        return { type: "ord", body, span: span(cmd) };
      }
    }
    // Dots — \cdots/\ddots are inner ⋯/⋱ (their glyphs sit raised, via a
    // negative metric depth); \vdots is ⋮; the \dots* family picks centered vs
    // baseline dots (we approximate the context rule).
    if (name in DOTS) {
      const d = DOTS[name];
      return { type: "atom", info: { font: "main", group: d.group, char: d.char }, span: span(cmd) };
    }

    if (name === "colon") {
      return { type: "atom", info: { font: "main", group: "punct", char: ":" }, span: span(cmd) };
    }
    if (name === "imath" || name === "jmath") {
      const ch = name === "imath" ? "ı" : "ȷ";
      return { type: "atom", info: { font: "main", group: "mathord", char: ch }, span: span(cmd) };
    }
    // A stray `\end` (error-tolerant): swallow its name, render nothing.
    if (name === "end") {
      this.parseEnvName();
      return { type: "ord", body: [], span: span(cmd) };
    }

    if (OVER_UNDER.has(name)) {
      const body = this.parseArg();
      return {
        type: "overunder",
        kind: name as "overline" | "underline" | "overbrace" | "underbrace",
        body,
        span: { start: cmd.start, end: body.span.end },
      };
    }

    if (name === "frac") {
      const num = this.parseArg();
      const den = this.parseArg();
      return {
        type: "frac",
        num,
        den,
        span: { start: cmd.start, end: den.span.end },
      };
    }

    if (name === "sqrt") {
      const index = this.parseOptionalArg();
      const body = this.parseArg();
      return {
        type: "sqrt",
        index,
        body,
        span: { start: cmd.start, end: body.span.end },
      };
    }

    if (name === "left") {
      const left = this.parseDelim();
      const body = this.parseExpression(["eof"], "right");
      let end = this.peek().end;
      // Consume the matching \right and its delimiter.
      let right = ".";
      if (this.peek().kind === "command" && this.peek().value === "right") {
        const r = this.next();
        right = this.parseDelim();
        end = r.end;
      }
      return { type: "leftright", left, right, body, span: { start: cmd.start, end } };
    }

    const sized = DELIM_SIZES[name];
    if (sized) {
      const delim = this.parseDelim();
      return {
        type: "sizeddelim",
        delim,
        size: sized.size,
        mclass: sized.mclass,
        span: { start: cmd.start, end: this.toks[this.pos - 1].end },
      };
    }

    if (name in SPACES) {
      return { type: "space", width: SPACES[name], span: span(cmd) };
    }

    if (ACCENTS.has(name)) {
      const base = this.parseArg();
      return {
        type: "accent",
        label: "\\" + name,
        base,
        stretchy: STRETCHY_ACCENTS.has(name),
        span: { start: cmd.start, end: base.span.end },
      };
    }

    const info = mathSymbols["\\" + name];
    if (info) return { type: "atom", info, span: span(cmd) };

    return { type: "unknown", name, span: span(cmd) };
  }

  /**
   * A mandatory argument: a braced group, or — TeX-style — the single next
   * atom (`\frac12`). A missing argument yields an empty group so layout has
   * something to place.
   */
  private parseArg(): Node {
    this.skipSpace();
    const t = this.peek();
    if (t.kind === "lbrace") return this.parseGroup();
    if (t.kind === "eof" || t.kind === "rbrace") {
      return { type: "ord", body: [], span: { start: t.start, end: t.start } };
    }
    const atom = this.parseAtom();
    if (atom) return atom;
    return { type: "ord", body: [], span: { start: t.start, end: t.start } };
  }

  /**
   * `\begin{env}[…] … \end{env}` — a tabular environment. Cells are separated
   * by `&`, rows by `\\`. Error-tolerant: a missing `\end` just ends at EOF.
   */
  private parseEnvironment(begin: Token): Node {
    const env = this.parseEnvName();
    const colAlign = env === "array" || env === "subarray"
      ? this.parseColSpec()
      : undefined;

    const rows: Node[][] = [];
    let row: Node[] = [];
    for (;;) {
      this.skipSpace();
      const t = this.peek();
      if (t.kind === "eof") break;
      if (t.kind === "command" && t.value === "end") break;

      const cellStart = t.start;
      const body = this.parseExpression(["amp", "dbackslash"], "end");
      const last = body.length ? body[body.length - 1].span.end : cellStart;
      row.push({ type: "ord", body, span: { start: cellStart, end: last } });

      const sep = this.peek();
      if (sep.kind === "amp") {
        this.next();
      } else if (sep.kind === "dbackslash") {
        this.next();
        rows.push(row);
        row = [];
      } else {
        break; // eof or \end
      }
    }
    // A non-empty final row, or a trailing row that isn't just one empty cell.
    if (row.length && !(row.length === 1 && isEmptyOrd(row[0]))) rows.push(row);

    let end = this.peek().end;
    if (this.peek().kind === "command" && this.peek().value === "end") {
      this.next();
      this.parseEnvName();
      end = this.toks[this.pos - 1].end;
    }
    return { type: "array", env, rows, colAlign, span: { start: begin.start, end } };
  }

  /** Read a `{name}` group as a plain string (environment name). */
  private parseEnvName(): string {
    this.skipSpace();
    if (this.peek().kind !== "lbrace") return "";
    this.next();
    let name = "";
    while (this.peek().kind === "char") name += this.next().value;
    if (this.peek().kind === "rbrace") this.next();
    return name;
  }

  /** Read a `\begin{array}{lcr}` column spec; bars and other chars are ignored. */
  private parseColSpec(): ("l" | "c" | "r")[] {
    this.skipSpace();
    const aligns: ("l" | "c" | "r")[] = [];
    if (this.peek().kind !== "lbrace") return aligns;
    this.next();
    while (this.peek().kind === "char") {
      const c = this.next().value;
      if (c === "l" || c === "c" || c === "r") aligns.push(c);
    }
    if (this.peek().kind === "rbrace") this.next();
    return aligns;
  }

  /**
   * Read a `{…}` argument as a raw string (text mode), preserving spaces.
   * Used by `\text` / `\operatorname`, whose bodies are characters, not atoms.
   */
  private parseRawTextArg(): { text: string; end: number } {
    this.skipSpace();
    if (this.peek().kind !== "lbrace") {
      // A single token argument (`\text x`).
      const t = this.next();
      return { text: t.kind === "command" ? t.value : t.value, end: t.end };
    }
    this.next(); // {
    let depth = 1;
    let text = "";
    let end = this.peek().end;
    while (this.peek().kind !== "eof") {
      const t = this.peek();
      if (t.kind === "lbrace") depth++;
      else if (t.kind === "rbrace") {
        depth--;
        if (depth === 0) { end = t.end; this.next(); break; }
      }
      this.next();
      end = t.end;
      if (t.kind === "space") text += " ";
      else if (t.kind === "command") text += t.value; // bare letters of \cmd
      else if (t.kind !== "lbrace" && t.kind !== "rbrace") text += t.value;
    }
    return { text, end };
  }

  /** Parse a length argument (`\kern2em`, `\mkern{18mu}`) → width in em. */
  private parseLengthArg(unitDefault: "em" | "mu"): number {
    this.skipSpace();
    const braced = this.peek().kind === "lbrace";
    if (braced) this.next();
    this.skipSpace();
    let s = "";
    // sign + digits + dot + unit letters, read off the raw char/command stream.
    while (this.peek().kind === "char") {
      const c = this.peek().value;
      if (/[-+0-9.a-zA-Z]/.test(c)) { s += c; this.next(); } else break;
    }
    if (braced && this.peek().kind === "rbrace") this.next();
    const m = s.match(/^([-+]?[0-9]*\.?[0-9]+)\s*([a-zA-Z]*)$/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    const unit = m[2] || unitDefault;
    switch (unit) {
      case "mu": return n / 18;
      case "pt": return n / 10; // ptPerEm = 10
      case "ex": return n * 0.431; // ≈ xHeight
      case "em": default: return n;
    }
  }

  /** Build `\pmod{n}` / `\mod{n}` / `\pod{n}` as a parenthesized "mod" group. */
  private makeMod(name: "pmod" | "mod" | "pod", arg: Node, cmd: Token): Node {
    const sp = (w: number): Node => ({ type: "space", width: w, span: span(cmd) });
    const mod: Node = { type: "opname", name: "mod", limits: false, span: span(cmd) };
    const open: Node = { type: "atom", info: symbolFor("("), span: span(cmd) };
    const close: Node = { type: "atom", info: symbolFor(")"), span: span(cmd) };
    let body: Node[];
    if (name === "pod") body = [sp(0.444), open, arg, close];
    else if (name === "mod") body = [sp(0.667), mod, sp(0.333), arg];
    else body = [sp(0.444), open, mod, sp(0.333), arg, close]; // \pmod
    return { type: "ord", body, span: { start: cmd.start, end: arg.span.end } };
  }

  /** An optional `[ … ]` argument (e.g. the root index of `\sqrt[3]{x}`). */
  private parseOptionalArg(): Node | null {
    this.skipSpace();
    if (!(this.peek().kind === "char" && this.peek().value === "[")) return null;
    const open = this.next(); // [
    const body: Node[] = [];
    while (this.peek().kind !== "eof") {
      if (this.peek().kind === "char" && this.peek().value === "]") break;
      const atom = this.parseAtomWithScripts();
      if (atom) body.push(atom);
      else this.pos++;
    }
    let end = this.peek().end;
    if (this.peek().kind === "char" && this.peek().value === "]") this.next();
    else end = body.length ? body[body.length - 1].span.end : open.end;
    return { type: "ord", body, span: { start: open.start, end } };
  }
}

/** `\big`-family → delimiter size + atom class. */
const DELIM_SIZES: Record<
  string,
  { size: 1 | 2 | 3 | 4; mclass: "mopen" | "mclose" | "mrel" | "mord" }
> = {
  big: { size: 1, mclass: "mord" },
  Big: { size: 2, mclass: "mord" },
  bigg: { size: 3, mclass: "mord" },
  Bigg: { size: 4, mclass: "mord" },
  bigl: { size: 1, mclass: "mopen" },
  Bigl: { size: 2, mclass: "mopen" },
  biggl: { size: 3, mclass: "mopen" },
  Biggl: { size: 4, mclass: "mopen" },
  bigr: { size: 1, mclass: "mclose" },
  Bigr: { size: 2, mclass: "mclose" },
  biggr: { size: 3, mclass: "mclose" },
  Biggr: { size: 4, mclass: "mclose" },
  bigm: { size: 1, mclass: "mrel" },
  Bigm: { size: 2, mclass: "mrel" },
  biggm: { size: 3, mclass: "mrel" },
  Biggm: { size: 4, mclass: "mrel" },
};

/** Explicit spacing commands → width in em (mu values use 1mu = 1/18 em). */
const SPACES: Record<string, number> = {
  quad: 1.0,
  qquad: 2.0,
  ",": 3 / 18, // \, thin space
  ":": 4 / 18, // \: medium space
  ";": 5 / 18, // \; thick space
  "!": -3 / 18, // \! negative thin space
  " ": 0.3333, // \<space> control space
  enspace: 0.5,
  thinspace: 3 / 18,
  enskip: 0.5,
};

/** Accents (over the base). `widehat`/`widetilde` stretch to the base width. */
const ACCENTS = new Set([
  "hat", "widehat", "tilde", "widetilde", "bar", "vec",
  "dot", "ddot", "acute", "grave", "check", "breve", "mathring",
]);

/** Accents whose glyph stretches to span the whole base. */
const STRETCHY_ACCENTS = new Set(["widehat", "widetilde"]);

/** Full-width rules / stretchy braces placed over or under their body. */
const OVER_UNDER = new Set([
  "overline", "underline", "overbrace", "underbrace",
]);

/**
 * Named math operators → whether they take limits (scripts stacked above/below
 * in display style). The no-limit ops keep their scripts on the side.
 * Exported (within the package) as the data behind `operatorCommands`.
 */
export const MATH_OPERATORS: Record<string, boolean> = {
  // No limits (scripts on the side).
  arcsin: false, arccos: false, arctan: false, arctg: false, arcctg: false,
  arg: false, cos: false, cosec: false, cosh: false, cot: false, cotg: false,
  coth: false, csc: false, ctg: false, cth: false, deg: false, dim: false,
  exp: false, hom: false, ker: false, lg: false, ln: false, log: false,
  sec: false, sin: false, sinh: false, sh: false, tan: false, tanh: false,
  tg: false, th: false,
  // Limits (scripts above/below in display).
  det: true, gcd: true, inf: true, lim: true, liminf: true, limsup: true,
  max: true, min: true, Pr: true, sup: true, injlim: true, projlim: true,
  argmax: true, argmin: true,
};

/** Font/alphabet commands → the face variant their argument is set in. */
const MATH_FONTS: Record<string, string> = {
  mathrm: "Main-Regular",
  mathbf: "Main-Bold",
  mathit: "Main-Italic",
  mathnormal: "Math-Italic",
  boldsymbol: "Math-BoldItalic",
  bm: "Math-BoldItalic",
  mathbb: "AMS-Regular",
  mathcal: "Caligraphic-Regular",
  mathfrak: "Fraktur-Regular",
  mathsf: "SansSerif-Regular",
  mathtt: "Typewriter-Regular",
  mathscr: "Script-Regular",
};

/** Prefix fraction commands → their `FracNode` overrides. */
const FRAC_FORMS: Record<
  string,
  { hasRule?: boolean; leftDelim?: string; rightDelim?: string; forceStyle?: "display" | "text"; continued?: boolean }
> = {
  dfrac: { forceStyle: "display" },
  tfrac: { forceStyle: "text" },
  cfrac: { forceStyle: "display", continued: true },
  binom: { hasRule: false, leftDelim: "(", rightDelim: ")" },
  dbinom: { hasRule: false, leftDelim: "(", rightDelim: ")", forceStyle: "display" },
  tbinom: { hasRule: false, leftDelim: "(", rightDelim: ")", forceStyle: "text" },
};

/** Infix fraction operators → bar/delimiter form (style stays ambient). */
const INFIX_FORMS: Record<
  string,
  { hasRule?: boolean; leftDelim?: string; rightDelim?: string }
> = {
  over: { hasRule: true },
  atop: { hasRule: false },
  choose: { hasRule: false, leftDelim: "(", rightDelim: ")" },
  brace: { hasRule: false, leftDelim: "\\{", rightDelim: "\\}" },
  brack: { hasRule: false, leftDelim: "[", rightDelim: "]" },
};

/** Text-mode font commands → their face variant. */
const TEXT_FONTS: Record<string, string> = {
  text: "Main-Regular",
  textrm: "Main-Regular",
  textnormal: "Main-Regular",
  textmd: "Main-Regular",
  textup: "Main-Regular",
  textbf: "Main-Bold",
  textit: "Main-Italic",
  texttt: "Typewriter-Regular",
  textsf: "SansSerif-Regular",
};

/** Atom-class wrappers → resulting class. */
const MCLASS_FORMS: Record<string, MClassNode["mclass"]> = {
  mathord: "mord",
  mathbin: "mbin",
  mathrel: "mrel",
  mathopen: "mopen",
  mathclose: "mclose",
  mathpunct: "mpunct",
  mathinner: "minner",
  mathop: "mop",
};

/** Phantom-family commands → kind. */
const PHANTOM_FORMS: Record<string, PhantomNode["kind"]> = {
  phantom: "phantom",
  hphantom: "hphantom",
  vphantom: "vphantom",
  smash: "smash",
};

/** Style-switch commands → the style they impose on the rest of the group. */
const STYLE_SWITCHES: Record<string, StyleNode["style"]> = {
  displaystyle: "display",
  textstyle: "text",
  scriptstyle: "script",
  scriptscriptstyle: "scriptscript",
};

/** Fixed-width spacing commands → width in em (18 mu = 1 em). */
const SPACE_WIDTHS: Record<string, number> = {
  thinspace: 3 / 18,
  medspace: 4 / 18,
  thickspace: 5 / 18,
  negthinspace: -3 / 18,
  negmedspace: -4 / 18,
  negthickspace: -5 / 18,
  enspace: 0.5,
  space: 1 / 3,
  nobreakspace: 1 / 3,
};

/** Length-argument kerns → default unit when the arg has none. */
const LENGTH_KERNS: Record<string, "em" | "mu"> = {
  kern: "em",
  hskip: "em",
  hspace: "em",
  mkern: "mu",
  mskip: "mu",
  mspace: "mu",
};

/** Blackboard-bold number-set shortcuts → the letter to set in `\mathbb`. */
const BLACKBOARD: Record<string, string> = {
  R: "R", N: "N", Z: "Z", C: "C", Q: "Q", H: "H",
  Reals: "R", reals: "R", Complex: "C", cnums: "C", natnums: "N",
};

/** Simple symbol aliases → the canonical command in `mathSymbols`. */
const SYMBOL_ALIASES: Record<string, string> = {
  darr: "\\downarrow", uarr: "\\uparrow", larr: "\\leftarrow", rarr: "\\rightarrow",
  lang: "\\langle", rang: "\\rangle", sdot: "\\cdot", plusmn: "\\pm",
  infin: "\\infty", exist: "\\exists", isin: "\\in", empty: "\\emptyset",
  weierp: "\\wp", image: "\\Im", real: "\\Re", alef: "\\aleph", alefsym: "\\aleph",
  bull: "\\bullet", sect: "\\S", gets: "\\leftarrow", owns: "\\ni",
};

/** Logical connectives → the relation glyph, rendered spaced (`\;sym\;`). */
const LOGIC_RELS: Record<string, string> = {
  iff: "\\Longleftrightarrow",
  implies: "\\Longrightarrow",
  impliedby: "\\Longleftarrow",
};

/** Dots commands → glyph + atom group (centered ⋯/⋱ are inner). */
const DOTS: Record<string, { char: string; group: "inner" | "textord" }> = {
  cdots: { char: "⋯", group: "inner" },
  ddots: { char: "⋱", group: "inner" },
  vdots: { char: "⋮", group: "textord" },
  dotsb: { char: "⋯", group: "inner" },
  dotsm: { char: "⋯", group: "inner" },
  dotsi: { char: "⋯", group: "inner" },
  dotsc: { char: "…", group: "inner" },
  dotso: { char: "…", group: "inner" },
  dotsx: { char: "…", group: "inner" },
  dots: { char: "…", group: "inner" },
  ldots: { char: "…", group: "inner" },
};

/**
 * Every recognized command *name* (no backslash) — the union of every command
 * table above, the inline-handled control words in `parseCommand`, and the
 * symbol table. This is the authoritative "is this a real command" oracle used
 * by {@link needsCommandSeparator} to tell a complete command from one the user
 * is still typing.
 */
const KNOWN_COMMAND_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(DELIM_SIZES),
  ...Object.keys(SPACES),
  ...ACCENTS,
  ...OVER_UNDER,
  ...Object.keys(MATH_OPERATORS),
  ...Object.keys(MATH_FONTS),
  ...Object.keys(FRAC_FORMS),
  ...Object.keys(INFIX_FORMS),
  ...Object.keys(TEXT_FONTS),
  ...Object.keys(MCLASS_FORMS),
  ...Object.keys(PHANTOM_FORMS),
  ...Object.keys(STYLE_SWITCHES),
  ...Object.keys(SPACE_WIDTHS),
  ...Object.keys(LENGTH_KERNS),
  ...Object.keys(BLACKBOARD),
  ...Object.keys(SYMBOL_ALIASES),
  ...Object.keys(LOGIC_RELS),
  ...Object.keys(DOTS),
  // Symbol commands (`\alpha`, `\oint`, …) — keys are backslash-prefixed; the
  // bare literal-char keys (`+`, `=`) aren't command names, so keep only `\…`.
  ...Object.keys(mathSymbols)
    .filter((k) => k.startsWith("\\"))
    .map((k) => k.slice(1)),
  // Control words handled by inline branches in `parseCommand`.
  "begin", "end", "not", "neq", "ne", "notin",
  "operatorname", "operatornamewithlimits",
  "overset", "underset", "stackrel", "boxed", "fbox", "mathstrut",
  "bmod", "pmod", "mod", "pod", "colon", "imath", "jmath",
  "frac", "sqrt", "left", "right",
]);

/** Whether `name` could still grow into a known command (`inf` → `infty`). */
function isCommandNamePrefix(name: string): boolean {
  for (const n of KNOWN_COMMAND_NAMES) {
    if (n.length > name.length && n.startsWith(name)) return true;
  }
  return false;
}

/**
 * Whether typing `char` at `offset` into `latex` should be separated from a
 * preceding control word by a space.
 *
 * In LaTeX a control word swallows following letters, so typing `x` right after
 * a complete `\oint` would silently corrupt it into the unknown `\ointx`. A live
 * editor uses this to insert a space instead (`\oint x` → ∮x), so the letter
 * becomes a new atom. Returns false while the user is still typing the command
 * itself: when the run to the left isn't a complete command yet (`\al`), or when
 * extending it stays a known command or could grow into one (`\in`+`f` → `\inf`,
 * still en route to `\infty`) — so command typing, including prefix-sharing
 * names, is never interrupted. Only letters trigger it; digits/symbols already
 * terminate a control word on their own.
 */
export function needsCommandSeparator(
  latex: string,
  offset: number,
  char: string,
): boolean {
  if (!/^[a-zA-Z]$/.test(char)) return false;
  // Walk back over the letters immediately before the caret to the `\`.
  let i = offset;
  while (i > 0 && /[a-zA-Z]/.test(latex[i - 1])) i--;
  // Must sit right after a control word: a `\` that isn't the second half of a
  // line-break `\\` (whose trailing letters are ordinary atoms, not a command).
  if (i === 0 || latex[i - 1] !== "\\" || latex[i - 2] === "\\") return false;
  const name = latex.slice(i, offset);
  if (!KNOWN_COMMAND_NAMES.has(name)) return false; // still typing the command
  const extended = name + char;
  // Still a command (or on the way to a longer one) → keep typing it.
  return !KNOWN_COMMAND_NAMES.has(extended) && !isCommandNamePrefix(extended);
}

/**
 * The source range of a `\`+letters control word ending *exactly* at `caret` —
 * the command the user is currently typing — or null if the caret isn't at the
 * trailing edge of such a run. A live editor uses this to render an in-progress
 * command (`\al` on the way to `\alpha`) in the normal text color rather than
 * the red "unknown command" placeholder: it isn't an error yet, just unfinished.
 * Once the caret moves off the run (or it's completed/committed) the range no
 * longer matches and the red shows. Mirrors {@link needsCommandSeparator}'s
 * back-scan, including the line-break `\\` guard.
 *
 * A run that is ALREADY a complete command with nowhere left to grow (`\frac`,
 * `\alpha` — known, and not a prefix of any longer command) is *not* pending: it
 * has resolved. Rendering it literally would parse it as an `unknown` placeholder
 * and orphan its arguments — `\frac{dy}{dx}` would de-structure into the literal
 * `\frac` followed by bare `dy`/`dx` groups (`\fracdydx`). Only an incomplete run
 * (`\fra`) or one still en route to a longer command (`\in`→`\int`) is pending,
 * exactly mirroring {@link needsCommandSeparator}'s "still typing" condition.
 *
 * The completeness check weighs the WHOLE control word — letters on both sides of
 * the caret — not just the prefix typed up to it. A caret resting *inside* a
 * finished command (`\fr|ac`, e.g. after the caret is placed before the chip and
 * a char is typed) still sees the full `\frac` and resolves; checking only the
 * prefix `\fr` would mistake it for an in-progress command and flash the whole
 * `\frac{dy}{dx}` literally as `\fracdydx`. The returned range still ends at the
 * caret — only the resolved-vs-pending decision consults the trailing letters.
 */
export function pendingCommandRange(
  latex: string,
  caret: number,
): { start: number; end: number } | null {
  let i = caret;
  while (i > 0 && /[a-zA-Z]/.test(latex[i - 1])) i--;
  if (i === 0 || latex[i - 1] !== "\\" || latex[i - 2] === "\\") return null;
  // The full control word spans the letter run on BOTH sides of the caret, so a
  // caret parked inside a complete command resolves it instead of going literal.
  let j = caret;
  while (j < latex.length && /[a-zA-Z]/.test(latex[j])) j++;
  const name = latex.slice(i, j);
  // A complete command that can't grow into a longer one is done, not pending.
  if (KNOWN_COMMAND_NAMES.has(name) && !isCommandNamePrefix(name)) return null;
  return { start: i - 1, end: caret };
}

/**
 * Resolve an infix fraction operator (`a \over b`) against the surrounding node
 * list: everything before becomes the numerator, everything after the
 * denominator (TeX allows at most one per group; we honor the first).
 */
function resolveInfix(nodes: Node[]): Node[] {
  const i = nodes.findIndex((n) => n.type === "infix");
  if (i < 0) return nodes;
  const marker = nodes[i] as Extract<Node, { type: "infix" }>;
  const before = nodes.slice(0, i);
  const after = resolveInfix(nodes.slice(i + 1));
  const wrap = (body: Node[]): Node => {
    if (body.length === 1 && body[0].type === "ord") return body[0];
    const start = body.length ? body[0].span.start : marker.span.start;
    const end = body.length ? body[body.length - 1].span.end : marker.span.end;
    return { type: "ord", body, span: { start, end } };
  };
  const frac: Node = {
    type: "frac",
    num: wrap(before),
    den: wrap(after),
    hasRule: marker.form.hasRule,
    leftDelim: marker.form.leftDelim,
    rightDelim: marker.form.rightDelim,
    span: marker.span,
  };
  return [frac];
}

function span(t: Token): Span {
  return { start: t.start, end: t.end };
}

/** True for an empty `{}` cell — used to drop a trailing `\\`'s phantom row. */
function isEmptyOrd(n: Node): boolean {
  return n.type === "ord" && n.body.length === 0;
}

/** Symbol info for a literal character, synthesizing an ordinary if unknown. */
export function symbolFor(ch: string): SymbolInfo {
  const known = mathSymbols[ch];
  if (known) return known;
  // Unknown literal: treat as an ordinary symbol in the main font (best effort).
  return { font: "main", group: "textord", char: ch };
}
