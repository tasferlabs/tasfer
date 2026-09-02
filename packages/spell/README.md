# @tasfer/spell

Opt-in spellcheck for [`@tasfer/editor`](../editor). Hunspell compiled to
WebAssembly runs in a Web Worker; a prose tokenizer decides which words are
worth checking; a per-editor checker turns the worker's answers into range
decorations under the misspelled words. Nothing here needs React or the DOM:
the engine-facing modules run in a worker and in Node.

Arabic and English are the first-class scripts. Tokens are routed by writing
script, so an English typo can never be "accepted" by the Arabic dictionary
and vice versa. Arabic lookups strip tashkeel and tatweel and fold
presentation forms, but never fold hamza forms, ta marbuta or alif maqsura —
confusing those is exactly what the checker should catch (an opt-in lenient
mode accepts them).

## Install

```sh
npm install @tasfer/spell @tasfer/editor
```

`hunspell-wasm` comes with the package. Dictionaries do not — bring your own
`.aff`/`.dic` pair per language (see [Dictionaries](#dictionaries)).

## Entry points

| Import                   | Runs on     | What it gives you                                                                                                                                                               |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tasfer/spell`          | main thread | `SpellChecker`, the main↔worker protocol types, tokenizer (`tokenize`, `wordAt`), script helpers (`scriptOf`, `normalizeForLookup`), `wordListToDic`, the `REPLACE_WORD` action |
| `@tasfer/spell/worker`   | worker      | `createWorkerHost(post, factory, fetchBytes?)` — engines, personal dictionary, the sliced check queue and suggestions behind a message handler                                  |
| `@tasfer/spell/hunspell` | worker      | `createHunspellFactory({ wasm, fetchBytes? })` — a `SpellEngineFactory` over Hunspell-in-WASM                                                                                   |

## Wiring

### Worker entry

```ts
// spell.worker.ts — bundled as a module worker by your host
import { createHunspellFactory } from "@tasfer/spell/hunspell";
import { createWorkerHost } from "@tasfer/spell/worker";
import type { SpellRequest } from "@tasfer/spell";
import wasmUrl from "hunspell-wasm/wasm/hunspell.wasm?url"; // however your bundler exposes the binary

const factory = createHunspellFactory({ wasm: wasmUrl });
const handle = createWorkerHost(
  (msg, transfer) => self.postMessage(msg, { transfer }),
  factory,
);

self.onmessage = (event: MessageEvent<SpellRequest>) => void handle(event.data);
```

The host controls where the bytes come from: `wasm` may be a URL the worker
fetches, an `ArrayBuffer` read on the main thread, or a precompiled
`WebAssembly.Module`. Nothing is fetched relative to the glue's own
`import.meta.url`. Pass `fetchBytes` to both factory and host when the
platform cannot use `fetch` (Electron `file://`, a native filesystem driver).

Once the worker is up, the main thread drives it with the protocol messages
from `@tasfer/spell`:

1. `init` → `ready`
2. `loadDictionary { lang, script, source, extras? }` → `dictionaryLoaded { ms, bytes }` or `dictionaryError`
3. `setUserWords { words, forbidden }` — the personal dictionary, replayed into every engine
4. `check { docId, blocks, options, priority }` → one or more `checked { docId, results }`
5. `suggest { word, script, limit }` → `suggestions`
6. `cancel { id }`

Checking runs in slices of about 8 ms with a yield between them, so
`suggest` and `cancel` interleave with a long initial pass. Blocks whose
script has no dictionary loaded yet are reported with `deferredScripts` and
never flagged; the host re-queues them itself once that dictionary lands.

### Main thread

```ts
import { SpellChecker } from "@tasfer/spell";

const checker = new SpellChecker({
  editor,
  doc,
  docId,
  transport /* … */,
}).start();
// later
checker.stop();
```

The checker, its transport contract and its anchor/decoration model are
documented in `src/checker.ts`.

## Dictionaries

- **Hunspell pairs.** A `.aff` file with the affix rules and a `.dic` word
  list, in the encoding the `.aff` declares (`SET UTF-8`, `SET ISO8859-1`,
  …). The engine transcodes to UTF-8 on load, so legacy-encoded dictionaries
  work unchanged. Arabic dictionaries typically declare `IGNORE` for tashkeel,
  which lets diacritised words match their bare stems.
- **Plain word lists.** `wordListToDic(lines)` turns a one-word-per-line
  list (with `#` comments and cspell-style `!forbidden`, `~ci`, `+`/`*`
  compound markers) into an `.aff`/`.dic` pair the same engine loads, and
  returns the forbidden words separately for `setUserWords`.
- **Extras.** `loadDictionary.extras` merges additional `.dic` bodies
  (accept-lists, imports) into a language's engine after load.

Word lookups are cached per engine (LRU, 100 000 entries), so a document's
recurring words cost one engine call each.

## Licence

This package is MIT. It bundles nothing from Hunspell itself but depends on
[`hunspell-wasm`](https://github.com/rotemdan/hunspell-wasm), which ships
Hunspell compiled to WebAssembly under Hunspell's LGPL-2.1 / GPL-2.0 /
MPL-1.1 tri-licence (the LGPL option applies to the compiled library as used
here). Dictionaries carry their own licences — check each one's `LICENSE`
before shipping it with your product.
