// Client bundle contract (built through the verifying build script) and the
// localStorage preference migration.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { buildSource, verifyClientBundle, loadClientBundle } from '../scripts/build.mjs'
import { migratePrefs, readV1, readerModelToRoute, V2_FLAG, V2_PREFS } from '../lib/shared/prefs.js'

const require = createRequire(import.meta.url)

test('fresh build verifies and matches the committed lib/client.js', async () => {
  const src = await buildSource()
  const v = verifyClientBundle(src)
  assert.equal(v.slots.length, 3)
  assert.equal(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), src, 'lib/client.js is stale: run npm run build')
})

test('bundle requires only react, exports name/inject/apply like 1.x', async () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const { id, exported, required } = loadClientBundle(src)
  assert.equal(id, 'dsh-voice')
  assert.equal(exported.name, 'dsh-voice')
  assert.equal(JSON.stringify(exported.inject), '["slots"]')
  assert.equal(JSON.stringify(Array.from(new Set(required))), '["react"]')
})

test('verifier rejects a bundle without apply', () => {
  assert.throws(() => verifyClientBundle("window.__ModuleLoader__.load({ id: 'dsh-voice', factory: function () { return {} } })"), /no apply/)
  assert.throws(() => verifyClientBundle("window.__ModuleLoader__.load({ id: 'other', factory: function () { return { apply() {} } } })"), /expected/)
})

test('components render with real React (server render, no browser APIs)', () => {
  let React
  let renderToString
  try { React = require('react'); ({ renderToString } = require('react-dom/server')) } catch (e) { return }
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry
  const storage = new Map()
  const window = {
    __ModuleLoader__: { load: (e) => { entry = e } },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), key: () => null, length: 0 },
  }
  runInNewContext(src, { window, console })
  const mod = entry.factory((n) => { if (n !== 'react') throw new Error(n); return React })
  const comps = {}
  mod.apply({ slots: { inject: (s, fn) => fn(), register: (meta, c) => { comps[meta.id] = c } } })
  globalThis.window = window
  try {
    const chat = { legacy: { nodes: [{ kind: 'assistant', messageId: 'm1', blocks: [{ kind: 'text', text: 'Hello there. [[el]]Γεια σας[[/]]\n```js\nx\n```' }] }] } }
    const html = renderToString(React.createElement(comps['voice-speak'], { useChat: (sel) => sel(chat), messageId: 'm1' }))
    assert.match(html, /Read aloud/)
    assert.match(html, /Read code aloud/)
    const empty = renderToString(React.createElement(comps['voice-speak'], { useChat: (sel) => sel(chat), messageId: 'nope' }))
    assert.equal(empty, '')
    const mic = renderToString(React.createElement(comps['voice-mic'], { useInput: (sel) => sel({ draft: '' }), inputActions: { setDraft() {} } }))
    assert.match(mic, /Dictate a prompt/)
    assert.match(mic, /ElevenLabs/)
    const settings = renderToString(React.createElement(comps['voice-settings'], {}))
    assert.match(settings, /Browser-voice fallback/)
    assert.equal(storage.get(V2_FLAG), '1')
  } finally { delete globalThis.window }
})

function fakeStorage(init) {
  const m = new Map(Object.entries(init || {}))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), key: (i) => Array.from(m.keys())[i], get length() { return m.size }, _m: m }
}

test('migratePrefs maps Luca-style 1.x keys and never deletes them', () => {
  const st = fakeStorage({
    'dsh-voice.engine': 'mimo', 'dsh-voice.mimovoice': 'Mia', 'dsh-voice.lfm3voice': 'male', 'dsh-voice.voice': 'auto',
    'dsh-voice.localmodel': 'maya', 'dsh-voice.rate': '1.25', 'dsh-voice.fallback': '0',
    'dsh-tts-reader.model': 'mistral:voxtral-mini-tts-3-0', 'dsh-tts-reader.rate': '1.5', 'dsh-tts-reader.voice.mimo': 'Chloe',
  })
  const before = new Map(st._m)
  const snap = migratePrefs(st)
  assert.deepEqual(snap.manual, { provider: 'mimo', model: 'maya' })
  assert.deepEqual(snap.voices, { mimo: 'Mia', lfm3: 'male' })
  assert.equal(snap.rate, 1.25)
  assert.equal(snap.fallbackToBrowser, false)
  assert.deepEqual(snap.reader.route, { provider: 'mistral', model: 'voxtral-mini-tts-3-0' })
  assert.equal(snap.reader.rate, 1.5)
  assert.equal(snap.reader.voices.mimo, 'Chloe')
  for (const [k, v] of before) assert.equal(st.getItem(k), v)
  assert.equal(st.getItem(V2_FLAG), '1')
  st.setItem('dsh-voice.engine', 'mistral')
  assert.equal(migratePrefs(st).manual.provider, 'mimo', 'runs once')
  assert.ok(st.getItem(V2_PREFS))
})

test('defaults and reader ids', () => {
  const snap = readV1(fakeStorage({}))
  assert.equal(snap.manual.provider, 'auto')
  assert.equal(snap.rate, 1)
  assert.equal(snap.fallbackToBrowser, true)
  assert.deepEqual(readerModelToRoute('local:maya'), { provider: 'local', model: 'maya' })
  assert.deepEqual(readerModelToRoute('grey'), { provider: 'grey', model: '' })
  assert.deepEqual(readerModelToRoute('auto'), { provider: 'auto', model: '' })
})
