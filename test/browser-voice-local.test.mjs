// The browser voice and the browser-voice fallback use on-device voices and the natural
// (Natural / Neural) cloud voices of Edge and Windows; ordinary online voices such as Chrome's
// "Google ..." ones (localService false) send the text to Google and are never picked.
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

// Windows 11 + Edge (issue #1): the natural zh-CN voices are cloud voices (localService false)
const WIN = [
  V('Microsoft Huihui - Chinese (Simplified, PRC)', 'zh-CN', true), V('Microsoft Kangkang - Chinese (Simplified, PRC)', 'zh-CN', true),
  V('Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', 'zh-CN', false), V('Microsoft Yunxi Online (Natural) - Chinese (Mainland)', 'zh-CN', false),
  V('Microsoft David - English (United States)', 'en-US', true, true), V('Microsoft Aria Online (Natural) - English (United States)', 'en-US', false),
]

test('a natural cloud voice of the language beats the mechanical offline one, the offline one stays the fallback', () => {
  assert.match(player.localVoice('zh-CN', WIN).name, /Xiaoxiao Online \(Natural\)/)
  assert.match(player.localVoice('zh', WIN).name, /Natural/)
  assert.match(player.localVoice('en-US', WIN).name, /Aria Online \(Natural\)/)
  const offlineOnly = WIN.filter((v) => v.localService)
  assert.match(player.localVoice('zh-CN', offlineOnly).name, /Huihui/)
  assert.equal(player.localVoice('ja', WIN).name, 'Microsoft David - English (United States)') // no ja voice: the device default, never a cloud voice of another language
})

test('ordinary online voices (no Natural or Neural in the name) are still never picked', () => {
  const mixed = [V('Google 普通话（中国大陆）', 'zh-CN', false), V('Microsoft Huihui', 'zh-CN', true)]
  assert.equal(player.localVoice('zh-CN', mixed).name, 'Microsoft Huihui')
  assert.equal(player.localVoice('zh-CN', [V('Google 普通话', 'zh-CN', false)]), null)
})

test('a configured voice name wins (exact, then part of the name), an unknown name is ignored', () => {
  assert.match(player.localVoice('zh-CN', WIN, 'Microsoft Yunxi Online (Natural) - Chinese (Mainland)').name, /Yunxi/)
  assert.match(player.localVoice('zh-CN', WIN, 'yunxi').name, /Yunxi/)
  assert.match(player.localVoice('zh-CN', WIN, 'af_heart').name, /Xiaoxiao/)
  assert.equal(player.localVoice('zh-CN', [V('Google 普通话', 'zh-CN', false)], 'google 普通话').name, 'Google 普通话')
})

test('speakBrowser uses the natural voice and honours hooks.voice', async () => {
  voices = WIN; listeners.voiceschanged && listeners.voiceschanged()
  spoken.length = 0
  assert.equal(player.speakBrowser('你好。', 'zh-CN'), true)
  await new Promise((r) => setTimeout(r, 10))
  assert.match(spoken[0].voice.name, /Xiaoxiao/)
  spoken.length = 0
  assert.equal(player.speakBrowser('你好。', 'zh-CN', null, { voice: 'Kangkang' }), true)
  await new Promise((r) => setTimeout(r, 10))
  assert.match(spoken[0].voice.name, /Kangkang/)
})

test('reader: browserVoiceName reads perLanguage.<lang>.tts.voice, then *', async () => {
  const { browserVoiceName } = await import('../src/client/reader.js')
  const cfg = { perLanguage: { zh: { tts: { provider: 'browser', voice: ' Xiaoyi ' } }, '*': { tts: { provider: 'auto', voice: 'Aria' } } } }
  assert.equal(browserVoiceName(cfg, 'zh-CN'), 'Xiaoyi')
  assert.equal(browserVoiceName(cfg, 'it'), 'Aria')
  assert.equal(browserVoiceName({}, 'it'), '')
  assert.equal(browserVoiceName(null, 'it'), '')
})
