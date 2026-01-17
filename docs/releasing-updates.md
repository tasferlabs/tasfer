# Releasing Updates

All version configuration lives in `/version.json` at the monorepo root.

## Version Fields

| Field                      | Purpose                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `clientVersion`            | Current version baked into the client at build time                |
| `minClientVersion`         | Minimum required version - clients below this are forced to update |
| `recommendedClientVersion` | Suggested version - shows a dismissible update prompt              |
| `updateMessage`            | Optional message shown in the update prompt                        |
| `updateUrls`               | Platform-specific URLs (ios, android, web)                         |

## How It Works

1. **Build time**: Vite reads `version.json` and injects `clientVersion` into the web bundle
2. **Runtime**: Client calls `GET /api/version` to check compatibility
3. **Comparison**: Client compares its baked-in version against `minClientVersion` and `recommendedClientVersion`

## Release Process

### Standard Release

1. Bump `clientVersion` in `version.json`:

   ```json
   {
     "clientVersion": "1.1.0",
     "minClientVersion": "1.0.0",
     "recommendedClientVersion": "1.1.0"
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
  "clientVersion": "2.0.0",
  "minClientVersion": "2.0.0",
  "recommendedClientVersion": "2.0.0"
}
```

This blocks old clients with a full-screen update page.

## Update Behavior

| Scenario                              | User Experience                     |
| ------------------------------------- | ----------------------------------- |
| `version < minClientVersion`          | Full-screen block, must update      |
| `version < recommendedClientVersion`  | Dismissible popup suggesting update |
| `version >= recommendedClientVersion` | No prompt                           |
