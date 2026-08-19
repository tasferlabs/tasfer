# Desktop Release & Auto-Update

The desktop app is packaged by [electron-builder](https://electron.build) and
updated in place by [electron-updater](https://www.electron.build/auto-update),
which reads its update feed straight from GitHub Releases. There is no update
server to run.

## The pipeline

1. Conventional commits land on `main`.
   [`release-please.yml`](../.github/workflows/release-please.yml) keeps a release
   PR open that bumps `appVersion` in [`version.json`](../version.json) and
   [`.release-please-manifest.json`](../.release-please-manifest.json).
   No package manifest carries a version: `apps/desktop/scripts/package.mjs`
   passes `version.json`'s to electron-builder as `extraMetadata.version`, which
   stamps it into the packaged app — and so into the `app-update.yml` feed
   electron-updater reads. The release type is `simple` rather than `node` for
   this reason: `node` would rewrite a `version` field back into
   `apps/desktop/package.json`, while `simple` skips its own version file when
   absent.
2. Merging that PR tags `v<version>` and creates a **draft** GitHub release
   (`"draft": true` in [`release-please-config.json`](../release-please-config.json)).
3. Release Please then calls
   [`native-release.yml`](../.github/workflows/native-release.yml), which builds
   the web app, compiles Electron, and runs `npm run package -- --publish always`
   on a macOS and a Linux runner. Each uploads its artifacts plus the
   `latest*.yml` update manifests into that draft.
4. Once both succeed, the `publish-release` job un-drafts the release. Drafts
   are invisible to `electron-updater`, so clients never see a release that is
   missing their platform.

iOS and Android are not part of this — they go through
[`store-release.yml`](../.github/workflows/store-release.yml).

### Dry run

Dispatch **Native Release** manually with `publish = false`, choosing the branch
or tag to build in the ref picker — there is no version to type, since the build
reads `version.json` at that ref. It runs the full build and attaches the
artifacts to the workflow run instead of the release. Without signing secrets the artifacts are unsigned, but the build
itself still passes, so this is a cheap way to check a packaging change.

### Locally

```sh
cd apps/web && npm run build          # extraResources pulls in apps/web/dist
cd ../desktop && npm run build        # electron-vite → out/
npm run package:dir -- --mac          # unpacked, fast; add CSC_IDENTITY_AUTO_DISCOVERY=false to skip signing
```

`--dir` produces no `app-update.yml`; electron-builder only writes it for real
targets (dmg/zip, nsis, AppImage). Build one of those to inspect the update
config baked into the app.

## Secrets

The pipeline degrades instead of failing when these are missing — the build
still produces artifacts, just unsigned and un-notarized. That is fine for a dry
run and useless for a release: unsigned macOS builds are refused by Gatekeeper
and cannot auto-update at all, since Squirrel.Mac verifies the signature before
swapping the bundle.

| Secret | Used for |
| --- | --- |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | Developer ID Application certificate (`.p12`, base64) and its password |
| `APPLE_TEAM_ID` | Picks the signing identity |
| `ASC_KEY_CONTENT`, `ASC_KEY_ID`, `ASC_ISSUER_ID` | Notarization via the App Store Connect API key — the same secrets the store release uses |

Export a `.p12` for `MAC_CSC_LINK` with:

```sh
base64 -i Certificates.p12 | pbcopy
```

## Windows is off

The `win` matrix entry in
[`native-release.yml`](../.github/workflows/native-release.yml) is commented out
until there is a signing identity, and the download page offers no Windows
asset — its card shows the same "not yet published" chip as the store builds.
Turning it back on means uncommenting that entry and its `WIN_CSC_*` env, then
restoring the link in
[`DownloadPage.tsx`](../apps/site/src/views/DownloadPage/DownloadPage.tsx)
(`FILES.windows` is still there) along with the `download.windows.desc`,
`download.windowsHint`, and `download.note` strings.

Shipping unsigned Windows builds in the meantime is possible but not free:
SmartScreen warns on every install, and the identity is a one-way door.
`electron-updater` reads `publisherName` from the installed app's
`app-update.yml` (`NsisUpdater.verifySignature`) and rejects any update whose
signature does not match it — so unsigned → signed is safe, but signed-as-A →
signed-as-B strands every existing client with `ERR_UPDATER_INVALID_SIGNATURE`.

Note also that a `.p12` is no longer obtainable for new Windows certificates:
since the CA/Browser Forum's 2023 rules, OV keys must live on an HSM. Signing
means Azure Trusted Signing (`win.azureSignOptions`, with `AZURE_TENANT_ID` /
`AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`) or a cloud-HSM CA such as SSL.com
eSigner — not the `WIN_CSC_LINK` path this file describes for macOS.

## What updates, and how

[`apps/desktop/src/main/handlers/updater.ts`](../apps/desktop/src/main/handlers/updater.ts)
checks 5s after launch and every 4 hours, downloads only when the renderer asks,
and installs on the next quit. It forwards progress over IPC to
[`useVersionCheck`](../apps/web/src/app/hooks/useVersionCheck.ts), which drives
the in-app update prompt.

| Target | Auto-update |
| --- | --- |
| macOS (`zip` feed, `dmg` download) | Yes — requires a signed, notarized build |
| Windows (`nsis`) | Not built yet — see below |
| Linux `AppImage` | Yes — `electron-updater` keys off the `APPIMAGE` env var |
| Linux `deb`, `pacman` | No — the package manager owns the install; the updater stays silent |

## Artifact names

[`electron-builder.yml`](../apps/desktop/electron-builder.yml) uses versionless
`artifactName`s so the download page can link every build through
`releases/latest/download/<file>` without knowing the current version. Those
filenames are duplicated in
[`DownloadPage.tsx`](../apps/site/src/views/DownloadPage/DownloadPage.tsx)
(`FILES`) — change them together, or the site starts linking to 404s.

`publish.owner`/`publish.repo` must match the repository the releases live in
(`tasferlabs/tasfer`). It is baked into `app-update.yml` inside every shipped
build, so a wrong value there is only discovered after users have installed it.
