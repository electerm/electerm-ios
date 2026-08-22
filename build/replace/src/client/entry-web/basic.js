/**
 * init app data then write main script to html body
 */
import '../electerm-react/css/basic.styl'
import '../web-components/style-overide.styl'
import '../electerm-react/css/mobile.styl'
import '../web-components/web-api.js'
import '../web-components/web-pre.js'
import { get as _get } from 'lodash-es'

// iOS WKWebView has no requestIdleCallback. bookmark-form's save path wraps
// addItem/editItem in runIdle() -> window.requestIdleCallback; without this
// polyfill every save silently throws "undefined is not a function" and the
// bookmark never reaches the store (connect/test paths don't use runIdle,
// which is why those buttons still work). Semantics follow the spec draft:
// call the callback ASAP with a deadline, support options.timeout, return a
// cancellable id.
if (typeof window.requestIdleCallback !== 'function') {
  window.requestIdleCallback = function (cb, options) {
    const start = Date.now()
    return setTimeout(function () {
      cb({
        didTimeout: false,
        timeRemaining: function () {
          return Math.max(0, 50 - (Date.now() - start))
        }
      })
    }, options && options.timeout ? 1 : 0)
  }
  window.cancelIdleCallback = function (id) {
    clearTimeout(id)
  }
}

const { isDev, version, cdn } = window.et

window.et.buildWsUrl = (
  host,
  port,
  tokenElecterm,
  id,
  type = 'terminals',
  extra = ''
) => {
  const ss = isDev ? window.et.server : window.location.href
  const s = ss
    ? ss.replace(/https?:\/\//, '').replace(/\/$/, '')
    : `${host}:${port}`
  const pre = ss.startsWith('https') ? 'wss' : 'ws'
  return `${pre}://${s}/${type}/${id}?token=${tokenElecterm}${extra}`
}

async function loadWorker () {
  return new Promise((resolve) => {
    const url = !isDev ? cdn + `/js/worker-${version}.js` : cdn + '/js/worker.js'
    window.worker = new window.Worker(url)
    function onInit (e) {
      if (!e || !e.data) {
        return false
      }
      const {
        action
      } = e.data
      if (action === 'worker-init') {
        window.worker.removeEventListener('message', onInit)
        resolve(1)
      }
    }
    window.worker.addEventListener('message', onInit)
  })
}

async function load () {
  window.capitalizeFirstLetter = (string) => {
    return string.charAt(0).toUpperCase() + string.slice(1)
  }
  function loadScript () {
    const rcs = document.createElement('script')
    const url = !isDev ? cdn + `/js/electerm-${version}.js` : cdn + '/js/electerm.js'
    rcs.src = url
    rcs.type = 'module'
    rcs.onload = () => {
      const loadingEl = document.getElementById('content-loading')
      if (loadingEl) {
        document.body.removeChild(loadingEl)
      }
    }
    document.body.appendChild(rcs)
  }
  window.getLang = (lang = window.store?.config.language || 'en_us') => {
    return _get(window.langMap, `[${lang}].lang`)
  }
  window.translate = txt => {
    const lang = window.getLang()
    const str = _get(lang, `[${txt}]`) || txt
    return window.capitalizeFirstLetter(str)
  }
  await loadWorker()
  if (!window.et.isDev) {
    window.worker.postMessage({
      action: 'init-url',
      url: window.location.href
    })
  }
  loadScript()
}

// window.addEventListener('load', load)
load()
