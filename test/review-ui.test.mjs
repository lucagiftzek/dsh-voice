// Review additions: OpenAI retirement notes and a server render of the grouped
// Settings > Voice provider list fed by a real GET /settings answer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { retirementNotes } from '../lib/shared/retirements.js'
import { voiceServer } from './helpers.mjs'

const require = createRequire(import.meta.url)

test('retirementNotes: OpenAI speech and transcription models, only on OpenAI hosts', () => {
  const n = retirementNotes({ type: 'openai', models: { tts: 'gpt-4o-mini-tts', stt: 'whisper-1' } })
  assert.deepEqual(n.map((x) => [x.dir, x.on]), [['tts', '2027-01-06'], ['stt', '2027-02-26']])
  assert.equal(retirementNotes({ type: 'openai', models: { tts: 'tts-1-hd', stt: 'gpt-transcribe' } }).length, 1)
  assert.equal(retirementNotes({ type: 'openai', models: { stt: 'gpt-4o-mini-transcribe-2025-03-20' } })[0].on, '2027-01-20')
  assert.equal(retirementNotes({ type: 'openai', models: { stt: 'gpt-4o-transcribe-diarize' } })[0].on, '2027-02-26')
  assert.equal(retirementNotes({ type: 'openai-compatible', baseUrl: 'https://eu.api.openai.com/v1', models: { tts: 'tts-1' } }).length, 1)
  // a self-hosted openedai-speech also calls its model tts-1: no note
  assert.equal(retirementNotes({ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1', models: { tts: 'tts-1' } }).length, 0)
  assert.equal(retirementNotes({ type: 'mistral', models: { tts: 'tts-1' } }).length, 0)
  for (const x of n) assert.ok(!/[\u2013\u2014]/.test(x.text))
})

function loadComponents() {
  let React
  let renderToString
  try { React = require('react'); ({ renderToString } = require('react-dom/server')) } catch (e) { return null }
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
  // no ctx.inject at all: the optional sidebar path must not be required
  mod.apply({ slots: { inject: (s, fn) => fn(), register: (meta, c) => { comps[meta.id] = c } } })
  return { React, renderToString, comps, window }
}

test('Settings > Voice renders providers grouped EU first, Others, Self-hosted, with the retirement note', async () => {
  const L = loadComponents()
  if (!L) return
  const v = await voiceServer({ MISTRAL_API_KEY: 'k-test', TTS_API_KEY: 'k-test' }, {
    config: { providers: [{ id: 'openai', type: 'openai', label: 'OpenAI', credential: 'env:OPENAI_API_KEY', models: { tts: 'tts-1', stt: 'whisper-1' } }] },
  })
  try {
    const view = (await v.call('GET', '/settings')).json
    assert.equal(view.ok, true)
    const oa = view.instances.find((i) => i.id === 'openai')
    assert.equal(oa.notices.length, 2)
    globalThis.window = L.window
    let html
    try { html = L.renderToString(L.React.createElement(L.comps['voice-settings'], { __testView: view })) } finally { delete globalThis.window }
    const eu = html.indexOf('aria-label="EU first"')
    const other = html.indexOf('aria-label="Others"')
    const self = html.indexOf('aria-label="Self-hosted"')
    assert.ok(eu > 0 && other > eu && self > other, 'groups in order')
    assert.ok(html.indexOf('Mistral') > eu && html.indexOf('Mistral') < other, 'Mistral in the EU group')
    assert.match(html, /data-voice-notice="retirement"/)
    assert.match(html, /OpenAI retires tts-1 on 2027-01-06/)
    assert.match(html, /Add provider/)
    assert.ok(!html.includes('k-test'), 'no secret in the rendered page')
  } finally { await v.close() }
})
