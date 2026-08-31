import fs from 'node:fs'
import path from 'node:path'

/**
 * Copy build/replace/src over src/ so the iOS build picks up the patched
 * sources. Idempotent: safe to call from every build entry point.
 *
 * Called BOTH from the npm install lifecycle (build/bin/install.js) AND from
 * build/ios/build.mjs (before runVite), so CI and local builds stay identical.
 * The 5.3.16 launch crash came from the override only happening at install time
 * — local builds (which don't run npm i) silently bundled unpatched sources.
 * Calling it here too removes that dependency on install order.
 *
 * @param {string} [root] repo root (defaults to process.cwd())
 * @returns {number} number of override files copied
 */
export function applySrcOverrides (root = process.cwd()) {
  const replaceSrc = path.resolve(root, 'build/replace/src')
  if (!fs.existsSync(replaceSrc)) {
    return 0
  }
  const srcRoot = path.resolve(root, 'src')

  let count = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.endsWith('.DS_Store')) continue
      const full = path.resolve(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        count++
      }
    }
  }
  walk(replaceSrc)

  fs.cpSync(replaceSrc, srcRoot, {
    recursive: true,
    // never copy the replace tree's own metadata files
    filter: (src) => !src.endsWith('.DS_Store')
  })
  return count
}
