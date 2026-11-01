import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import a from '../lib/server/providers/openai.js'
import { checkMeta } from './_meta.mjs'

const AUDIO = Buffer.from('FAKEAUDIOBYTES-0123456789')
const field = (req, name) => {
  const m = new RegExp('name="' + name.replace(/[[\]]/g, '\\$&') + '"\\r\\n\\r\\n([^\\r]*)\\r\\n').exec(req.body.toString('latin1'))
  return m ? m[1] : null
}

test('openai: metadata, presets and residency', () => {
  checkMeta(a, { group: 'other', residency: 'non-eu' })
  assert.equal(a.type, 'openai')
  assert.equal(a.residencyOf({ baseUrl: 'https://eu.api.openai.com/v1' }), 'eu-region')
  assert.equal(a.residencyOf({ baseUrl: 'https://api.openai.com/v1' }), 'non-eu')
  assert.match(a.euNote, /approval/)
  assert.equal(a.presets.find((p) => p.id === 'openai-eu').residency, 'eu-region')
  assert.match(a.verification, /2027-01-06/)
})

test('openai: capabilities and configured', () => {
  const c = a.capabilities(inst({}))
  assert.equal(c.tts, true)
  assert.equal(c.stt, true)
  assert.equal(c.ttsLangs, '*')
  assert.equal(c.alignment, 'none')
  assert.deepEqual(c.nativeSpeed, [0.25, 4])
  assert.equal(a.configured(inst({})), true)
  assert.equal(a.configured(inst({ key: '' })), false)
})

test('openai: fixed voice list of 13', async () => {
  const v = await a.listVoices(inst({}), {})
  assert.equal(v.length, 13)
  assert.ok(v.find((x) => x.id === 'marin').tags.includes('recommended'))
  assert.ok(v.find((x) => x.id === 'alloy').tags.includes('all-models'))
})

test('openai: tts request shape and voice degradation per model', async () => {
  const m = await mockServer((r, res) => reply(res, 200, AUDIO))
  try {
    const i = inst({ baseUrl: m.origin + '/v1' })
    const out = await a.tts({ text: 'Ciao', voice: 'cedar', speed: 1.25 }, i)
    assert.deepEqual(out.audio, AUDIO)
    const r = m.reqs[0]
    assert.equal(r.path, '/v1/audio/speech')
    assert.ok(r.headers.authorization.startsWith('Bearer '))
    assert.deepEqual(r.json(), { model: 'gpt-4o-mini-tts', input: 'Ciao', voice: 'cedar', response_format: 'mp3', speed: 1.25 })
    const old = await a.tts({ text: 'x', voice: 'cedar', model: 'tts-1' }, i)
    assert.equal(m.reqs[1].json().voice, 'alloy')
    assert.match(old.note, /not offered/)
    await a.tts({ text: 'x', voice: 'voice_abc123' }, i)
    assert.equal(m.reqs[2].json().voice, 'voice_abc123')
  } finally { await m.close() }
})

test('openai: stt wantWords uses whisper-1 verbose_json; default is gpt-transcribe json with languages', async () => {
  const m = await mockServer((r, res) => {
    if (field(r, 'model') === 'whisper-1') return reply(res, 200, { text: 'ciao mondo', language: 'italian', duration: 1, words: [{ word: 'ciao', start: 0, end: 0.4 }, { word: 'mondo', start: 0.5, end: 1 }] })
    return reply(res, 200, { text: 'ciao mondo', languages: [{ code: 'it' }] })
  })
  try {
    const i = inst({ baseUrl: m.origin + '/v1' })
    const w = await a.stt({ audio: wavBuffer(), lang: 'it', wantWords: true }, i)
    assert.equal(field(m.reqs[0], 'model'), 'whisper-1')
    assert.equal(field(m.reqs[0], 'timestamp_granularities[]'), 'word')
    assert.equal(w.language, 'it')
    assert.deepEqual(w.words.map((x) => x.w), ['ciao', 'mondo'])
    const p = await a.stt({ audio: wavBuffer(), lang: 'it' }, i)
    assert.equal(field(m.reqs[1], 'model'), 'gpt-transcribe')
    assert.equal(field(m.reqs[1], 'languages[]'), 'it')
    assert.equal(field(m.reqs[1], 'language'), null)
    assert.equal(p.language, 'it')
    assert.equal(p.words, null)
    const g = await a.stt({ audio: wavBuffer(), model: 'gpt-4o-transcribe', lang: 'el', wantWords: true }, i)
    assert.equal(field(m.reqs[2], 'language'), 'el')
    assert.equal(field(m.reqs[2], 'response_format'), null)
    assert.equal(g.words, null)
  } finally { await m.close() }
})

test('openai: errors and health', async () => {
  let status = 401
  const m = await mockServer((r, res) => reply(res, r.path.endsWith('/models') ? 200 : status, { error: { message: 'x' } }))
  try {
    const i = inst({ baseUrl: m.origin + '/v1' })
    await assert.rejects(a.tts({ text: 'x' }, i), (e) => e.code === 'bad_key')
    status = 429
    await assert.rejects(a.stt({ audio: wavBuffer() }, i), (e) => e.code === 'quota_exceeded')
    status = 500
    await assert.rejects(a.tts({ text: 'x' }, i), (e) => e.code === 'vendor')
    assert.equal((await a.health(i)).status, 'up')
    assert.equal((await a.health(inst({ baseUrl: m.origin + '/v1', key: '' }))).status, 'down')
  } finally { await m.close() }
})
