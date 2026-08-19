/**
 * db loader
 *
 * Tries the sql.js-backed `node:sqlite` shim first (used on desktop / any
 * runtime with WebAssembly). On the iOS on-device runtime (nodejs-mobile,
 * jitless) `WebAssembly` is not defined: the sqlite shim's module init
 * throws and the promise rejects — fall back to the pure-JS nedb wrapper,
 * which needs no WASM and persists to DB_PATH.
 *
 * This file lives in build/replace/ and is copied over src/ at iOS build
 * time (src/ is downloaded from electerm-android and must not be edited).
 */

let dbModule = null

async function getDbModule () {
  if (!dbModule) {
    if (process.env.DISABLE_SQLITE) {
      // jitless runtime (iOS): no WebAssembly -> sql.js cannot load
      dbModule = await import('./nedb.js')
    } else {
      dbModule = await import('./sqlite.js').catch((e) => {
        console.warn('[db] sqlite backend unavailable, falling back to nedb:', e?.message || e)
        return import('./nedb.js')
      })
    }
  }
  return dbModule
}

export async function dbAction (...args) {
  const db = await getDbModule()
  // sqlite.js exports a named `dbAction`; nedb.js's default export IS the
  // function (the module also exposes it on `inst`).
  const fn = db.dbAction || (typeof db.default === 'function' ? db.default : db.default?.dbAction)
  return fn(...args)
}
