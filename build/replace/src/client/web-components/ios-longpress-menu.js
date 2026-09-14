/**
 * iOS long-press -> `contextmenu` polyfill.
 *
 * Android WebView fires a `contextmenu` DOM event on long-press, so antd
 * Dropdowns with trigger=['contextMenu'] (sftp file list, tabs, ...) open
 * their menu there. iOS WebKit never dispatches `contextmenu` for touch
 * (https://bugs.webkit.org/show_bug.cgi?id=213953), so those menus never
 * open on iOS.
 *
 * This synthesizes the event when a single finger rests ~500ms without
 * moving and then lifts — the same gesture Android reports natively, and
 * the same mechanism the terminal uses for its own menu (openContextMenuAt
 * in term-touch.js dispatches an identical MouseEvent). iOS-only: on
 * Android the OS already fires the native event, and a second synthetic one
 * would double-toggle the dropdown.
 *
 * Drag safety: sftp rows are `draggable` (desktop HTML5 DnD) and live in a
 * scrollable list, so the pending press is cancelled on any real movement,
 * on native `dragstart`, on scroll and on `touchcancel` — a drag or scroll
 * gesture can never end with a stray menu. The synthetic event is only ever
 * dispatched on `touchend`, never mid-gesture.
 *
 * The terminal is excluded: it owns its long-press gesture (word select +
 * drag to extend) and dispatches its own `contextmenu`. Text fields keep
 * the native loupe/copy menu.
 */

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE_PX = 12

const EXCLUDE_SELECTOR = [
  '.term-wrap',
  '.xterm',
  '.terminal-select-text',
  '.ant-dropdown',
  'input',
  'textarea',
  'select',
  '[contenteditable]'
].join(',')

function isIOS () {
  try {
    const ua = window.navigator.userAgent || ''
    if (/iPhone|iPad|iPod/.test(ua)) {
      return true
    }
    // iPadOS in desktop mode reports a Mac UA
    return window.navigator.platform === 'MacIntel' &&
      window.navigator.maxTouchPoints > 1
  } catch (e) {
    return false
  }
}

let pressTimer = null
let pressTarget = null
let startX = 0
let startY = 0
let held = false

function cancel () {
  clearTimeout(pressTimer)
  pressTimer = null
  pressTarget = null
  held = false
}

function isExcluded (el) {
  return !!(el && el.closest && el.closest(EXCLUDE_SELECTOR))
}

function onTouchStart (e) {
  cancel()
  if (!e.touches || e.touches.length !== 1) {
    return
  }
  const t = e.touches[0]
  if (isExcluded(t.target)) {
    return
  }
  pressTarget = t.target
  startX = t.clientX
  startY = t.clientY
  pressTimer = setTimeout(() => {
    pressTimer = null
    held = true
  }, LONG_PRESS_MS)
}

function onTouchMove (e) {
  if (!pressTimer && !held) {
    return
  }
  const t = e.touches && e.touches[0]
  if (!t) {
    cancel()
    return
  }
  const dx = t.clientX - startX
  const dy = t.clientY - startY
  if (Math.sqrt(dx * dx + dy * dy) > MOVE_TOLERANCE_PX) {
    cancel()
  }
}

function onTouchEnd (e) {
  if (held && pressTarget && !isExcluded(pressTarget)) {
    const t = (e.changedTouches && e.changedTouches[0]) || null
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: t ? t.clientX : startX,
      clientY: t ? t.clientY : startY
    })
    pressTarget.dispatchEvent(event)
  }
  cancel()
}

function installLongPressMenu () {
  if (!isIOS() || installLongPressMenu.installed) {
    return false
  }
  installLongPressMenu.installed = true
  const opts = { passive: true, capture: true }
  window.addEventListener('touchstart', onTouchStart, opts)
  window.addEventListener('touchmove', onTouchMove, opts)
  window.addEventListener('touchend', onTouchEnd, opts)
  window.addEventListener('touchcancel', cancel, opts)
  // a browser-owned drag (desktop HTML5 DnD on the draggable rows) or any
  // scroll means this was not a press-and-hold
  window.addEventListener('dragstart', cancel, opts)
  window.addEventListener('scroll', cancel, opts)
  return true
}

installLongPressMenu.installed = false

installLongPressMenu()

export default installLongPressMenu
