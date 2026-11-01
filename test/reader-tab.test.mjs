// Phase 3 reader tab: rendered with real React against a fake browser window
// (server render: controls, per-segment chips, saved text, the old tab's picks).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let React
let renderToString
try { React = require('react'); ({ renderToString } = require('react-dom/server')) } catch (e) { React = null }

// The tab is JSX: bundle it once (esbuild, as scripts/build.mjs does) into a temp ESM file.
let tabModule = null
async function loadTab() {
  if (tabModule) return tabModule
  const { build } = await import('esbuild')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const r = await build({
    entryPoints: [new URL('../src/client/reader-tab.jsx', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node',
    jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', loader: { '.js': 'jsx', '.jsx': 'jsx' }, external: ['react'], logLevel: 'silent',
  })
  const file = join(mkdtempSync(join(tmpdir(), 'dshv-tab-')), 'reader-tab.mjs')
  writeFileSync(file, r.outputFiles[0].text.replace(/from "react"/g, 'from ' + JSON.stringify(require.resolve('react'))))
  tabModule = await import(file)
  return tabModule
}

const store = new Map()
before(() => {
  globalThis.window = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    setTimeout, clearTimeout,
  }
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
})

test('reader tab renders controls, markers helper, and a chip per language segment', { skip: !React }, async () => {
  store.set('dsh-tts-reader.text', 'Read this sentence aloud please. [[el]]Γεια σας φίλοι μου.[[/]] [[it]]Ciao a tutti voi.[[/]]')
  const { ReaderTab, TAB_ID, TAB_TITLE, readerTabDescriptor } = await loadTab()
  assert.equal(TAB_ID, 'dsh-tts-reader:main')
  assert.equal(TAB_TITLE, 'TTS Reader')
  const html = renderToString(React.createElement(ReaderTab, { visible: true }))
  for (const label of ['Current reply', 'Selection', 'Open file', 'Read the text', 'Pause', 'Previous sentence', 'Next sentence', 'Download the whole text as audio', 'Insert EN marker', 'Insert IT marker', 'Insert EL marker', 'Insert end marker', 'Export format']) {
    assert.ok(html.includes(label), 'missing ' + label)
  }
  const chips = Array.from(html.matchAll(/data-dsh-voice-ui="1"[^>]*>(EN|EL|IT)</g)).map((m) => m[1])
  assert.deepEqual(chips, ['EN', 'EL', 'IT'])
  assert.ok(html.includes('role="status"'))
  const hidden = renderToString(React.createElement(ReaderTab, { visible: false }))
  assert.equal(hidden, '<div></div>')
  const d = readerTabDescriptor()
  assert.equal(d.id, TAB_ID)
  assert.equal(d.order, 94)
})

test('reader tab starts from the retired tab\'s model pick and voice', { skip: !React }, async () => {
  store.set('dsh-tts-reader.model', 'mistral:voxtral-mini-tts-3-0')
  store.set('dsh-tts-reader.voice.mistral:voxtral-mini-tts-3-0', 'voice_482')
  store.delete('dsh-voice.v2.reader.provider')
  const { ReaderTab } = await loadTab()
  const html = renderToString(React.createElement(ReaderTab, { visible: true }))
  // Voxtral TTS 3 picked: the tag menu appears
  assert.ok(html.includes('Insert a Voxtral tag'))
})

test('provider and voice choices come from /config', async () => {
  const { readerProviders, readerChoices } = await loadTab()
  const cfg = {
    providers: [{ id: 'mistral', type: 'mistral', label: 'Mistral', enabled: true, tts: true }, { id: 'groq', type: 'openai-compatible', enabled: false, tts: false }, { id: 'browser', type: 'browser', enabled: true, tts: true }],
    engines: { mistral: { models: { tts: [{ id: 'voxtral-mini-tts-3-0', name: 'Voxtral TTS 3' }] }, voices: [{ id: 'gb_oliver_neutral', name: 'Oliver' }] }, grey: { models: { tts: ['bm_george'] } } },
  }
  assert.deepEqual(readerProviders(cfg).map((p) => p.id), ['auto', 'mistral', 'browser'])
  assert.deepEqual(readerChoices(cfg, 'mistral'), { models: [{ id: 'voxtral-mini-tts-3-0', label: 'Voxtral TTS 3' }], voices: [{ id: 'gb_oliver_neutral', label: 'Oliver' }] })
  assert.deepEqual(readerChoices(cfg, 'grey').voices, [{ id: 'bm_george', label: 'bm_george' }])
})
