import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import a from '../lib/server/providers/openai-compatible.js'
import { checkMeta } from './_meta.mjs'

const AUDIO = Buffer.from('FAKEAUDIOBYTES-0123456789')
const field = (req, name) => {
  const m = new RegExp('name="' + name.replace(/[[\]]/g, '\\$&') + '"\\r\\n\\r\\n([^\\r]*)\\r\\n').exec(req.body.toString('latin1'))
  return m ? m[1] : null
}

test('openai-compatible: metadata and presets', () => {
  checkMeta(a, { group: 'other', residency: 'varies' })
  const ids = a.presets.map((p) => p.id)
  for (const id of ['groq', 'openai', 'openai-eu', 'kokoro-fastapi', 'speaches', 'localai', 'openedai-speech', 'ovh']) assert.ok(ids.includes(id))
  const by = (id) => a.presets.find((p) => p.id === id)
  assert.equal(by('openai-eu').residency, 'eu-region')
  assert.equal(by('kokoro-fastapi').group, 'self')
  assert.equal(by('ovh').group, 'eu')
  assert.equal(by('ovh').residency, 'eu')
  assert.equal(by('groq').options.tts, false)
})

test('openai-compatible: capabilities truthful', () => {
  const kokoro = a.presets.find((p) => p.id === 'kokoro-fastapi')
  const c = a.capabilities(inst({ options: kokoro.options }))
  assert.deepEqual(c.ttsLangs, ['en', 'es', 'fr', 'hi', 'it', 'ja', 'pt', 'zh'])
  assert.ok(!c.ttsLangs.includes('el'))
  assert.equal(c.stt, false)
  assert.equal(c.alignment, 'word')
  const g = a.capabilities(inst({ options: { stt: true, tts: false } }))
  assert.equal(g.tts, false)
  assert.equal(g.alignment, 'none')
  assert.equal(g.sttLangs, '*')
  assert.deepEqual(a.capabilities(inst({ options: { tts: true, ttsLangs: 'en, it' } })).ttsLangs, ['en', 'it'])
})

test('openai-compatible: residencyOf and configured', () => {
  assert.equal(a.residencyOf({ baseUrl: 'https://eu.api.openai.com/v1' }), 'eu-region')
  assert.equal(a.residencyOf({ baseUrl: 'http://127.0.0.1:8880/v1' }), 'self')
  assert.equal(a.residencyOf({ baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1' }), 'eu')
  assert.equal(a.configured(inst({})), true)
  assert.equal(a.configured(inst({ key: '', options: {} })), false)
  assert.equal(a.configured(inst({ key: '', options: { keyless: true } })), true)
})

test('openai-compatible: tts request shape, format and speed', async () => {
  const m = await mockServer((r, res) => reply(res, 200, AUDIO))
  try {
    const i = inst({ baseUrl: m.origin + '/v1', defaultVoice: 'af_heart', models: { tts: 'kokoro' }, options: { tts: true, format: 'wav' } })
    const out = await a.tts({ text: 'Hello there', speed: 1.5 }, i)
    assert.deepEqual(out.audio, AUDIO)
    assert.equal(out.voice, 'af_heart')
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/v1/audio/speech')
    assert.ok(r.headers.authorization.startsWith('Bearer '))
    assert.deepEqual(r.json(), { model: 'kokoro', input: 'Hello there', voice: 'af_heart', response_format: 'wav', speed: 1.5 })
    await a.tts({ text: 'x' }, inst({ baseUrl: m.origin + '/v1', key: '', options: { tts: true } }))
    assert.equal(m.reqs[1].headers.authorization, undefined)
    assert.equal(m.reqs[1].json().speed, undefined)
  } finally { await m.close() }
})

test('openai-compatible: kokoro captioned speech gives word alignment on the sent text', async () => {
  const text = 'Hello world again'
  const m = await mockServer((r, res) => reply(res, 200, {
    audio: AUDIO.toString('base64'),
    timestamps: [{ word: 'Hello', start_time: 0.1, end_time: 0.4 }, { word: 'world', start_time: 0.5, end_time: 0.9 }, { word: 'again', start_time: 1.0, end_time: 1.5 }],
  }))
  try {
    const i = inst({ baseUrl: m.origin + '/v1', models: { tts: 'kokoro' }, defaultVoice: 'af_bella', options: { tts: true, captions: true } })
    const out = await a.tts({ text, wantAlignment: true }, i)
    assert.deepEqual(out.audio, AUDIO)
    assert.equal(m.reqs[0].path, '/dev/captioned_speech')
    assert.equal(m.reqs[0].json().stream, false)
    assert.equal(out.alignment.unit, 'word')
    const it = out.alignment.items
    assert.deepEqual(it.map((x) => text.slice(x.c0, x.c1)), ['Hello', 'world', 'again'])
    for (let k = 1; k < it.length; k += 1) assert.ok(it[k].t0 >= it[k - 1].t1 - 1e-9)
    assert.equal(out.durationS, 1.5)
  } finally { await m.close() }
})

test('openai-compatible: captioned route missing falls back to plain speech', async () => {
  const m = await mockServer((r, res) => (r.path === '/v1/audio/speech' ? reply(res, 200, AUDIO) : reply(res, 404, { detail: 'nope' })))
  try {
    const i = inst({ baseUrl: m.origin + '/v1', options: { tts: true, captions: true } })
    const out = await a.tts({ text: 'hi', wantAlignment: true }, i)
    assert.equal(out.alignment, null)
    assert.deepEqual(out.audio, AUDIO)
    assert.deepEqual(m.reqs.map((r) => r.path), ['/dev/captioned_speech', '/v1/audio/speech'])
  } finally { await m.close() }
})

test('openai-compatible: stt words via verbose_json and language name mapped', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { text: ' kalimera kosme', language: 'greek', duration: 1.2, words: [{ word: 'kalimera', start: 0.1, end: 0.6 }, { word: 'kosme', start: 0.7, end: 1.2 }] }))
  try {
    const i = inst({ baseUrl: m.origin + '/openai/v1', models: { stt: 'whisper-large-v3' } })
    const out = await a.stt({ audio: wavBuffer(), name: 'a.wav', mime: 'audio/wav', lang: 'el', wantWords: true }, i)
    assert.equal(out.text, 'kalimera kosme')
    assert.equal(out.language, 'el')
    assert.deepEqual(out.words, [{ w: 'kalimera', t0: 0.1, t1: 0.6 }, { w: 'kosme', t0: 0.7, t1: 1.2 }])
    const r = m.reqs[0]
    assert.equal(r.path, '/openai/v1/audio/transcriptions')
    assert.equal(field(r, 'response_format'), 'verbose_json')
    assert.equal(field(r, 'timestamp_granularities[]'), 'word')
    assert.equal(field(r, 'language'), 'el')
    const plain = await a.stt({ audio: wavBuffer(), name: 'a.wav', mime: 'audio/wav' }, i)
    assert.equal(plain.words, null)
    assert.equal(field(m.reqs[1], 'response_format'), null)
  } finally { await m.close() }
})

test('openai-compatible: error mapping', async () => {
  let status = 401
  let body = { error: { message: 'nope' } }
  const m = await mockServer((r, res) => reply(res, status, body))
  try {
    const i = inst({ baseUrl: m.origin + '/v1', options: { tts: true } })
    await assert.rejects(a.tts({ text: 'x' }, i), (e) => e.code === 'bad_key' && e.status === 502)
    status = 429
    await assert.rejects(a.tts({ text: 'x' }, i), (e) => e.code === 'quota_exceeded' && e.status === 429)
    status = 503
    await assert.rejects(a.stt({ audio: wavBuffer() }, i), (e) => e.code === 'vendor' && e.status === 502)
    status = 400
    body = { detail: 'Voice zz_none not found' }
    await assert.rejects(a.tts({ text: 'x', voice: 'zz_none' }, i), (e) => e.code === 'bad_voice' && e.status === 400)
    body = { detail: 'unsupported language' }
    await assert.rejects(a.stt({ audio: wavBuffer(), lang: 'el' }, i), (e) => e.code === 'unsupported_lang')
  } finally { await m.close() }
})

test('openai-compatible: listVoices parses kokoro answer, caches, filters by language', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { voices: ['af_heart', 'am_michael', 'if_sara', 'bf_emma'] }))
  try {
    const i = inst({ baseUrl: m.origin + '/v1', options: { tts: true } })
    const all = await a.listVoices(i, {})
    assert.equal(all.length, 4)
    const it = await a.listVoices(i, { lang: 'it' })
    assert.deepEqual(it.map((v) => v.id), ['if_sara'])
    assert.equal(it[0].gender, 'female')
    assert.equal((await a.listVoices(i, { lang: 'el' })).length, 0)
    assert.equal(m.reqs.length, 1)
    assert.equal(m.reqs[0].path, '/v1/audio/voices')
  } finally { await m.close() }
})

test('openai-compatible: listVoices falls back to options.voices', async () => {
  const m = await mockServer((r, res) => reply(res, 404, { detail: 'x' }))
  try {
    const i = inst({ baseUrl: m.origin + '/v1', options: { voices: 'alloy, nova' } })
    assert.deepEqual((await a.listVoices(i, {})).map((v) => v.id), ['alloy', 'nova'])
  } finally { await m.close() }
})

test('openai-compatible: health with and without a probe', async () => {
  const m = await mockServer((r, res) => reply(res, r.headers.authorization ? 200 : 401, { data: [] }))
  try {
    const up = await a.health(inst({ baseUrl: m.origin + '/v1' }))
    assert.equal(up.status, 'up')
    assert.equal(m.reqs[0].path, '/v1/models')
    const none = await a.health(inst({ baseUrl: m.origin + '/v1', key: '', options: {} }))
    assert.equal(none.status, 'down')
    assert.equal(m.reqs.length, 1)
  } finally { await m.close() }
})
