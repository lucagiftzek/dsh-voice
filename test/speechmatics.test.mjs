import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import sm, { parseTranscript, apiBase } from '../lib/server/providers/speechmatics.js'

const DASH = /[\u2013\u2014]/
const w = (content, s, e, extra) => Object.assign({ alternatives: [{ confidence: 0.99, content, language: 'en', speaker: 'UU' }], start_time: s, end_time: e, type: 'word' }, extra || {})
const p = (content, t) => ({ alternatives: [{ confidence: 1, content, language: 'en', speaker: 'UU' }], attaches_to: 'previous', start_time: t, end_time: t, is_eos: true, type: 'punctuation' })
const TRANSCRIPT = {
  format: '2.9',
  job: { created_at: '2026-10-31T10:00:00.000Z', data_name: 'a.wav', duration: 3, id: 'job123' },
  metadata: { created_at: '2026-10-31T10:00:02Z', language_pack_info: { adapted: false, itn: true, language_description: 'English', word_delimiter: ' ', writing_direction: 'left-to-right' }, transcription_config: { language: 'en', model: 'enhanced' }, type: 'transcription' },
  results: [w('Hello', 0.5, 0.9), w('brave', 1.0, 1.3), w('world', 1.4, 1.9), p('.', 1.9)],
}

/** A mock Speechmatics batch service. `running` status polls answer running first. */
function batch(over) {
  const o = Object.assign({ running: 0, transcript: TRANSCRIPT, status: 'done', createStatus: 201 }, over || {})
  let polls = 0
  return (r, res) => {
    if (r.method === 'POST' && r.path === '/v2/jobs/') return o.createStatus === 201 ? reply(res, 201, { id: 'job123' }) : reply(res, o.createStatus, { error: 'denied' })
    if (r.method === 'GET' && r.path === '/v2/jobs/job123') {
      polls += 1
      const status = polls <= o.running ? 'running' : o.status
      return reply(res, 200, { job: { id: 'job123', status, errors: status === 'rejected' ? [{ message: 'language pack not available', timestamp: 'x' }] : undefined } })
    }
    if (r.method === 'GET' && r.path === '/v2/jobs/job123/transcript') return reply(res, 200, o.transcript)
    if (r.method === 'DELETE') return reply(res, 200, { job: { id: 'job123', status: 'deleted' } })
    if (r.method === 'GET' && r.path === '/v2/jobs/') return reply(res, 200, { jobs: [] })
    if (r.method === 'POST' && r.path.startsWith('/generate/')) return reply(res, 200, wavBuffer(3200))
    return reply(res, 404, { error: 'nope' })
  }
}
const field = (req, name) => { const m = new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)\\r\\n').exec(req.body.toString('latin1')); return m ? m[1] : null }

test('speechmatics: metadata sanity', () => {
  assert.equal(sm.type, 'speechmatics')
  assert.equal(sm.group, 'eu')
  assert.equal(sm.residency, 'eu-region')
  assert.ok(sm.desc.length < 140)
  for (const s of [sm.desc, sm.euNote, sm.verification, sm.label]) assert.ok(!DASH.test(s))
  assert.match(sm.docs, /^https:\/\//)
  assert.ok(['verified', 'partial', 'unverified', 'planned'].includes(sm.status))
  assert.equal(sm.defaultBaseUrl, '')
  assert.ok(sm.presets.length >= 1 && sm.presets.every((x) => x.id))
  assert.deepEqual(sm.regions.map((r) => r.id), ['eu1', 'eu2', 'us1', 'au1'])
  assert.ok(sm.regions.slice(0, 2).every((r) => r.eu === true))
  assert.equal(sm.configured(inst({ key: '' })), false)
  assert.equal(sm.configured(inst()), true)
})

test('speechmatics: capabilities are truthful', () => {
  const c = sm.capabilities(inst())
  assert.deepEqual(c.sttLangs, ['el', 'it', 'en'])
  assert.deepEqual(c.ttsLangs, ['en'])
  assert.equal(c.stt, true)
  assert.equal(c.tts, true)
  assert.equal(c.alignment, 'none')
  assert.equal(c.streaming, false)
})

test('speechmatics: region derives the URL, baseUrl wins, residency follows', () => {
  assert.equal(apiBase(inst()), 'https://eu1.asr.api.speechmatics.com/v2')
  assert.equal(apiBase(inst({ region: 'eu2' })), 'https://eu2.asr.api.speechmatics.com/v2')
  assert.equal(apiBase(inst({ options: { region: 'us1' } })), 'https://us1.asr.api.speechmatics.com/v2')
  assert.equal(apiBase(inst({ region: 'eu2', baseUrl: 'http://127.0.0.1:9/' })), 'http://127.0.0.1:9/v2')
  assert.equal(sm.residencyOf(inst({ region: 'eu1' })), 'eu-region')
  assert.equal(sm.residencyOf(inst({ options: { region: 'eu2' } })), 'eu-region')
  assert.equal(sm.residencyOf(inst({ region: 'us1' })), 'non-eu')
  assert.equal(sm.residencyOf(inst({ baseUrl: 'http://127.0.0.1:1' })), 'varies')
})

test('speechmatics: stt request shape, polling and word timings', async () => {
  const m = await mockServer(batch({ running: 1 }))
  try {
    const i = inst({ baseUrl: m.origin, options: { pollSeconds: 1 } })
    const out = await sm.stt({ audio: wavBuffer(), name: 'a.wav', mime: 'audio/wav', lang: 'en-GB' }, i)
    assert.equal(out.text, 'Hello brave world.')
    assert.equal(out.language, 'en')
    assert.deepEqual(out.words, [{ w: 'Hello', t0: 0.5, t1: 0.9 }, { w: 'brave', t0: 1.0, t1: 1.3 }, { w: 'world', t0: 1.4, t1: 1.9 }])
    assert.equal(out.durationS, 3)
    assert.ok(out.confidence > 0.9)
    const post = m.reqs[0]
    assert.equal(post.method, 'POST')
    assert.equal(post.path, '/v2/jobs/')
    assert.ok(post.headers.authorization.startsWith('Bearer '))
    assert.match(post.headers['content-type'], /^multipart\/form-data; boundary=/)
    assert.match(post.body.toString('latin1'), /name="data_file"; filename="a.wav"/)
    const cfg = JSON.parse(field(post, 'config'))
    assert.deepEqual(cfg, { type: 'transcription', transcription_config: { language: 'en', model: 'enhanced' } })
    const polls = m.reqs.filter((r) => r.method === 'GET' && r.path === '/v2/jobs/job123')
    assert.equal(polls.length, 2)
    assert.match(polls[0].query, /wait=1/)
    const tr = m.reqs.find((r) => r.path === '/v2/jobs/job123/transcript')
    assert.equal(tr.query, '?format=json-v2')
  } finally { await m.close() }
})

test('speechmatics: no language asks for auto identification limited to el/it/en', async () => {
  const m = await mockServer(batch())
  try {
    await sm.stt({ audio: wavBuffer() }, inst({ baseUrl: m.origin }))
    const cfg = JSON.parse(field(m.reqs[0], 'config'))
    assert.equal(cfg.transcription_config.language, 'auto')
    assert.deepEqual(cfg.language_identification_config.expected_languages, ['el', 'it', 'en'])
  } finally { await m.close() }
})

test('speechmatics: Greek transcript with attached punctuation parses', () => {
  const g = (c, s, e) => ({ alternatives: [{ confidence: 0.9, content: c, language: 'el' }], start_time: s, end_time: e, type: 'word' })
  const out = parseTranscript({ metadata: { language_pack_info: { word_delimiter: ' ' } }, results: [g('Καλημέρα', 0, 0.6), g('κόσμε', 0.7, 1.2), p(',', 1.2), g('ευχαριστώ', 1.5, 2)] })
  assert.equal(out.text, 'Καλημέρα κόσμε, ευχαριστώ')
  assert.equal(out.language, 'el')
  assert.equal(out.words.length, 3)
})

test('speechmatics: rejected job and error mapping', async () => {
  const m = await mockServer(batch({ status: 'rejected' }))
  try {
    await assert.rejects(sm.stt({ audio: wavBuffer(), lang: 'it' }, inst({ baseUrl: m.origin })), (e) => e.code === 'unsupported_lang' && e.status === 400)
  } finally { await m.close() }
  const cases = [[401, 'bad_key', 502], [403, 'bad_key', 502], [429, 'quota_exceeded', 429], [500, 'vendor', 502]]
  for (const [status, code, http] of cases) {
    const m2 = await mockServer(batch({ createStatus: status }))
    try {
      await assert.rejects(sm.stt({ audio: wavBuffer() }, inst({ baseUrl: m2.origin })), (e) => e.code === code && e.status === http)
    } finally { await m2.close() }
  }
})

test('speechmatics: tts preview request shape, voice fallback, english only', async () => {
  const m = await mockServer(batch())
  try {
    const i = inst({ baseUrl: m.origin, defaultVoice: 'theo' })
    const out = await sm.tts({ text: 'Hello there', voice: 'megan', lang: 'en' }, i)
    assert.equal(out.mime, 'audio/wav')
    assert.equal(out.voice, 'megan')
    assert.equal(out.alignment, null)
    assert.ok(out.audio.length > 44 && out.durationS > 0)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/generate/megan')
    assert.equal(r.query, '?output_format=wav_16000')
    assert.ok(r.headers.authorization.startsWith('Bearer '))
    assert.deepEqual(r.json(), { text: 'Hello there' })
    const out2 = await sm.tts({ text: 'x', voice: 'nobody' }, i)
    assert.equal(out2.voice, 'theo')
    await assert.rejects(sm.tts({ text: 'γεια', lang: 'el' }, i), (e) => e.code === 'unsupported_lang')
  } finally { await m.close() }
})

test('speechmatics: tts errors map to typed codes', async () => {
  for (const [status, code] of [[401, 'bad_key'], [429, 'quota_exceeded'], [404, 'bad_voice'], [503, 'vendor']]) {
    const m = await mockServer((r, res) => reply(res, status, { error: 'x' }))
    try {
      await assert.rejects(sm.tts({ text: 'x' }, inst({ baseUrl: m.origin })), (e) => e.code === code)
    } finally { await m.close() }
  }
})

test('speechmatics: listVoices is the static english list', async () => {
  const all = await sm.listVoices(inst(), {})
  assert.deepEqual(all.map((v) => v.id), ['sarah', 'theo', 'megan', 'jack'])
  assert.deepEqual(await sm.listVoices(inst(), { lang: 'el' }), [])
  assert.equal((await sm.listVoices(inst(), { lang: 'en' })).length, 4)
})

test('speechmatics: health probes the job list, without a key stays offline', async () => {
  const m = await mockServer(batch())
  try {
    const ok = await sm.health(inst({ baseUrl: m.origin }))
    assert.equal(ok.status, 'up')
    assert.ok(m.reqs[0].headers.authorization.startsWith('Bearer '))
    const bad = await mockServer((r, res) => reply(res, 401, {}))
    try { assert.equal((await sm.health(inst({ baseUrl: bad.origin }))).status, 'down') } finally { await bad.close() }
  } finally { await m.close() }
  const before = m.reqs.length
  const none = await sm.health(inst({ key: '' }))
  assert.equal(none.ok, false)
  assert.equal(m.reqs.length, before)
})
