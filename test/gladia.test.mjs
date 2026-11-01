import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import gladia, { pickModel, parseResult } from '../lib/server/providers/gladia.js'

const DASH = /[\u2013\u2014]/
const RESULT = {
  metadata: { audio_duration: 2.5, number_of_distinct_channels: 1, billing_time: 2.5, transcription_time: 0.4 },
  transcription: {
    full_transcript: 'Ciao mondo',
    languages: ['it'],
    utterances: [{ start: 0.1, end: 1.2, confidence: 0.95, channel: 0, language: 'it', text: 'Ciao mondo', words: [
      { word: ' Ciao', start: 0.1, end: 0.5, confidence: 0.97 },
      { word: ' mondo', start: 0.6, end: 1.2, confidence: 0.93 },
    ] }],
  },
}

function service(over) {
  const o = Object.assign({ queued: 0, final: { status: 'done', result: RESULT }, uploadStatus: 200, initStatus: 201 }, over || {})
  let polls = 0
  return (r, res) => {
    if (r.method === 'POST' && r.path === '/v2/upload') return o.uploadStatus === 200 ? reply(res, 200, { audio_url: 'https://api.example.test/file/abc', audio_metadata: { id: 'abc', filename: 'a.wav', extension: 'wav' } }) : reply(res, o.uploadStatus, { message: 'no' })
    if (r.method === 'POST' && r.path === '/v2/pre-recorded') return o.initStatus === 201 ? reply(res, 201, { id: 'tx1', result_url: 'https://api.example.test/v2/pre-recorded/tx1' }) : reply(res, o.initStatus, { message: 'language not supported' })
    if (r.method === 'GET' && r.path === '/v2/pre-recorded/tx1') {
      polls += 1
      return reply(res, 200, polls <= o.queued ? { id: 'tx1', status: 'processing', result: null } : Object.assign({ id: 'tx1' }, o.final))
    }
    if (r.method === 'DELETE') return reply(res, 202, {})
    if (r.method === 'GET' && r.path === '/v2/pre-recorded') return reply(res, 200, { first: '', current: '', next: '', items: [] })
    return reply(res, 404, {})
  }
}

test('gladia: metadata sanity', () => {
  assert.equal(gladia.type, 'gladia')
  assert.equal(gladia.group, 'eu')
  assert.ok(gladia.desc.length < 140)
  for (const s of [gladia.desc, gladia.euNote, gladia.verification, gladia.label]) assert.ok(!DASH.test(s))
  assert.match(gladia.docs, /^https:\/\//)
  assert.ok(['verified', 'partial', 'unverified', 'planned'].includes(gladia.status))
  assert.ok(gladia.presets.every((x) => x.id))
  assert.equal(gladia.configured(inst({ key: '' })), false)
  assert.equal(gladia.configured(inst()), true)
})

test('gladia: capabilities are truthful', () => {
  const c = gladia.capabilities(inst())
  assert.equal(c.stt, true)
  assert.equal(c.tts, false)
  assert.deepEqual(c.sttLangs, ['el', 'it', 'en'])
  assert.deepEqual(c.ttsLangs, [])
  assert.equal(c.detectsLanguage, true)
})

test('gladia: model choice keeps Greek on solaria-1', () => {
  assert.equal(pickModel(undefined, 'en'), 'solaria-1')
  assert.equal(pickModel('solaria-3', 'it'), 'solaria-3')
  assert.equal(pickModel('solaria-3', 'el'), 'solaria-1')
  assert.equal(pickModel('junk', 'el'), 'solaria-1')
})

test('gladia: stt upload, init, poll and word timings', async () => {
  const m = await mockServer(service({ queued: 2 }))
  try {
    const i = inst({ baseUrl: m.origin, options: { pollMs: 5 } })
    const out = await gladia.stt({ audio: wavBuffer(), name: 'a.wav', mime: 'audio/wav', lang: 'it' }, i)
    assert.equal(out.text, 'Ciao mondo')
    assert.equal(out.language, 'it')
    assert.deepEqual(out.words, [{ w: 'Ciao', t0: 0.1, t1: 0.5 }, { w: 'mondo', t0: 0.6, t1: 1.2 }])
    assert.equal(out.durationS, 2.5)
    assert.ok(out.confidence > 0.9)
    const [up, init] = m.reqs
    assert.equal(up.method, 'POST')
    assert.equal(up.path, '/v2/upload')
    assert.equal(typeof up.headers['x-gladia-key'], 'string')
    assert.ok(up.headers['x-gladia-key'].length > 0)
    assert.match(up.headers['content-type'], /^multipart\/form-data/)
    assert.match(up.body.toString('latin1'), /name="audio"; filename="a.wav"/)
    assert.equal(init.path, '/v2/pre-recorded')
    assert.deepEqual(init.json(), { audio_url: 'https://api.example.test/file/abc', model: 'solaria-1', language_config: { languages: ['it'], code_switching: false } })
    assert.equal(m.reqs.filter((r) => r.method === 'GET' && r.path === '/v2/pre-recorded/tx1').length, 3)
  } finally { await m.close() }
})

test('gladia: unknown language restricts detection to el/it/en', async () => {
  const m = await mockServer(service())
  try {
    await gladia.stt({ audio: wavBuffer(), wantWords: false }, inst({ baseUrl: m.origin, options: { pollMs: 5 } }))
    assert.deepEqual(m.reqs[1].json().language_config, { languages: ['el', 'it', 'en'], code_switching: false })
    const r = await gladia.stt({ audio: wavBuffer(), wantWords: false }, inst({ baseUrl: m.origin, options: { pollMs: 5 } }))
    assert.equal(r.words, null)
  } finally { await m.close() }
})

test('gladia: parseResult falls back to utterance text', () => {
  const p = parseResult({ transcription: { full_transcript: '', utterances: [{ text: 'a b', language: 'en', words: [{ word: 'a', start: 0, end: 1, confidence: 1 }] }] } })
  assert.equal(p.text, 'a b')
  assert.equal(p.language, 'en')
})

test('gladia: errors map to typed codes', async () => {
  for (const [over, code, status] of [
    [{ uploadStatus: 401 }, 'bad_key', 502],
    [{ uploadStatus: 429 }, 'quota_exceeded', 429],
    [{ uploadStatus: 500 }, 'vendor', 502],
    [{ initStatus: 422 }, 'unsupported_lang', 400],
    [{ final: { status: 'error', error_code: 500, result: null } }, 'vendor', 502],
  ]) {
    const m = await mockServer(service(over))
    try {
      await assert.rejects(gladia.stt({ audio: wavBuffer() }, inst({ baseUrl: m.origin, options: { pollMs: 5 } })), (e) => e.code === code && e.status === status)
    } finally { await m.close() }
  }
})

test('gladia: tts and voices are not offered', async () => {
  assert.deepEqual(await gladia.listVoices(inst(), {}), [])
  await assert.rejects(gladia.tts({ text: 'x' }, inst()), (e) => e.code === 'disabled' && e.status === 503)
})

test('gladia: health probes the list with the key, none without', async () => {
  const m = await mockServer(service())
  try {
    assert.equal((await gladia.health(inst({ baseUrl: m.origin }))).status, 'up')
    assert.equal(typeof m.reqs[0].headers['x-gladia-key'], 'string')
    const before = m.reqs.length
    assert.equal((await gladia.health(inst({ key: '', baseUrl: m.origin }))).ok, false)
    assert.equal(m.reqs.length, before)
  } finally { await m.close() }
  const bad = await mockServer((r, res) => reply(res, 401, {}))
  try { assert.equal((await gladia.health(inst({ baseUrl: bad.origin }))).status, 'down') } finally { await bad.close() }
})
