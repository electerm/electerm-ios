# electerm for iOS — build & test

This folder turns the electerm-web codebase into a native iOS app.

## How it works

```
WebView (frontend)  ── http://127.0.0.1:5577 ──►  Node.js backend (on device)
   loads index.html                                    serves UI + SSH/SFTP/...
   (local "loading" page)                              API/WebSocket on same origin
```

- **Capacitor** provides the native iOS shell + WKWebView.
- **`@capawesome/capacitor-nodejs`** embeds a Node.js runtime and auto-starts the
  electerm backend (`www/nodejs`) when the app launches. The bundled Node.js is
  **v18**, so:
  - native modules that can't be built for iOS (`node-pty`, `serialport`,
    `node-bash`, `font-list`) are kept **external**. The backend
    loads them through guarded `import()` / dynamic-require calls that catch the
    load failure, so a missing native module never prevents the server from
    starting — the feature that needs it simply stays unavailable;
  - logging uses a small **dependency-free Node.js logger** (no `electron-log`),
    so there is one less desktop-only dependency to worry about on mobile.
  - electerm's `node:sqlite` usage is shimmed with **sql.js** (pure JS + WASM),
    because built-in `node:sqlite` only exists on Node ≥ 22.5.
- The backend is configured by `build/ios/.env` (copied into
  `www/nodejs/.env`), which sets `DISABLE_LOCAL_TERMINAL=1` because the local
  terminal / serial features are not available on iOS yet.
- The WebView first shows a small local "loading" page (`www/index.html`) that
  polls the backend and redirects once it is listening. Because the backend is
  served over plain `http://127.0.0.1`, an App Transport Security (ATS)
  exception for localhost is baked into `Info.plist` directly, and
  `build.mjs --overlay-only` re-applies it after every `cap sync`.

## Prerequisites (local build)

- Node.js ≥ 24
- Xcode 16+ (with the iOS SDK + command-line tools)
- CocoaPods (`sudo gem install cocoapods`)
- Python 3 (used by some build tooling)

## Build

```bash
# 1. install everything
npm i                       # root: electerm deps + esbuild + sql.js (also runs
                            # the postinstall that copies electerm-react into src/)
npm --prefix build/ios install   # capacitor + @capawesome/capacitor-nodejs

# 2. build the web frontend + Node.js backend bundle into build/ios/www
npm run build:ios

# 3. create the native project + sync assets/plugins (first time only)
cd build/ios
npx cap add ios
npx cap sync ios

# 4. re-apply the Info.plist ATS overlay (after cap sync), then open
node build.mjs --overlay-only
npx cap open ios            # Xcode — build & run on a simulator / device
```

The unsigned app is produced in Xcode's DerivedData. To install on a physical
device you must sign it with a valid Apple development certificate/provisioning
profile (set in Xcode or via CI secrets).

## Known limitations on iOS

- **Local terminal / serial port** are disabled via `DISABLE_LOCAL_TERMINAL=1` in
  `build/ios/.env` (and the `node-pty` / `serialport` native modules simply are
  not present on the device). The guarded imports mean the app still starts fine;
  these features can be re-enabled once native libraries are built for iOS.
  SSH, SFTP, Telnet, FTP, RDP, VNC and Spice work because they are network protocols
  implemented in pure JS / WASM.

## CI

`.github/workflows/build-ios.yml` builds the app on a macOS runner (Capacitor
iOS + unsigned `xcodebuild`) and uploads the unsigned `.app` as a workflow
artifact. It does **not** produce a signed IPA — add your Apple signing
certificate + provisioning profile to the repo secrets to do so.
