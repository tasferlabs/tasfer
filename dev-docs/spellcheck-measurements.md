# Spellcheck measurements (P0a)

Companion to [spellcheck-design.md](./spellcheck-design.md), section 11. Numbers
here gate the engine choice (Hunspell for every language versus a trie fallback
for English), the Arabic loading policy, and the low-end hardening phase (P6).
Budgets come from the design: main thread under 0.5 ms of spell work per
keystroke, worker slices under 8 ms, boundary keystroke to squiggle under
300 ms, English engine ready in under 150 ms on the target phone, Arabic ready
in under 1.5 s and under 55 MB of worker heap.

## Engine, Node baseline

Machine: Apple Silicon Mac, Node 22.23, `hunspell-wasm` 0.3.0 (Hunspell
compiled with Emscripten), dictionaries from `apps/web/public/app/spell/`.
Script: a throwaway `bench.mjs` that instantiates the module once with
`wasmBinary`, then per language constructs `Hunspell(module, aff, dic)`,
checks the first 20,000 dictionary entries, and times 20 `suggest()` calls on
common misspellings. Run on 2026-09-02.

| Dictionary | Entries | Load | RSS delta | Check per word | Suggest p50 | Suggest p95 |
| --- | --- | --- | --- | --- | --- | --- |
| en (SCOWL en_US 2020.12.07) | 49,568 stems | 16 ms | +17 MB | 0.7 µs | 5.9 ms | 8.0 ms |
| ar (Ayaspell 3.5) | 465,928 entries | 200 ms | +119 MB | 0.8 µs | 0.5 ms | 57 ms |

Notes:

- WASM instantiation itself is 3 ms once the bytes are in memory.
- The Arabic RSS delta is larger than the 46 to 48 MB the research pass saw
  with `hunspell-asm`, because this run keeps the 7.2 MB `.dic` as a JavaScript
  string (14 MB as UTF-16) alongside the Emscripten heap and measures whole
  process RSS. The worker should drop the decoded strings after
  `Hunspell_create` returns and measure heap in the browser (see below).
- Arabic suggest is bimodal: short hamza and ta-marbuta fixes return in under
  a millisecond; long unknown tokens take 40 to 60 ms because Hunspell's
  n-gram phase scans every stem. This is why suggestions are computed only on
  demand and why the worker skips auto-suggest for Arabic tokens longer than
  14 letters unless a menu asks.
- Correctness spot checks: en accepts `hello`, `Hello`, `don't`; rejects
  `helo`, `recieve`, `akchualy` with `receive` and `actually` in the top
  three. ar accepts `الكتاب`, `وبالكتاب`, `كِتَابٌ` (tashkeel ignored),
  `مدرسة`; rejects `الى` (top suggestion `إلى`) and `انشاء` (`إنشاء` second);
  silently accepts `مدرسه` (ta-marbuta written as ha), a known Ayaspell gap
  the lenient toggle and the P4 accept-list address.

Acceptance rate on the dictionaries' own entries was 19,997 / 20,000 (en) and
19,998 / 20,000 (ar); the misses are entries with `NEEDAFFIX`-style flags that
are not standalone words.

## Still to measure

These need a browser or a device and are recorded as they are run. Each item
lists the pass condition from the design.

1. **Worker start and dictionary load in Chromium, Safari and Firefox**
   (desktop): time from `new Worker` to `ready`, and from `loadDictionary` to
   `dictionaryLoaded` for en and ar with bytes transferred from the main
   thread. Pass: en under 150 ms, ar under 1.5 s on an old laptop.
2. **Worker heap** via `performance.measureUserAgentSpecificMemory()` where
   available, else DevTools before and after load and after `dispose()`.
   Pass: ar under 55 MB.
3. **Low-end Android WebView** (2 to 3 GB device via `chrome://inspect`):
   items 1 and 2 again, plus `Intl.Segmenter` availability and cost inside the
   worker, and check throughput over a 10k-word bilingual fixture.
4. **iPhone via Web Inspector**: items 1 and 2.
5. **Electron** (`apps/desktop`, file:// renderer): does
   `new Worker(new URL(..., import.meta.url), { type: "module" })` construct,
   and does the main-thread `fetch(publicAssetUrl(...))` of the wasm and
   dictionaries succeed (it does for locales today). The design already avoids
   in-worker fetch, so only worker construction is open. Fallback if it
   fails: Vite `?worker&inline`.
6. **Repaint cost** of `setDecorations` with 0 / 100 / 500 / 2000 underline
   decorations on a long page, with and without the per-block decoration
   index. Pass: under 4 ms extra per frame at 500 visible flags on the phone.
7. **Keystroke to squiggle** via `performance.mark` around the boundary
   keystroke and the next paint. Pass: p50 under 150 ms, p95 under 300 ms on
   desktop.
8. **Wire size**: the dictionaries are served as `.txt` so the CDN compresses
   them; confirm with
   `curl -sI -H 'Accept-Encoding: br,gzip' https://<host>/app/spell/ar/index.dic.txt`
   after the first deploy. Expected: about 1.5 MB for Arabic, 190 KB for
   English.

Decisions taken so far from these numbers: Hunspell for every language (English
costs 16 ms and 17 MB, so a second engine buys nothing); Arabic loads lazily on
the first Arabic token and is disposed after ten idle minutes on touch devices;
suggestions only on demand.
