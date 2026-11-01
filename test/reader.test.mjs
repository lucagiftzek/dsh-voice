// Client highlight progression with fake timings: the real reader, player and
// highlighter against a fake DOM, a fake <audio> clock and a fake /tts.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------- fake DOM
class TextNode { constructor(v, p) { this.nodeValue = v; this.parentElement = p; this.nodeType = 3 } }
class El {
  constructor(tag, kids, attrs) {
    this.tagName = tag.toUpperCase(); this.attrs = attrs || {}; this.childNodes = []; this.isConnected = true; this.parentElement = null
    for (const k of kids || []) { const n = typeof k === 'string' ? new TextNode(k, this) : k; if (n instanceof El) n.parentElement = this; this.childNodes.push(n) }
  }
  hasAttribute(n) { return n in this.attrs }
  get textContent() { return this.childNodes.map((c) => (c instanceof El ? c.textContent : c.nodeValue)).join('') }
  scrollIntoView() { scrolls += 1 }
}
let scrolls = 0
const textNodesOf = (root) => { const out = []; const walk = (e) => e.childNodes.forEach((c) => (c instanceof El ? walk(c) : out.push(c))); walk(root); return out }
let ROOT = null
function rangeText(r) {
  const all = textNodesOf(ROOT)
  const a = all.indexOf(r.sn)
  const b = all.indexOf(r.en)
  if (a === b) return r.sn.nodeValue.slice(r.so, r.eo)
  let s = r.sn.nodeValue.slice(r.so)
  for (let i = a + 1; i < b; i += 1) s += all[i].nodeValue
  return s + r.en.nodeValue.slice(0, r.eo)
}
const frames = []
const audios = []
const fetches = []
class FakeAudio {
  constructor(url) { this.src = url; this.currentTime = 0; this.duration = NaN; this.playbackRate = 1; this.paused = true; this.tagName = 'AUDIO' }
  play() { this.paused = false; if (audios.indexOf(this) < 0) audios.push(this); return Promise.resolve() }
  pause() { this.paused = true }
}
const store = new Map()

before(() => {
  globalThis.document = {
    createTreeWalker(root, what, filter) {
      const list = textNodesOf(root).filter((n) => filter.acceptNode(n) === 1)
      let i = 0
      return { nextNode: () => (i < list.length ? list[i++] : null) }
    },
    createRange() { return { setStart(n, o) { this.sn = n; this.so = o }, setEnd(n, o) { this.en = n; this.eo = o }, get startContainer() { return this.sn }, getBoundingClientRect() { return { top: 2000, bottom: 2020 } } } },
    getElementById() { return null }, createElement() { return {} }, head: { appendChild() {} }, documentElement: { clientHeight: 800 },
  }
  globalThis.window = {
    CSS: { highlights: new Map() }, Highlight: class { constructor(r) { this.r = r } },
    innerHeight: 800, matchMedia: () => ({ matches: true }), addEventListener() {},
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length }, cancelAnimationFrame() {},
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    Audio: FakeAudio, atob: globalThis.atob, Blob: globalThis.Blob, setTimeout, clearTimeout,
  }
  globalThis.fetch = async (url, opts) => {
    fetches.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null })
    if (String(url).startsWith('/api/voice/tts?alignment=1')) {
      const text = JSON.parse(opts.body).text
      // one word per 0.5 s, in the sent text's offsets
      const items = []
      const re = /\S+/g
      let m
      let t = 0
      while ((m = re.exec(text))) { items.push({ c0: m.index, c1: m.index + m[0].length, t0: t, t1: t + 0.4 }); t += 0.5 }
      const body = { ok: true, engine: 'elevenlabs', mime: 'audio/mpeg', audio_base64: Buffer.from('ID3fake').toString('base64'), alignment: { unit: 'word', items } }
      return { ok: true, status: 200, headers: { get: (h) => (h === 'content-type' ? 'application/json' : h === 'x-voice-engine' ? 'elevenlabs' : null) }, json: async () => body }
    }
    return { ok: true, status: 200, headers: { get: (h) => (h === 'content-type' ? 'audio/mpeg' : h === 'x-voice-engine' ? 'mistral' : null) }, blob: async () => new Blob(['ID3x'], { type: 'audio/mpeg' }) }
  }
})

const flush = async (n) => { for (let i = 0; i < (n || 20); i += 1) await new Promise((r) => setImmediate(r)) }
async function until(cond) { for (let i = 0; i < 300; i += 1) { if (cond()) return; await new Promise((r) => setImmediate(r)) } throw new Error('timed out waiting') }
function runFrames() { const f = frames.splice(0); f.forEach((fn) => fn()) }
const hl = (name) => { const h = window.CSS.highlights.get(name); return h ? rangeText(h.r) : null }

function message(texts) {
  const row = new El('span', ['\ud83d\udd0a'], { 'data-dsh-voice-ui': '1' })
  ROOT = new El('div', texts.map((t) => new El('p', [t])).concat([row]))
  return ROOT
}

const CFG = (over) => Object.assign({
  engines: { mistral: { v2: { alignment: 'none' } }, elevenlabs: { v2: { alignment: 'char' } } },
  routes: { en: { tts: 'mistral' } }, reading: { highlight: 'word' }, detection: { mode: 'heuristic' }, markers: { enabled: true },
}, over || {})

test('estimated timings: sentence and word follow the clock through pause, resume, seek and speed', async () => {
  const reader = await import('../src/client/reader.js')
  const container = message(['Hello world. ', 'This is a **test**.'.replace(/\*/g, '')])
  reader.read({ messageId: 'm1', md: 'Hello world. This is a **test**.', cfg: CFG(), engine: 'mistral', prefs: {}, getContainer: () => container })
  await until(() => audios.length === 1)
  const a = audios[0]
  await flush()
  assert.equal(reader.getNow().state, 'speaking')
  assert.equal(reader.getNow().lang, 'en')
  assert.equal(fetches[0].url, '/api/voice/tts', 'no alignment request for an engine without timings')
  assert.equal(fetches[0].body.lang, 'en')
  a.duration = 3
  a.currentTime = 0.05; runFrames()
  assert.equal(hl('dsh-voice-word'), 'Hello')
  assert.equal(hl('dsh-voice-sentence'), 'Hello world.')
  a.currentTime = 2.7; runFrames()
  assert.equal(hl('dsh-voice-word'), 'test.'.replace('.', ''))
  assert.equal(hl('dsh-voice-sentence'), 'This is a test.')
  // pause: the clock stops, the highlight holds
  reader.togglePause()
  assert.equal(reader.getNow().state, 'paused')
  assert.equal(a.paused, true)
  runFrames(); runFrames()
  assert.equal(hl('dsh-voice-word'), 'test')
  reader.togglePause()
  assert.equal(reader.getNow().state, 'speaking')
  // previous sentence: back to the first one
  reader.skipSentence(-1)
  assert.equal(a.currentTime, 0)
  runFrames()
  assert.equal(hl('dsh-voice-sentence'), 'Hello world.')
  // speed change: the media clock simply runs faster
  a.playbackRate = 2
  a.currentTime = 1.9; runFrames()
  assert.equal(hl('dsh-voice-sentence'), 'This is a test.')
  assert.ok(scrolls >= 1, 'out-of-view sentence scrolled into view')
  // end of audio: highlight cleared, idle
  a.onended()
  await flush()
  assert.equal(window.CSS.highlights.size, 0)
  assert.equal(reader.getNow().state, 'idle')
})

test('provider timings: auto routes to an aligned engine, /tts?alignment=1 drives the word highlight', async () => {
  const reader = await import('../src/client/reader.js')
  audios.length = 0
  fetches.length = 0
  const container = message(['One two three four.'])
  reader.read({ messageId: 'm2', md: 'One two three four.', cfg: CFG({ routes: { en: { tts: 'elevenlabs' } } }), engine: 'auto', prefs: {}, getContainer: () => container })
  await until(() => audios.length === 1)
  await flush()
  assert.equal(fetches[0].url, '/api/voice/tts?alignment=1')
  const a = audios[0]
  a.currentTime = 1.1; runFrames()
  assert.equal(hl('dsh-voice-word'), 'three')
  a.currentTime = 1.6; runFrames()
  assert.equal(hl('dsh-voice-word'), 'four')
  reader.stop()
  assert.equal(window.CSS.highlights.size, 0)
})

test('sentence-only highlight and markers: no word highlight, segment language per chunk', async () => {
  const reader = await import('../src/client/reader.js')
  audios.length = 0
  fetches.length = 0
  const container = message(['Read this please now. ', 'Γεια σας φίλοι μου.'])
  reader.read({ messageId: 'm3', md: 'Read this please now. [[el]]Γεια σας φίλοι μου.[[/]]', cfg: CFG({ reading: { highlight: 'sentence' }, routes: { en: { tts: 'mistral' }, el: { tts: 'local' } } }), engine: 'auto', prefs: {}, getContainer: () => container })
  await until(() => audios.length === 1)
  await flush()
  assert.equal(fetches[0].body.lang, 'en')
  audios[0].duration = 2; audios[0].currentTime = 0.5; runFrames()
  assert.equal(hl('dsh-voice-word'), null)
  assert.equal(hl('dsh-voice-sentence'), 'Read this please now.')
  audios[0].onended()
  await until(() => audios.length === 2)
  await flush()
  assert.equal(fetches[1].body.lang, 'el')
  assert.equal(reader.getNow().lang, 'el')
  assert.equal(reader.getNow().langSource, 'marker')
  audios[1].duration = 2; audios[1].currentTime = 1; runFrames()
  assert.equal(hl('dsh-voice-sentence'), 'Γεια σας φίλοι μου.')
  reader.stop()
})

test('auto-read queues behind a read and typing (stopAuto) clears it', async () => {
  const reader = await import('../src/client/reader.js')
  audios.length = 0
  const container = message(['First reply here.'])
  reader.read({ messageId: 'm4', md: 'First reply here.', cfg: CFG(), engine: 'mistral', prefs: {}, getContainer: () => container })
  await until(() => audios.length === 1)
  reader.read({ messageId: 'm5', md: 'Second reply here.', cfg: CFG(), engine: 'mistral', prefs: {}, auto: true, getContainer: () => container }, { replace: false })
  assert.equal(reader.queueLength(), 1)
  assert.equal(reader.getNow().queued, 1)
  reader.stopAuto()
  assert.equal(reader.queueLength(), 0)
  assert.equal(reader.getNow().state, 'speaking', 'a manual read keeps playing')
  reader.stop()
  assert.equal(reader.getNow().state, 'idle')
})

test('auto-read: an empty chat followed by an older chat does not read history', async () => {
  const { createAutoRead } = await import('../src/client/autoread.js')
  const ar = createAutoRead()
  const snap = (ids) => ({ legacy: { nodes: ids.map((id) => ({ kind: 'assistant', messageId: id })) } })
  ar.observe(snap([]))
  ar.observe(snap(['old1', 'old2']))
  assert.equal(ar.take('old2', 'new-replies'), false)
})
