# Deep Links Setup (Universal Links & App Links)

Deep links allow `https://cypher.md/...` URLs (e.g. password reset emails) to open directly in the native app instead of the browser.

## How It Works

1. User clicks `https://cypher.md/reset-password?token=...` in an email
2. iOS/Android recognizes the domain is associated with the app
3. The link opens inside the app's WebView instead of the browser
4. Capacitor's hostname is already `cypher.md`, so the route loads naturally

## Supported Paths

- `/reset-password?token=...`
- `/verify-email-change?token=...`

## File Overview

| File | Purpose |
|------|---------|
| `apps/web/public/.well-known/apple-app-site-association` | Tells iOS which app handles which URLs |
| `apps/web/public/.well-known/assetlinks.json` | Tells Android which app handles which URLs |
| `apps/ios/App/App/App.entitlements` | Declares the associated domain on the iOS side |
| `apps/ios/App/App.xcodeproj/project.pbxproj` | References the entitlements file in build settings |
| `apps/android/app/src/main/AndroidManifest.xml` | Intent filters that register the app for matching URLs |
| `Dockerfile.web` | Nginx serves `apple-app-site-association` with correct Content-Type |

## Setup Steps

### 1. Apple Developer Portal

1. Go to https://developer.apple.com/account/resources/identifiers
2. Select your App ID (`md.cypher.app`)
3. Under Capabilities, enable **Associated Domains**
4. Save

### 2. Android Signing Fingerprint

Get your signing key's SHA-256 fingerprint:

```bash
# Debug key
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android

# Release key
keytool -list -v -keystore <your-release-keystore> -alias <your-alias>
```

Copy the `SHA256:` value (format: `AA:BB:CC:...`) and paste it in:

```
apps/web/public/.well-known/assetlinks.json
```

Replace `SHA256_FINGERPRINT` with the full fingerprint string.

### 3. Deploy the `.well-known` Files

The files in `apps/web/public/.well-known/` are copied to the nginx build automatically by Vite. After deploying, verify they're accessible:

```bash
curl -I https://cypher.md/.well-known/apple-app-site-association
# Should return Content-Type: application/json

curl https://cypher.md/.well-known/assetlinks.json
# Should return the JSON with your fingerprint
```

### 4. Go to Production

When you're ready to ship, remove `?mode=developer` from the entitlements file:

**`apps/ios/App/App/App.entitlements`**

Change:
```
applinks:cypher.md?mode=developer
```
To:
```
applinks:cypher.md
```

The `?mode=developer` flag makes iOS fetch the AASA file directly from your server (good for testing). Without it, iOS fetches via Apple's CDN which caches for up to 24 hours.

## Testing

### iOS

1. Build and install the app on a device (simulator does not support Universal Links)
2. Open Safari and type `https://cypher.md/reset-password?token=test`
3. You should see a banner at the top offering to open in the app
4. Or: paste the link in Notes and tap it — it should open the app directly

### Android

1. Build and install the app
2. Verify link handling:
   ```bash
   adb shell am start -a android.intent.action.VIEW -d "https://cypher.md/reset-password?token=test" md.cypher.app
   ```
3. Or tap a link in an email/message — it should open in the app

If Android shows a disambiguation dialog instead of opening the app directly, the `assetlinks.json` verification failed. Re-install the app after deploying the correct file.

## Adding New Deep Link Paths

To support a new path (e.g. `/invite`):

1. **AASA** — Add a new component in `apple-app-site-association`:
   ```json
   { "/": "/invite", "?": { "token": "*" } }
   ```

2. **Android** — Add a new intent filter in `AndroidManifest.xml`:
   ```xml
   <intent-filter android:autoVerify="true">
       <action android:name="android.intent.action.VIEW" />
       <category android:name="android.intent.category.DEFAULT" />
       <category android:name="android.intent.category.BROWSABLE" />
       <data
           android:scheme="https"
           android:host="cypher.md"
           android:pathPrefix="/invite" />
   </intent-filter>
   ```

3. Make sure the web app has a matching route in `Router.tsx`.

## Troubleshooting

- **iOS not opening links in app**: Ensure Associated Domains is enabled in the Apple Developer portal. Long-press the link — if "Open in Cypher" appears in the menu, Universal Links are configured but the system chose to open in Safari (this happens if the user previously chose "Open in Safari").
- **Android disambiguation dialog**: The `assetlinks.json` verification failed. Check the file is accessible and the SHA-256 fingerprint matches your signing key. Re-install the app to trigger re-verification.
- **AASA not loading**: Check `https://cypher.md/.well-known/apple-app-site-association` returns valid JSON with `Content-Type: application/json`. Apple's CDN can take up to 24 hours to update — use `?mode=developer` in entitlements during development.
