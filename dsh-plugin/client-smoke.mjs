/**
 * Structural check for the Client half without a browser.
 *
 * Stubs the module loader, React, and the Slot/tab services, executes the
 * factory, and asserts the tab type and both slot registrations. It cannot
 * render components or exercise fetch; it catches module-format and
 * registration mistakes before a page refresh.
 *
 *   node dsh-plugin/client-smoke.mjs
 */
import assert from 'node:assert/strict'

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

const fakeReact = {
  createElement() {
    return null
  },
  useState() {
    return [undefined, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
  useRef() {
    return { current: undefined }
  },
}

await import('./client.js')

assert.ok(loaded !== null, 'client.js must call window.__ModuleLoader__.load')
assert.equal(loaded.id, '@local/dsh-hprof-explorer')

const tabTypes = []
const slots = []
const injectedSlots = []
const opened = []
const panels = []
const module = loaded.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require: ${name}`)
})

assert.ok(Array.isArray(module.inject))
for (const name of ['slots', 'sidebarRight', 'sidebarRightTabs', 'layout']) {
  assert.ok(module.inject.includes(name), `inject must include ${name}`)
}
assert.equal(typeof module.apply, 'function')

const ctx = {
  effect(fn) {
    return fn()
  },
  on() {
    return () => {}
  },
  slots: {
    inject(name, callback) {
      injectedSlots.push(name)
      callback()
    },
    register(options, component) {
      slots.push({ options, component })
    },
  },
  sidebarRightTabs: {
    register(definition) {
      tabTypes.push(definition)
      return () => {}
    },
  },
  sidebarRight: {
    openTab(kind, options) {
      opened.push({ kind, options })
    },
  },
  layout: {
    selectPanel(id) {
      panels.push(id)
    },
  },
}

module.apply(ctx)

assert.equal(tabTypes.length, 1)
assert.equal(tabTypes[0].id, '@local/dsh-hprof-explorer')
assert.equal(tabTypes[0].kind, 'hprof')
assert.equal(typeof tabTypes[0].title, 'function')
assert.equal(tabTypes[0].title(''), 'HPROF Explorer')
assert.ok(Array.isArray(tabTypes[0].guide) && tabTypes[0].guide.length === 1)

assert.deepEqual(injectedSlots.sort(), [
  'conversation.composer.dock',
  'hprof.conversation',
  'main',
  'sidebar.panellist',
  'sidebar.right.pane.tab',
])
assert.equal(slots.length, 5)

const workspace = slots.find((slot) => slot.options.name === 'main')
assert.ok(workspace !== undefined)
assert.equal(workspace.options.key, 'hprof')
assert.ok(workspace.options.children['hprof.conversation'] !== undefined)
assert.equal(typeof workspace.component, 'function')

const conversation = slots.find((slot) => slot.options.name === 'hprof.conversation')
assert.ok(conversation !== undefined)
assert.equal(typeof conversation.component, 'function')

const panelIcon = slots.find((slot) => slot.options.name === 'sidebar.panellist')
assert.ok(panelIcon !== undefined)
assert.equal(panelIcon.options.id, 'hprof')
assert.equal(typeof panelIcon.component, 'function')

const body = slots.find((slot) => slot.options.name === 'sidebar.right.pane.tab')
assert.ok(body !== undefined)
assert.equal(body.options.key, '@local/dsh-hprof-explorer')
assert.equal(typeof body.component, 'function')

const dock = slots.find((slot) => slot.options.name === 'conversation.composer.dock')
assert.ok(dock !== undefined)
assert.equal(typeof dock.options.inject, 'function')
const injected = dock.options.inject()
assert.equal(typeof injected.open, 'function')
injected.open()
assert.deepEqual(panels, ['hprof'])

console.log('CLIENT SMOKE OK')
