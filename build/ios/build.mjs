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
 *   2. copy static assets (icons, images, views) into the node project
 *   3. esbuild bundle the backend -> www/nodejs/app.bundle.mjs. Native modules
 *      that are not built for iOS yet (node-pty, serialport, node-bash,
 *      font-list) are kept *external*: the source loads them via guarded
 *      `import()` calls that fall back gracefully, so a missing module never
 *      prevents the server from starting. Logging uses a built-in dependency-free
 *      logger (no `electron-log`). The on-device runtime is jitless Node 18
 *      (no WebAssembly), so the db layer uses the pure-JS nedb backend and
 *      `node:sqlite` is aliased to a throwing stub.
 */
import { build as viteBuild } from 'vite'
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { applySrcOverrides } from '../bin/apply-src-overrides.mjs'

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

// --------------------------------------------------------------------------
// 1. Frontend
// --------------------------------------------------------------------------
async function runVite () {
  console.log('[ios] building frontend (vite)…')
  await viteBuild({
    configFile: path.resolve(__dirname, 'vite.ios.mjs'),
    root: ROOT,
    logLevel: 'warn'
  })
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

  fs.mkdirSync(path.resolve(NODEJS_DIR, 'views'), { recursive: true })
  fs.copyFileSync(
    path.resolve(ROOT, 'src/app/views/index.pug'),
    path.resolve(NODEJS_DIR, 'views/index.pug')
  )
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
    var PORT = 5577;
    var BASE = 'http://127.0.0.1:' + PORT + '/';
    var Http = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    var done = false;
    function go (src) {
      if (done) return;
      done = true;
      location.replace(BASE);
    }
    function tryLoad () {
      if (Http) {
        Http.get({ url: BASE })
          .then(function (r) {
            if (r && r.status >= 200 && r.status < 500) go('capacitorhttp');
            else setTimeout(tryLoad, 700);
          })
          .catch(function () {
            document.getElementById('msg').textContent = 'Waiting for engine…';
            setTimeout(tryLoad, 700);
          });
      } else {
        fetch(BASE, { mode: 'no-cors' })
          .then(function () { go('fetch'); })
          .catch(function () {
            document.getElementById('msg').textContent = 'Waiting for engine…';
            setTimeout(tryLoad, 700);
          });
      }
    }
    tryLoad();
    // Fallback: probes blocked on this device -> after the engine has had time
    // to come up (~1-2s), navigate directly (works because navigation is exempt).
    setTimeout(function () { go('timeout'); }, 4000);
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
      'font-list'
    ],
    // Some bundled CJS deps (e.g. sql.js's initSqlJs) reference __dirname /
    // __filename, which don't exist in an ESM bundle. Define them from
    // import.meta.url. NOTE: do NOT `import { dirname } from "path"` here —
    // the bundle already imports `dirname` at top level, which would collide
    // ("Identifier 'dirname' has already been declared"). Alias fileURLToPath
    // to a private name for the same reason, and derive __dirname from a
    // directory URL.
    banner: {
      js: "import { createRequire } from 'module'; import { fileURLToPath as __etu } from 'url'; const require = createRequire(import.meta.url); const __filename = __etu(import.meta.url); const __dirname = __etu(new URL('.', import.meta.url));"
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
// Tell the server where the pug views live (cwd is now the node project dir,
// set above via process.chdir(__d)).
process.env.VIEW_FOLDER = resolve(__d, 'views')

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
      { name: 'electerm-node', version: VERSION, main: 'index.js', type: 'module' },
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
const safeAreaContainerSwift = `import UIKit
import Capacitor
import WebKit

/// Container that keeps the Capacitor web view below the status bar /
/// Dynamic Island and above the home indicator, without requiring the
/// web content itself to be safe-area aware.
class SafeAreaContainerViewController: UIViewController {
  private let bridge = CAPBridgeViewController()

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
    installSaveBridge()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    // Re-attach: idempotent, and guarantees the bridge is present even if
    // the WebView was recreated while we were backgrounded.
    installSaveBridge()
  }

  /// Attach the native save bridge to Capacitor's WKWebView. The UI page is
  /// served by the on-device Node backend (http://127.0.0.1:5577), outside
  /// Capacitor's own origin, so Capacitor never injects its plugin runtime
  /// there and the browser download path cannot work. See ElectermSaveBridge.
  private func installSaveBridge() {
    view.layoutIfNeeded()
    guard let webView = findWebView(in: bridge.view) else { return }
    ElectermSaveBridge.install(on: webView)
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
