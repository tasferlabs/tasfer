# Math Editing Corruption: Diagnosis and Remediation Plan

Status: investigation complete; Phase 0 and Phase 1 landed (see below); Phases
2-4 pending.
Scope: block and inline LaTeX editing (`packages/tex/src/edit`,
`packages/tex/src/parse`, `packages/editor/src/nodes/{MathNode,math,math-commands}.ts`,
`packages/editor/src/inline-math*`).

This document records why math editing keeps corrupting LaTeX source, the
reproduced root causes, and a phased plan to fix the bug *class* rather than
individual instances. It was produced by a systematic investigation (pipeline
map, parser-contract map, git-history taxonomy, test-coverage audit, and three
reproduction agents that drove real keystrokes through `insertText`). All 38
reproduced corruptions and the runnable repro tests are summarized here.

## Executive summary

The recurring corruption is not a collection of unrelated bugs. It is a single
architectural property producing endless surface bugs:

- Math is edited as a **flat LaTeX string** mutated by integer-offset splicing.
  There is no persistent structured model; structure is re-derived on every
  keystroke by re-parsing the whole string.
- The parser **never fails**. Invalid or incomplete source is silently
  reinterpreted, and some tokens are silently discarded during recovery.
- Safety is a fleet of independent, keystroke-time heuristics plus an ~8-pass
  post-edit repair pipeline. Each heuristic is effectively a blacklist entry
  added *after* a user found a corruption.
- There is **no validation gate** between a keystroke and the CRDT commit: any
  not-yet-enumerated character/construct interaction ships as silent corruption.
- There is **no property/fuzz testing** on the edit layer, so each hazard is
  discovered by a user and pinned as one frozen example.

The hazard space is the cross-product of every typed character against every
construct and caret position. It is open-ended, so an enumerate-and-patch
strategy cannot converge. The git history confirms this: in the 16 days after
live editing landed (2026-06-19) there were 10+ fix waves over the same seams,
with same-day re-fixes and at least one explicit oscillation regression.

## Data model (why a local edit has non-local effects)

- **Block math**: the LaTeX *is* the block's CRDT char-run visible text
  (`packages/editor/src/nodes/math.ts:80`, `MathNode.ts:827`).
- **Inline math**: the LaTeX is the visible text of a `"math"` mark span over an
  ordinary paragraph's CRDT text, resolved by tombstone-tolerant char ordinals
  (`packages/editor/src/inline-math-spans.ts:72`). Chip identity is emergent
  from the mark range, not a real node.
- No persistent AST. Every editing query (delete unit, matrix context, caret
  stops, heal, materialize) re-parses the full string. Offsets and AST meet only
  through a `span:{start,end}` threaded onto every AST node and layout box.
- Caret is a plain integer text index, remapped only by explicit plan fields; on
  remote sync it is merely clamped to length, never identity-remapped
  (`packages/editor/src/entries/editor.ts:4829`).

Keystroke path: `insertText` (`actions/actions.ts:1060`) → `mathTransformTypedInput`
(`math.ts:557`) → CRDT insert → `TEXT_INPUTTED` → `normalizeMathInput`
(`MathNode.ts:1246`), which chains chip edge-join → brace heal → construct
materialize → chip split → separator cleanup, all as extra CRDT ops in the same
transaction. Backspace path: `deleteText` (`actions/actions.ts:1308`) →
`mathDeleteUnit` (`math.ts:342`) → `texUnitBefore` (`edit/unit.ts:402`) →
`applyDeleteUnit` (`actions/actions.ts:675`) → `CONTENT_DELETED` observer.

## Reproduced root causes

Each was reproduced by typing character-by-character through the real
`insertText` pipeline. Counts are distinct corrupting `(formula, caret,
keystrokes)` inputs found.

### RC1 — `\text` + braces swallows the suffix (12 inputs)

`escapeTypedBrace` (`packages/tex/src/edit/brace.ts:58`) deliberately lets an
argument-opening `{` through raw (the `afterCommandIntro` check at `brace.ts:64`)
but nothing inserts the matching closer *at the caret*. The group is left open,
and on the same keystroke `balanceBraces` (`brace.ts:196`) appends the healing
`}` at `latex.length` (`brace.ts:207`). `balanceBraces`' own comment claims
"imbalance only enters through pasted/imported source" — violated by every
argument-opening `{` typed with content to the right of the caret.

- `x+y`, caret 0, type `\text{` → `\text{x+y}` (the math becomes the argument).
- Then typing the closing `}`: source now looks balanced, so `escapeTypedBrace`
  rewrites it to a literal `\}` → `\text{hi\}x+y}`.
- `\frac{a}{b}`, caret after `a`, type `\text{` → `\frac{a\text{}{b}}{}`
  (denominator sucked in, new empty denominator materialized).
- Whole `\text`-family affected (`\textrm{`, `\mathrm{`, ...).

Compounding cause: `parseRawTextArg` (`parser.ts:548`) grabs one token as the
argument when the next token is not `{`, and that fallback consumes structural
tokens (`&`, `\\`, `\end`).

### RC2 — a typed backslash fuses with existing adjacent content (21 inputs)

`backslashFusesWith` (`packages/tex/src/edit/brace.ts:145`) wedges a protective
`\ ` separator only for structural non-letters (`{ } & ^ _ [ ]` and `\\` inside
an environment). Letters are excluded by design ("`\`+letter is the command name
being typed"). That reasoning conflates letters the user is *about* to type with
letters that *already exist* to the caret's right.

- `\frac{a}{b}`, caret before `a`, type `\pi` → `\frac{\pia}{b}` (numerator gone;
  permanent unknown `\pia`). The separator logic (`needsCommandSeparator`,
  `parser.ts:930`) back-scans only letters *before* the caret, so it never fires.
- `\alpha+\beta`, caret before `+`, type `\` → `\alpha\+\beta` (operator consumed
  by an unknown command; latent when the user then clicks away).
- Inside `\text{hi}`, typing `\pi` → source `\text{\pihi}` renders as literal
  text `pihi` (backslash invisible, π never typeset), because `parseRawTextArg`
  inlines a command token's name as characters (`parser.ts:594`).

`/` is safe at every position — the corruption is specific to `\` before letters
(permanent) and abandoned `\` before a digit/operator (latent).

### RC3 — matrix cells are destroyed by typing/deleting (5 inputs)

Cells are not nodes; they are text between `&`/`\\`. Multiple cooperating
defects:

- **Trailing empty cell dropped by the parser** (`parser.ts:485`): after a row's
  trailing `&`, the loop breaks on `\end`/EOF without emitting the pending empty
  cell, and a final row of one empty cell is dropped. So one Backspace on `d` in
  a 2×2 makes the bottom-right cell cease to exist (no box, no caret slot), and
  nothing re-materializes a placeholder because `normalizeLatex` never braces
  array cells (`edit/normalize.ts:100`).
- **`\text` eats separators** via the `parseRawTextArg` single-token fallback:
  completing `\text` in a cell consumes the following `&` or `\\` as its argument
  and merges cells/rows.
- **Brace heal crosses cell and environment boundaries** (`brace.ts:196`): inside
  an environment an unclosed `{` swallows `&`, `\\`, and `\end{...}`; the
  end-of-source heal makes that state balanced and permanent, and the heal `}`
  lands *after* `\end{matrix}`.
- Consequence: one unclosed `{` in a cell makes a 2×2 parse as 1×1 with `&`/`\\`
  silently dropped, and `matrixContextAt`/`matrixResize` (`edit/matrix.ts:180`)
  then treat that destroyed reading as truth.

Controls that pass: every plain keystroke at every caret stop in six matrix
hosts preserves grid shape; Backspace/Delete at structural boundaries correctly
selects the whole matrix. The corruption enters through command completion,
the brace heal, and the parser's silent drops — not through the `35fd6a5`
backslash guards, which do hold for `\` typed directly before `&`/`\\`.

### Cross-cutting: no gate, silent parser recovery, no fuzzing

- No validation gate exists between keystroke and commit. `isValidLatex`
  (`packages/tex/src/index.ts:104`) is used only by a command-catalog test.
- The parser silently discards `&`/`\\` inside an unclosed group via the
  non-progress guard (`parser.ts:104`).
- The renderer paints unknown commands as raw red LaTeX to the *reader*
  (`layout/build.ts:1788`), violating the agent.md rule that a reader never sees
  raw source. (Tracked as an independent fix.)

## History taxonomy (evidence of the treadmill)

The same seams were re-patched repeatedly:

- **Backslash fusion**: 5 commits across 4 layers (`feab125` lexer, `6ffc9e9`
  pending-command predicate, `890969f`, `47f7262` command-entry masking,
  `35fd6a5` the `backslashFusesWith` whitelist).
- **Brace/group integrity**: 4 commits (`776a46a` `\frac` materialization,
  `f13fae3` `escapeTypedBrace`, `47f7262` `balanceBraces` auto-heal, `35fd6a5`
  `typedBraceSkipsCloser`).
- **Pending-command literal rendering**: `6ffc9e9` and `feab125` patched the same
  predicate on the same day (2026-06-23).
- **Policy reversal**: `63f7579` (06-30) discards unrenderable typed chars;
  `35fd6a5` (07-05) reverses it to wrapping them in `\text{}`.
- **Explicit oscillation regression** guarded at
  `MathNode.selection.test.ts:359` — patching the previous day's snapper.
- File churn concentrates in `MathNode.ts` (34 commits/1602 lines) and `math.ts`
  (22 commits/1679 lines); repair logic is split across `packages/tex/src/edit`
  and `packages/editor/src/nodes`.

## Test coverage gap

Existing math tests are example-based single cases pinned after each bug. There
is no property/fuzz testing over the edit layer, even though the CRDT already has
a mature fuzzer (`packages/editor/src/sync/__fuzz__`, `FUZZ_SEED`/mulberry32 seed
and reproduction machinery) and a keystroke harness exists
(`math-command-entry.test.ts`). A corruption oracle is buildable from current
APIs: parse-shape preservation outside the edited construct (locality),
`matrixContextAt` dimension invariance, no newly-dropped tokens, and
normalize/balance idempotence at quiescence.

## Remediation plan

The evaluated strategies (incremental hardening, transactional gate, structured
editing) converge on one sequence. Structured editing is the correctness
destination but must not ship cold; the earlier phases stop the bleeding and
double as its safety net. The product is unreleased, so no compatibility shims
are needed (agent.md).

### Phase 0 — kill the live bugs (small, localized) — DONE

1. When a typed `{` opens a control word's argument, insert `{}` and place the
   caret inside (`afterCommandWord` in `edit/brace.ts`, used by the brace path in
   `nodes/math.ts`, mirroring the `^{}` auto-close; `typedBraceSkipsCloser`
   handles the user's own closing `}`). Fixes the RC1 swallow family.
2. Inverted `backslashFusesWith` from a non-letter blacklist to "a typed `\`
   fuses with any adjacent non-whitespace char" (keeping the `\\`-in-environment
   rule and the prime exclusion). Fixes RC2 typed path.
3. `parseRawTextArg`: the braceless single-token fallback consumes only a `char`;
   structural tokens (`&`, `\\`, `\end`, `}`, eof) yield empty text and are not
   consumed. Fixes RC1/RC3 separator-eating.
4. `parseEnvironment`: a trailing `&` now materializes its promised (empty) cell
   instead of dropping it, so an emptied matrix cell stays addressable. Fixes
   RC3 cell loss.

Landed with a runnable regression corpus (the 38 reproduced cases, driven
through the real `insertText` pipeline):
`packages/editor/src/math-text-brace-corruption.test.ts`,
`math-backslash-fusion.test.ts`, and
`nodes/math-matrix-cell-integrity.test.ts`. A redundant-separator cleanup was
extended (`mathRedundantSeparatorAfterInput`) so the argument auto-close leaves
no stray separator space (still gated by the parse-neutral `isRedundantSpace`).

Known-remaining (distinct mechanisms, NOT among the four Phase 0 fixes; the
first two are tracked as `it.fails` in the corpus, the last two as documented
carve-outs in the keystroke fuzzer):

- Typing a literal `\{` at a cell start flush after a `\\` row break (produces
  `\\\\{`).
- `\sqrt[…]` optional-index editing: the open `[` optional index swallows
  following content (mis-nests the radicand, strands a spurious `{}`, and can
  even absorb a matrix `&` — the fuzzer found this via the matrix oracle).
- **Command-append fusion**: a letter typed right after a COMPLETE command whose
  extension is a prefix of a longer command fuses instead of separating
  (`\pi` + `t` → `\pit`, since `pit` is a prefix of `\pitchfork`, so the "still
  typing a longer command" heuristic suppresses the separator, losing the π).
  Note `\alpha` + `b` → `\alpha b` correctly separates — the bug is specific to
  the prefix-of-longer-command case. This is the RC2 fusion family in the
  *append* direction; unlike RC2 it cannot be fixed by a local separator rule
  without breaking mid-typing rendering of the longer command, so it belongs to
  the Phase 2 gate / Phase 4 structured model.
- **Double script**: typing a second `^`/`_` on an already-scripted base
  (`x^{2}` + `^{3}`) forms invalid LaTeX whose second operand is discarded.

Fold the first two into a Phase 0.1; the last two are inherent to flat-string
editing and are the province of the Phase 2 gate / Phase 4 rewrite.

### Phase 1 — regression corpus + keystroke fuzzer — DONE

The 38 reproduced cases landed with Phase 0 as the three table-driven corpus
tests. The keystroke fuzzer is now checked in at
`packages/editor/src/math-keystroke-fuzz.test.ts`, reusing the CRDT fuzzer's
mulberry32 seed/repro machinery and the `mathState` harness. It has two
complementary halves:

1. **Directed conservation sweep** (exhaustive, deterministic): type ONE
   dangerous operation (`\`, `/`, `\pi`, `\frac`, `\sqrt`, `\text{hi}`, `&`,
   `\\`, a brace, a letter, …) into every clean host at every reachable caret
   stop, and assert no leaf char / structural node / matrix cell is dropped.
   This is the anti-corruption gate for RC1/RC2/RC3, generalized past the corpus
   fixtures. Each probe starts clean and applies a single operation, so it stays
   on the well-formed manifold where "typing preserves content" is a real
   invariant.
2. **Random totality walk** (fuzz): long random keystroke/delete sequences over
   random hosts/stops, asserting only that the read paths (`parse`, `layoutMath`,
   `caretStops`, `normalizeLatex`) never throw and the caret never leaves the
   source — a property that holds for ANY input. Reproduce a failure with
   `FUZZ_SEED=<printed seed>`; scale with `FUZZ_RUNS` / `FUZZ_OPS`.

Design note — why conservation is asserted only by the *directed* sweep and not
across the random walk: free-form walks reach mangled states (via text mode,
scripts, escaped braces, deletes) from which a single keystroke can *legally*
reshuffle the parse, so "one keystroke preserves content" is only meaningful
from a clean formula. This is the flat-string model's fundamental leakiness —
exactly what Phases 2–4 exist to close. The sweep skips two operations that
provably hit that long tail (see the two new known-remaining entries below),
each gated on an exact precondition so no reported family is masked.

What the fuzzer surfaced beyond the three reported families: whitespace and
`[`/`]` are delimiter-ambiguous (protective separators; `\sqrt[…]` index vs.
literal bracket), so they are excluded from the conservation multiset (content
*inside* brackets is still checked); and `maxCols` is not monotonic under
insertion (a `\\` mid-row legitimately splits a row), so only total cells and
row count are asserted monotonic.

### Phase 2 — commit gate (medium)

Add a generic transaction guard as an editor-core facet, placed *after* the full
handler+observer composition — `insertText` already returns one composed
`ActionResult` before broadcast (`actions/actions.ts:1298`), so no refactor of
the observer chain is needed. Validate each edit's net result against the Phase 1
oracles; on failure retry with fully-literal escaped input, else reject visibly.
Ship in log-only mode first to measure false positives. This flips the default:
an unenumerated hazard becomes a refused keystroke plus a fuzzer counterexample,
not silent corruption. Keep the facet node-agnostic.

### Phase 3 — LaTeX printer (medium, standalone)

`packages/tex` has no AST→LaTeX printer, so no `parse(print(ast)) ≡ ast`
round-trip oracle exists. Build it in isolation. It strengthens the fuzzer and
is the prerequisite that makes Phase 4 incremental.

### Phase 4 — structured editing (the destination; decide after Phase 3)

Editing sessions operate on a tree: keystrokes are tree transforms; braces,
`&`, and `\\` become structure the printer emits rather than typeable
characters; half-typed commands live in an explicit local-only PendingToken
node; matrix cells are real nodes that can be empty. The string stays the CRDT
format (printer emits minimal diffs on commit). This deletes `brace.ts`,
`normalize.ts`, `matrix.ts`, and most of `unit.ts` (~900 lines of guards) and is
the only design where corruption is unrepresentable rather than refusable. Start
only once the fuzzer exists as its parity harness.

### Known residuals

- **Concurrent remote edits** can merge two individually-valid strings into
  corrupt LaTeX regardless of local guards. Phase 2 gate is pre-broadcast only.
  Ship a detect-only post-merge check with a single-writer repair convention; a
  full semantic merge needs a CRDT-native math structure (separate decision).
- **Reader-safe rendering** of unknown/stray nodes (`layout/build.ts:1788`) is a
  small independent fix, worth doing immediately.

## Artifacts

The three runnable reproduction tests (minimized inputs, drive real keystrokes)
and the full structured dossier were produced during the investigation. If not
already checked in as the Phase 1 corpus, they live in the session scratchpad as
`repro-text-brackets.test.ts`, `repro-stray-backslash.test.ts`,
`repro-matrix-cells.test.ts`, and `math-diagnosis-full.json`.
