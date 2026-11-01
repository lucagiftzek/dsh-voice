import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import a from '../lib/server/providers/fish.js'
import { checkMeta } from './_meta.mjs'

const AUDIO = Buffer.from('FAKEAUDIOBYTES-0123456789')
const field = (req, name) => {
  const m = new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)\\r\\n').exec(req.body.toString('latin1'))
  return m ? m[1] : null
}

test('fish: metadata and capabilities (Italian yes, Greek unverified so absent)', () => {
  checkMeta(a, { group: 'other', residency: 'non-eu' })
  const c = a.capabilities(inst({}))
  assert.ok(c.ttsLangs.includes('it'))
  assert.ok(c.ttsLangs.includes('en'))
  assert.ok(!c.ttsLangs.includes('el'))
  assert.equal(c.alignment, 'none')
  assert.equal(c.stt, true)
  assert.deepEqual(a.capabilities(inst({ options: { ttsLangs: 'en,el' } })).ttsLangs, ['en', 'el'])
  assert.equal(a.configured(inst({})), true)
  assert.equal(a.configured(inst({ key: '' })), false)
})

test('fish: tts request shape with model header', async () => {
  const m = await mockServer((r, res) => reply(res, 200, AUDIO))
  try {
    const i = inst({ baseUrl: m.origin, models: { tts: 's2.1-pro-free' }, defaultVoice: 'abc123' })
    const out = await a.tts({ text: 'Ciao a tutti', speed: 1.2 }, i)
    assert.deepEqual(out.audio, AUDIO)
    assert.equal(out.mime, 'audio/mpeg')
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/v1/tts')
    assert.ok(r.headers.authorization.startsWith('Bearer '))
    assert.equal(r.headers.model, 's2.1-pro-free')
    assert.deepEqual(r.json(), { text: 'Ciao a tutti', format: 'mp3', normalize: true, reference_id: 'abc123', prosody: { speed: 1.2 } })
    await a.tts({ text: 'x', model: 's2-pro' }, inst({ baseUrl: m.origin }))
    assert.equal(m.reqs[1].headers.model, 's2-pro')
    assert.equal(m.reqs[1].json().reference_id, undefined)
  } finally { await m.close() }
})

test('fish: stt multipart, model header, word segments, speaker markers stripped', async () => {
  const m = await mockServer((r, res) => reply(res, 200, {
    text: '<|speaker:0|> ciao mondo', duration: 1.1, language_code: 'it',
    segments: [{ text: 'ciao', start: 0.1, end: 0.5 }, { text: 'mondo', start: 0.6, end: 1.1 }],
  }))
  try {
    const i = inst({ baseUrl: m.origin })
    const out = await a.stt({ audio: wavBuffer(), name: 'a.wav', mime: 'audio/wav', lang: 'it', wantWords: true }, i)
    const r = m.reqs[0]
    assert.equal(r.path, '/v1/asr')
    assert.equal(r.headers.model, 'transcribe-1-pro')
    assert.ok(r.headers.authorization.startsWith('Bearer '))
    assert.equal(field(r, 'ignore_timestamps'), 'false')
    assert.equal(field(r, 'language'), 'it')
    assert.match(r.body.toString('latin1'), /name="audio"; filename="a.wav"/)
    assert.equal(out.text, 'ciao mondo')
    assert.equal(out.language, 'it')
    assert.deepEqual(out.words, [{ w: 'ciao', t0: 0.1, t1: 0.5 }, { w: 'mondo', t0: 0.6, t1: 1.1 }])
    const plain = await a.stt({ audio: wavBuffer() }, i)
    assert.equal(plain.words, null)
    assert.equal(field(m.reqs[1], 'ignore_timestamps'), 'true')
  } finally { await m.close() }
})

test('fish: error mapping', async () => {
  let status = 401
  let body = { status: 401, message: 'bad' }
  const m = await mockServer((r, res) => reply(res, status, body))
  try {
    const i = inst({ baseUrl: m.origin })
    await assert.rejects(a.tts({ text: 'x' }, i), (e) => e.code === 'bad_key' && e.status === 502)
    status = 402
    await assert.rejects(a.tts({ text: 'x' }, i), (e) => e.code === 'quota_exceeded' && e.status === 429)
    status = 429
    await assert.rejects(a.stt({ audio: wavBuffer() }, i), (e) => e.code === 'quota_exceeded')
    status = 404
    body = { status: 404, message: 'reference model not found' }
    await assert.rejects(a.tts({ text: 'x', voice: 'nope' }, i), (e) => e.code === 'bad_voice' && e.status === 400)
    status = 503
    body = { status: 503, message: 'busy' }
    await assert.rejects(a.tts({ text: 'x' }, i), (e) => e.code === 'vendor' && e.status === 502)
  } finally { await m.close() }
})

test('fish: listVoices parse + cache, health with and without probe', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { total: 2, items: [
    { _id: 'v1', title: 'Giulia', languages: ['it', 'en'], tags: ['female'] },
    { _id: 'v2', title: 'Nikos', languages: ['el-GR'], tags: [] },
  ] }))
  try {
    const i = inst({ baseUrl: m.origin })
    const v = await a.listVoices(i, { lang: 'it' })
    assert.deepEqual(v.map((x) => [x.id, x.name, x.langs]), [['v1', 'Giulia', ['it', 'en']], ['v2', 'Nikos', ['el']]])
    await a.listVoices(i, { lang: 'it' })
    assert.equal(m.reqs.length, 1)
    assert.equal(m.reqs[0].path, '/model')
    assert.match(m.reqs[0].query, /language=it/)
    assert.equal((await a.health(i)).status, 'up')
    assert.equal((await a.health(inst({ baseUrl: m.origin, key: '' }))).status, 'down')
    assert.equal(m.reqs.length, 2)
  } finally { await m.close() }
})
