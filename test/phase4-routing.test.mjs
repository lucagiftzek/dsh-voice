// Phase 4 integration: new provider types reached through the real /api/voice routes,
// per-language routing that never sends a language to a provider that lacks it,
// and credential pointers resolved from a FAKE environment only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, voiceServer, wavBuffer, multipartUpload, makeRegistry } from './helpers.mjs'
import { resolveTts, resolveStt } from '../lib/server/routing.js'

const AUDIO = Buffer.from('FAKEAUDIO-phase4-0123456789')

test('stt route: a Deepgram instance configured in settings serves Greek through its credential pointer', async () => {
  const dg = await mockServer((r, res) => reply(res, 200, { results: { channels: [{ detected_language: 'el', alternatives: [{ transcript: 'kalimera', words: [{ word: 'kalimera', start: 0, end: 0.5, confidence: 0.9 }] }] }] } }))
  const env = { FAKE_DEEPGRAM_KEY: 'fake-dg-key-0000' }
  const v = await voiceServer(env, { config: {
    providers: [{ id: 'dg', type: 'deepgram', baseUrl: dg.origin, credential: 'env:FAKE_DEEPGRAM_KEY', inAuto: false }],
    perLanguage: { el: { stt: { provider: 'dg' } } },
  } })
  try {
    const up = multipartUpload(wavBuffer(), 'clip.wav')
    const r = await v.call('POST', '/stt?lang=el', { headers: { 'content-type': up.contentType }, body: up.body })
    assert.equal(r.status, 200)
    assert.equal(r.json.engine, 'dg')
    assert.equal(r.json.text, 'kalimera')
    const req = dg.reqs[0]
    assert.equal(req.path, '/v1/listen')
    assert.equal(req.headers.authorization.startsWith('Token '), true)
    assert.equal(req.headers.authorization.includes('fake-dg-key-0000'), true)
    // the settings view reports the pointer as found and never contains the key
    const view = await v.call('GET', '/settings')
    assert.equal(view.text.includes('fake-dg-key-0000'), false)
    const inst = view.json.instances.find((i) => i.id === 'dg')
    assert.equal(inst.credential.kind, 'pointer')
    assert.equal(inst.credential.resolved, true)
    assert.equal(inst.group, 'other')
    assert.equal(inst.residency, 'non-eu')
  } finally { await v.close(); await dg.close() }
})

test('tts route with alignment: Kokoro-FastAPI captions reach the client as word items', async () => {
  const k = await mockServer((r, res) => {
    if (r.path === '/dev/captioned_speech') {
      return reply(res, 200, { audio: AUDIO.toString('base64'), timestamps: [{ word: 'Hello', start_time: 0, end_time: 0.4 }, { word: 'world', start_time: 0.5, end_time: 0.9 }] })
    }
    return reply(res, 404, {})
  })
  const v = await voiceServer({}, { config: {
    providers: [{ id: 'kokoro', type: 'openai-compatible', baseUrl: k.origin + '/v1', credential: '', group: 'self', options: { tts: true, stt: false, keyless: true, captions: true }, defaultVoice: 'af_heart', models: { tts: 'kokoro' } }],
  } })
  try {
    const r = await v.call('POST', '/tts?alignment=1', { body: { text: 'Hello world', provider: 'kokoro', lang: 'en' } })
    assert.equal(r.status, 200)
    assert.equal(r.json.engine, 'kokoro')
    assert.deepEqual(r.json.alignment.items.map((x) => 'Hello world'.slice(x.c0, x.c1)), ['Hello', 'world'])
    assert.equal(r.json.alignment.items[1].t0, 0.5)
  } finally { await v.close(); await k.close() }
})

test('routing: a provider without Greek is skipped for Greek, a provider with Greek is used', async () => {
  const providers = [
    { id: 'polly', type: 'amazon', credential: 'fake-access:fake-secret', region: 'eu-west-1' },
    { id: 'dg', type: 'deepgram', credential: 'fake-dg-key-0000' },
    { id: 'az', type: 'azure', credential: 'fake-az-key-0000', region: 'westeurope' },
  ]
  const { reg, settings } = makeRegistry({}, { providers: providers.map((p) => Object.assign({ enabled: true, inAuto: true }, p)), perLanguage: { el: { tts: { provider: 'nope', fallback: [] } }, it: { tts: { provider: 'nope', fallback: [] } } } })
  const el = await resolveTts({ lang: 'el', settings, reg })
  assert.equal(el.id, 'az', 'Greek goes to the only provider that speaks it')
  const it = await resolveTts({ lang: 'it', settings, reg })
  assert.ok(['polly', 'dg', 'az'].includes(it.id), 'Italian may use any of the three, got ' + it.id)
  // speech-to-text: AssemblyAI sends Greek to Universal-2 only, the adapter lists it
  const s = makeRegistry({}, { providers: [{ id: 'aai', type: 'assemblyai', credential: 'fake-aai-key-0000', enabled: true, inAuto: true }], perLanguage: { el: { stt: { provider: 'nope' } } } })
  const st = await resolveStt({ lang: 'el', settings: s.settings, reg: s.reg })
  assert.equal(st.id, 'aai')
})

test('an unconfigured provider is never chosen, and a disabled one neither', async () => {
  const { reg, settings } = makeRegistry({}, { providers: [
    { id: 'rs', type: 'readspeaker', credential: '', enabled: true, inAuto: true },
    { id: 'az', type: 'azure', credential: 'fake-az-key-0000', region: 'westeurope', enabled: false, inAuto: true },
  ], perLanguage: { el: { tts: { provider: 'nope' } } } })
  const el = await resolveTts({ lang: 'el', settings, reg })
  assert.ok(el.id !== 'rs' && el.id !== 'az', 'got ' + el.id)
})
