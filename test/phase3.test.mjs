// Phase 3: dictation state machine, caret insertion, shortcuts, tags and markers helper,
// the dsh-tts-reader stub, optional-injection boot, polish via ctx.llm, and the
// settings store on three host shapes (0.1.5 register, 0.2 forms, no settings).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import http from 'node:http'
import { createDictation, insertAt, caretToDraftOffset, nextDictationLang, levelOf, HOLD_MS } from '../src/client/dictation.js'
import { parseCombo, matches, actionFor, conflicts, installShortcuts, DEFAULT_SHORTCUTS } from '../src/client/shortcuts.js'
import { stripTags, carryTags, insertMarker, insertSnippet, fileText, takesTags } from '../src/client/tags.js'
import { loadClientBundle } from '../scripts/build.mjs'
import { polish, POLISH_SYSTEM, polishConfig } from '../lib/server/polish.js'
import { createSettingsStore } from '../lib/server/settings-store.js'
import { settingsSchema, DEFAULTS } from '../lib/server/settings.js'
import { loadHostSchemastery, requireFromHarness } from '../lib/dual-settings.js'

// ---------------------------------------------------------------- dictation
function machine(mode) {
  let t = 0
  const log = []
  const m = createDictation({ mode, now: () => t, effects: { start: () => log.push('start'), stop: () => log.push('stop'), discard: () => log.push('discard') } })
  return { m, log, at: (ms) => { t = ms } }
}

test('dictation toggle mode: a click latches, a second click stops', () => {
  const { m, log, at } = machine('toggle')
  at(0); assert.equal(m.press(), 'rec')
  at(100); assert.equal(m.release(), 'rec')
  at(3000); assert.equal(m.press(), 'busy')
  assert.equal(m.release(), 'busy')
  assert.deepEqual(log, ['start', 'stop'])
  assert.equal(m.press(), 'busy', 'busy ignores presses')
  assert.equal(m.done(), 'idle')
})

test('dictation toggle mode: holding works as push-to-talk', () => {
  const { m, log, at } = machine('toggle')
  at(0); m.press()
  at(HOLD_MS + 50); assert.equal(m.release(), 'busy')
  assert.deepEqual(log, ['start', 'stop'])
})

test('dictation push-to-talk: any release sends; cancel discards', () => {
  const { m, log, at } = machine('push-to-talk')
  at(0); m.press(); at(50)
  assert.equal(m.release(), 'busy')
  m.done()
  m.press()
  assert.equal(m.cancel(), 'idle')
  assert.deepEqual(log, ['start', 'stop', 'start', 'discard'])
  assert.equal(m.cancel(), 'idle', 'cancel outside recording is a no-op')
})

test('dictation: an error resets on the next press; mode can change', () => {
  const { m } = machine('toggle')
  m.press(); m.fail()
  assert.equal(m.state, 'error')
  assert.equal(m.press(), 'rec')
  m.setMode('push-to-talk')
  assert.equal(m.mode, 'push-to-talk')
})

test('insertAt: caret, append, replace, spacing', () => {
  assert.deepEqual(insertAt('Hello world', 'big', 'caret', 6), { draft: 'Hello big world', caret: 9 })
  assert.deepEqual(insertAt('Hello', 'there', 'caret', 5), { draft: 'Hello there', caret: 11 })
  assert.equal(insertAt('End.', 'More', 'append', null).draft, 'End. More')
  assert.equal(insertAt('abc', 'x', 'caret', null).draft, 'abc x', 'unknown caret appends')
  assert.equal(insertAt('abc', 'x', 'caret', 99).draft, 'abc x', 'stale caret appends')
  assert.equal(insertAt('old', 'new', 'replace', 1).draft, 'new')
  assert.equal(insertAt('Say . now', 'hi', 'caret', 4).draft, 'Say hi. now')
  assert.equal(insertAt('', 'first', 'caret', 0).draft, 'first')
  assert.equal(insertAt('keep', '   ', 'caret', 2).draft, 'keep')
})

test('caret mapping across Lexical paragraphs, language cycle, level', () => {
  assert.equal(caretToDraftOffset('ab\ncd', 'abc'), 4)
  assert.equal(caretToDraftOffset('ab\ncd', ''), 0)
  assert.equal(caretToDraftOffset('ab', 'abxyz'), 2)
  assert.equal(nextDictationLang('auto', ['en', 'it', 'el']), 'en')
  assert.equal(nextDictationLang('el', ['en', 'it', 'el']), 'auto')
  assert.equal(levelOf(new Uint8Array(64).fill(128)), 0)
  assert.ok(levelOf(Uint8Array.from({ length: 64 }, (x, i) => (i % 2 ? 228 : 28))) > 0.9)
})

// ---------------------------------------------------------------- shortcuts
const ev = (code, mods) => Object.assign({ code, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, repeat: false, key: 'x', preventDefault() { this.prevented = true } }, mods || {})

test('shortcut parsing and matching by physical key', () => {
  assert.deepEqual(parseCombo('Alt+Shift+R'), { alt: true, shift: true, ctrl: false, meta: false, code: 'KeyR' })
  assert.equal(parseCombo('Alt+Shift+.').code, 'Period')
  assert.equal(parseCombo('Alt+Shift+,').code, 'Comma')
  assert.equal(parseCombo('Alt+Shift+=').code, 'Equal')
  assert.equal(parseCombo('Alt+Shift+-').code, 'Minus')
  assert.equal(parseCombo('Ctrl+Alt+F5').code, 'F5')
  assert.equal(parseCombo('R'), null, 'a bare key would fight typing')
  assert.equal(parseCombo('Shift+R'), null)
  assert.equal(parseCombo(''), null)
  // a Greek layout sends key 'ρ' for KeyR: the code still matches
  assert.ok(matches(parseCombo('Alt+Shift+R'), ev('KeyR', { altKey: true, shiftKey: true, key: '\u03c1' })))
  assert.ok(!matches(parseCombo('Alt+Shift+R'), ev('KeyR', { altKey: true })))
  assert.equal(actionFor({}, ev('KeyM', { altKey: true, shiftKey: true })), 'dictate')
  assert.equal(actionFor({ dictate: '' }, ev('KeyM', { altKey: true, shiftKey: true })), null, 'empty disables')
})

test('defaults have no duplicates and avoid the DSH composer bindings', () => {
  assert.deepEqual(conflicts(DEFAULT_SHORTCUTS), [])
  assert.equal(conflicts({ stop: 'Alt+Shift+R' }).length, 1)
  const dsh = [ev('ArrowUp', { altKey: true }), ev('ArrowDown', { shiftKey: true, altKey: true }), ev('Enter', { shiftKey: true }), ev('KeyO', { ctrlKey: true }), ev('Escape')]
  for (const e of dsh) assert.equal(actionFor({}, e), null)
})

test('installShortcuts: down and up handlers, repeat ignored, preventDefault, uninstall', () => {
  const listeners = {}
  const target = { addEventListener: (t, fn) => { listeners[t] = fn }, removeEventListener: (t) => { delete listeners[t] } }
  const calls = []
  const off = installShortcuts(target, () => ({}), { dictate: { down: () => calls.push('down'), up: () => calls.push('up') }, stop: { down: () => calls.push('stop') } })
  const d = ev('KeyM', { altKey: true, shiftKey: true })
  listeners.keydown(d)
  assert.ok(d.prevented)
  listeners.keydown(ev('KeyM', { altKey: true, shiftKey: true, repeat: true }))
  listeners.keyup(ev('KeyM'))
  listeners.keydown(ev('KeyS', { altKey: true, shiftKey: true }))
  listeners.keydown(ev('KeyQ', { altKey: true, shiftKey: true }))
  assert.deepEqual(calls, ['down', 'up', 'stop'])
  off()
  assert.equal(listeners.keydown, undefined)
})

// ---------------------------------------------------------------- tags and markers helper
test('Voxtral tags: only Mistral TTS 3 gets them, carried across chunks', () => {
  assert.equal(stripTags('[emotion=happy] Hello [laugh] there [pace=slow]now'), ' Hello there now')
  assert.equal(stripTags('keep [[el]] markers and [wiki]'), 'keep [[el]] markers and [wiki]')
  assert.ok(takesTags('mistral', 'voxtral-mini-tts-3-0'))
  assert.ok(!takesTags('mistral', ''))
  assert.ok(!takesTags('elevenlabs', 'voxtral-mini-tts-3-0'))
  assert.deepEqual(carryTags(['[emotion=sad] a.', 'b.', '[pace=fast] c.', 'd.']), ['[emotion=sad] a.', '[emotion=sad]b.', '[pace=fast] c.', '[emotion=sad][pace=fast]d.'])
})

test('markers helper: wrap a selection, insert a switch, end marker, snippets', () => {
  assert.deepEqual(insertMarker('say ciao now', 4, 8, 'it'), { text: 'say [[it]]ciao[[/]] now', start: 10, end: 14 })
  assert.deepEqual(insertMarker('ab', 1, 1, 'el'), { text: 'a[[el]]b', start: 7, end: 7 })
  assert.equal(insertMarker('ab', 2, 2, '/').text, 'ab[[/]]')
  assert.equal(insertSnippet('Hello', 5, 5, '[laugh]').text, 'Hello [laugh] ')
  assert.equal(fileText('a.md', '# Title'), '# Title')
  assert.equal(fileText('a.html', '<p>Hi <b>there</b></p><script>x()</script>'), 'Hi there')
})

// ---------------------------------------------------------------- the dsh-tts-reader stub
test('dsh-tts-reader stub: no inject, registers nothing, needs no sidebar', () => {
  const src = readFileSync(new URL('../stub/dsh-tts-reader/lib/client.js', import.meta.url), 'utf8')
  const { id, exported, required } = loadClientBundle(src)
  assert.equal(id, 'dsh-tts-reader')
  assert.equal(JSON.stringify(exported.inject), '[]')
  assert.equal(required.length, 0)
  const ctx = { betterSidebar: { registerTab: () => { throw new Error('the stub must not register a tab') } }, slots: { inject() { throw new Error('no slots either') } } }
  exported.apply(ctx)
  const pkg = JSON.parse(readFileSync(new URL('../stub/dsh-tts-reader/package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-tts-reader')
  assert.deepEqual(pkg.dsh.client.inject, [])
  assert.ok(!/[\u2013\u2014]/.test(src + JSON.stringify(pkg)))
})

// ---------------------------------------------------------------- optional injection boot
function bootClient(ctxExtra) {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry
  const stubWindow = { __ModuleLoader__: { load: (e) => { entry = e } } }
  runInNewContext(src, { window: stubWindow, console: { warn() {}, info() {}, log() {}, error() {} } })
  const React = { createElement() { return null }, Fragment: 'F', useState(v) { return [typeof v === 'function' ? v() : v, () => {}] }, useEffect() {}, useRef(v) { return { current: v } }, useMemo(f) { return f() }, useCallback(f) { return f } }
  const mod = entry.factory((n) => { if (n !== 'react') throw new Error('requires ' + n); return React })
  const slots = []
  const ctx = Object.assign({ slots: { inject: (s, fn) => fn(), register: (meta) => { slots.push(meta.id); return () => {} } } }, ctxExtra || {})
  mod.apply(ctx)
  return { mod, slots }
}

test('client boots without the sidebar service (no inject API, or the service never arrives)', () => {
  assert.deepEqual(bootClient().slots.sort(), ['voice-mic', 'voice-settings', 'voice-speak'])
  const waited = []
  const r = bootClient({ inject: (names) => { waited.push(names.join(',')) } })
  assert.equal(r.slots.length, 3)
  assert.deepEqual(waited, ['betterSidebar'])
  assert.equal(JSON.stringify(r.mod.inject), '["slots"]', 'betterSidebar is not a required inject')
})

test('client registers the TTS Reader tab when the sidebar exists, and survives a duplicate id', () => {
  const tabs = []
  bootClient({ inject: (names, cb) => cb({ betterSidebar: { registerTab: (d) => { tabs.push(d); return () => {} } }, on() {} }) })
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, 'dsh-tts-reader:main')
  assert.equal(tabs[0].title, 'TTS Reader')
  assert.equal(tabs[0].single, true)
  assert.equal(typeof tabs[0].component, 'function')
  const dup = bootClient({ inject: (names, cb) => cb({ betterSidebar: { registerTab: () => { throw new Error('tab type "dsh-tts-reader:main" already registered') } }, on() {} }) })
  assert.equal(dup.slots.length, 3)
})

// ---------------------------------------------------------------- polish via ctx.llm
test('polish: the DSH model goes first, never-translate rule, fallback keeps the 1.x shape', async () => {
  assert.match(POLISH_SYSTEM, /NEVER translate/)
  const cfg = Object.assign(polishConfig({ DSH_VOICE_OLLAMA_PORT: '9' }))
  const calls = []
  const llm = { async *stream(o) { calls.push(o); yield { type: 'text-delta', text: 'Γεια σας, τι κάνετε;' } } }
  const out = await polish('γεια σας τι κανετε', { asked: 'auto', mistralInst: null, cfg, llm, llmModel: { provider: 'mistral', model: 'mistral-small-latest' } })
  assert.deepEqual(out, { text: 'Γεια σας, τι κάνετε;', polished: true, engine: 'llm', model: 'mistral/mistral-small-latest' })
  assert.equal(calls[0].system, POLISH_SYSTEM)
  const broken = { async *stream() { throw new Error('down') } }
  const fb = await polish('raw text', { asked: 'auto', mistralInst: null, cfg, llm: broken, llmModel: { provider: 'p', model: 'm' } })
  assert.equal(fb.polished, false)
  assert.equal(fb.text, 'raw text')
  const local = await polish('raw', { asked: 'local', mistralInst: null, cfg, llm, llmModel: { provider: 'p', model: 'm' } })
  assert.equal(local.engine, undefined, 'asked for local: the model is not used')
})

// ---------------------------------------------------------------- settings on three host shapes
const z015 = loadHostSchemastery(import.meta.url)
const V021 = '/var/tmp/dsh-mig/core'
const z021 = (() => {
  const p = join(V021, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!existsSync(p)) return null
  const saved = process.env.DSH_GLOBAL_PREFIX
  process.env.DSH_GLOBAL_PREFIX = V021
  try { const m = requireFromHarness('@deepseek-ai/schemastery', import.meta.url); return m ? (m.default || m) : null } finally { if (saved === undefined) delete process.env.DSH_GLOBAL_PREFIX; else process.env.DSH_GLOBAL_PREFIX = saved }
})()

test('host shape 0.1.5: register mode reads and writes through the registered scope; secrets go to the vault', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshv-015-'))
  let stored = {}
  const registered = []
  const ctx = { settings: { register(ns, schema, opts) { registered.push([ns, opts.applies, typeof schema]); return { get: () => schema(JSON.parse(JSON.stringify(stored))), update: async (p) => { stored = Object.assign({}, stored, p) } } } } }
  const store = createSettingsStore({ ctx, config: {}, schema: settingsSchema(z015), dataDir: dir })
  assert.equal(store.mode, 'register')
  assert.deepEqual(registered[0].slice(0, 2), ['dsh-voice', 'live'])
  assert.equal(store.raw().detection.mode, 'heuristic+model')
  await store.update({ reading: { autoRead: 'new-replies' }, providers: [{ id: 'mistral-eu', type: 'mistral', credential: 'sk-test-literal-0000' }] })
  assert.equal(stored.reading.autoRead, 'new-replies')
  assert.equal(stored.providers[0].credential, 'vault:mistral-eu')
  assert.ok(!JSON.stringify(stored).includes('sk-test-literal'))
  assert.equal(store.vault('mistral-eu'), 'sk-test-literal-0000')
  assert.equal(statSync(join(dir, 'vault.json')).mode & 0o777, 0o600)
})

test('host shape 0.2.x: forms mode writes the plugin row through update(entryId, patch)', async () => {
  const z = z021 || z015
  const schema = settingsSchema(z)
  const dir = mkdtempSync(join(tmpdir(), 'dshv-021-'))
  if (z021) assert.equal(schema.dict.reading.meta.volatile, true, 'every top-level key is live on 0.2.1')
  const fiber = {}
  const writes = []
  let user = {}
  const config = schema({})
  const ctx = {
    fiber,
    settings: {
      describe: () => [{ ns: 'voice', user: JSON.parse(JSON.stringify(user)) }],
      async update(id, patch) { writes.push([id, patch]); user = Object.assign({}, user, patch); Object.assign(config, schema(JSON.parse(JSON.stringify(user)))) },
      configure: () => () => {},
    },
    loader: { entries: () => [{ options: { id: 'voice', name: 'dsh-voice' }, fiber }], await: async () => {} },
    profileContext: { home: dir },
    effect: () => {},
  }
  const store = createSettingsStore({ ctx, config, schema, dataDir: dir })
  await store.ready
  assert.equal(store.mode, 'forms')
  assert.equal(store.backend, 'profile')
  await store.update({ dictation: { mode: 'push-to-talk' }, providers: [{ id: 'x', type: 'elevenlabs', credential: 'literal-key-1234567890' }] })
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], 'voice', 'the loader entry id, not the package name')
  assert.equal(writes[0][1].providers[0].credential, 'vault:x')
  assert.equal(store.raw().dictation.mode, 'push-to-talk')
  assert.ok(!JSON.stringify(user).includes('literal-key'))
})

test('host shape without settings: reading ctx.settings throws, the store must not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshv-none-'))
  const ctx = {}
  Object.defineProperty(ctx, 'settings', { get() { throw new Error('cannot get property "settings" without inject') } })
  const store = createSettingsStore({ ctx, config: { reading: { highlight: 'sentence' } }, schema: settingsSchema(z015), dataDir: dir })
  assert.equal(store.mode, 'config')
  assert.equal(store.raw().reading.highlight, 'sentence')
  await store.update({ reading: { autoRead: 'new-replies' } })
  assert.equal(store.raw().reading.autoRead, 'new-replies', 'the plugin file is the writable fallback')
})

test('host entry: Config export, inject list, apply on each host shape serves /config', async () => {
  const mod = await import('../lib/index.js')
  assert.deepEqual(mod.inject, ['webServer', 'settings'])
  assert.ok(mod.Config, 'Config exported (built with the harness schemastery)')
  for (const k of Object.keys(DEFAULTS)) assert.ok(mod.Config.dict[k], 'Config declares ' + k)
  const shapes = {
    register: { settings: { register: (ns, schema) => ({ get: () => schema({}), update: async () => {} }) } },
    none: (() => { const c = {}; Object.defineProperty(c, 'settings', { get() { throw new Error('not injected') } }); return c })(),
  }
  for (const [label, extra] of Object.entries(shapes)) {
    let handler
    const ctx = Object.assign({ webServer: { register: (r) => { handler = r.handler; return () => {} } }, on() {}, logger: () => ({ info() {}, warn() {} }) }, {})
    for (const k of Object.getOwnPropertyNames(extra)) Object.defineProperty(ctx, k, Object.getOwnPropertyDescriptor(extra, k))
    process.env.DSH_VOICE_DATA_DIR = mkdtempSync(join(tmpdir(), 'dshv-entry-'))
    mod.apply(ctx, {})
    const srv = http.createServer(handler)
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    try {
      const j = await (await fetch('http://127.0.0.1:' + srv.address().port + '/api/voice/config')).json()
      assert.equal(j.ok, true, label)
      assert.ok(j.shortcuts && j.shortcuts.dictate, label + ': shortcuts in /config')
      assert.equal(typeof j.dictation.polish.enabled, 'boolean')
    } finally { srv.close(); delete process.env.DSH_VOICE_DATA_DIR }
  }
})
