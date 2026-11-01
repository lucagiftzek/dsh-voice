import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import assemblyai from '../lib/server/providers/assemblyai.js'

const NODASH = /[\u2013\u2014]/
const DONE = {
  id: 't1', status: 'completed', text: 'Hello world', language_code: 'en_us', language_confidence: 0.99, audio_duration: 2,
  words: [{ text: 'Hello', start: 100, end: 500, confidence: 0.99, speaker: null }, { text: 'world', start: 600, end: 1000, confidence: 0.98, speaker: null }],
}

/** A mock AssemblyAI: upload, create, poll (queued, processing, then the final body). */
function flow(final, queuedPolls) {
  let polls = 0
  return (r, res) => {
    if (r.path === '/v2/upload') return reply(res, 200, { upload_url: 'https://cdn.example.test/upload/abc' })
    if (r.path === '/v2/transcript' && r.method === 'POST') return reply(res, 200, { id: 't1', status: 'queued' })
    if (r.path === '/v2/transcript/t1') {
      polls += 1
      if (polls <= (queuedPolls === undefined ? 2 : queuedPolls)) return reply(res, 200, { id: 't1', status: polls === 1 ? 'queued' : 'processing' })
      return reply(res, 200, final)
    }
    return reply(res, 404, { error: 'nf' })
  }
}

test('assemblyai: metadata sanity', () => {
  assert.equal(assemblyai.type, 'assemblyai')
  assert.equal(assemblyai.group, 'other')
  assert.ok(assemblyai.desc.length < 140)
  for (const s of [assemblyai.desc, assemblyai.euNote, assemblyai.verification]) assert.ok(!NODASH.test(s))
  assert.ok(assemblyai.docs.startsWith('https://'))
  assert.ok(['verified', 'partial', 'unverified', 'planned'].includes(assemblyai.status))
  assert.ok(assemblyai.presets.every((p) => p.id))
  assert.equal(assemblyai.presets.find((p) => p.id === 'assemblyai-eu').baseUrl, 'https://api.eu.assemblyai.com')
  assert.ok(assemblyai.optionFields.some((f) => f.key === 'pollMs'))
})

test('assemblyai: stt only capabilities', async () => {
  const c = assemblyai.capabilities(inst())
  assert.equal(c.tts, false)
  assert.equal(c.stt, true)
  assert.deepEqual(c.ttsLangs, [])
  for (const l of ['el', 'it', 'en']) assert.ok(c.sttLangs.includes(l))
  assert.ok(c.sttLangs.every((l) => /^[a-z]{2}$/.test(l)))
  assert.equal(c.detectsLanguage, true)
  await assert.rejects(assemblyai.tts({ text: 'x' }, inst()), (e) => typeof e.code === 'string')
  assert.deepEqual(await assemblyai.listVoices(inst(), {}), [])
})

test('assemblyai: residency follows the base url', () => {
  assert.equal(assemblyai.residencyOf(inst({ baseUrl: 'https://api.eu.assemblyai.com' })), 'eu-region')
  assert.equal(assemblyai.residencyOf(inst({ baseUrl: 'https://api.assemblyai.com' })), 'non-eu')
})

test('assemblyai: full flow upload, create, poll, with words in seconds', async () => {
  const m = await mockServer(flow(DONE))
  try {
    const i = inst({ baseUrl: m.origin, options: { pollMs: 5 } })
    const wav = wavBuffer(800)
    const out = await assemblyai.stt({ audio: wav, mime: 'audio/wav', lang: 'it' }, i)
    const [up, cr, p1, p2, p3] = m.reqs
    assert.equal(up.method, 'POST')
    assert.equal(up.path, '/v2/upload')
    assert.equal(up.headers['content-type'], 'application/octet-stream')
    assert.ok(up.headers.authorization.length > 0)
    assert.ok(!/^(Bearer|Token) /.test(up.headers.authorization))
    assert.deepEqual(up.body, wav)
    assert.equal(cr.path, '/v2/transcript')
    const b = cr.json()
    assert.equal(b.audio_url, 'https://cdn.example.test/upload/abc')
    assert.equal(b.language_code, 'it')
    assert.equal(b.language_detection, undefined)
    assert.deepEqual(b.speech_models, ['universal-3-5-pro', 'universal-2'])
    assert.equal(b.speech_model, undefined)
    assert.equal(m.reqs.length, 5)
    assert.ok([p1, p2, p3].every((r) => r.method === 'GET' && r.path === '/v2/transcript/t1'))
    assert.equal(out.text, 'Hello world')
    assert.equal(out.language, 'en')
    assert.equal(out.confidence, 0.99)
    assert.equal(out.durationS, 2)
    assert.deepEqual(out.words, [{ w: 'Hello', t0: 0.1, t1: 0.5 }, { w: 'world', t0: 0.6, t1: 1 }])
  } finally { await m.close() }
})

test('assemblyai: Greek goes to universal-2 only, no language uses detection', async () => {
  const m = await mockServer(flow(DONE, 0))
  try {
    const i = inst({ baseUrl: m.origin, options: { pollMs: 5 } })
    await assemblyai.stt({ audio: wavBuffer(100), lang: 'el' }, i)
    await assemblyai.stt({ audio: wavBuffer(100) }, i)
    const creates = m.reqs.filter((r) => r.path === '/v2/transcript' && r.method === 'POST').map((r) => r.json())
    assert.deepEqual(creates[0].speech_models, ['universal-2'])
    assert.equal(creates[0].language_code, 'el')
    assert.equal(creates[1].language_detection, true)
    assert.equal(creates[1].language_code, undefined)
    assert.deepEqual(creates[1].speech_models, ['universal-3-5-pro', 'universal-2'])
  } finally { await m.close() }
})

test('assemblyai: an explicit model wins and wantWords false drops words', async () => {
  const m = await mockServer(flow(DONE, 0))
  try {
    const i = inst({ baseUrl: m.origin, options: { pollMs: 5 } })
    const out = await assemblyai.stt({ audio: wavBuffer(100), lang: 'en', model: 'universal-2', wantWords: false }, i)
    assert.deepEqual(m.reqs.find((r) => r.path === '/v2/transcript').json().speech_models, ['universal-2'])
    assert.equal(out.words, null)
  } finally { await m.close() }
})

test('assemblyai: a status error from the vendor is a typed error', async () => {
  const m = await mockServer(flow({ id: 't1', status: 'error', error: 'Audio file could not be decoded' }, 1))
  try {
    await assert.rejects(assemblyai.stt({ audio: wavBuffer(100), lang: 'en' }, inst({ baseUrl: m.origin, options: { pollMs: 5 } })), (e) => e.code === 'vendor' && e.status === 502)
  } finally { await m.close() }
})

test('assemblyai: polling is capped by maxWaitMs', async () => {
  const m = await mockServer((r, res) => {
    if (r.path === '/v2/upload') return reply(res, 200, { upload_url: 'https://cdn.example.test/u' })
    if (r.method === 'POST') return reply(res, 200, { id: 't1' })
    return reply(res, 200, { id: 't1', status: 'processing' })
  })
  try {
    const t0 = Date.now()
    await assert.rejects(assemblyai.stt({ audio: wavBuffer(100), lang: 'en' }, inst({ baseUrl: m.origin, options: { pollMs: 5, maxWaitMs: 60 } })), (e) => e.code === 'timeout' && e.status === 504)
    assert.ok(Date.now() - t0 < 2000)
  } finally { await m.close() }
})

test('assemblyai: unsupported language is refused locally', async () => {
  const m = await mockServer(flow(DONE))
  try {
    await assert.rejects(assemblyai.stt({ audio: wavBuffer(100), lang: 'zz' }, inst({ baseUrl: m.origin })), (e) => e.code === 'unsupported_lang' && e.status === 400)
    assert.equal(m.reqs.length, 0)
  } finally { await m.close() }
})

test('assemblyai: error mapping 401 429 5xx', async () => {
  const m = await mockServer((r, res) => {
    const k = r.headers.authorization
    if (k === 'fake-q') return reply(res, 429, { error: 'rate' })
    if (k === 'fake-5') return reply(res, 500, { error: 'boom' })
    return reply(res, 401, { error: 'Authentication error' })
  })
  try {
    const run = (key) => assemblyai.stt({ audio: wavBuffer(100), lang: 'en' }, inst({ baseUrl: m.origin, key }))
    await assert.rejects(run('fake-key-0000'), (e) => e.code === 'bad_key' && e.status === 502 && !/fake-key/.test(e.message))
    await assert.rejects(run('fake-q'), (e) => e.code === 'quota_exceeded' && e.status === 429)
    await assert.rejects(run('fake-5'), (e) => e.code === 'vendor' && e.status === 502)
  } finally { await m.close() }
})

test('assemblyai: health makes no network call', async () => {
  const m = await mockServer((r, res) => reply(res, 200, {}))
  try {
    const h = await assemblyai.health(inst({ baseUrl: m.origin }))
    assert.equal(h.status, 'unknown')
    assert.equal((await assemblyai.health(inst({ baseUrl: m.origin, key: '' }))).ok, false)
    assert.equal(m.reqs.length, 0)
  } finally { await m.close() }
})
