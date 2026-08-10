/**
 * install.js
 *
 * Runs automatically on `npm install` (npm "install" lifecycle script).
 *
 * electerm-ios reuses 100 % of the source code from electerm-android.
 * Instead of keeping a duplicate copy in this repo, we download the latest
 * source archive from https://github.com/electerm/electerm-android and copy
 * its `src/` directory into ours.  This repo only keeps its own package.json,
 * build scripts and iOS-specific build configuration.
 *
 * After the source sync we also copy the @electerm/electerm-react client
 * from node_modules (same as the original install step).
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import pkg from 'shelljs'
import { x as tarX } from 'tar'

const { echo, rm: shellRm, cp } = pkg

const REPO = 'electerm/electerm-android'
const BRANCH = 'main'
const URL = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`
const TMP = resolve('temp/electerm-android-src')
const TMP_FILE = resolve(TMP, 'electerm-android.tar.gz')

echo('install required modules')

// ---------------------------------------------------------------------------
// 1. Download the latest electerm-android source archive
// ---------------------------------------------------------------------------
echo(`downloading latest ${REPO} (${BRANCH} branch)…`)

shellRm('-rf', TMP)
await mkdir(TMP, { recursive: true })

let downloaded = false
try {
  const res = await fetch(URL)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(TMP_FILE, buf)
  echo('download complete')
  downloaded = true
} catch (e) {
  echo(`WARNING: failed to download source — ${e.message}`)
  if (existsSync('src')) {
    echo('keeping existing src/ folder')
  } else {
    echo('ERROR: src/ does not exist and download failed — cannot continue')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// 2. Extract archive and replace src/
// ---------------------------------------------------------------------------
if (downloaded) {
  echo('extracting…')
  await tarX({
    file: TMP_FILE,
    cwd: TMP,
    strip: 1 // remove the top-level "electerm-android-main/" directory
  })

  echo('syncing src/ from electerm-android…')
  shellRm('-rf', 'src')
  cp('-r', resolve(TMP, 'src'), resolve('src'))
}

// ---------------------------------------------------------------------------
// 3. Copy @electerm/electerm-react client from node_modules
// ---------------------------------------------------------------------------
echo('installing electerm-react module')
shellRm('-rf', 'src/client/electerm-react')
cp('-r', 'node_modules/@electerm/electerm-react/client', 'src/client/electerm-react')

// ---------------------------------------------------------------------------
// 4. Cleanup temp files
// ---------------------------------------------------------------------------
shellRm('-rf', TMP)

echo('done install required modules')
