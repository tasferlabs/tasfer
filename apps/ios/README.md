# iOS App

The iOS build of Tasfer — the web app (`apps/web`) wrapped in a native shell via
[Capacitor](https://capacitorjs.com/). The Swift files under `App/App/` are thin
native bridges (clipboard, storage, image picker, PDF, context menu, lifecycle)
that expose device features to the web layer.

## Prerequisites

- **macOS with Xcode 15+** — iOS builds cannot be produced on Windows or Linux.
- An Apple Developer account (free is enough to run on your own device; a paid
  membership is required for TestFlight / the App Store).

## Signing setup

The Apple Developer Team ID is not tracked. Store Release CI reads
`APPLE_TEAM_ID` from GitHub Actions secrets and passes it to Xcode through
Fastlane. Local Xcode builds read the team from a gitignored override.

One-time setup after cloning:

```bash
cd apps/ios
cp DeveloperSettings.xcconfig.example DeveloperSettings.xcconfig
# edit DeveloperSettings.xcconfig and set DEVELOPMENT_TEAM to your own Team ID
```

Find your Team ID under **Membership details** at
<https://developer.apple.com/account>.

`DeveloperSettings.xcconfig` is gitignored and is pulled into both Debug and
Release via `#include?`. Local Fastlane releases also need the same value as
`APPLE_TEAM_ID` in `fastlane/.env`.

> **Do not change the Team in Xcode's _Signing & Capabilities_ tab.** It should
> already show your team as resolved (inherited from the xcconfig). Selecting it
> manually makes Xcode write `DEVELOPMENT_TEAM` into `project.pbxproj`. Leave it
> inherited from the xcconfig files so the tracked project stays clean.

## Building & running

Open the workspace in Xcode and build the `App` scheme:

```bash
cd apps/ios/App
open App.xcodeproj
```

The **Build & sync web** phase runs `apps/web/scripts/build-and-sync.sh` on every
build, which builds `apps/web` and copies the output into `App/App/public/`
(gitignored). To run against a live dev server instead, see the HTTPS dev setup in
[../../dev-docs/ssl-dev-setup.md](../../dev-docs/ssl-dev-setup.md).

## Licensing

`apps/*` are AGPL-3.0-or-later and also offered commercially — see
[../../LICENSING.md](../../LICENSING.md). Contributions here require the CLA
sign-off described in [../../CONTRIBUTING.md](../../CONTRIBUTING.md).
