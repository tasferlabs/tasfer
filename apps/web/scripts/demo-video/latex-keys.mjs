// Turns a LaTeX formula into the keystrokes a person types to build it in a
// Tasfer equation block.
//
// The editor has no LaTeX source box: you type `\frac`, it becomes a fraction,
// and you move between its slots with Tab and the arrow keys. So the braces in
// the source are never typed — they tell us when to move the caret instead.
//
// Each returned step carries the keys to press and `upto`, the offset in the
// source that those keys finish.
//
// Supported: letters, digits, operators, `^` / `_`, grouping braces, and
// commands with brace arguments (`\frac{a}{b}`, `\sqrt{x}`, `\sum_{i}^{n}`,
// `\mathbb{R}`). Not supported: `\begin{…}` environments and `\left` / `\right`.

/** Keys that move from one slot of a command to the next, and out of the last. */
const SLOT_KEYS = {
  frac: "Tab",
  dfrac: "Tab",
  tfrac: "Tab",
};
const DEFAULT_SLOT_KEY = "ArrowRight";

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const start = i;
    const ch = src[i];
    if (ch === "\\") {
      const word = /^\\[a-zA-Z]+/.exec(src.slice(i));
      if (word) {
        i += word[0].length;
        tokens.push({ kind: "cmd", name: word[0].slice(1), start, end: i });
      } else {
        i += 2;
        tokens.push({ kind: "esc", ch: src[start + 1] ?? "", start, end: i });
      }
    } else if (ch === "{") {
      tokens.push({ kind: "open", start, end: ++i });
    } else if (ch === "}") {
      tokens.push({ kind: "close", start, end: ++i });
    } else if (ch === "^" || ch === "_") {
      tokens.push({ kind: "script", ch, start, end: ++i });
    } else if (/\s/.test(ch)) {
      while (i < src.length && /\s/.test(src[i])) i++;
      tokens.push({ kind: "ws", start, end: i });
    } else {
      const point = String.fromCodePoint(src.codePointAt(i));
      i += point.length;
      tokens.push({ kind: "char", ch: point, start, end: i });
    }
  }
  return tokens;
}

function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;

  function atom() {
    const token = tokens[pos++];
    if (token.kind === "open") {
      const atoms = row(true);
      const close = tokens[pos++];
      if (!close) throw new Error(`Unclosed "{" at ${token.start} in: ${src}`);
      return { kind: "group", atoms, start: token.start, end: close.end };
    }
    if (token.kind === "close") {
      throw new Error(`Stray "}" at ${token.start} in: ${src}`);
    }
    if (token.kind === "script") {
      while (tokens[pos]?.kind === "ws") pos++;
      if (!tokens[pos] || tokens[pos].kind === "close") {
        throw new Error(`"${token.ch}" needs something after it in: ${src}`);
      }
      const arg = atom();
      return { ...token, arg, end: arg.end };
    }
    return token;
  }

  function row(inGroup) {
    const atoms = [];
    while (pos < tokens.length) {
      if (tokens[pos].kind === "close") {
        if (inGroup) return atoms;
        throw new Error(`Stray "}" at ${tokens[pos].start} in: ${src}`);
      }
      atoms.push(atom());
    }
    return atoms;
  }

  return row(false);
}

/** The slots a catalog template opens, in order: `\sum_{}^{}` → sub, sup. */
function templateSlots(template) {
  if (!template) return [];
  if (template.startsWith("\\begin{")) return null;
  return [...template.matchAll(/([_^]?)\{\}/g)].map((m) =>
    m[1] === "_" ? "sub" : m[1] === "^" ? "sup" : "arg",
  );
}

/**
 * @param {string} src LaTeX source of one formula.
 * @param {{ id: string, latex: string }[]} [catalog] The editor's command
 *   list. Without it every command is committed with a space, which always
 *   works but shows a few spaces a person would not type.
 * @returns {{ keys: string[], upto: number }[]}
 */
export function latexToKeys(src, catalog) {
  const ids = catalog?.map((c) => c.id);
  const templates = new Map(catalog?.map((c) => [c.id, c.latex]));
  const steps = [];
  const push = (keys, upto) => steps.push({ keys, upto });

  // A fully typed command the editor keeps waiting on, because a longer one
  // starts the same way (`\in` could still become `\int`).
  function staysPending(name, followingLetter) {
    if (!ids) return true;
    if (!ids.includes(name)) return true;
    if (!ids.some((id) => id.length > name.length && id.startsWith(name))) {
      return false;
    }
    if (!followingLetter) return true;
    return ids.some((id) => id.startsWith(name + followingLetter));
  }

  function contentOf(atom) {
    return atom.kind === "group" ? atom.atoms : [atom];
  }

  function emitRow(atoms) {
    for (let i = 0; i < atoms.length; i++) {
      const atom = atoms[i];
      if (atom.kind === "ws") push([], atom.end);
      else if (atom.kind === "char") push([atom.ch], atom.end);
      else if (atom.kind === "esc") push(["\\", atom.ch], atom.end);
      else if (atom.kind === "group") {
        push([], atom.start + 1);
        emitRow(atom.atoms);
        push([], atom.end);
      } else if (atom.kind === "script") {
        const opensAt = atom.arg.kind === "group" ? atom.arg.start + 1 : atom.end;
        push([atom.ch], atom.arg.kind === "group" ? opensAt : atom.start + 1);
        emitRow(contentOf(atom.arg));
        push([DEFAULT_SLOT_KEY], atom.end);
      } else if (atom.kind === "cmd") {
        i = emitCommand(atoms, i);
      }
    }
  }

  function emitCommand(atoms, index) {
    const cmd = atoms[index];
    const slots = templateSlots(templates.get(cmd.name));
    if (slots === null) {
      throw new Error(`\\${cmd.name} is an environment; not supported yet.`);
    }
    push(["\\", ...cmd.name], cmd.end);

    const nextIndex = (from) => {
      let k = from;
      while (atoms[k]?.kind === "ws") k++;
      return k;
    };
    let cursor = index + 1;
    const next = atoms[nextIndex(cursor)];

    // A symbol or digit typed next commits the command on its own. Anything
    // else needs a space first — including `^` and `_`, which would otherwise
    // land on an empty base beside the command (`\int{}_{0}`).
    const nextLetter =
      next?.kind === "char" && /^[a-zA-Z]$/.test(next.ch) ? next.ch : "";
    const commitsItself = next?.kind === "char" && !nextLetter;
    if (!commitsItself && staysPending(cmd.name, nextLetter)) {
      push([" "], cmd.end);
    }

    // A command outside the editor's list (`\mathbb`, `\mathbf`) opens no
    // slot: it applies to the next character, so `\mathbb{R}` is typed as
    // `\mathbb`, space, `R`.
    if (!slots.length && next?.kind === "group") {
      const inner = next.atoms.filter((a) => a.kind !== "ws");
      if (inner.length !== 1 || inner[0].kind !== "char") {
        throw new Error(
          `\\${cmd.name}{…} can only hold one character here: ${src}`,
        );
      }
      push([inner[0].ch], next.end);
      return nextIndex(cursor);
    }

    // Slots the editor opened with the command: the caret is already in the
    // first one, so the source braces only say what goes inside.
    const wanted = slots;
    const slotKey = SLOT_KEYS[cmd.name] ?? DEFAULT_SLOT_KEY;
    let end = cmd.end;
    wanted.forEach((slot, n) => {
      const k = nextIndex(cursor);
      const atom = atoms[k];
      const matches =
        slot === "arg"
          ? atom?.kind === "group"
          : atom?.kind === "script" && atom.ch === (slot === "sub" ? "_" : "^");
      if (n > 0) push([slotKey], end);
      if (!matches) return; // slot left empty
      const inner = slot === "arg" ? atom : atom.arg;
      push([], inner.kind === "group" ? inner.start + 1 : atom.start + 1);
      emitRow(contentOf(inner));
      end = atom.end;
      cursor = k + 1;
    });
    if (wanted.length) push([slotKey], end);
    return cursor - 1;
  }

  emitRow(parse(src));
  push([], src.length);
  return steps.filter((step, i) => step.keys.length || i === steps.length - 1);
}
