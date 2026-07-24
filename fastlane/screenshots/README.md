# iOS App Store screenshots

The release lane uploads only locales enabled by `IOS_LANGS` in the Fastfile.
The current set is English-only under `en-US/`; Arabic listing files remain
version-controlled separately and are not sent to App Store Connect.

Each PNG is an opaque 1290x2796 portrait image for Apple's 6.9-inch iPhone
screenshot slot. Keep between one and ten images per enabled locale and preserve
the numeric filename prefixes to control their App Store order.

## Regenerate

Run this from the repository root:

```sh
npm --prefix brand ci
npm --prefix brand run generate:app-store-screenshots
```

The script starts a local Tasfer development server only when one is not already
running, wipes and seeds the dedicated `.claude/skills/run-web/.pw-profile`,
captures the canonical app views, and composes the five images in this directory.
It never uses the production beta site or a personal browser profile. Pass
`--skip-capture` to reuse the checked-in source captures under
`apps/web/public/screenshots/`.
