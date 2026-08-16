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
}

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// 4a. src overrides (build/replace -> src)
// --------------------------------------------------------------------------
// src/ is downloaded from electerm-android at install time (build/bin/install.js)
// and is git-ignored — it must never be edited directly. iOS-specific backend
// overrides live in build/replace/ mirroring the src/ tree; this step copies
// them over src/ before bundling, so the bundle sees the patched sources while
// the repo keeps a clean, reviewable set of overrides.
function applySrcOverrides () {
  const replaceSrc = path.resolve(__dirname, '..', 'replace', 'src')
  if (!fs.existsSync(replaceSrc)) {
    return
  }
  const srcRoot = path.resolve(ROOT, 'src')
  fs.cpSync(replaceSrc, srcRoot, {
    recursive: true,
    // never copy the replace tree's own metadata files
    filter: (src) => !src.endsWith('.DS_Store')
  })
  console.log('[ios] applied src overrides from', path.dirname(replaceSrc))
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
