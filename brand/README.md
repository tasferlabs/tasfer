# tasfer brand assets

The tasfer mark is the word **صفر** (sifr, "zero") drawn as a single
calligraphic stroke, in two renditions:

- **Mark** (`logo.svg`) — the green glyph on a transparent background.
  Used for in-app wordmarks, the readme, and anywhere the mark sits on
  arbitrary backgrounds. Green `#43a047` on light surfaces, `#66bb6a` on
  ink/dark surfaces. The site and web app render it inline via their mark
  components; keep those in sync with `logo.svg`.
- **Icon** (generated) — the app-icon rendition: the same `#43a047` glyph on a
  transparent canvas, no plate. Used for favicons, PWA icons, and the desktop
  launcher icons, where whatever the icon sits on shows through.

The mobile launcher icons are opaque instead — a white plate on light, an ink
(`#101012`) plate on dark, behind the same green glyph. On iOS this is forced:
App Store validation rejects an app icon that contains an alpha channel, even a
fully opaque one, so those two appearances are written without one. Android
follows the same treatment so the platforms read alike, via
`res/values/ic_launcher_background.xml` and
`res/values-night/ic_launcher_background.xml`. Two exceptions keep alpha
because the format requires it: the iOS tinted appearance, which Apple
composites over a background of its own, and the Android adaptive foreground
layer, which has to be transparent for the background layer to show through.

Android's legacy (pre-API-26) `ic_launcher` / `ic_launcher_round` are drawn
as-is, with no adaptive layers and no launcher mask, so they carry their own
rounded/circular white plate and cannot follow the system theme.

Because the PWA icons are transparent they are declared `purpose: any` in
`apps/web/public/manifest.json`. A maskable icon has to be an opaque
full-bleed plate, which is what this rendition deliberately drops.

Splash screens invert the icon: a solid green (`#43a047`) field with a white
glyph in the middle. Note this does not match `ios.backgroundColor` /
`android.backgroundColor` in `apps/web/capacitor.config.js` (ink), which is
painted between the splash disappearing and the web content's first paint.

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
`apps/android/app/src/main/res/values/ic_launcher_background.xml` and is
transparent.
