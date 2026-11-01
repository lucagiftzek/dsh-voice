import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import deepgram from '../lib/server/providers/deepgram.js'

const NODASH = /[\u2013\u2014]/

test('deepgram: metadata sanity', () => {
  assert.equal(deepgram.type, 'deepgram')
  assert.equal(deepgram.group, 'other')
  assert.ok(deepgram.desc.length < 140)
  for (const s of [deepgram.desc, deepgram.euNote, deepgram.verification]) assert.ok(!NODASH.test(s))
  assert.ok(deepgram.docs.startsWith('https://'))
  assert.ok(['verified', 'partial', 'unverified', 'planned'].includes(deepgram.status))
  assert.ok(deepgram.presets.every((p) => p.id))
  assert.equal(deepgram.presets.find((p) => p.id === 'deepgram-eu').baseUrl, 'https://api.eu.deepgram.com')
})

test('deepgram: capabilities, Aura-2 has no Greek but Nova-3 does', () => {
  const c = deepgram.capabilities(inst())
  assert.deepEqual(c.ttsLangs, ['en', 'es', 'de', 'fr', 'nl', 'it', 'ja'])
  assert.ok(!c.ttsLangs.includes('el'))
  assert.ok(c.ttsLangs.includes('it') && c.ttsLangs.includes('en'))
  for (const l of ['el', 'it', 'en']) assert.ok(c.sttLangs.includes(l))
  assert.equal(c.alignment, 'none')
  assert.equal(c.detectsLanguage, true)
  assert.equal(c.tts, true)
  assert.equal(c.stt, true)
})

test('deepgram: residency follows the base url', () => {
  assert.equal(deepgram.residencyOf(inst({ baseUrl: 'https://api.eu.deepgram.com' })), 'eu-region')
  assert.equal(deepgram.residencyOf(inst({ baseUrl: 'https://api.deepgram.com' })), 'non-eu')
  assert.equal(deepgram.residencyOf(inst({ baseUrl: '' })), 'non-eu')
})

test('deepgram: tts request shape and audio', async () => {
  const wav = wavBuffer(2400)
  const m = await mockServer((r, res) => reply(res, 200, wav, { 'content-type': 'audio/wav' }))
  try {
    const i = inst({ baseUrl: m.origin })
    const out = await deepgram.tts({ text: 'Buongiorno', voice: 'aura-2-cesare-it', lang: 'it' }, i)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/v1/speak')
    const q = new URLSearchParams(r.query)
    assert.equal(q.get('model'), 'aura-2-cesare-it')
    assert.equal(q.get('encoding'), 'linear16')
    assert.equal(q.get('container'), 'wav')
    assert.ok(r.headers.authorization.startsWith('Token '))
    assert.deepEqual(r.json(), { text: 'Buongiorno' })
    assert.deepEqual(out.audio, wav)
    assert.equal(out.mime, 'audio/wav')
    assert.equal(out.alignment, null)
    assert.equal(out.voice, 'aura-2-cesare-it')
    assert.equal(out.billedChars, 10)
  } finally { await m.close() }
})

test('deepgram: voice degrades to a voice of the right language', async () => {
  const m = await mockServer((r, res) => reply(res, 200, wavBuffer(100)))
  try {
    const i = inst({ baseUrl: m.origin, defaultVoice: 'aura-2-thalia-en' })
    await deepgram.tts({ text: 'x', voice: 'aura-2-thalia-en', lang: 'it' }, i)
    await deepgram.tts({ text: 'x', voice: 'junk' }, i)
    await deepgram.tts({ text: 'x', voice: 'aura-2-thalia-en', speed: 1.3 }, i)
    const models = m.reqs.map((r) => new URLSearchParams(r.query).get('model'))
    assert.deepEqual(models, ['aura-2-livia-it', 'aura-2-thalia-en', 'aura-2-thalia-en'])
    assert.equal(new URLSearchParams(m.reqs[2].query).get('speed'), '1.3')
  } finally { await m.close() }
})

test('deepgram: Greek tts is refused with unsupported_lang and never hits the network', async () => {
  const m = await mockServer((r, res) => reply(res, 200, wavBuffer(100)))
  try {
    await assert.rejects(deepgram.tts({ text: 'x', lang: 'el' }, inst({ baseUrl: m.origin })), (e) => e.code === 'unsupported_lang' && e.status === 400)
    assert.equal(m.reqs.length, 0)
  } finally { await m.close() }
})

test('deepgram: error mapping 401 402 429 5xx bad voice', async () => {
  const m = await mockServer((r, res) => {
    const model = new URLSearchParams(r.query).get('model')
    if (model === 'aura-2-bad-en') return reply(res, 400, { err_code: 'INVALID_QUERY_PARAMETER', err_msg: 'Invalid model', request_id: 'x' })
    const t = r.json().text
    if (t === 'k') return reply(res, 401, { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' })
    if (t === 'q') return reply(res, 429, { err_code: 'TOO_MANY_REQUESTS', err_msg: 'slow' })
    if (t === 'c') return reply(res, 402, { category: 'payment', message: 'Insufficient credits' })
    return reply(res, 503, { err_msg: 'down' })
  })
  try {
    const i = inst({ baseUrl: m.origin })
    await assert.rejects(deepgram.tts({ text: 'k' }, i), (e) => e.code === 'bad_key' && e.status === 502)
    await assert.rejects(deepgram.tts({ text: 'q' }, i), (e) => e.code === 'quota_exceeded' && e.status === 429)
    await assert.rejects(deepgram.tts({ text: 'c' }, i), (e) => e.code === 'quota_exceeded')
    await assert.rejects(deepgram.tts({ text: 'z' }, i), (e) => e.code === 'vendor' && e.status === 502)
    await assert.rejects(deepgram.tts({ text: 'v', model: 'aura-2-bad-en' }, i), (e) => e.code === 'bad_voice' && e.status === 400)
  } finally { await m.close() }
})

test('deepgram: stt raw body, query and parsed words', async () => {
  const body = {
    metadata: { duration: 1.2 },
    results: { channels: [{ detected_language: 'el', alternatives: [{ transcript: 'kalimera kosme', confidence: 0.98, words: [
      { word: 'kalimera', start: 0.1, end: 0.5, confidence: 0.99, punctuated_word: 'Kalimera' },
      { word: 'kosme', start: 0.6, end: 1.0, confidence: 0.97, punctuated_word: 'kosme.' },
    ] }] }] },
  }
  const m = await mockServer((r, res) => reply(res, 200, body))
  try {
    const i = inst({ baseUrl: m.origin })
    const wav = wavBuffer(800)
    const out = await deepgram.stt({ audio: wav, mime: 'audio/wav', lang: 'el' }, i)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/v1/listen')
    const q = new URLSearchParams(r.query)
    assert.equal(q.get('model'), 'nova-3')
    assert.equal(q.get('language'), 'el')
    assert.equal(q.get('smart_format'), 'true')
    assert.equal(q.get('punctuate'), 'true')
    assert.equal(q.get('detect_language'), null)
    assert.equal(r.headers['content-type'], 'audio/wav')
    assert.ok(r.headers.authorization.startsWith('Token '))
    assert.deepEqual(r.body, wav)
    assert.equal(out.text, 'kalimera kosme')
    assert.equal(out.language, 'el')
    assert.equal(out.confidence, 0.98)
    assert.deepEqual(out.words, [{ w: 'Kalimera', t0: 0.1, t1: 0.5 }, { w: 'kosme.', t0: 0.6, t1: 1.0 }])
    assert.equal(out.durationS, 1.2)
  } finally { await m.close() }
})

test('deepgram: stt without a language asks for detection, and unsupported language is refused', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { results: { channels: [{ detected_language: 'it', alternatives: [{ transcript: 'ciao', words: [] }] }] } }))
  try {
    const i = inst({ baseUrl: m.origin, options: { smartFormat: false } })
    const out = await deepgram.stt({ audio: wavBuffer(100), mime: 'audio/wav' }, i)
    const q = new URLSearchParams(m.reqs[0].query)
    assert.equal(q.get('detect_language'), 'true')
    assert.equal(q.get('smart_format'), null)
    assert.equal(out.language, 'it')
    await assert.rejects(deepgram.stt({ audio: wavBuffer(100), lang: 'zz' }, i), (e) => e.code === 'unsupported_lang')
  } finally { await m.close() }
})

test('deepgram: stt error mapping', async () => {
  const m = await mockServer((r, res) => reply(res, r.headers.authorization === 'Token fake-q' ? 429 : 401, { err_msg: 'no' }))
  try {
    await assert.rejects(deepgram.stt({ audio: wavBuffer(100) }, inst({ baseUrl: m.origin })), (e) => e.code === 'bad_key')
    await assert.rejects(deepgram.stt({ audio: wavBuffer(100) }, inst({ baseUrl: m.origin, key: 'fake-q' })), (e) => e.code === 'quota_exceeded')
  } finally { await m.close() }
})

test('deepgram: listVoices is a static documented list', async () => {
  const all = await deepgram.listVoices(inst(), {})
  assert.equal(all.length, 90)
  assert.ok(all.every((v) => v.id.startsWith('aura-2-') && v.langs.length === 1 && /^[a-z]{2}$/.test(v.langs[0])))
  assert.ok(!all.some((v) => v.langs[0] === 'el'))
  const it = await deepgram.listVoices(inst(), { lang: 'it' })
  assert.equal(it.length, 9)
  assert.ok(it.some((v) => v.id === 'aura-2-livia-it' && v.gender === 'female'))
})

test('deepgram: health with a probe and without a key', async () => {
  const m = await mockServer((r, res) => (r.headers.authorization === 'Token fake-bad' ? reply(res, 401, { err_msg: 'no' }) : reply(res, 200, { stt: [], tts: [] })))
  try {
    const up = await deepgram.health(inst({ baseUrl: m.origin }))
    assert.equal(up.status, 'up')
    assert.equal(m.reqs[0].path, '/v1/models')
    assert.equal((await deepgram.health(inst({ baseUrl: m.origin, key: 'fake-bad' }))).status, 'down')
    assert.equal((await deepgram.health(inst({ baseUrl: m.origin, key: '' }))).ok, false)
    assert.equal(m.reqs.length, 2)
  } finally { await m.close() }
})
