import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import a, { langOfVoice, wavSeconds } from '../lib/server/providers/piper.js'
import { checkMeta } from './_meta.mjs'

const VOICES = { 'el_GR-rapunzelina-medium': { num_speakers: 1 }, 'it_IT-paola-medium': { num_speakers: 1 }, 'en_US-lessac-medium': { num_speakers: 1 } }
const WAV = wavBuffer(24000)
const server = () => mockServer((r, res) => {
  if (r.path === '/voices') return reply(res, 200, VOICES)
  if (r.path === '/synthesize') return reply(res, 200, WAV, { 'content-type': 'audio/wav' })
  return reply(res, 404, {})
})

test('piper: metadata and helpers', () => {
  checkMeta(a, { group: 'self', residency: 'self' })
  assert.equal(langOfVoice('el_GR-rapunzelina-low'), 'el')
  assert.equal(langOfVoice('it_IT-riccardo-x_low'), 'it')
  assert.ok(Math.abs(wavSeconds(WAV) - 1.5) < 1e-6)
  assert.equal(a.configured(inst({ baseUrl: 'http://x', key: '' })), true)
  assert.equal(a.configured(inst({ baseUrl: '', key: '' })), false)
})

test('piper: voices parsed, cached, capabilities follow the list', async () => {
  const m = await server()
  try {
    const i = inst({ baseUrl: m.origin })
    assert.deepEqual(a.capabilities(i).ttsLangs, [])
    const v = await a.listVoices(i, {})
    assert.equal(v.length, 3)
    assert.deepEqual((await a.listVoices(i, { lang: 'el' })).map((x) => x.id), ['el_GR-rapunzelina-medium'])
    assert.equal(m.reqs.length, 1)
    assert.deepEqual(a.capabilities(i).ttsLangs.slice().sort(), ['el', 'en', 'it'])
    assert.equal(a.capabilities(i).stt, false)
    assert.deepEqual(a.capabilities(inst({ options: { ttsLangs: 'it,el' } })).ttsLangs, ['it', 'el'])
  } finally { await m.close() }
})

test('piper: tts request shape, language picks voice, speed maps to length_scale', async () => {
  const m = await server()
  try {
    const i = inst({ baseUrl: m.origin, key: '' })
    const out = await a.tts({ text: 'Kalimera', lang: 'el', speed: 2 }, i)
    const r = m.reqs.find((x) => x.path === '/synthesize')
    assert.equal(r.method, 'POST')
    assert.deepEqual(r.json(), { text: 'Kalimera', voice: 'el_GR-rapunzelina-medium', length_scale: 0.5 })
    assert.equal(r.headers.authorization, undefined)
    assert.equal(out.mime, 'audio/wav')
    assert.ok(Math.abs(out.durationS - 1.5) < 1e-6)
    assert.equal(out.alignment, null)
    const bad = await a.tts({ text: 'x', voice: 'zz_ZZ-none-low' }, i)
    assert.match(bad.note, /not on this server/)
  } finally { await m.close() }
})

test('piper: error mapping and health', async () => {
  let status = 500
  let body = 'Voice not found'
  const m = await mockServer((r, res) => (r.path === '/voices' ? reply(res, 200, VOICES) : reply(res, status, body)))
  try {
    const i = inst({ baseUrl: m.origin })
    await assert.rejects(a.tts({ text: 'x', voice: 'el_GR-rapunzelina-medium' }, i), (e) => e.code === 'bad_voice' && e.status === 400)
    status = 401
    await assert.rejects(a.tts({ text: 'x' }, i), (e) => e.code === 'bad_key')
    status = 429
    await assert.rejects(a.tts({ text: 'x' }, i), (e) => e.code === 'quota_exceeded')
    status = 503
    body = 'busy'
    await assert.rejects(a.tts({ text: 'x' }, i), (e) => e.code === 'vendor' && e.status === 502)
    const h = await a.health(i)
    assert.equal(h.status, 'up')
  } finally { await m.close() }
})
