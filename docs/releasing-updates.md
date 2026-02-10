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
