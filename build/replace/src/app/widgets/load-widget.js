// load-widget.js (iOS override)
//
// Upstream electerm-android statically imports all five widget modules at the
// top of this file. src/app/lib/run-sync.js imports load-widget.js on the
// app's STARTUP path, so those static imports force the entire widget
// dependency graph (express + the MCP SDK + zod + @electerm/ftp-srv) to be
// evaluated at app LAUNCH. On the jitless, RAM-limited iOS device runtime that
// initialization blows the launch budget and the app is killed before it can
// show the UI — the simulator (JIT, abundant RAM) survives it. The App Store
// review rejection "crashed after initial launch" is exactly this.
//
// This override defers each widget module behind a dynamic import() so the
// heavy graph is only evaluated the first time a widget is actually used,
// never during startup. The public API (listWidgets / runWidget / stopWidget /
// runWidgetFunc) is unchanged, so run-sync.js and the renderer are unaffected.

const widgetLoaders = {
  'batch-op': () => import('./widget-batch-op.js'),
  'local-file-server': () => import('./widget-local-file-server.js'),
  'local-ftp-server': () => import('./widget-local-ftp-server.js'),
  'mcp-server': () => import('./widget-mcp-server.js'),
  rename: () => import('./widget-rename.js')
}

const widgetIdPattern = /^[a-z0-9-]+$/

// Store running widget instances
const runningInstances = new Map()

async function listWidgets () {
  const entries = await Promise.all(
    Object.entries(widgetLoaders).map(async ([id, load]) => {
      const mod = await load()
      return { id, info: mod.widgetInfo }
    })
  )
  return entries
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
  if (typeof widgetId !== 'string' || !widgetIdPattern.test(widgetId)) {
    throw new Error(`Invalid widget ID: ${widgetId}`)
  }
  const load = widgetLoaders[widgetId]
  if (!load) {
    throw new Error(`Widget not found: ${widgetId}`)
  }

  const widget = await load()
  const { type, singleInstance } = widget.widgetInfo
  if (type !== 'instance') {
    return widget.widgetRun(config)
  }

  // Check if singleInstance widget already has a running instance
  if (singleInstance && hasRunningInstance(widgetId)) {
    return Promise.reject(new Error(`Widget ${widgetId} already has a running instance. Only one instance is allowed.`))
  }

  const instance = widget.widgetRun(config)
  instance.widgetId = widgetId
  runningInstances.set(instance.instanceId, instance)

  return instance.start()
    .then((result) => {
      return {
        instanceId: instance.instanceId,
        widgetId,
        singleInstance: !!singleInstance,
        ...result
      }
    })
    .catch((err) => {
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

  return instance.stop()
    .then(() => {
      runningInstances.delete(instanceId)
      return { instanceId, status: 'stopped' }
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
    throw error
  }
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
  runWidgetFunc
}
