# iOS App Store screenshots

The release lane uploads only locales enabled by `IOS_LANGS` in the Fastfile.
The current set is English-only under `en-US/`; Arabic listing files remain
version-controlled separately and are not sent to App Store Connect.

Each locale contains opaque images for Apple's 6.9-inch iPhone (1290x2796) and
13-inch iPad (2732x2048) screenshot slots. Keep between one and ten images per
device slot. Numeric filename prefixes control their order.

## Regenerate

Run this from the repository root:

```sh
npm --prefix brand ci
npm --prefix brand run generate:app-store-screenshots
```

For fresh captures, start Tasfer separately at `http://127.0.0.1:4000` (or pass
another address through `URL`). The script never starts or owns a development
server. It wipes and seeds the dedicated `.claude/skills/run-web/.pw-profile`,
captures canonical app views, and generates both phone and iPad device sets.
Pass `--skip-capture` to reuse checked-in sources under
`apps/web/public/screenshots/` without contacting a server.
