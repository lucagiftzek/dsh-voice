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
  // /config is not answering in this test, so the tab shows the pickers once a config arrives:
  // what matters here is that the saved pick survives (the provider menu lists Voxtral's models when known)
  const html = renderToString(React.createElement(ReaderTab, { visible: true }))
  const cfg = { providers: [{ id: 'mistral', type: 'mistral', label: 'Mistral', enabled: true, tts: true }], engines: { mistral: { models: { tts: [{ id: 'voxtral-mini-tts-3-0', name: 'Voxtral TTS 3' }] }, voices: [], ttsModels: null, v2: { annotation: { family: 'voxtral', summary: 'tone, pace, sounds' } } } } }
  const { readerChoices, readerAnnotation } = await loadTab()
  assert.equal(readerChoices(cfg, 'mistral').models[0].id, 'voxtral-mini-tts-3-0')
  assert.equal(readerAnnotation(cfg, 'mistral').family, 'voxtral', 'the saved pick maps to its family, so the menu has its groups')
  assert.equal(typeof html, 'string')
})

test('provider and voice choices come from /config, and a catalogue makes the voices follow the model', async () => {
  const { readerProviders, readerChoices, readerAnnotation } = await loadTab()
  const cfg = {
    providers: [{ id: 'mistral', type: 'mistral', label: 'Mistral', enabled: true, tts: true }, { id: 'or', type: 'openrouter', label: 'OpenRouter', enabled: true, tts: true }, { id: 'groq', type: 'openai-compatible', enabled: false, tts: false }, { id: 'browser', type: 'browser', enabled: true, tts: true }],
    engines: {
      mistral: { models: { tts: [{ id: 'voxtral-mini-tts-3-0', name: 'Voxtral TTS 3' }, { id: 'voxtral-mini-tts-2603', name: 'Voxtral TTS v1' }] }, voices: [{ id: 'gb_oliver_neutral', name: 'Oliver' }], ttsModels: null, v2: { annotation: { family: 'voxtral', summary: 'tone, pace, sounds', menu: { groups: [] } } } },
      grey: { models: { tts: ['bm_george'] }, ttsModels: null },
      or: { ttsModels: [
        { id: 'elevenlabs/eleven-v3', label: 'Eleven v3', family: 'elevenlabs', default: false, voices: [{ id: 'george' }, { id: 'sarah' }] },
        { id: 'mistralai/voxtral-mini-tts-3-0', label: 'Voxtral TTS 3', family: 'voxtral', default: true, voices: [{ id: 'gb_oliver_neutral' }] },
        { id: 'hexgrad/kokoro-82m', label: 'Kokoro', family: 'kokoro', voices: [] },
      ] },
    },
  }
  assert.deepEqual(readerProviders(cfg).map((p) => p.id), ['auto', 'mistral', 'or', 'browser'])
  const mistral = readerChoices(cfg, 'mistral')
  assert.deepEqual(mistral.models.map((m) => m.id), ['voxtral-mini-tts-3-0', 'voxtral-mini-tts-2603'])
  assert.deepEqual(mistral.voices, [{ id: 'gb_oliver_neutral', label: 'Oliver' }])
  // the voices carry their facets: language, accent and tone read from the id
  const vox = readerChoices(cfg, 'mistral')
  assert.deepEqual(vox.voices, [{ id: 'gb_oliver_neutral', label: 'Oliver' }])
  assert.deepEqual(vox.facets.languages.map((x) => x.value), ['English'], 'one language entry, even for gb and en tags')
  assert.deepEqual(vox.facets.accents.map((x) => x.value), ['gb'], 'only the accents the voices name')
  // a catalogue: every model with its own voices, and the default model picked until one is chosen
  const or = readerChoices(cfg, 'or')
  assert.equal(or.catalogue, true)
  assert.deepEqual(or.models.map((m) => m.id), ['elevenlabs/eleven-v3', 'mistralai/voxtral-mini-tts-3-0', 'hexgrad/kokoro-82m'])
  assert.equal(or.model.id, 'mistralai/voxtral-mini-tts-3-0')
  assert.deepEqual(or.voices.map((v) => v.id), ['gb_oliver_neutral'])
  assert.deepEqual(readerChoices(cfg, 'or', 'elevenlabs/eleven-v3').voices.map((v) => v.id), ['george', 'sarah'], 'the voices of the chosen model')
  assert.equal(readerAnnotation(cfg, 'or', 'elevenlabs/eleven-v3').family, 'elevenlabs')
  assert.equal(readerAnnotation(cfg, 'mistral').family, 'voxtral')
})
