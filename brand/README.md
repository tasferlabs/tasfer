# tasfer brand assets

The tasfer mark is the word **صفر** (sifr, "zero") drawn as a single
calligraphic stroke, in two renditions:

- **Mark** (`logo.svg`) — the green glyph on a transparent background.
  Used for in-app wordmarks, the readme, and anywhere the mark sits on
  arbitrary backgrounds. Green `#43a047` on light surfaces, `#66bb6a` on
  ink/dark surfaces. The site and web app render it inline via their mark
  components; keep those in sync with `logo.svg`.
- **Plate** (`logo-plate.svg`, generated) — the app-icon rendition: the white
  glyph on a solid green (`#43a047`) plate. Used for favicons, PWA icons, and
  the desktop/iOS/Android launcher icons.

Splash screens use an ink (`#101012`) background with the `#66bb6a` glyph.

The wordmark is the lowercase word **tasfer** set in the UI sans at weight
600 with `-0.03em` letter spacing, in the foreground ink color (the mark
carries the green). In Arabic copy the product name is written **تصفير**.

## Regenerating assets

```sh
cd brand
npm install
npm run generate
```

This rewrites every raster brand asset in the repo (favicons, PWA icons,
`.icns`/`.ico`, tray templates, iOS/Android launcher icons and splash
screens) from the geometry in `generate.mjs`. macOS is required for the
`.icns` step (`iconutil`). The Open Graph image is generated separately by
`apps/site/scripts/generate-og.mjs`. The Android adaptive-icon background
color lives in
`apps/android/app/src/main/res/values/ic_launcher_background.xml`.
