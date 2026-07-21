# Arabic i18n glossary

The contract for Arabic copy in Tasfer. Derived from a full audit of all 1,016
translation keys across `apps/web/public/app/locales/`, `apps/site/src/lib/i18n/`,
the Android/iOS generated strings, and the Fastlane store metadata.

Two rules govern everything below:

1. **Section A terms are never translated or transliterated.** They stay in Latin
   script, byte-for-byte, including capitalisation.
2. **Section C terms have exactly one Arabic rendering.** When a term appears in
   this table, do not invent a synonym — even a better one. Change the table.

---

## A. Never translate — keep Latin script verbatim

**Brands / platforms**
`GitHub` · `Chrome` · `Safari` · `Edge` · `Brave` · `Firefox` · `Android` ·
`iPhone` · `iPad` · `iOS` · `macOS` · `Windows` · `Linux` · `App Store` ·
`Google Play` · `Cloudflare` · `Workers` · `Dock` · `Git` · `GNU`

**Formats / extensions**
`Markdown` · `LaTeX` · `ZIP` · `PDF` · `PNG` · `JPG` · `SVG` · `.md` · `.txt` ·
`.zip` · `base64` · `QR`

> `Markdown` is capital-M Latin **everywhere**, including running Arabic prose.
> Do not transliterate it as `ماركداون` and do not lowercase it. It sits in the
> same class as `ZIP` and `PDF`, which the file already treats this way.

**Protocols / tech**
`CRDT` · `WebRTC` · `P2P` · `URL` · `IndexedDB` · `WebSocket` · `UUID` ·
`GMT` · `UTC`

**Licenses** — `AGPL-3.0` · `MIT`  (write `GNU AGPL-3.0`, never `رخصة جنو`)

**Fonts** — `Serif` · `Sans` · `Mono`

**Keyboard keys** — `Enter` · `Shift` · `Escape` · `Cmd` · `Ctrl` · `Alt` · `Tab`

**URL scheme** — `tasferinvite`

**Markup and interpolation** — must survive byte-identical, including spacing:
`<bold>…</bold>` · `<shareIcon />` · `<plusIcon />` · `<moreIcon />` ·
`<addIcon />` · `{{count}}` · `{{name}}` · `{{date}}` · `{{time}}` ·
`{{duration}}` · `{{total}}` · `{{done}}` · `{{title}}` · `{{n}}`

### Exception: API

`API` is the one Section A candidate that is **translated**: use
`الواجهة البرمجية` in Arabic prose. `مرجع API` reads as a fragment in Arabic,
and the corpus already settled on the Arabic form. Keep Latin `API` only inside
code identifiers and route names.

---

## B. The brand name

- **Arabic prose — including native permission strings and store metadata: `تصفير`.**
  This is the native form the brand derives from, not a translation. Never write
  "Tasfer" in Latin inside an Arabic sentence.
- **Latin-only surfaces: `Tasfer`.** Android `app_name`, the bundle display name,
  the package id `app.tasfer`.

---

## C. Canonical Arabic renderings

One term, one rendering. Deviations are bugs.

### Product model

| EN | AR | Note |
|---|---|---|
| Space | مساحة | |
| Page | صفحة | |
| Sub-page / nested page | صفحة فرعية | one term for both English variants |
| Parent page | الصفحة الأم | not `الأصلية`, which means *original* |
| No parent (root) | بلا صفحة أم (الجذر) | it names a *choice*, not a description |
| Block | كتلة | |
| Bin | سلة المحذوفات | |
| Archive (verb) | أرشفة | |
| Draft | مسودة | |
| Snapshot | لقطة | |
| Version (of a page) | **إصدار** | `سجل الإصدارات` for version history |
| Copy (a duplicate) | **نسخة** | reserved for the copy sense only — see below |
| Release (shipped app) | إصدار | store notes, build number |

> **إصدار vs نسخة.** These competed across the file. `إصدار` is now the only word
> for a *version*; `نسخة` is only ever a *copy* (`نسخة كاملة`, `نسختك`,
> `إنشاء نسخة من الحدث`). Using `نسخة` for a snapshot in one string and
> `سجل الإصدارات` in the next makes them read as two different objects.

### Networking

| EN | AR | Note |
|---|---|---|
| Peer | نظير (ج. أقران) | **never `قرين`** — that means companion/consort |
| Peer-to-peer | نظير لنظير | not `نِدّ لنِدّ`, not `بدون وسيط`, not `بين الأطراف` |
| Relay | **مُرحِّل** | **never `وسيط`** — see below |
| Signaling | خدمة الإشارة / رسائل الإشارة | the *service* runs on Workers, not the signals |
| End-to-end encrypted | مشفّر من طرف إلى طرف | indefinite, with both prepositions |
| Sync | مزامنة | |
| Mirror (folder) | نسخ أحادي الاتجاه | **never `مزامنة`** — mirroring is not sync |
| Offline | دون اتصال | not `بدون إنترنت`; local sync works with no internet |
| Invite code | رمز الدعوة | |
| Cryptographic keys | مفاتيح تشفيرية | adjective — not the idafa `مفاتيح تشفير` (= *encryption* keys) |

> **Relay must not be `وسيط`.** The landing page sold "no intermediary"
> (`بدون وسيط`) and then named a core component "the intermediary". The privacy
> page denied `وسطاء` in one item and introduced a `الوسيط` in the next.
> Use `مُرحِّل` for the relay and `سمسار` for a data broker.

### Editor

| EN | AR |
|---|---|
| Canvas | لوحة الرسم (not `الكانفس`, not `لوحة الكتابة`) |
| Code — block label | شيفرة برمجية |
| Code — inline mark | شيفرة |
| `code` — search keyword only | كود |
| Source code / codebase | الشيفرة المصدرية |
| Math equation (block) | معادلة رياضية |
| Inline math (mark) | معادلة مضمّنة |
| Snippet | مقتطف |
| Checkbox | خانة اختيار |
| Bold / Italic / Strikethrough | غامق / مائل / يتوسطه خط |
| Indent / Outdent | زيادة / تقليل المسافة البادئة (not `الإزاحة` = offset) |
| Plain Text (code language) | نص عادي |
| Commit (VCS) | إيداع (**never `التزام`** = obligation) |
| Dependency | تبعية |
| op-log | سجل العمليات |
| Soft-delete | حذف ناعم |

### Common UI

| EN | AR |
|---|---|
| Go to X | الانتقال إلى X (not `الذهاب إلى`) |
| Join a space | الانضمام إلى مساحة (`انضمّ` governs with `إلى`) |
| Try again | إعادة المحاولة |
| Discard | تجاهل |
| Dismiss | إخفاء (kept distinct from Discard) |
| Crop | اقتصاص (not `قص` = cut) |
| Paste | الصق (form I, clipboard sense) |
| Drop (drag & drop) | أفلت / مُفلَت |
| Scan (QR) | مسح رمز QR ضوئيًا (always keep `رمز`; `ضوئيًا` disambiguates from *erase*) |
| Display name | الاسم الظاهر (never `الخاص بك`) |
| Avatar | صورة |
| Reading time | مدة القراءة (a duration, not a clock time) |
| Browser tab | علامة تبويب (**never clipped to `العلامة`** = mark) |
| Cookies | ملفات تعريف الارتباط |
| Third party | أطراف ثالثة |
| Storage | تخزين المتصفح (definite) / مساحة تخزين (indefinite) |
| Source of truth | النسخة المرجعية |
| Inspector (dev tool) | مفتش تصفير |
| Reproduce (a bug) | تكرار المشكلة |
| Corrupt (dev action) | إتلاف (n.) / تالف (adj.) |
| by default | افتراضيًا (not `تلقائيًا` = automatically) |
| off (a setting) | معطّل (not `متوقّف` = halted) |
| Docs | التوثيق (not `الوثائق` = individual documents) |
| Internals (site section) | من الداخل / الملاحظات الداخلية |
| Tracker | متعقّب |
| Photo Library (iOS) | مكتبة الصور (Apple's fixed term — never possessivize) |
| Camera | الكاميرا |
| Alice / Bob | آليس / بوب (`أليس` collides with the interrogative particle) |

### OS menu items — quote them exactly

The user is hunting for a literal label on screen, so these must match what
Arabic iOS/macOS/Chrome actually display.

| Menu item | AR |
|---|---|
| Add to Home Screen | إضافة إلى الشاشة الرئيسية (no `ال` prefix) |
| Add to Dock | إضافة إلى Dock (`Dock` stays Latin in Arabic macOS) |
| Share | مشاركة |

Do not add "right"/"left" to browser-chrome instructions: browser UI direction
follows the OS locale, so the install icon is at the *trailing* edge either way.

---

## D. Mechanical rules

1. **Punctuation is Arabic.** `،` `؛` `؟` — never `,` `;` `?`.
2. **Quotation marks are guillemets** `«…»`, not ASCII `"…"`, which are visually
   ambiguous in RTL.
3. **Ellipsis mirrors the English source.** `…` where EN has `…`, `...` where EN
   has `...`. Do not silently swap.
4. **Digits are Western** (0-9) throughout.
5. **Tanwin goes on the letter before the alif**: `ـًا` (`رمزًا`, `لاحقًا`), never
   `ـاً`.
6. **`جارٍ`, not `جاري`** — it is a manqus noun in an indefinite fronted predicate.
7. **Leading-punctuation Latin tokens need U+200E (LRM).** Any `.md` / `.txt` /
   `.zip` / `.tasferinvite` / `+2` inside an Arabic string must be preceded by an
   LRM, or the leading dot flips to the wrong side. Tokens that begin with a
   letter (`GMT+2`, `AGPL-3.0`, `WebRTC`) resolve correctly on their own — do not
   add noise LRMs there.
8. **Buttons, menu items and titles take the verbal noun** (`حفظ`, `إغلاق`,
   `إضافة رابط`), not the imperative. Prompts, descriptions and inline
   instructions take the imperative (`اختر`, `الصق`, `اضغط`).
9. **Tap → `اضغط`, Click → `انقر`.** Match the input surface.
10. **Failures use `تعذّر` + masdar**, not `فشل`. Always with the shadda.
11. **Avoid `تم` / `لم يتم` + masdar.** Prefer the internal passive (`أُنشئت`,
    `تُشتق`, `لا يُشارَك`) or a direct statement (`لا توجد نتائج`).
12. **Verb-first is the default clause order.** `تحتوي هذه الصفحة على…`, not
    `هذه الصفحة تحتوي على…`.
13. **Coordinated verbal nouns need a resumptive pronoun.** English "view or edit
    this page" is `عرض هذه الصفحة أو تعديلها` — never `عرض وتعديل هذه الصفحة`.
14. **Negated lists coordinate with `ولا`**, not bare juxtaposition or `أو`.
15. **"Only X" is `لا … إلا`**, not a trailing `فقط` — especially in security
    warnings, where the restrictive force matters.
16. **Tashkeel only to disambiguate** (`مُرحِّل`, `مُشارَك`). Do not vocalise fully.
17. **No dialect.** `ما يحتاج`, `على محمل الثقة`, `اعمل لها نسخة` are all out.

---

## E. Plurals

Arabic has six CLDR plural categories: `zero`, `one`, `two`, `few`, `many`,
`other`. Any count-bearing string needs all six via i18next suffixes:

```json
"format.filesSelected_zero":  "لم يُحدَّد أي ملف",
"format.filesSelected_one":   "ملف واحد محدد",
"format.filesSelected_two":   "ملفان محددان",
"format.filesSelected_few":   "{{count}} ملفات محددة",
"format.filesSelected_many":  "{{count}} ملفًا محددًا",
"format.filesSelected_other": "{{count}} ملف محدد"
```

**Never pluralise in code.** `count === 1 ? t("x.one") : t("x.many")` cannot be
correct in Arabic, and concatenating the numeral in JSX outside the translated
string makes the dual forms (`كلمتان`, `صفحتان`, `خطآن`) impossible to express.
Pass `{ count }` through `t()` and let i18next select the form.

The invariant abbreviations `س` / `د` (hr / min) sidestep agreement entirely —
keep them, do not expand them to `ساعات` / `دقائق`.

---

## F. Adding a new string

- Add the key to **both** `en` and `ar`. A key that lives only as
  `t("key", "English default")` ships English to Arabic users — that pattern
  accounted for 43 leaked strings before this audit.
- Check Section C before inventing a term.
- Run the parity check: every `en` key must exist in `ar`, and every
  `{{var}}` / `<tag>` must appear identically in both.
- If the string reaches a native surface, regenerate:
  `npm run gen:android-strings && npm run gen:ios-strings` from `apps/web`.
