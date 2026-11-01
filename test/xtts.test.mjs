import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import a, { XTTS_LANGS } from '../lib/server/providers/xtts.js'
import { checkMeta } from './_meta.mjs'

test('xtts: metadata and languages (no Greek, Italian yes)', () => {
  checkMeta(a, { group: 'self', residency: 'self' })
  assert.match(a.euNote, /CPML/)
  assert.match(a.euNote, /defunct/)
  const c = a.capabilities(inst({}))
  assert.deepEqual(c.ttsLangs, XTTS_LANGS)
  assert.ok(c.ttsLangs.includes('it'))
  assert.ok(!c.ttsLangs.includes('el'))
  assert.equal(c.stt, false)
  assert.equal(c.alignment, 'none')
  assert.deepEqual(a.capabilities(inst({ options: { ttsLangs: 'it' } })).ttsLangs, ['it'])
})

test('xtts: tts request shape', async () => {
  const wav = wavBuffer()
  const m = await mockServer((r, res) => reply(res, 200, wav, { 'content-type': 'audio/wav' }))
  try {
    const i = inst({ baseUrl: m.origin, key: '', defaultVoice: 'female' })
    const out = await a.tts({ text: 'Buongiorno', lang: 'it-IT' }, i)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/tts_to_audio/')
    assert.deepEqual(r.json(), { text: 'Buongiorno', speaker_wav: 'female', language: 'it' })
    assert.equal(r.headers.authorization, undefined)
    assert.deepEqual(out.audio, wav)
    assert.equal(out.mime, 'audio/wav')
    await a.tts({ text: 'x', lang: 'zh', voice: 'v2' }, i)
    assert.deepEqual(m.reqs[1].json(), { text: 'x', speaker_wav: 'v2', language: 'zh-cn' })
  } finally { await m.close() }
})

test('xtts: unsupported language and missing speaker are typed errors without a request', async () => {
  const m = await mockServer((r, res) => reply(res, 200, wavBuffer()))
  try {
    const i = inst({ baseUrl: m.origin, defaultVoice: 'female' })
    await assert.rejects(a.tts({ text: 'x', lang: 'el' }, i), (e) => e.code === 'unsupported_lang' && e.status === 400)
    await assert.rejects(a.tts({ text: 'x', lang: 'en' }, inst({ baseUrl: m.origin })), (e) => e.code === 'bad_voice' && e.status === 400)
    assert.equal(m.reqs.length, 0)
  } finally { await m.close() }
})

test('xtts: error mapping', async () => {
  let status = 500
  let body = { detail: 'Error: speaker wav not found' }
  const m = await mockServer((r, res) => reply(res, status, body))
  try {
    const i = inst({ baseUrl: m.origin, defaultVoice: 'female' })
    await assert.rejects(a.tts({ text: 'x', lang: 'en' }, i), (e) => e.code === 'bad_voice')
    status = 401
    await assert.rejects(a.tts({ text: 'x', lang: 'en' }, i), (e) => e.code === 'bad_key')
    status = 429
    await assert.rejects(a.tts({ text: 'x', lang: 'en' }, i), (e) => e.code === 'quota_exceeded')
    status = 502
    body = { detail: 'gateway' }
    await assert.rejects(a.tts({ text: 'x', lang: 'en' }, i), (e) => e.code === 'vendor')
  } finally { await m.close() }
})

test('xtts: speakers parsed and cached, health', async () => {
  const m = await mockServer((r, res) => {
    if (r.path === '/speakers') return reply(res, 200, [{ name: 'female', voice_id: 'female.wav', preview_url: 'http://x/sample/female.wav' }, { name: 'male', voice_id: 'male.wav' }])
    if (r.path === '/languages') return reply(res, 200, { languages: { en: 'English' } })
    return reply(res, 404, {})
  })
  try {
    const i = inst({ baseUrl: m.origin })
    const v = await a.listVoices(i, {})
    assert.deepEqual(v.map((x) => [x.id, x.name]), [['female.wav', 'female'], ['male.wav', 'male']])
    await a.listVoices(i, {})
    assert.equal(m.reqs.length, 1)
    assert.equal((await a.health(i)).status, 'up')
  } finally { await m.close() }
})
