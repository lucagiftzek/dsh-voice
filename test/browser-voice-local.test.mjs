// The browser voice and the browser-voice fallback use on-device voices only:
// Chrome's online voices (localService false) send the text to Google.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const spoken = []
let voices = []
const listeners = {}
globalThis.window = globalThis.window || {}
const synth = {
  speaking: false, paused: false,
  getVoices: () => voices,
  addEventListener: (n, f) => { listeners[n] = f },
  cancel() {}, pause() {}, resume() {},
  speak(u) { spoken.push(u); setTimeout(() => u.onend && u.onend(), 0) },
}
window.speechSynthesis = synth
window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t } }
window.localStorage = window.localStorage || { getItem: () => null, setItem() {} }
globalThis.localStorage = globalThis.localStorage || window.localStorage

const V = (name, lang, local, dflt = false) => ({ name, lang, localService: local, default: dflt })
const ONLINE = [V('Google UK English Female', 'en-GB', false), V('Google italiano', 'it-IT', false)]
const LOCAL = [V('eSpeak English', 'en-US', true, true), V('Alice', 'it-IT', true), V('Melina', 'el-GR', true)]

const player = await import('../src/client/player.js')

test('localVoice never returns an online voice', () => {
  assert.equal(player.localVoice('it', ONLINE), null)
  assert.equal(player.localVoice('', ONLINE), null)
})

test('localVoice prefers the language, then the device default', () => {
  const all = ONLINE.concat(LOCAL)
  assert.equal(player.localVoice('it-IT', all).name, 'Alice')
  assert.equal(player.localVoice('el', all).name, 'Melina')
  assert.equal(player.localVoice('en_GB', all).name, 'eSpeak English')
  assert.equal(player.localVoice('ja', all).name, 'eSpeak English')
})

test('no local voice: speakBrowser and speakBrowserSegments refuse, nothing is spoken', () => {
  voices = ONLINE; listeners.voiceschanged && listeners.voiceschanged()
  spoken.length = 0
  assert.equal(player.speakBrowser('Ciao a tutti.', 'it'), false)
  assert.equal(player.speakBrowserSegments([{ text: 'Hello.', lang: 'en' }], () => {}), false)
  assert.equal(spoken.length, 0)
  assert.equal(player.hasLocalVoice(), false)
})

test('local voices: every utterance carries an on-device voice', async () => {
  voices = ONLINE.concat(LOCAL); listeners.voiceschanged && listeners.voiceschanged()
  spoken.length = 0
  let done = false
  assert.equal(player.speakBrowserSegments([{ text: 'Ciao. Come stai?', lang: 'it' }, { text: 'Hello.', lang: 'en' }], () => { done = true }), true)
  for (let i = 0; i < 20 && !done; i += 1) await new Promise((r) => setTimeout(r, 5))
  assert.equal(done, true)
  assert.ok(spoken.length >= 2)
  for (const u of spoken) assert.equal(u.voice.localService, true)
  assert.equal(spoken[0].voice.name, 'Alice')
})
