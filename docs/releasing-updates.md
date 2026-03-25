# Releasing Updates

All version configuration lives in `/version.json` at the monorepo root.

## Version Fields

| Field        | Purpose                                                            |
| ------------ | ------------------------------------------------------------------ |
| `version`    | Current version (integer) baked into the client at build time      |
| `minVersion` | Minimum required version - clients below this are forced to update |
| `updateUrls` | Platform-specific URLs (ios, android, web)                         |

## How It Works

1. **Build time**: Vite reads `version.json` and injects `version` into the web bundle
2. **Runtime**: Client calls `GET /api/version` to check compatibility
3. **Comparison**: Client compares its baked-in version against `minVersion` and `latestVersion`

## Release Process

### Standard Release

1. Bump `version` in `version.json`:

   ```json
   {
     "version": 2,
     "minVersion": 1,
     "updateUrls": { "ios": null, "android": null, "web": null }
   }
   ```

2. Build and deploy:
   ```bash
    ./deploy.sh
   ```

### Forcing Updates (Breaking Changes)

If a release has breaking changes and old clients must update:

```json
{
  "version": 2,
  "minVersion": 2,
  "updateUrls": { "ios": null, "android": null, "web": null }
}
```

This blocks old clients with a full-screen update page.

## Update Behavior

| Scenario                   | User Experience                     |
| -------------------------- | ----------------------------------- |
| `version < minVersion`     | Full-screen block, must update      |
| `version < latestVersion`  | Dismissible popup suggesting update |
| `version >= latestVersion` | No prompt                           |

## Desktop Releases (Electron)

The desktop app uses `electron-updater` with GitHub Releases for distribution. Versioning is semver (separate from the web integer version).

### How It Works

1. **Build**: GitHub Actions builds macOS, Windows, and Linux artifacts on tag push
2. **Publish**: Artifacts are uploaded to a GitHub Release with `latest.yml` / `latest-mac.yml` / `latest-linux.yml` metadata files
3. **Check**: The app checks for updates on launch (after 5s) and every 4 hours
4. **Notify**: If an update is found, the existing `UpdatePopup` is shown (dismissible)
5. **Install**: User clicks "Update now" → download starts → app restarts with the new version

### Release Process

1. Push a tag:
   ```bash
   git tag desktop-v1.1.0
   git push origin desktop-v1.1.0
   ```

2. The `desktop-release.yml` workflow runs automatically:
   - Extracts the version from the tag (`desktop-v1.1.0` → `1.1.0`)
   - Builds the web app, then the Electron app
   - Packages and publishes to GitHub Releases for all platforms

3. Existing installs will detect the new version on their next check

### Artifacts per Platform

| Platform | Targets                                    | Auto-update format |
| -------- | ------------------------------------------ | ------------------ |
| macOS    | `.dmg` + `.zip`                            | `.zip`             |
| Windows  | `.exe` (NSIS)                              | NSIS installer     |
| Linux    | `.AppImage`, `.deb`, `.rpm`, `.pacman`     | `.AppImage`        |

### Required GitHub Secrets

| Secret                       | Purpose                              |
| ---------------------------- | ------------------------------------ |
| `MAC_CSC_LINK`               | Base64-encoded macOS `.p12` cert     |
| `MAC_CSC_KEY_PASSWORD`       | Password for the macOS cert          |
| `APPLE_ID`                   | Apple ID for notarization            |
| `APPLE_APP_SPECIFIC_PASSWORD`| App-specific password for notarization |
| `APPLE_TEAM_ID`              | Apple Developer Team ID              |
| `WIN_CSC_LINK`               | Base64-encoded Windows `.pfx` cert   |
| `WIN_CSC_KEY_PASSWORD`       | Password for the Windows cert        |

`GITHUB_TOKEN` is provided automatically by GitHub Actions.

### AUR (Arch Linux)

A PKGBUILD is maintained in `aur/` for the [AUR](https://aur.archlinux.org/). It points to the `.pacman` artifact from the GitHub Release.

After each release, update `aur/PKGBUILD`:
1. Bump `pkgver` to match the new version
2. Update `sha256sums` (run `makepkg -g` or use `updpkgsums`)
3. Regenerate `.SRCINFO`: `makepkg --printsrcinfo > .SRCINFO`
4. Push to the AUR git repo

Users can then install via: `yay -S cypher-bin`

### Configuration

- **electron-builder config**: `apps/desktop/electron-builder.yml`
- **macOS entitlements**: `apps/desktop/build/entitlements.mac.plist`
- **Updater handler**: `apps/desktop/src/main/handlers/updater.ts`
- **AUR PKGBUILD**: `aur/PKGBUILD`
