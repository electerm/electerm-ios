/**
 * Build the electerm iOS web bundle.
 *
 * Produces `build/ios/www`, which Capacitor copies into the native app:
 *   - www/index.html              local "loading" page (waits for the Node backend)
 *   - www/nodejs                  the electerm Node.js project, run on-device by
 *                                 @capawesome/capacitor-nodejs. It serves the real
 *                                 UI + the SSH/SFTP/telnet/ftp/RDP/VNC/Spice API on
 *                                 http://127.0.0.1:5577.
 *
 * Steps:
 *   1. vite build the frontend  -> www/nodejs/dist/assets
 *   2. copy static assets (icons, images) into the node project
 *   3. esbuild bundle the backend -> www/nodejs/app.bundle.mjs. Native modules
 *      that are not built for iOS yet (node-pty, serialport, node-bash,
 *      font-list) are kept *external*: the source loads them via guarded
 *      `import()` calls that fall back gracefully, so a missing module never
 *      prevents the server from starting. Logging uses a built-in dependency-free
 *      logger (no `electron-log`). The on-device runtime is jitless Node 18
 *      (no WebAssembly), so the db layer uses the pure-JS nedb backend and
 *      `node:sqlite` is aliased to a throwing stub.
 *   4. render the homepage to dist/assets/index.html (build/bin/gen-index-html.js),
 *      so the pug compiler never has to run on the device.
 */
import { build as viteBuild } from 'vite'
import { createConfig, entryNames } from './vite.ios.mjs'
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { applySrcOverrides } from '../bin/apply-src-overrides.mjs'
import { generateIndexHtml } from '../bin/gen-index-html.js'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..', '..') // build/ios -> repo root

// Make every path that reads process.cwd() resolve against the repo root,
// regardless of where this script is invoked from.
process.chdir(ROOT)

const WWW = path.resolve(__dirname, 'www')
const NODEJS_DIR = path.resolve(WWW, 'nodejs')
const VERSION = JSON.parse(
  fs.readFileSync(path.resolve(ROOT, 'package.json'), 'utf8')
).version

// JWT secret for the on-device server.
// In CI (GitHub Actions) SERVER_SECRET should come from the repository secret,
// but to keep the build self-contained we fall back to a fresh random key when
// it is not provided. For local development a fixed fallback value is used.
const LOCAL_DEV_SECRET = 'electerm-ios-local-dev-secret'
const SERVER_SECRET = process.env.SERVER_SECRET ||
  (process.env.CI
    ? require('crypto').randomBytes(32).toString('hex')
    : LOCAL_DEV_SECRET)
if (SERVER_SECRET === LOCAL_DEV_SECRET) {
  console.warn(
    '[ios] WARNING: using insecure local-dev SERVER_SECRET fallback. ' +
    'Set the SERVER_SECRET GitHub Actions secret for production builds.'
  )
}

// The package.json the node project carries on the device. The server reads it
// as `packInfo`, so the build-time homepage must embed the same object — not
// this repo's package.json, which runtime-constants would otherwise pick up.
const NODE_PKG = {
  name: 'electerm-node',
  version: VERSION,
  main: 'index.js',
  type: 'module'
}

// --------------------------------------------------------------------------
// 1. Frontend
// --------------------------------------------------------------------------
// The frontend is built once per entry with every dynamic import inlined
// (see vite.ios.mjs): on the device each asset is an HTTP round trip through
// the single-threaded node server, so ~250 chunks with 138 of them on the
// first screen cost ~2 s of launch time. 3 files cost ~0.
const VITE_TMP = path.resolve(__dirname, '.gen', 'vite')

function rmrfMaybe (dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

async function runVite () {
  console.log('[ios] building frontend (vite)…')
  rmrfMaybe(VITE_TMP)
  for (const name of entryNames) {
    const outDir = path.resolve(VITE_TMP, name, 'assets')
    await viteBuild({
      ...createConfig(name, outDir),
      logLevel: 'warn'
    })
  }

  // Assemble dist/assets from the per-entry outputs.
  const assets = path.resolve(NODEJS_DIR, 'dist', 'assets')
  // A stale chunk/ directory from an older build would still be packed into
  // the app bundle even though nothing references it any more.
  for (const stale of ['js', 'chunk', 'css']) {
    rmrfMaybe(path.resolve(assets, stale))
  }
  fs.mkdirSync(assets, { recursive: true })
  const cssParts = []
  for (const name of entryNames) {
    const out = path.resolve(VITE_TMP, name, 'assets')
    if (!fs.existsSync(out)) {
      continue
    }
    for (const entry of fs.readdirSync(out)) {
      const from = path.join(out, entry)
      if (entry === 'css') {
        // cssCodeSplit:false gives one file per entry; the html only links
        // css/style-<version>.css, so the entries have to be concatenated.
        for (const file of fs.readdirSync(from).sort()) {
          cssParts.push(fs.readFileSync(path.join(from, file), 'utf8'))
        }
      } else if (fs.statSync(from).isDirectory()) {
        copyDir(from, path.resolve(assets, entry))
      } else {
        fs.copyFileSync(from, path.resolve(assets, entry))
      }
    }
  }
  if (cssParts.length) {
    fs.mkdirSync(path.resolve(assets, 'css'), { recursive: true })
    fs.writeFileSync(
      path.resolve(assets, 'css', `style-${VERSION}.css`),
      cssParts.join('\n')
    )
  }
  const jsCount = fs
    .readdirSync(path.resolve(assets, 'js'))
    .filter(f => f.endsWith('.js')).length
  console.log(`[ios] frontend: ${jsCount} js file(s), ${cssParts.length} css file(s) merged`)
}

// --------------------------------------------------------------------------
// 2. Static assets for the node project
// --------------------------------------------------------------------------
function copyDir (from, to) {
  if (!fs.existsSync(from)) {
    console.warn('[ios] skip missing source:', from)
    return
  }
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name)
    const d = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

function copyFrontendAssets () {
  console.log('[ios] copying static assets into node project…')
  const assets = path.resolve(NODEJS_DIR, 'dist', 'assets')

  copyDir(path.resolve(ROOT, 'src/client/statics'), assets)
  copyDir(
    path.resolve(ROOT, 'node_modules/electerm-icons/icons'),
    path.resolve(assets, 'icons')
  )
  copyDir(
    path.resolve(ROOT, 'node_modules/@electerm/electerm-resource/res/imgs'),
    path.resolve(assets, 'images')
  )
  copyDir(
    path.resolve(ROOT, 'node_modules/@electerm/electerm-resource/tray-icons'),
    path.resolve(assets, 'images')
  )

  // No `views/` in the node project: the homepage is rendered to
  // dist/assets/index.html at build time (build/bin/gen-index-html.js) and the
  // runtime never reads a template from disk.
}

function writeLoadingPage () {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>electerm</title>
  <style>
    html, body { height: 100%; margin: 0; background: #15171a; color: #cfd6e4;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .wrap { height: 100%; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 18px; }
    .logo { font-size: 22px; font-weight: 600; letter-spacing: .5px; }
    .spin { width: 34px; height: 34px; border: 3px solid rgba(255,255,255,.15);
      border-top-color: #4aa3ff; border-radius: 50%; animation: r 1s linear infinite; }
    @keyframes r { to { transform: rotate(360deg); } }
    .msg { font-size: 13px; opacity: .7; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">electerm</div>
    <div class="spin"></div>
    <div class="msg" id="msg">Starting engine…</div>
  </div>
  <script>
    // Reach the on-device Node.js backend at http://127.0.0.1:5577.
    // Subresource probes are unreliable here:
    //   - fetch()        -> Chromium Private Network Access ("Failed to fetch")
    //   - CapacitorHttp  -> works only where the native client allows cleartext
    // A top-level navigation is NOT a subresource (PNA does not apply) and the
    // network-security-config permits cleartext to 127.0.0.1, so once the engine
    // is up we navigate. allowNavigation:["127.0.0.1"] keeps it in-app.
    //
    // The engine does NOT start in a second: the plugin unpacks the node project
    // and the 7-8 MB server bundle has to be parsed (11-15 s measured on the
    // Android emulator; the iOS simulator is in the same range). So navigation
    // is driven by a probe that keeps retrying, never by a fixed timer: a blind
    // navigation fired while the port is still closed lands the WebView on its
    // "cannot connect" page, which has no way back and makes a cold launch look
    // broken.
    var PORT = 5577;
    var BASE = 'http://127.0.0.1:' + PORT + '/';
    var RETRY_MS = 500;
    var GIVE_UP_MS = 60000;
    var Http = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    var startedAt = Date.now();
    var done = false;
    var msg = document.getElementById('msg');
    function go () {
      if (done) return;
      done = true;
      msg.textContent = 'Loading…';
      location.replace(BASE);
    }
    function probeOnce () {
      if (Http) {
        return Http.get({ url: BASE, connectTimeout: 1000, readTimeout: 1000 })
          .then(function (r) { return !!(r && r.status >= 100 && r.status < 500); })
          .catch(function () { return false; });
      }
      return fetch(BASE, { mode: 'no-cors' })
        .then(function () { return true; })
        .catch(function () { return false; });
    }
    function giveUp () {
      var btn = document.createElement('button');
      btn.textContent = 'Retry';
      btn.style.cssText = 'margin-top:6px;padding:8px 18px;border:0;border-radius:6px;' +
        'background:#4aa3ff;color:#0b1017;font-size:14px;font-weight:600';
      btn.onclick = function () {
        startedAt = Date.now();
        btn.remove();
        msg.textContent = 'Waiting for engine…';
        tick();
      };
      msg.textContent = 'The engine did not start. ';
      msg.appendChild(btn);
    }
    function tick () {
      if (done) return;
      probeOnce().then(function (ok) {
        if (done) return;
        if (ok) return go();
        var waited = Date.now() - startedAt;
        if (waited > GIVE_UP_MS) return giveUp();
        msg.textContent = 'Waiting for engine… ' + Math.round(waited / 1000) + 's';
        setTimeout(tick, RETRY_MS);
      });
    }
    tick();
  </script>
</body>
</html>
`
  fs.writeFileSync(path.resolve(WWW, 'index.html'), html)
}

// --------------------------------------------------------------------------
// 3. Backend (esbuild) with native stubs + node:sqlite stub
// --------------------------------------------------------------------------
// The on-device Node runtime is jitless: `WebAssembly` is not defined, so the
// old sql.js-backed shim could never initialize (its module init threw an
// unhandled rejection and the whole db layer silently failed to load). The
// backend now uses the pure-JS nedb wrapper (src/app/lib/nedb.js) selected by
// DISABLE_SQLITE=1 in the generated entry. `node:sqlite` is still aliased so
// esbuild never tries to resolve it (Node 18 has no builtin), but the stub
// only throws if something imports it directly.
function genSqliteStub () {
  const stub = `export class DatabaseSync {
  constructor () {
    throw new Error('node:sqlite is not available on this platform (jitless runtime, no WebAssembly); the nedb backend is used instead')
  }
}
`
  const genDir = path.resolve(__dirname, '.gen')
  fs.mkdirSync(genDir, { recursive: true })
  const stubPath = path.resolve(genDir, 'node-sqlite-stub.mjs')
  fs.writeFileSync(stubPath, stub)
  return stubPath
}

// esbuild plugin: rewrite path-to-regexp v8 Unicode property-escape regexes
// so they run on the on-device Node 18 build (which lacks \p{...} support
// inside character classes due to its stripped ICU data).
//
// path-to-regexp v8 defines three regexes that use \p{ID_Start} and
// \p{ID_Continue} — Unicode property escapes that require full ICU support.
// We replace them with ASCII-equivalent character classes; route parameter
// names are always ASCII in practice, so the behaviour is identical.
// esbuild plugin: mark all .node native-addon files as external.
// Before the session.js refactor the dynamic `import(\`./session-${type}.js\`)`
// was opaque to esbuild, so it never traversed into session-ssh.js and its
// dependencies (ssh2 → cpu-features → cpufeatures.node, sshcrypto.node).
// Now that session.js uses static imports esbuild sees those .node files and
// errors because it has no loader for them.  Marking them external is correct:
// the native binaries are not present on iOS anyway and the libraries that
// use them have pure-JS fallbacks guarded by try/catch.
const nativeNodePlugin = {
  name: 'native-node-files',
  setup (build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true
    }))
  }
}

const patchPathToRegexpPlugin = {
  name: 'patch-path-to-regexp',
  setup (build) {
    build.onLoad({ filter: /path-to-regexp/ }, async (args) => {
      let src = await fs.promises.readFile(args.path, 'utf8')
      src = src
        .replace(
          '/^[$_\\p{ID_Start}]$/u',
          '/^[$_a-zA-Z]$/'
        )
        .replace(
          '/^[$\\u200c\\u200d\\p{ID_Continue}]$/u',
          '/^[$\\u200c\\u200da-zA-Z0-9_]$/'
        )
        .replace(
          '/^[$_\\p{ID_Start}][$\\u200c\\u200d\\p{ID_Continue}]*$/u',
          '/^[$_a-zA-Z][$\\u200c\\u200da-zA-Z0-9_]*$/'
        )
      return { contents: src, loader: 'js' }
    })
  }
}

async function bundleBackend (shimPath) {
  console.log('[ios] bundling backend (esbuild)…')
  await esbuild.build({
    entryPoints: [path.resolve(ROOT, 'src/app/app.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    outfile: path.resolve(NODEJS_DIR, 'app.bundle.mjs'),
    alias: {
      // The on-device runtime is Node 18, which has no built-in `node:sqlite`,
      // and it is jitless (no WebAssembly) so a sql.js shim cannot work either.
      // The backend's db.js selects the pure-JS nedb backend via DISABLE_SQLITE;
      // this alias only exists so esbuild can resolve the bare `node:sqlite`
      // import in sqlite.js (which is never loaded on-device).
      'node:sqlite': shimPath
    },
    // Native modules that are not built for iOS yet. Keep them external so
    // esbuild never tries to resolve them; the guarded `import()` calls in the
    // source fall back gracefully at runtime (see DISABLE_LOCAL_TERMINAL).
    external: [
      'node-pty',
      'serialport',
      'node-bash',
      'font-list',
      // Dev-only template engine (see server/server.js): the guarded
      // `if (isDev) await import('pug')` must not pull the compiler into the
      // device bundle — it is 1.5 MB of @babel/parser + @babel/types + acorn.
      'pug'
    ],
    // Some bundled CJS deps (e.g. sql.js's initSqlJs) reference __dirname /
    // __filename, which don't exist in an ESM bundle. Define them from
    // import.meta.url. NOTE: do NOT `import { dirname } from "path"` here —
    // the bundle already imports `dirname` at top level, which would collide
    // ("Identifier 'dirname' has already been declared"). Alias fileURLToPath
    // to a private name for the same reason, and derive __dirname from a
    // directory URL.
    banner: {
      // Every name the banner needs is aliased: src/app/widgets/user-widget.js
      // imports createRequire by name, and a banner that also declares it makes
      // the bundle fail to link ("Identifier 'createRequire' has already been
      // declared"), so the on-device server never starts.
      js: "import { createRequire as __cr } from 'module'; import { fileURLToPath as __etu } from 'url'; const require = __cr(import.meta.url); const __filename = __etu(import.meta.url); const __dirname = __etu(new URL('.', import.meta.url));"
    },
    plugins: [nativeNodePlugin, patchPathToRegexpPlugin],
    // keep node built-ins external; everything else is bundled
    logLevel: 'info'
  })
}

function copyEnv () {
  const src = path.resolve(__dirname, '.env')
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.resolve(NODEJS_DIR, '.env'))
    console.log('[ios] copied runtime .env ->', path.resolve(NODEJS_DIR, '.env'))
  }
}

function writeNodeEntry () {
  const entry = `import { resolve } from 'node:path'
import fs, { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __d = fileURLToPath(new URL('.', import.meta.url))

// The embedded Node.js engine starts with cwd "/" (the app sandbox root),
// not the nodejs-project directory. electerm's runtime-constants.js reads
// "package.json" via resolve(process.cwd(), 'package.json'), so without
// chdir it tries to open "/package.json" -> ENOENT -> uncaught exception ->
// the Node process exits and the app crashes (SIGSEGV during teardown).
// Switch cwd to the project directory before loading the backend bundle.
process.chdir(__d)

// Runtime configuration for the on-device electerm server.
process.env.NODE_ENV = 'production'
process.env.HOST = '127.0.0.1'
process.env.PORT = '5577'
// JWT secret baked in at build time. In CI this comes from the SERVER_SECRET
// GitHub Action secret; locally it falls back to a fixed dev value.
// The web UI auto-logs-in because ENABLE_AUTH is not set.
process.env.SERVER_SECRET = ${JSON.stringify(SERVER_SECRET)}
// No real pty on iOS -> disable the local terminal feature.
process.env.DISABLE_LOCAL_TERMINAL = '1'
// The on-device Node.js engine runs jitless (no WebAssembly), so the
// sql.js-backed sqlite shim cannot load. Tell db.js to use the pure-JS
// nedb backend and view.js that nedb files are the primary store (no
// "migrate nedb -> sqlite" banner).
process.env.DISABLE_SQLITE = '1'
// No VIEW_FOLDER: the one template is precompiled into dist/assets/index.html
// at build time, and the runtime never renders a page.

// The embedded engine is Node 18, where net.connect's autoSelectFamily
// defaults to false: a hostname with an AAAA record gets a single IPv6
// connect attempt, and on networks with no usable IPv6 route the SSH
// connection fails with EHOSTUNREACH ("no route to host") with no IPv4
// retry. Prefer A records so the common IPv4 path is tried first.
import dns from 'node:dns'
dns.setDefaultResultOrder('ipv4first')

// Stable, app-private user-data directory.
//
// On iOS the bundled Node.js project lives INSIDE the app bundle
// (App.app/public/nodejs), which is READ-ONLY on a real device. Any attempt
// to mkdir inside it throws EACCES, the Node engine exits, and the app
// closes immediately after launch (the simulator never showed this because
// simulator bundles are writable). So the data dir must live outside the
// bundle.
//
// The plugin's native layer registers the app's Documents directory for us
// (NodeRunner.registerDataDirPath), exposed to Node via
// process._linkedBinding('capacitor_bridge').getDataDir(). That directory:
//   - is writable on real devices
//   - survives app updates (unlike anything inside the bundle)
//
// Fallbacks (desktop runs of the same bundle, older plugin builds):
//   1. <Documents>/electerm-data  (when the linked binding is unavailable)
//   2. <project>/data             (writable when not running from a bundle)
const userDataDir = (() => {
  const candidates = []
  try {
    // Preferred: the data dir registered by the native plugin (Documents dir).
    const bridge = process._linkedBinding('capacitor_bridge')
    const registered = bridge.getDataDir()
    if (registered) candidates.push(resolve(registered, 'electerm-data'))
  } catch (e) {}
  // Inside the app bundle -> parent dir is still read-only, skip it entirely.
  if (!__d.includes('.app/')) {
    candidates.push(resolve(__d, '..', 'electerm-data'))
    candidates.push(resolve(__d, 'data'))
  }
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      // Verify it is actually writable — mkdir on a read-only FS may not
      // throw on all platforms, and writing the DB later would crash the app.
      const probe = resolve(dir, '.write-test')
      fs.writeFileSync(probe, '')
      fs.rmSync(probe)
      return dir
    } catch (e) {}
  }
  // Last resort: system temp dir (always writable; data won't persist across
  // reinstalls but the app starts, and the real dirs above virtually always
  // succeed).
  const tmp = resolve(tmpdir(), 'electerm-data')
  mkdirSync(tmp, { recursive: true })
  return tmp
})()
process.env.DB_PATH = userDataDir

// The embedded Node.js engine does not set a meaningful HOME directory on iOS.
// os.homedir() may return a path the app cannot access, causing
// "EACCES: permission denied" when electerm tries to enumerate SSH keys from
// ~/.ssh.  Point HOME at the writable user-data directory so that:
//   - os.homedir() returns a path the app can read/write
//   - SSH keys stored in <userDataDir>/.ssh are found automatically
//   - The .ssh dir is created once on first launch
const sshDir = resolve(userDataDir, '.ssh')
mkdirSync(sshDir, { recursive: true })
process.env.HOME = userDataDir

await import('./app.bundle.mjs')
`
  fs.writeFileSync(path.resolve(NODEJS_DIR, 'index.js'), entry)
  fs.writeFileSync(
    path.resolve(NODEJS_DIR, 'package.json'),
    JSON.stringify(
      NODE_PKG,
      null,
      2
    )
  )
}

// --------------------------------------------------------------------------
// 5. Post-sync overlay: patch Info.plist with ATS exception for localhost
// --------------------------------------------------------------------------
// `cap sync ios` regenerates Info.plist from Capacitor's default template,
// which does NOT include an App Transport Security (ATS) exception.
//
// The on-device Node.js backend serves over plain http://127.0.0.1:5577.
// iOS blocks insecure (http) loads by default via ATS, so without this
// exception the WebView cannot reach the backend. We patch Info.plist after
// every sync to ensure local builds work without manual steps.
//
// This function is a no-op when the native project has not been created yet
// (e.g. during a pure `npm run build:ios` before `cap add ios`).

// The web UI is not safe-area aware (no viewport-fit=cover / env() usage),
// so on devices with a notch / Dynamic Island the fixed-position header
// slides under the system status bar. Instead of restyling the web app,
// keep the WKWebView itself inside the safe area: a container VC embeds
// Capacitor's CAPBridgeViewController with safe-area constraints. The web
// content then lays out inside the safe rect and env(safe-area-inset-*)
// would even resolve to 0 — nothing in the web layer needs to change.
//
// Consequence: the two bands OUTSIDE the safe rect (status bar on top, home
// indicator at the bottom) are the container view's own background, i.e. the
// system default — white on a light-mode device. ElectermWindowChrome paints
// them with the UI theme's colours instead (see window-chrome.js), which is why
// this VC owns one and overrides preferredStatusBarStyle.
const safeAreaContainerSwift = `import UIKit
import Capacitor
import WebKit

/// Container that keeps the Capacitor web view below the status bar /
/// Dynamic Island and above the home indicator, without requiring the
/// web content itself to be safe-area aware.
class SafeAreaContainerViewController: UIViewController {
  private let bridge = CAPBridgeViewController()

  /// Paints the status-bar / home-indicator bands with the UI theme colours.
  private var windowChrome: ElectermWindowChrome?

  /// The bands are outside the web page, so the clock / battery colour has to
  /// come from the strip colour too — dark glyphs on a light strip, light
  /// glyphs on a dark one.
  override var preferredStatusBarStyle: UIStatusBarStyle {
    return windowChrome?.statusBarStyle ?? .lightContent
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    addChild(bridge)
    view.addSubview(bridge.view)
    bridge.view.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      bridge.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      bridge.view.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
      bridge.view.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
      bridge.view.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor)
    ])
    bridge.didMove(toParent: self)
    // Added after the bridge view so the strips stay on top of it; they live in
    // the safe-area bands, where the web view never draws.
    windowChrome = ElectermWindowChrome(container: view)
    windowChrome?.onColorsChanged = { [weak self] in
      self?.setNeedsStatusBarAppearanceUpdate()
    }
    installBridges()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    // Re-attach: idempotent, and guarantees the bridges are present even if
    // the WebView was recreated while we were backgrounded.
    installBridges()
    // A recreated WebView reloads the page, so the strips are re-painted as
    // soon as the page reports its theme again; this covers the gap.
    windowChrome?.refresh()
  }

  /// Attach both native bridges to Capacitor's WKWebView. The UI page is
  /// served by the on-device Node backend (http://127.0.0.1:5577), outside
  /// Capacitor's own origin, so Capacitor never injects its plugin runtime
  /// there and every plugin silently falls back to its web implementation (a
  /// no-op in a WebView). Anything that must reach native is one of these:
  ///
  ///   window.ElectermNative  ElectermSaveBridge    - public Documents save
  ///   window.ElectermChrome  ElectermWindowChrome  - status-bar / home-indicator
  ///                                                  colours from the UI theme
  private func installBridges() {
    view.layoutIfNeeded()
    guard let webView = findWebView(in: bridge.view) else { return }
    ElectermSaveBridge.install(on: webView)
    if let chrome = windowChrome {
      ElectermWindowChrome.install(on: webView, chrome: chrome)
    }
  }

  private func findWebView(in view: UIView) -> WKWebView? {
    if let webView = view as? WKWebView { return webView }
    for subview in view.subviews {
      if let found = findWebView(in: subview) { return found }
    }
    return nil
  }
}
`

// ElectermWindowChrome.swift — the status-bar / home-indicator strips, painted
// with the UI theme's own colours. Same feature as electerm-android's
// ElectermWindowChrome.java; the page side is
// build/replace/src/client/web-components/window-chrome.js.
//
// Bridge contract:
//   window.ElectermChrome.getVersion() -> "1"
//   window.ElectermChrome.setWindowChrome(topArgb, bottomArgb)   '#AARRGGBB'
//     top    -> --main-dark, the tab bar / header it continues
//     bottom -> --main, the footer (and main surface) it continues
const electermWindowChromeSwift = `import UIKit
import WebKit

/// Window chrome — the two system strips that live OUTSIDE the web page.
///
/// Why this exists
/// ---------------
/// The status-bar band (top) and the home-indicator band (bottom) are not part
/// of the web page: SafeAreaContainerViewController constrains the WebView to
/// the safe area, so those bands are the container view's background. Left
/// alone that is the system default — white on a light-mode device — so a dark
/// electerm theme gets a white status bar and a white bottom strip, with
/// near-invisible dark glyphs.
///
/// Two plain coloured views sit in exactly those bands and their colour comes
/// from the UI theme:
///   - the page reports the live --main-dark / --main through the
///     ElectermChrome message handler (see window-chrome.js), so switching
///     theme in settings re-paints the strips immediately;
///   - the container's own background is kept in sync as well, so a band that
///     is briefly taller than the strip (rotation, keyboard, first layout) does
///     not flash white.
/// The clock / battery appearance follows the top strip's luminance, so no
/// separate foreground argument is needed.
///
/// Same feature as electerm-android's ElectermWindowChrome.java.
final class ElectermWindowChrome: NSObject, WKScriptMessageHandler {

  /// Version marker: lets the page feature-detect this bridge.
  static let version = "1"
  static let handlerName = "ElectermChrome"

  /// Boot colours — electerm's dark default (#15171a), the same colour the
  /// loading page and the launch screen use, so the hand-off from launch screen
  /// to first frame shows no white flash.
  private static let bootColor = UIColor(
    red: 0x15 / 255.0,
    green: 0x17 / 255.0,
    blue: 0x1a / 255.0,
    alpha: 1
  )

  /// Last colours reported by the page. Static so a recreated view controller
  /// (WebView still on the old theme) keeps them instead of flashing the boot
  /// colour.
  private static var topColor = bootColor
  private static var bottomColor = bootColor

  private let topStrip = UIView()
  private let bottomStrip = UIView()
  private weak var container: UIView?

  /// Called on the main thread whenever the colours change, so the view
  /// controller can re-ask for the status-bar style.
  var onColorsChanged: (() -> Void)?

  /// Dark glyphs on a light strip, light glyphs on a dark one.
  var statusBarStyle: UIStatusBarStyle {
    return ElectermWindowChrome.isLight(ElectermWindowChrome.topColor)
      ? .darkContent
      : .lightContent
  }

  init(container: UIView) {
    self.container = container
    super.init()
    for strip in [topStrip, bottomStrip] {
      strip.translatesAutoresizingMaskIntoConstraints = false
      // Purely decorative: never eat a touch meant for the page.
      strip.isUserInteractionEnabled = false
      container.addSubview(strip)
    }
    NSLayoutConstraint.activate([
      topStrip.topAnchor.constraint(equalTo: container.topAnchor),
      topStrip.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      topStrip.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      topStrip.bottomAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),

      bottomStrip.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.bottomAnchor),
      bottomStrip.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      bottomStrip.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      bottomStrip.bottomAnchor.constraint(equalTo: container.bottomAnchor)
    ])
    applyColors()
  }

  /// Attach the bridge to a WKWebView. Safe to call repeatedly: the message
  /// handler is re-registered and the shim script is added once.
  static func install(on webView: WKWebView, chrome: ElectermWindowChrome) {
    let controllers = webView.configuration.userContentController
    controllers.removeScriptMessageHandler(forName: handlerName)
    controllers.add(chrome, name: handlerName)
    let alreadyInjected = controllers.userScripts.contains { $0.source == shimScript }
    if (!alreadyInjected) {
      let script = WKUserScript(
        source: shimScript,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: false
      )
      controllers.addUserScript(script)
    }
    chrome.refresh()
  }

  /// Re-apply the current colours (view recreated / appeared).
  func refresh() {
    applyColors()
  }

  /// The page-side shim. WKWebView exposes only
  /// window.webkit.messageHandlers, so window.ElectermChrome is a thin wrapper
  /// that keeps the page code identical to the Android build's
  /// @JavascriptInterface object.
  private static let shimScript: String = """
    (function () {
      if (window.ElectermChrome && typeof window.ElectermChrome.setWindowChrome === 'function') return;
      var handler = (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ElectermChrome) || null;
      if (!handler) return;
      window.ElectermChrome = {
        getVersion: function () { return "1"; },
        setWindowChrome: function (topArgb, bottomArgb) {
          handler.postMessage({ method: 'setWindowChrome', top: topArgb, bottom: bottomArgb });
        }
      };
    })();
    """

  // MARK: - WKScriptMessageHandler

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    guard message.name == Self.handlerName,
          let body = message.body as? [String: Any],
          let method = body["method"] as? String,
          method == "setWindowChrome" else { return }
    // Invalid / missing colours keep the previous value instead of clearing it.
    let top = Self.parseColor(body["top"] as? String)
    let bottom = Self.parseColor(body["bottom"] as? String)
    DispatchQueue.main.async { [weak self] in
      if let top = top { Self.topColor = top }
      if let bottom = bottom { Self.bottomColor = bottom }
      self?.applyColors()
    }
  }

  // MARK: - internals

  private func applyColors() {
    let top = Self.topColor
    let bottom = Self.bottomColor
    topStrip.backgroundColor = top
    bottomStrip.backgroundColor = bottom
    // The strips cover the bands, but a band can be briefly taller than its
    // strip (rotation, keyboard animation); the container background is what
    // shows through then.
    container?.backgroundColor = bottom
    onColorsChanged?()
  }

  /// '#RRGGBB' / '#AARRGGBB' -> opaque UIColor, or nil when unusable.
  /// The alpha byte is accepted and ignored: a translucent strip would show the
  /// system default through it, which is the whole problem.
  private static func parseColor(_ value: String?) -> UIColor? {
    guard var hex = value?.trimmingCharacters(in: .whitespacesAndNewlines), !hex.isEmpty else {
      return nil
    }
    if hex.hasPrefix("#") {
      hex.removeFirst()
    }
    guard hex.count == 6 || hex.count == 8, let number = UInt32(hex, radix: 16) else {
      return nil
    }
    let rgb = hex.count == 8 ? (number & 0x00FFFFFF) : number
    return UIColor(
      red: CGFloat((rgb >> 16) & 0xFF) / 255.0,
      green: CGFloat((rgb >> 8) & 0xFF) / 255.0,
      blue: CGFloat(rgb & 0xFF) / 255.0,
      alpha: 1
    )
  }

  /// True when the strip is light enough to need dark system-bar glyphs.
  /// Straight sRGB luminance weighting — enough to pick between two options.
  private static func isLight(_ color: UIColor) -> Bool {
    var r: CGFloat = 0
    var g: CGFloat = 0
    var b: CGFloat = 0
    var a: CGFloat = 0
    guard color.getRed(&r, green: &g, blue: &b, alpha: &a) else { return false }
    return (0.299 * r + 0.587 * g + 0.114 * b) > 0.6
  }
}
`

// ElectermSaveBridge.swift is written verbatim into the generated Xcode
// project by applyResOverlay() below (the ios/ tree is gitignored and
// rebuilt by `cap add ios` in CI, so checked-in native sources would never
// reach the build). Keep this template in sync with the protocol expected by
// build/replace/src/client/web-components/native-file-save.js:
//   window.ElectermNative.getVersion() -> "1"
//   saveUrl(url, token, fallbackName, callbackId)
//   saveBase64(filename, base64Data, contentType, callbackId)
// Results are reported via window.__etNativeSaveResult(callbackId, ok,
// dataJson, errorString). Files land in the app's Documents directory, which
// is visible in the iOS Files app.
const electermSaveBridgeSwift = `import Foundation
import WebKit

/// electerm native save bridge (WKWebView -> Documents, visible in Files).
///
/// Why this exists
/// ---------------
/// The electerm UI is served by the on-device Node.js backend on
/// http://127.0.0.1:5577, which is *not* the Capacitor local-server origin.
/// Capacitor only injects its JS runtime (window.Capacitor + PluginHeaders)
/// into documents of its own origin, so on the real UI page every Capacitor
/// plugin call silently degrades to its "web" fallback — a blob/anchor
/// download — and \`<a download>\` is a no-op inside WKWebView. Result:
/// "download from browser" saved nothing.
///
/// What it does
/// ------------
/// Injects \`window.ElectermNative\` (WKUserScript, document start) backed
/// by a WKScriptMessageHandler:
///   saveUrl(url, token, fallbackName, callbackId)
///     Fetches the /api/download response (token header included) and writes
///     it to Documents. Streamed to disk via URLSession download task, so big
///     files and directory tarballs never pass through JS memory.
///   saveBase64(filename, base64Data, contentType, callbackId)
///     Writes in-memory content (theme/quick-command/config exports).
///
/// Note: the bridge object is reachable from every document loaded in this
/// WebView. The WebView only ever loads the packaged loading page and the
/// loopback backend (see capacitor.config.ts allowNavigation), so no third
/// party page can reach it.
class ElectermSaveBridge: NSObject, WKScriptMessageHandler {

  /// Version marker: lets the web app feature-detect this bridge.
  static let version = "1"
  static let handlerName = "ElectermNative"

  private weak var webView: WKWebView?
  private let worker = DispatchQueue(label: "org.electerm.savebridge", qos: .utility)

  private static let shimScript: String = """
    (function () {
      if (window.ElectermNative && typeof window.ElectermNative.getVersion === 'function') return;
      var handler = (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ElectermNative) || null;
      if (!handler) return;
      window.ElectermNative = {
        getVersion: function () { return "1"; },
        saveUrl: function (url, token, fallbackName, callbackId) {
          handler.postMessage({ method: 'saveUrl', url: url, token: token, fallbackName: fallbackName, callbackId: callbackId });
        },
        saveBase64: function (filename, base64Data, contentType, callbackId) {
          handler.postMessage({ method: 'saveBase64', filename: filename, base64Data: base64Data, contentType: contentType, callbackId: callbackId });
        }
      };
    })();
    """

  /// Attach the bridge to a WKWebView. Safe to call repeatedly: the message
  /// handler is re-registered and the shim script is added once.
  static func install(on webView: WKWebView) {
    let controllers = webView.configuration.userContentController
    controllers.removeScriptMessageHandler(forName: handlerName)
    let bridge = ElectermSaveBridge(webView: webView)
    controllers.add(bridge, name: handlerName)
    let alreadyInjected = controllers.userScripts.contains { $0.source == shimScript }
    if (!alreadyInjected) {
      let script = WKUserScript(source: shimScript, injectionTime: .atDocumentStart, forMainFrameOnly: false)
      controllers.addUserScript(script)
    }
  }

  private init(webView: WKWebView) {
    self.webView = webView
  }

  // MARK: - WKScriptMessageHandler

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == Self.handlerName,
          let body = message.body as? [String: Any],
          let method = body["method"] as? String,
          let callbackId = body["callbackId"] as? String else { return }
    worker.async { [weak self] in
      guard let self = self else { return }
      do {
        let result: [String: String]
        if (method == "saveUrl") {
          result = try self.handleSaveUrl(body: body)
        } else if (method == "saveBase64") {
          result = try self.handleSaveBase64(body: body)
        } else {
          throw BridgeError.message("unknown method: " + method)
        }
        self.report(callbackId: callbackId, ok: true, data: result, error: nil)
      } catch {
        self.report(callbackId: callbackId, ok: false, data: nil, error: error.localizedDescription)
      }
    }
  }

  // MARK: - handlers

  private func handleSaveUrl(body: [String: Any]) throws -> [String: String] {
    guard let urlString = body["url"] as? String, let url = URL(string: urlString) else {
      throw BridgeError.message("invalid url")
    }
    let token = body["token"] as? String ?? ""
    let fallback = sanitize(body["fallbackName"] as? String ?? "download")

    var request = URLRequest(url: url, timeoutInterval: 120)
    request.httpMethod = "GET"
    if (!token.isEmpty) {
      request.setValue(token, forHTTPHeaderField: "token")
    }
    let (tempURL, response) = try perform(request: request)
    defer { try? FileManager.default.removeItem(at: tempURL) }
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw BridgeError.message("server responded " + String((response as? HTTPURLResponse)?.statusCode ?? -1))
    }
    let headers = http.allHeaderFields
    var headerMap: [String: String] = [:]
    for (key, value) in headers {
      if let k = key as? String, let v = value as? String {
        headerMap[k.lowercased()] = v
      }
    }
    let disposition = headerMap["content-disposition"]
    let contentType = headerMap["content-type"]
    var name = resolveFilename(disposition: disposition, fallback: fallback)
    // The backend tars directories but only signals it via headers.
    if (isGzip(contentType) && !name.lowercased().hasSuffix(".tar.gz")) {
      name += ".tar.gz"
    }
    let data = try Data(contentsOf: tempURL)
    return try saveToDocuments(name: name, data: data)
  }

  private func handleSaveBase64(body: [String: Any]) throws -> [String: String] {
    let filename = sanitize(body["filename"] as? String ?? "download")
    let raw = stripDataUrl(body["base64Data"] as? String ?? "")
    guard let data = Data(base64Encoded: raw, options: .ignoreUnknownCharacters) else {
      throw BridgeError.message("invalid base64 content")
    }
    return try saveToDocuments(name: filename, data: data)
  }

  private func perform(request: URLRequest) throws -> (URL, URLResponse) {
    var resultURL: URL?
    var resultResponse: URLResponse?
    var resultError: Error?
    let semaphore = DispatchSemaphore(value: 0)
    URLSession.shared.downloadTask(with: request) { url, response, error in
      resultURL = url
      resultResponse = response
      resultError = error
      semaphore.signal()
    }.resume()
    semaphore.wait()
    if let error = resultError { throw error }
    guard let url = resultURL, let response = resultResponse else {
      throw BridgeError.message("empty response")
    }
    return (url, response)
  }

  private func saveToDocuments(name: String, data: Data) throws -> [String: String] {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    let fileURL = uniqueFile(in: docs, name: name)
    try data.write(to: fileURL, options: .atomic)
    return ["name": fileURL.lastPathComponent, "location": fileURL.path]
  }

  private func uniqueFile(in dir: URL, name: String) -> URL {
    let candidate = dir.appendingPathComponent(name)
    if (!FileManager.default.fileExists(atPath: candidate.path)) { return candidate }
    let ext = (name as NSString).pathExtension
    let base = (name as NSString).deletingPathExtension
    for i in 1..<1000 {
      let next = ext.isEmpty ? base + " (" + String(i) + ")" : base + " (" + String(i) + ")." + ext
      let url = dir.appendingPathComponent(next)
      if (!FileManager.default.fileExists(atPath: url.path)) { return url }
    }
    return candidate
  }

  private func report(callbackId: String, ok: Bool, data: [String: String]?, error: String?) {
    var dataJson: String? = nil
    if let data = data,
       let jsonData = try? JSONSerialization.data(withJSONObject: data),
       let json = String(data: jsonData, encoding: .utf8) {
      dataJson = json
    }
    let script = "window.__etNativeSaveResult("
      + jsQuote(callbackId) + ","
      + (ok ? "true" : "false") + ","
      + (dataJson == nil ? "null" : jsQuote(dataJson!)) + ","
      + (error == nil ? "null" : jsQuote(error!))
      + ");"
    DispatchQueue.main.async { [weak self] in
      // WebView gone (view dismissed) - nothing to report to.
      _ = self?.webView
      self?.webView?.evaluateJavaScript(script, completionHandler: nil)
    }
  }

  private func jsQuote(_ value: String) -> String {
    if let data = try? JSONEncoder().encode(value),
       let quoted = String(data: data, encoding: .utf8) {
      return quoted
    }
    return "\\"" + value.replacingOccurrences(of: "\\\\", with: "\\\\\\\\").replacingOccurrences(of: "\\"", with: "\\\\\\"") + "\\""
  }

  // MARK: - filename helpers (mirror the Android bridge)

  private func resolveFilename(disposition: String?, fallback: String) -> String {
    var name: String? = nil
    if let disposition = disposition {
      if let range = disposition.range(of: "filename\\\\*\\\\s*=\\\\s*UTF-8''([^;]+)", options: [.regularExpression, .caseInsensitive]) {
        var raw = String(disposition[range])
        if let eq = raw.range(of: "''") { raw = String(raw[eq.upperBound...]) }
        name = raw.replacingOccurrences(of: "\\"", with: "").trimmingCharacters(in: .whitespaces).removingPercentEncoding ?? raw
      }
      if (name == nil || name!.isEmpty) {
        // RFC 6266: the plain form is a literal, already-decoded name.
        if let match = disposition.range(of: "filename\\\\s*=\\\\s*\\"([^\\"]+)\\"", options: [.regularExpression, .caseInsensitive]) {
          let raw = String(disposition[match])
          if let q1 = raw.firstIndex(of: "\\""), let q2 = raw.lastIndex(of: "\\""), q1 != q2 {
            name = String(raw[raw.index(after: q1)..<q2])
          }
        } else if let match = disposition.range(of: "filename\\\\s*=\\\\s*([^;]+)", options: [.regularExpression, .caseInsensitive]) {
          var raw = String(disposition[match])
          if let eq = raw.firstIndex(of: "=") { raw = String(raw[raw.index(after: eq)...]) }
          name = raw.trimmingCharacters(in: .whitespaces)
        }
      }
    }
    if (name == nil || name!.isEmpty) { name = fallback }
    return sanitize(name)
  }

  private func sanitize(_ name: String?) -> String {
    guard var clean = name, !clean.isEmpty else { return "download" }
    clean = clean.replacingOccurrences(of: "\\\\", with: "/")
    if let slash = clean.lastIndex(of: "/") { clean = String(clean[clean.index(after: slash)...]) }
    let invalid = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "*?<>|:\\u{22}"))
    clean = clean.components(separatedBy: invalid).joined(separator: "_").trimmingCharacters(in: .whitespaces)
    if (clean.isEmpty || clean == "." || clean == "..") { return "download" }
    return clean
  }

  private func isGzip(_ contentType: String?) -> Bool {
    return contentType?.lowercased().contains("gzip") ?? false
  }

  private func stripDataUrl(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if let comma = trimmed.firstIndex(of: ",") {
      let prefix = String(trimmed[..<comma]).lowercased()
      if (prefix.contains("base64")) {
        return String(trimmed[trimmed.index(after: comma)...]).components(separatedBy: .whitespacesAndNewlines).joined()
      }
    }
    return trimmed.components(separatedBy: .whitespacesAndNewlines).joined()
  }

  private enum BridgeError: LocalizedError {
    case message(String)
    var errorDescription: String? {
      switch self {
      case .message(let text): return text
      }
    }
  }
}
`

function applyResOverlay () {
  const plistPath = path.resolve(__dirname, 'ios', 'App', 'App', 'Info.plist')
  if (!fs.existsSync(plistPath)) {
    console.log('[ios] native project not found, skipping overlay (run cap add ios + cap sync first)')
    return
  }

  // ── ATS exception for localhost ──────────────────────────────────────
  console.log('[ios] patching Info.plist ATS exception for localhost…')
  let plist = fs.readFileSync(plistPath, 'utf8')

  if (!plist.includes('NSAppTransportSecurity')) {
    // Insert NSAppTransportSecurity dict before the closing </dict> of the root.
    // This allows the WebView to load http://127.0.0.1:5577 (the Node.js backend)
    // and also permits NSAllowsLocalNetworking for broader localhost coverage.
    const atsXml = `  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
    <key>NSExceptionDomains</key>
    <dict>
      <key>127.0.0.1</key>
      <dict>
        <key>NSExceptionAllowsInsecureHTTPLoads</key>
        <true/>
        <key>NSIncludesSubdomains</key>
        <false/>
      </dict>
    </dict>
  </dict>
`
    plist = plist.replace('</dict>\n</plist>', atsXml + '</dict>\n</plist>')
    fs.writeFileSync(plistPath, plist)
    console.log('[ios] wrote ATS exception to', plistPath)
  } else {
    console.log('[ios] NSAppTransportSecurity already present, skipping ATS patch')
  }

  // ── Local Network privacy (iOS 14+) ─────────────────────────────────
  // Without NSLocalNetworkUsageDescription iOS never shows the Local
  // Network permission prompt and silently drops connections to LAN
  // hosts (192.168.x, 10.x, .local…) — the SSH layer then reports
  // EHOSTUNREACH / "no route to host". The simulator does not enforce
  // this, so it only reproduces on real devices. electerm connects to
  // arbitrary user-configured hosts, so we must declare the usage.
  // NSBonjourServices is required iff the app browses Bonjour; listed
  // for the protocols electerm supports over .local hostnames.
  if (!plist.includes('NSLocalNetworkUsageDescription')) {
    console.log('[ios] patching Info.plist NSLocalNetworkUsageDescription…')
    const localNetXml = `  <key>NSLocalNetworkUsageDescription</key>
  <string>electerm needs local network access to connect to SSH/SFTP/telnet/RDP/VNC/Spice/FTP hosts on your network.</string>
  <key>NSBonjourServices</key>
  <array>
    <string>_ssh._tcp</string>
    <string>_sftp-ssh._tcp</string>
    <string>_telnet._tcp</string>
    <string>_ftp._tcp</string>
    <string>_rfb._tcp</string>
    <string>_rdp._tcp</string>
  </array>
`
    plist = plist.replace('</dict>\n</plist>', localNetXml + '</dict>\n</plist>')
    fs.writeFileSync(plistPath, plist)
    console.log('[ios] wrote local network keys to', plistPath)
  } else {
    console.log('[ios] NSLocalNetworkUsageDescription already present, skipping')
  }

  // ── Expose Documents in the Files app ──────────────────────────────
  // The native save bridge (ElectermSaveBridge.swift) writes downloads to
  // the app's Documents directory, but iOS hides that folder from the Files
  // app unless both keys below are set — without them a download succeeds
  // (toast + file on disk) yet is nowhere to be found. With them the files
  // appear under Files > On My iPhone > electerm.
  if (!plist.includes('UIFileSharingEnabled')) {
    console.log('[ios] patching Info.plist Files app visibility…')
    const filesXml = `  <key>UIFileSharingEnabled</key>
  <true/>
  <key>LSSupportsOpeningDocumentsInPlace</key>
  <true/>
`
    plist = plist.replace('</dict>\n</plist>', filesXml + '</dict>\n</plist>')
    fs.writeFileSync(plistPath, plist)
    console.log('[ios] wrote Files app keys to', plistPath)
  } else {
    console.log('[ios] UIFileSharingEnabled already present, skipping')
  }

  // ── Set MARKETING_VERSION from package.json ──────────────────────────
  // The Xcode project's MARKETING_VERSION defaults to 1.0. We overwrite it
  // with the version from package.json so App Store Connect shows the
  // correct version (e.g. 5.0.7 instead of 1.0).
  const pbxprojPath = path.resolve(__dirname, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj')
  if (fs.existsSync(pbxprojPath)) {
    console.log('[ios] setting MARKETING_VERSION to', VERSION)
    let pbxproj = fs.readFileSync(pbxprojPath, 'utf8')
    pbxproj = pbxproj.replace(
      /MARKETING_VERSION = [^;]*;/g,
      `MARKETING_VERSION = ${VERSION};`
    )
    fs.writeFileSync(pbxprojPath, pbxproj)
    console.log('[ios] updated MARKETING_VERSION in', pbxprojPath)
  }

  // ── Copy app icon from electerm-resource ─────────────────────────────
  // The Xcode project's AppIcon.appiconset uses a generic Capacitor icon.
  // We overwrite it with the pre-built electerm icon from
  // node_modules/@electerm/electerm-resource/build-res/ios/AppIcon-1024x1024.png
  // (a 1024×1024 RGB PNG, generated by build_images.py in the electerm-resource
  // repo). This is the single-size iOS AppIcon entry (Contents.json references
  // it as "AppIcon-512@2x.png" at size 1024×1024).
  const appIconDir = path.resolve(__dirname, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset')
  const iconSource = path.resolve(ROOT, 'node_modules', '@electerm', 'electerm-resource', 'build-res', 'ios', 'AppIcon-1024x1024.png')
  if (fs.existsSync(appIconDir) && fs.existsSync(iconSource)) {
    const iconDest = path.resolve(appIconDir, 'AppIcon-512@2x.png')
    fs.copyFileSync(iconSource, iconDest)
    console.log('[ios] copied app icon from', iconSource, '→', iconDest)
  } else {
    console.log('[ios] app icon source or destination not found, skipping icon copy')
  }

  // ── Safe-area container for the web view ─────────────────────────────
  // Adds SafeAreaContainerViewController.swift to the app target and makes
  // it the storyboard's initial VC (instead of CAPBridgeViewController).
  // The app's web UI is laid out for the full screen and its fixed header
  // ends up under the status bar / Dynamic Island; embedding the bridge
  // inside a safe-area-constrained container fixes this natively, with no
  // web-layer changes.
  const swiftPath = path.resolve(__dirname, 'ios', 'App', 'App', 'SafeAreaContainerViewController.swift')
  if (!fs.existsSync(swiftPath)) {
    fs.writeFileSync(swiftPath, safeAreaContainerSwift)
    console.log('[ios] wrote SafeAreaContainerViewController.swift')
  } else {
    fs.writeFileSync(swiftPath, safeAreaContainerSwift)
    console.log('[ios] refreshed SafeAreaContainerViewController.swift')
  }
  const storyboardPath = path.resolve(__dirname, 'ios', 'App', 'App', 'Base.lproj', 'Main.storyboard')
  if (fs.existsSync(storyboardPath)) {
    let storyboard = fs.readFileSync(storyboardPath, 'utf8')
    // The template tag is customClass="CAPBridgeViewController" customModule="Capacitor".
    // Replace the class AND flip the module (our VC lives in the app target),
    // handling both orderings and the module being present or absent.
    const capRe = /customClass="CAPBridgeViewController"(?:\s+customModule="[^"]*")?/
    if (capRe.test(storyboard)) {
      storyboard = storyboard.replace(
        capRe,
        'customClass="SafeAreaContainerViewController" customModule="App"'
      )
      fs.writeFileSync(storyboardPath, storyboard)
      console.log('[ios] storyboard initial VC -> SafeAreaContainerViewController')
    } else if (storyboard.includes('customClass="SafeAreaContainerViewController"')) {
      // self-heal: strip any stray duplicate customModule left by an older
      // patch run (e.g. customModule="App" customModule="Capacitor")
      const healed = storyboard.replace(
        /(customClass="SafeAreaContainerViewController" customModule="App")(\s+customModule="[^"]*")?/,
        '$1'
      )
      if (healed !== storyboard) {
        fs.writeFileSync(storyboardPath, healed)
        console.log('[ios] healed duplicate customModule in storyboard')
      } else {
        console.log('[ios] storyboard already uses SafeAreaContainerViewController')
      }
    } else {
      console.warn('[ios] WARNING: could not find CAPBridgeViewController in Main.storyboard — safe-area patch skipped')
    }
  }

  // ── Native save bridge (WKWebView -> Documents) ──────────────────────
  // Writes ElectermSaveBridge.swift into the app target. The UI page is
  // served by the on-device Node backend (http://127.0.0.1:5577), outside
  // Capacitor's own origin, so Capacitor never injects its plugin runtime
  // there and the browser download path cannot work. The bridge exposes
  // window.ElectermNative (same protocol as Android's ElectermSaveBridge)
  // so downloads land in Documents (visible in the Files app). See
  // build/replace/src/client/web-components/native-file-save.js.
  const saveBridgePath = path.resolve(__dirname, 'ios', 'App', 'App', 'ElectermSaveBridge.swift')
  fs.writeFileSync(saveBridgePath, electermSaveBridgeSwift)
  console.log('[ios] refreshed ElectermSaveBridge.swift')

  // ── Window chrome bridge (theme -> status bar / home indicator) ───────
  // Writes ElectermWindowChrome.swift into the app target. The status-bar and
  // home-indicator bands live outside the WebView (the container keeps it
  // inside the safe area), so the page has to hand their colours over. Losing
  // this file builds fine and silently gives the app system-white strips
  // around a dark theme. See
  // build/replace/src/client/web-components/window-chrome.js.
  const chromeBridgePath = path.resolve(__dirname, 'ios', 'App', 'App', 'ElectermWindowChrome.swift')
  fs.writeFileSync(chromeBridgePath, electermWindowChromeSwift)
  console.log('[ios] refreshed ElectermWindowChrome.swift')

  // ── Launch screen background ──────────────────────────────────────────
  // Capacitor's template paints the launch screen with
  // systemBackgroundColor, which is white in light mode: the first thing a
  // cold launch shows is a white flash, then the dark loading page. Paint it
  // with electerm's dark background instead (same idea as Android's
  // windowSplashScreenBackground). The splash image still sits on top; this
  // only fixes the letterboxed areas and the instant before it decodes.
  const launchPath = path.resolve(__dirname, 'ios', 'App', 'App', 'Base.lproj', 'LaunchScreen.storyboard')
  if (fs.existsSync(launchPath)) {
    const launch = fs.readFileSync(launchPath, 'utf8')
    const darkColor = '<color key="backgroundColor" red="0.08235294117647059" green="0.09019607843137255" blue="0.10196078431372549" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>'
    const patched = launch.replace(
      /<color key="backgroundColor" systemColor="systemBackgroundColor"\/>/g,
      darkColor
    )
    if (patched !== launch) {
      fs.writeFileSync(launchPath, patched)
      console.log('[ios] patched LaunchScreen background to electerm dark')
    } else if (launch.includes(darkColor)) {
      console.log('[ios] LaunchScreen background already dark')
    } else {
      console.warn('[ios] WARNING: could not find the LaunchScreen background colour — patch skipped')
    }
  }

  // ── Register SafeAreaContainerViewController.swift in the Xcode project ──
  // The project uses explicit file lists (not synchronized folders), so the
  // new Swift file must be added in 4 places in project.pbxproj: as a build
  // file, a file reference, a group child, and in the Sources build phase.
  // IDs are 24-hex-char strings; these are chosen to be unique in this file.
  function ensureSwiftFileRegistered (fileName, buildFileId, fileRefId) {
    let pbxproj = fs.readFileSync(pbxprojPath, 'utf8')
    if (pbxproj.includes(fileName)) {
      console.log(`[ios] ${fileName} already registered`)
      return
    }
    pbxproj = pbxproj.replace(
      '/* Begin PBXBuildFile section */\n',
      `/* Begin PBXBuildFile section */\n\t\t${buildFileId} /* ${fileName} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRefId} /* ${fileName} */; };\n`
    )
    pbxproj = pbxproj.replace(
      '/* Begin PBXFileReference section */\n',
      `/* Begin PBXFileReference section */\n\t\t${fileRefId} /* ${fileName} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${fileName}; sourceTree = "<group>"; };\n`
    )
    pbxproj = pbxproj.replace(
      /\t\t\t\t504EC3071FED79650016851F \/\* AppDelegate\.swift \*\/,\n/,
      '\t\t\t\t504EC3071FED79650016851F /* AppDelegate.swift */,\n\t\t\t\t' + fileRefId + ` /* ${fileName} */,\n`
    )
    pbxproj = pbxproj.replace(
      /\t\t\t\t504EC3081FED79650016851F \/\* AppDelegate\.swift in Sources \*\/,\n/,
      '\t\t\t\t504EC3081FED79650016851F /* AppDelegate.swift in Sources */,\n\t\t\t\t' + buildFileId + ` /* ${fileName} in Sources */,\n`
    )
    fs.writeFileSync(pbxprojPath, pbxproj)
    console.log(`[ios] registered ${fileName} in Xcode project`)
  }
  if (fs.existsSync(pbxprojPath)) {
    ensureSwiftFileRegistered('SafeAreaContainerViewController.swift', '5A1E000000000001000000A1', '5A1E000000000002000000A2')
    ensureSwiftFileRegistered('ElectermSaveBridge.swift', '5A1E000000000003000000A3', '5A1E000000000004000000A4')
    ensureSwiftFileRegistered('ElectermWindowChrome.swift', '5A1E000000000005000000A5', '5A1E000000000006000000A6')
  }
}

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
async function main () {
  // --overlay-only: just re-apply the res-overlay after `cap sync` without
  // rebuilding the entire www bundle. Used by the `sync` npm script.
  if (process.argv.includes('--overlay-only')) {
    applyResOverlay()
    return
  }

  fs.rmSync(WWW, { recursive: true, force: true })
  fs.mkdirSync(NODEJS_DIR, { recursive: true })

  // Apply iOS-specific src overrides (build/replace/src -> src/) BEFORE vite/esbuild
  // so the bundle sees the patched sources. Idempotent; also called by the npm
  // install lifecycle (build/bin/install.js) so CI and local builds stay identical.
  applySrcOverrides()

  await runVite()
  copyFrontendAssets()
  // Static homepage. Must run after runVite(), which recreates dist/assets.
  const index = await generateIndexHtml({
    outDir: path.resolve(NODEJS_DIR, 'dist', 'assets'),
    secret: SERVER_SECRET,
    user: process.env.SERVER_USER,
    packInfo: NODE_PKG
  })
  console.log(
    `[ios] homepage: ${path.relative(ROOT, index.outPath)} (${index.bytes} bytes)`
  )
  writeLoadingPage()

  const shimPath = genSqliteStub()
  await bundleBackend(shimPath)
  writeNodeEntry()
  copyEnv()

  // Patch Info.plist with ATS exception (no-op if native project doesn't exist yet).
  // The `sync` and `ios` npm scripts re-run `node build.mjs --overlay-only`
  // after `cap sync` to re-apply the ATS patch that cap sync resets.
  applyResOverlay()

  console.log('[ios] web + node project ready at', WWW)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
