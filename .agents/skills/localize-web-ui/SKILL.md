---
name: localize-web-ui
description: Localize Tasfer web UI changes in English and meaning-based Arabic using the app's i18next catalogs, including React and non-React strings, interpolation and plural forms, search keywords, RTL behavior, and generated native strings. Use when adding or changing user-facing text in apps/web, replacing hardcoded UI copy, checking translation coverage, fixing locale-key drift, or reviewing an English/Arabic UI change.
---

# Localize Tasfer web UI

Keep UI copy, the English source catalog, and the Arabic catalog aligned without translating word by word. Work from the `apps/web` root; paths below are relative to it.

## Workflow

1. Inspect the changed UI and nearby translation calls before choosing keys. Search for similar copy and reuse a key only when the meaning and grammatical role match.
2. Identify every user-visible string, including labels, placeholders, empty states, errors, confirmations, accessibility text, menu search keywords, document titles, and native-shell copy. Do not localize identifiers, URLs, file extensions, or user content.
3. Add or update calls using the surrounding convention:
   - Use `useTranslation()` inside React components.
   - Use the existing `i18next` or injected `TFunction` pattern outside React.
   - Keep keys stable and semantic, grouped under the feature namespace.
   - Preserve the repository's English fallback argument when nearby calls use `t("key", "English copy")`.
4. Update `public/app/locales/en/translation.json` and `public/app/locales/ar/translation.json` together.
5. Use a fresh subagent to propose natural Arabic wording. Give it the English meaning, UI surface, tone, variable meanings, and space constraints; do not seed it with a proposed Arabic answer. Review the result in context and preserve every interpolation variable exactly. If subagents are unavailable, flag the Arabic copy for human review instead of presenting a literal translation as final.
6. Check behavior affected by language direction. Prefer logical CSS properties, mirror directional navigation icons when meaning requires it, and keep inherently LTR values such as URLs, code, and times readable.
7. Run the bundled checker:

   ```bash
   node .skills/localize-web-ui/scripts/check-i18n.mjs
   ```

8. If the changed key is consumed by a native or manifest generator, run only the corresponding existing command: `npm run gen:desktop-strings`, `npm run gen:android-strings`, `npm run gen:ios-strings`, or `npm run gen:manifest`. Treat generated files as derived artifacts.
9. Inspect the affected UI in both English and Arabic when layout, direction, truncation, or canvas rendering could change. Use the sibling `run-web` skill for screenshot-based verification when appropriate; do not claim DOM automation verified canvas text.

## Copy rules

- Translate the intended action or message, not individual words.
- Match capitalization and punctuation conventions of each language.
- Keep labels concise; reserve complete sentences for explanatory and destructive-action copy.
- Keep distinct keys when one English word has different meanings or grammatical roles.
- Preserve `{{variables}}`, HTML-like component placeholders, and formatting tokens exactly.
- Pass `count` to `t()` for pluralized copy. Arabic and English require different plural suffix sets, so do not force exact suffix-key parity between their catalogs.
- Localize command/search synonyms for each language rather than transliterating English keywords.
- Avoid concatenating translated fragments. Translate the complete message with interpolation.

## Review checklist

- Check affected call sites and nearby variants, including mobile and desktop surfaces.
- Check both catalogs and plural/interpolation compatibility with the bundled script.
- Check Arabic meaning, RTL layout, truncation, and directional affordances.
- Check whether native generators or public documentation consume the changed copy.
- Report any pre-existing localization issue separately; do not expand the change without need.
