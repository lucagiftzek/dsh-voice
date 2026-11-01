import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import { mockWsServer } from './ws-helper.mjs'
import cartesia, { API_VERSION } from '../lib/server/providers/cartesia.js'

const NODASH = /[\u2013\u2014]/
const PCM = Buffer.alloc(4800, 1) // 0.1 s at 24 kHz mono 16 bit
const field = (req, name) => {
  const m = new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)\\r\\n').exec(req.body.toString('latin1'))
  return m ? m[1] : null
}

test('cartesia: metadata sanity', () => {
  assert.equal(cartesia.type, 'cartesia')
  assert.equal(cartesia.group, 'other')
  assert.ok(['non-eu', 'eu-region', 'varies'].includes(cartesia.residency))
  assert.ok(cartesia.desc.length < 140)
  for (const s of [cartesia.desc, cartesia.euNote, cartesia.verification, cartesia.label]) assert.ok(!NODASH.test(s))
  assert.ok(cartesia.docs.startsWith('https://'))
  assert.ok(['verified', 'partial', 'unverified', 'planned'].includes(cartesia.status))
  assert.ok(cartesia.presets.length > 0 && cartesia.presets.every((p) => p.id))
  assert.equal(cartesia.defaultBaseUrl, 'https://api.cartesia.ai')
  assert.equal(API_VERSION, '2026-08-14')
  assert.ok(cartesia.optionFields.some((f) => f.key === 'wordTimestamps' && f.type === 'bool' && f.default === true))
})

test('cartesia: capabilities are truthful', () => {
  const c = cartesia.capabilities(inst())
  assert.equal(c.tts, true)
  assert.equal(c.stt, true)
  assert.equal(c.ttsLangs.length, 44)
  for (const l of ['el', 'it', 'en']) { assert.ok(c.ttsLangs.includes(l)); assert.ok(c.sttLangs.includes(l)) }
  assert.ok(c.ttsLangs.every((l) => /^[a-z]{2}$/.test(l)) && c.sttLangs.every((l) => /^[a-z]{2}$/.test(l)))
  assert.equal(c.alignment, 'word')
  assert.deepEqual(c.nativeSpeed, [0.6, 1.5])
  assert.equal(cartesia.capabilities(inst({ options: { wordTimestamps: false } })).alignment, 'none')
  assert.equal(cartesia.configured(inst()), true)
  assert.equal(cartesia.configured(inst({ key: '' })), false)
})

test('cartesia: tts bytes request shape and audio', async () => {
  const wav = wavBuffer(2400)
  const m = await mockServer((r, res) => reply(res, 200, wav, { 'content-type': 'audio/wav' }))
  try {
    const i = inst({ baseUrl: m.origin, key: 'fake-key-0000', defaultVoice: 'v-default' })
    const out = await cartesia.tts({ text: 'Ciao mondo', lang: 'it', speed: 1.2 }, i)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/tts/bytes')
    assert.equal(typeof r.headers['x-api-key'], 'string')
    assert.ok(r.headers['x-api-key'].length > 0)
    assert.equal(r.headers['cartesia-version'], '2026-08-14')
    const b = r.json()
    assert.equal(b.model_id, 'sonic-3.6')
    assert.equal(b.transcript, 'Ciao mondo')
    assert.deepEqual(b.voice, { id: 'v-default' })
    assert.equal(b.language, 'it')
    assert.deepEqual(b.output_format, { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 })
    assert.deepEqual(b.generation_config, { speed: 1.2 })
    assert.deepEqual(out.audio, wav)
    assert.equal(out.mime, 'audio/wav')
    assert.equal(out.alignment, null)
    assert.equal(out.voice, 'v-default')
    assert.equal(out.billedChars, 10)
    assert.ok(out.durationS > 0)
  } finally { await m.close() }
})

test('cartesia: unsupported language is rejected locally', async () => {
  const i = inst({ baseUrl: 'http://127.0.0.1:1' })
  await assert.rejects(cartesia.tts({ text: 'x', lang: 'xx' }, i), (e) => e.code === 'unsupported_lang' && e.status === 400)
})

test('cartesia: word timestamps over the websocket, offsets index the sent text', async () => {
  const text = 'Hello world, again'
  let first = null
  const ws = await mockWsServer((conn) => {
    conn.on('message', (data) => {
      first = JSON.parse(String(data))
      const ctx = first.context_id
      conn.sendText(JSON.stringify({ type: 'chunk', data: PCM.slice(0, 2400).toString('base64'), done: false, status_code: 206, step_time: 1, context_id: ctx }))
      conn.sendText(JSON.stringify({ type: 'timestamps', done: false, status_code: 206, context_id: ctx, word_timestamps: { words: ['Hello', 'world,'], start: [0, 0.5], end: [0.4, 0.9] } }))
      conn.sendText(JSON.stringify({ type: 'chunk', data: PCM.slice(2400).toString('base64'), done: false, status_code: 206, step_time: 1, context_id: ctx }))
      conn.sendText(JSON.stringify({ type: 'timestamps', done: false, status_code: 206, context_id: ctx, word_timestamps: { words: ['again'], start: [1.0], end: [1.3] } }))
      conn.sendText(JSON.stringify({ type: 'done', done: true, status_code: 206, context_id: ctx }))
    })
  })
  try {
    const i = inst({ baseUrl: ws.origin.replace('ws://', 'http://') })
    const out = await cartesia.tts({ text, lang: 'en', wantAlignment: true }, i)
    const up = ws.reqs[0]
    assert.equal(up.path, '/tts/websocket')
    assert.ok(up.query.includes('cartesia_version=2026-08-14'))
    assert.ok(typeof up.headers['x-api-key'] === 'string' && up.headers['x-api-key'].length > 0)
    assert.equal(first.add_timestamps, true)
    assert.equal(first.continue, false)
    assert.deepEqual(first.voice, { id: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4' })
    assert.deepEqual(first.output_format, { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 })
    assert.equal(out.mime, 'audio/wav')
    assert.equal(out.audio.slice(0, 4).toString('latin1'), 'RIFF')
    assert.equal(out.audio.length, 44 + PCM.length)
    assert.equal(out.alignment.unit, 'word')
    const it = out.alignment.items
    assert.equal(it.length, 3)
    assert.deepEqual(it.map((w) => text.slice(w.c0, w.c1)), ['Hello', 'world,', 'again'])
    for (let k = 0; k < it.length; k += 1) {
      assert.ok(it[k].t1 >= it[k].t0)
      if (k) assert.ok(it[k].t0 >= it[k - 1].t0)
    }
    assert.ok(Math.abs(out.durationS - 0.1) < 1e-9)
  } finally { await ws.close() }
})

test('cartesia: socket failure falls back to bytes with alignment null', async () => {
  const wav = wavBuffer(800)
  const m = await mockServer((r, res) => reply(res, 200, wav, { 'content-type': 'audio/wav' }))
  try {
    // the plain HTTP mock refuses the websocket upgrade (404), so the adapter falls back
    const i = inst({ baseUrl: m.origin })
    const out = await cartesia.tts({ text: 'fallback please', wantAlignment: true }, i)
    assert.equal(out.alignment, null)
    assert.ok(/plain endpoint/.test(out.note))
    assert.deepEqual(out.audio, wav)
    assert.ok(m.reqs.some((r) => r.path === '/tts/bytes'))
  } finally { await m.close() }
})

test('cartesia: wordTimestamps false never opens a socket', async () => {
  const wav = wavBuffer(800)
  const m = await mockServer((r, res) => reply(res, 200, wav, { 'content-type': 'audio/wav' }))
  const ws = await mockWsServer(() => {})
  try {
    const i = inst({ baseUrl: m.origin, options: { wordTimestamps: false } })
    const out = await cartesia.tts({ text: 'no socket', wantAlignment: true }, i)
    assert.equal(out.alignment, null)
    assert.equal(ws.reqs.length, 0)
    assert.equal(m.reqs.length, 1)
  } finally { await m.close(); await ws.close() }
})

test('cartesia: error mapping 401 429 5xx and bad voice', async () => {
  const m = await mockServer((r, res) => {
    const t = (r.json() || {}).transcript
    if (t === 'k') return reply(res, 401, { title: 'Unauthorized', message: 'bad key', error_code: 'unauthorized', status_code: 401 })
    if (t === 'q') return reply(res, 429, { title: 'Too many', message: 'slow down', status_code: 429 })
    if (t === 'v') return reply(res, 400, { title: 'Voice', message: 'Voice not found', error_code: 'voice_not_found', status_code: 400 })
    if (t === 'l') return reply(res, 400, { title: 'Lang', message: 'language not supported', error_code: 'language_invalid', status_code: 400 })
    return reply(res, 503, { title: 'Down', message: 'try later' })
  })
  try {
    const i = inst({ baseUrl: m.origin })
    await assert.rejects(cartesia.tts({ text: 'k' }, i), (e) => e.code === 'bad_key' && e.status === 502 && !/fake-key/.test(e.message))
    await assert.rejects(cartesia.tts({ text: 'q' }, i), (e) => e.code === 'quota_exceeded' && e.status === 429)
    await assert.rejects(cartesia.tts({ text: 'v', voice: 'nope' }, i), (e) => e.code === 'bad_voice' && e.status === 400)
    await assert.rejects(cartesia.tts({ text: 'l' }, i), (e) => e.code === 'unsupported_lang' && e.status === 400)
    await assert.rejects(cartesia.tts({ text: 'z' }, i), (e) => e.code === 'vendor' && e.status === 502)
  } finally { await m.close() }
})

test('cartesia: a websocket error message maps to a typed error (bad voice is not retried over bytes)', async () => {
  const ws = await mockWsServer((conn) => {
    conn.on('message', (data) => {
      const ctx = JSON.parse(String(data)).context_id
      conn.sendText(JSON.stringify({ type: 'error', done: true, title: 'Voice', message: 'Voice not found', error_code: 'voice_not_found', status_code: 400, context_id: ctx }))
    })
  })
  try {
    const i = inst({ baseUrl: ws.origin.replace('ws://', 'http://') })
    await assert.rejects(cartesia.tts({ text: 'x', voice: 'nope', wantAlignment: true }, i), (e) => e.code === 'bad_voice')
  } finally { await ws.close() }
})

test('cartesia: stt multipart request and parsed words', async () => {
  const m = await mockServer((r, res) => reply(res, 200, {
    type: 'transcript', request_id: 'r1', text: ' Καλημέρα κόσμε ', language: 'el', duration: 1.5,
    words: [{ word: 'Καλημέρα', start: 0.1, end: 0.6 }, { word: 'κόσμε', start: 0.7, end: 1.2 }],
  }))
  try {
    const i = inst({ baseUrl: m.origin })
    const out = await cartesia.stt({ audio: wavBuffer(800), name: 'clip.wav', mime: 'audio/wav', lang: 'el' }, i)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/stt')
    assert.ok(r.headers['content-type'].startsWith('multipart/form-data'))
    assert.ok(r.headers['x-api-key'].length > 0)
    assert.equal(r.headers['cartesia-version'], '2026-08-14')
    assert.equal(field(r, 'model'), 'ink-whisper')
    assert.equal(field(r, 'language'), 'el')
    assert.equal(field(r, 'timestamp_granularities\\[\\]'), 'word')
    assert.equal(out.text, 'Καλημέρα κόσμε')
    assert.equal(out.language, 'el')
    assert.deepEqual(out.words, [{ w: 'Καλημέρα', t0: 0.1, t1: 0.6 }, { w: 'κόσμε', t0: 0.7, t1: 1.2 }])
    assert.equal(out.durationS, 1.5)
  } finally { await m.close() }
})

test('cartesia: stt error mapping', async () => {
  const m = await mockServer((r, res) => reply(res, r.headers['x-api-key'] === 'fake-q' ? 429 : 401, { message: 'no' }))
  try {
    await assert.rejects(cartesia.stt({ audio: wavBuffer(100) }, inst({ baseUrl: m.origin })), (e) => e.code === 'bad_key')
    await assert.rejects(cartesia.stt({ audio: wavBuffer(100) }, inst({ baseUrl: m.origin, key: 'fake-q' })), (e) => e.code === 'quota_exceeded')
  } finally { await m.close() }
})

test('cartesia: listVoices parses, paginates and caches', async () => {
  const pages = {
    '': { data: [{ id: 'v1', name: 'Skylar', tagline: 'Friendly', gender: 'feminine', language: 'en', accents: [{ accent: 'general-american', locale: 'en-US', is_native: true }, { accent: 'italian', locale: 'it-IT', is_native: false }] }], has_more: true, next_page: 'v1' },
    v1: { data: [{ id: 'v2', name: 'Nikos', tagline: '', gender: 'masculine', language: 'el', accents: [{ accent: 'greek', locale: 'el-GR', is_native: true }] }], has_more: false },
  }
  const m = await mockServer((r, res) => {
    const after = new URL(r.url, 'http://x').searchParams.get('starting_after') || ''
    reply(res, 200, pages[after] || { data: [], has_more: false })
  })
  try {
    const i = inst({ baseUrl: m.origin })
    const all = await cartesia.listVoices(i, {})
    assert.equal(all.length, 2)
    assert.deepEqual(all[0], { id: 'v1', name: 'Skylar', langs: ['en'], gender: 'female', accent: 'general-american', tags: ['Friendly'] })
    assert.deepEqual(all[1].langs, ['el'])
    assert.equal(all[1].gender, 'male')
    assert.equal(m.reqs.length, 2)
    assert.equal(m.reqs[0].path, '/voices')
    assert.equal(m.reqs[0].headers['cartesia-version'], '2026-08-14')
    const el = await cartesia.listVoices(i, { lang: 'el' })
    assert.equal(el[0].id, 'v2')
    assert.equal(m.reqs.length, 2) // cached
  } finally { await m.close() }
})

test('cartesia: health with a probe, rejected key, and without a key', async () => {
  const m = await mockServer((r, res) => (r.headers['x-api-key'] === 'fake-bad' ? reply(res, 401, { message: 'no' }) : reply(res, 200, { data: [], has_more: false })))
  try {
    const up = await cartesia.health(inst({ baseUrl: m.origin }))
    assert.equal(up.ok, true)
    assert.equal(up.status, 'up')
    assert.equal(m.reqs[0].path, '/voices')
    const down = await cartesia.health(inst({ baseUrl: m.origin, key: 'fake-bad' }))
    assert.equal(down.ok, false)
    assert.equal(down.status, 'down')
    const nokey = await cartesia.health(inst({ baseUrl: m.origin, key: '' }))
    assert.equal(nokey.ok, false)
    assert.equal(m.reqs.length, 2)
  } finally { await m.close() }
})

test('cartesia: the default base url is used when none is set (no network)', async () => {
  // configured() and capabilities() never touch the network
  assert.equal(cartesia.configured(inst({ baseUrl: '' })), true)
})
