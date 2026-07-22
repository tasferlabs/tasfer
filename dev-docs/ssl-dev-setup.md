# SSL / HTTPS Dev Setup

The mobile WebViews (iOS/Android) and non-localhost browsers treat a plain-HTTP
LAN origin as an **insecure context**, where `crypto.subtle`, OPFS, and
`navigator.locks` are all undefined. That breaks SQLite persistence, identity,
and sync — often surfacing as a bogus "disk I/O error". Serving the dev server
over HTTPS makes the LAN origin a secure context so those APIs exist.

`npm run dev:host` (`vite --host`) serves on the LAN. It uses a locally trusted
[mkcert](https://github.com/FiloSottile/mkcert) certificate. See
[`apps/web/vite.config.ts`](../apps/web/vite.config.ts) for how the cert is
loaded.

## 1. Generate a trusted LAN cert (once)

Install the mkcert root CA into your Mac keychain, then generate the cert.
`mkdir` is required — mkcert does not create the `certs/` directory.

```sh
brew install mkcert
mkcert -install

cd apps/web
mkdir -p certs
mkcert -cert-file certs/lan-cert.pem -key-file certs/lan-key.pem \
  <your-LAN-IP> localhost tasfer.app
```

Find `<your-LAN-IP>` with `ipconfig getifaddr en0`. `apps/web/certs/` is
gitignored. If the cert is missing, `--host` falls back to plain HTTP and warns.

The cert's Subject Alternative Names must include the exact IP the device
connects to. If your LAN IP changes, regenerate the cert with the new IP and
update `server.url` in [`apps/web/capacitor.config.js`](../apps/web/capacitor.config.js).

## 2. Trust the mkcert root CA on the connecting device

The root CA is the file `rootCA.pem` inside the directory printed by:

```sh
mkcert -CAROOT
```

(on macOS typically `~/Library/Application Support/mkcert`). That directory also
contains `rootCA-key.pem` — never copy that one anywhere; anyone holding it can
mint certificates your devices trust.

`mkcert -install` only trusts the CA on the **Mac's** keychain. Each device
(iOS Simulator, Android emulator, physical phone) keeps its **own** trust store
and must be told to trust the CA separately. Skipping this yields:

> The certificate for this server is invalid. You might be connecting to a
> server that is pretending to be "\<LAN-IP\>"…

This is the generic message iOS shows for an **untrusted issuer** — the cert
itself is fine; the device just doesn't know the CA.

### iOS Simulator

With the target simulator booted:

```sh
xcrun simctl keychain booted add-root-cert "$(mkcert -CAROOT)/rootCA.pem"
```

Then relaunch the app. This trust is **per simulator device** and survives
reboots, but **not** an "Erase All Content and Settings". After erasing the sim
or switching to a different device, re-run the command with that sim booted.

### iOS physical device

1. AirDrop or email `"$(mkcert -CAROOT)/rootCA.pem"` to the device and install
   the profile (Settings → General → VPN & Device Management).
2. Enable full trust: Settings → General → About → Certificate Trust Settings →
   toggle on the mkcert root.

### Android emulator / device

With the emulator running (or the device connected with USB debugging on):

```sh
adb push "$(mkcert -CAROOT)/rootCA.pem" /sdcard/Download/
```

Then on the device: Settings → Security & privacy → More security & privacy →
Encryption & credentials → Install a certificate → CA certificate → pick
`rootCA.pem` from Downloads. (The exact wording moved around Android versions and
OEMs — on older builds it's Settings → Security → Encryption & credentials; if you
can't find it, search Settings for "CA certificate".) On an emulator you can also
drag the file onto its window instead of `adb push`. On Android 7+ apps only trust
user CAs if their network security config opts in.

## Troubleshooting

- **"certificate is invalid"** on device → CA not trusted on that device
  (step 2), not a cert problem.
- **"pretending to be \<IP\>"** with the CA trusted → the cert's SANs don't
  include that IP; regenerate (step 1) and update `capacitor.config.js`.
- **"disk I/O error" / crypto undefined** in the browser → you're on a
  plain-HTTP LAN origin (insecure context); use HTTPS.
