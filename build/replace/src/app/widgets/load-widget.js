// load-widget.js (iOS override)
//
// Upstream electron/desktop statically imports all widget modules at the top of
// this file. src/app/lib/run-sync.js imports load-widget.js on the app's
// STARTUP path, so static imports force the entire widget dependency graph
// (express + the MCP SDK + zod + @electerm/ftp-srv) to be evaluated at app
// LAUNCH. On the jitless, RAM-limited iOS device runtime that initialization
// blows the launch budget and the app is killed before it can show the UI — the
// simulator (JIT, abundant RAM) survives it. The App Store review rejection
// "crashed after initial launch" is exactly this.
//
// So the only platform delta left in this file is how a BUILT-IN module is
// resolved: a fixed id → loader map with deferred import() instead of upstream's
// fs.readdirSync scan of this folder. Everything else is upstream's behaviour —
// user widgets under <data dir>/widgets/<id>/ included, they are loaded from
// disk at runtime and never touch the startup path.
//
// Keep the export list in sync with src/app/widgets/load-widget.js: run-sync.js
// imports this API BY NAME, and a missing export is a link-time failure at
// launch ("does not provide an export named ..."), not a soft error. That is
// what happened when upstream added callWidgetFunc/importWidget/deleteWidget.
//
// Not registered here: widget-ssh-server. It imports node-pty, which is not in
// this package's dependencies (no native build for the iOS runtime).

import * as widgetLog from './instance-log.js'
import {
  listUserWidgets,
  resolveUserWidgetEntry,
  isUserWidget,
  importWidget as importUserWidget,
  removeUserWidget,
  importUserWidgetModule,
  getUserWidgetDir
} from './user-widget.js'
import { isValidWidgetId } from './paths.js'

const widgetLoaders = {
  'batch-op': () => import('./widget-batch-op.js'),
  'local-file-server': () => import('./widget-local-file-server.js'),
  'local-ftp-server': () => import('./widget-local-ftp-server.js'),
  'mcp-server': () => import('./widget-mcp-server.js'),
  rename: () => import('./widget-rename.js')
}

// Store running widget instances
const runningInstances = new Map()

// One entry per built-in, in the shape the widget panel reads: `builtin` so it
// is not offered a delete action, `state` because a list mixing built-ins and
// user widgets is keyed on it.
async function listBuiltinWidgets () {
  const entries = await Promise.all(
    Object.entries(widgetLoaders).map(async ([id, load]) => {
      try {
        const mod = await load()
        if (!mod.widgetInfo) {
          console.error(`Skipping widget-${id}.js: no widgetInfo export`)
          return null
        }
        return {
          id,
          builtin: true,
          state: 'ok',
          info: {
            ...mod.widgetInfo,
            builtin: true
          }
        }
      } catch (error) {
        console.error(`Error loading widget ${id}:`, error)
        return null
      }
    })
  )
  return entries.filter(Boolean)
}

/**
 * Built-ins ship with the app; user widgets live in <data dir>/widgets/<id>/.
 *
 * One namespace, no shadowing: a user folder that reuses a built-in id is
 * ignored, and the built-in carries a warning the list can show. Silently
 * letting a user widget replace mcp-server would break features that have
 * nothing to do with the widget panel.
 */
async function listWidgets () {
  const widgets = await listBuiltinWidgets()
  const builtinIds = new Set(widgets.map(w => w.id))
  const userWidgets = listUserWidgets()
  for (const widget of userWidgets) {
    if (builtinIds.has(widget.id)) {
      const builtin = widgets.find(w => w.id === widget.id)
      builtin.warning = `User widget "${widget.id}" in ${getUserWidgetDir()} is ignored: the id belongs to a built-in widget`
      continue
    }
    widgets.push(widget)
  }
  return widgets
}

// Where the entry of one widget lives, whichever root it came from. A built-in
// has no entry path here (its module comes out of the bundle through
// widgetLoaders), so `entry` stays null for those — check `builtin` first.
function resolveWidgetModule (widgetId) {
  if (!isValidWidgetId(widgetId)) {
    throw new Error(`Invalid widget ID: ${widgetId}`)
  }
  if (widgetLoaders[widgetId]) {
    return { entry: null, builtin: true }
  }
  if (isUserWidget(widgetId)) {
    return { entry: resolveUserWidgetEntry(widgetId), builtin: false }
  }
  throw new Error(`Widget not found: ${widgetId}`)
}

// Load a widget's main module, whichever root it came from. A user widget keeps
// one module instance per folder (its own exports share state); see
// user-widget.js importUserWidgetModule.
function loadWidgetModule (widgetId) {
  const { entry, builtin } = resolveWidgetModule(widgetId)
  return builtin
    ? widgetLoaders[widgetId]()
    : importUserWidgetModule(entry)
}

// Metadata for one widget: the manifest for a user widget (the package.json is
// the source of truth), the widgetInfo export for a built-in.
async function getWidgetInfo (widgetId) {
  const { builtin } = resolveWidgetModule(widgetId)
  if (builtin) {
    const widgetModule = await loadWidgetModule(widgetId)
    if (!widgetModule.widgetInfo) {
      throw new Error(`Widget ${widgetId} has no widgetInfo export`)
    }
    return widgetModule.widgetInfo
  }
  const entryInfo = listUserWidgets().find(w => w.id === widgetId)
  if (!entryInfo || entryInfo.state !== 'ok') {
    throw new Error(entryInfo && entryInfo.error
      ? `Widget ${widgetId} is not usable: ${entryInfo.error}`
      : `Widget ${widgetId} not found`)
  }
  return entryInfo.info
}

function hasRunningInstance (widgetId) {
  for (const [, instance] of runningInstances) {
    if (instance.widgetId === widgetId) {
      return true
    }
  }
  return false
}

async function runWidget (widgetId, config) {
  const widget = await loadWidgetModule(widgetId)
  const info = await getWidgetInfo(widgetId)
  const { type, singleInstance } = info

  if (type !== 'instance') {
    // A UI-only widget (frontend) has nothing to start: the panel is its
    // renderer. No widgetRun is not an error there.
    if (typeof widget.widgetRun !== 'function') {
      return { success: true }
    }
    return widget.widgetRun(config)
  }

  if (typeof widget.widgetRun !== 'function') {
    throw new Error(`Widget ${widgetId} has no widgetRun export`)
  }

  // Check if singleInstance widget already has a running instance
  if (singleInstance && hasRunningInstance(widgetId)) {
    return Promise.reject(new Error(`Widget ${widgetId} already has a running instance. Only one instance is allowed.`))
  }

  // The widget reports through this context; it is handed the instance log
  // before it knows its own instanceId (see instance-log.js createContext).
  const ctx = widgetLog.createContext()
  const instance = widget.widgetRun(config, ctx)
  instance.widgetId = widgetId
  runningInstances.set(instance.instanceId, instance)
  ctx.bind(instance.instanceId)

  const logger = widgetLog.loggerFor(instance.instanceId)
  logger.log('info', `Starting ${info.name} (${widgetId})`)

  return instance.start()
    .then((result) => {
      logger.log('info', result && result.msg ? result.msg : 'Started')
      return {
        instanceId: instance.instanceId,
        widgetId,
        singleInstance: !!singleInstance,
        ...result
      }
    })
    .catch((err) => {
      // kept in the log file on purpose: this is what the user opens the panel
      // to read when the widget refuses to start
      logger.log('error', `Failed to start: ${err && err.message ? err.message : err}`)
      runningInstances.delete(instance.instanceId)
      return instance.stop().catch(() => {}).then(() => { throw err })
    })
}

function stopWidget (instanceId) {
  const instance = runningInstances.get(instanceId)
  if (!instance) {
    console.error(`No running instance found for instanceId: ${instanceId}`)
    return
  }

  const logger = widgetLog.loggerFor(instanceId)
  logger.log('info', 'Stopping...')

  return instance.stop()
    .then(() => {
      logger.log('info', 'Stopped')
      runningInstances.delete(instanceId)
      return { instanceId, status: 'stopped' }
    })
    .catch((err) => {
      logger.log('error', `Failed to stop: ${err && err.message ? err.message : err}`)
      throw err
    })
}

async function runWidgetFunc (instanceId, funcName, ...args) {
  const instance = runningInstances.get(instanceId)
  if (!instance) {
    throw new Error(`No running instance found for instanceId: ${instanceId}`)
  }

  if (typeof instance[funcName] !== 'function') {
    throw new Error(`Function ${funcName} not found in widget instance`)
  }

  try {
    const result = await instance[funcName](...args)
    return result
  } catch (error) {
    console.error(`Error executing ${funcName} on widget instance ${instanceId}:`, error)
    widgetLog.loggerFor(instanceId).log('error', `${funcName} failed: ${error.message}`)
    throw error
  }
}

/**
 * Call an exported function on a widget's main-process module.
 *
 * This is what a custom widget UI talks to: for `frontend` widgets there is no
 * instance to call methods on (runWidgetFunc needs one), and the panel is an
 * iframe the module never gets a handle to. Only own properties are reachable,
 * the same rule the runSync bridge itself follows.
 */
async function callWidgetFunc (widgetId, funcName, ...args) {
  const widget = await loadWidgetModule(widgetId)
  if (
    typeof funcName !== 'string' ||
    !Object.prototype.hasOwnProperty.call(widget, funcName) ||
    typeof widget[funcName] !== 'function'
  ) {
    throw new Error(`Widget ${widgetId} does not export the function ${funcName}`)
  }
  return widget[funcName](...args)
}

// Install: copy a whole widget folder into <data dir>/widgets/<id>/
function importWidget (srcDir, overwrite) {
  return importUserWidget(srcDir, overwrite)
}

// Uninstall: stop whatever it is running, then delete the folder.
async function deleteWidget (widgetId) {
  const stops = []
  for (const [instanceId, instance] of runningInstances) {
    if (instance.widgetId === widgetId) {
      stops.push(stopWidget(instanceId).catch(() => {}))
    }
  }
  await Promise.allSettled(stops)
  return removeUserWidget(widgetId)
}

async function cleanup () {
  if (runningInstances.size === 0) {
    return
  }

  const stopPromises = []

  for (const [instanceId, instance] of runningInstances) {
    console.log(`Stopping widget instance: ${instanceId}`)
    try {
      const stopPromise = instance.stop()
        .then(() => {
          console.log(`Successfully stopped widget instance: ${instanceId}`)
        })
        .catch(err => {
          console.error(`Error stopping widget instance ${instanceId}:`, err)
        })
      stopPromises.push(stopPromise)
    } catch (err) {
      console.error(`Error initiating stop for widget instance ${instanceId}:`, err)
    }
  }

  try {
    await Promise.allSettled(stopPromises)
    runningInstances.clear()
    console.log('All widget instances have been stopped')
  } catch (err) {
    console.error('Error during cleanup:', err)
  }
}

// Register cleanup handlers only for process exit signals
function registerCleanupHandlers () {
  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, cleaning up widgets...')
    await cleanup()
  })
}

// Initialize cleanup handlers
registerCleanupHandlers()

export {
  listWidgets,
  runWidget,
  stopWidget,
  runWidgetFunc,
  callWidgetFunc,
  importWidget,
  deleteWidget,
  resolveWidgetModule
}
