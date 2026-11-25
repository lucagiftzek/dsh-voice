// OpenRouter adapter: catalogue (voices per model, formats, speed range, instructions), request shape,
// PCM wrapped into a WAV, typed errors, transcription, health, and the /tts route through a settings instance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer, multipartUpload, voiceServer } from './helpers.mjs'
import a, { DEFAULT_TTS, DEFAULT_STT, normalizeModel, mergeCatalogues, voiceLangs, catalogue, openrouterError, pcmRate, providerRouting } from '../lib/server/providers/openrouter.js'
import { checkMeta } from './_meta.mjs'

const MP3 = Buffer.from('FAKEAUDIOBYTES-openrouter-0123456789')
const sp = (params) => ({ type: 'speech', supported_parameters: params })
const SPEECH = [
  { id: 'mistralai/voxtral-mini-tts-3-0', name: 'Mistral: Voxtral TTS 3', description: 'accepts emotion and pace tags', output_modalities: [sp({ voice: { type: 'enum', values: ['gb_oliver_neutral', 'voice_482'] }, response_format: { type: 'enum', values: ['mp3', 'pcm'] } })], endpoints: [{ provider_name: 'Mistral', provider_slug: 'mistral/eu' }, { provider_name: 'Mistral', provider_slug: 'mistral/zdr' }] },
  { id: 'elevenlabs/eleven-v3', name: 'ElevenLabs: Eleven v3', description: 'has a 5,000-character request limit', output_modalities: [sp({ voice: { type: 'enum', values: ['george', 'sarah'] }, response_format: { type: 'enum', values: ['mp3', 'pcm'] }, speed: { type: 'range', min: 0.7, max: 1.2 } })], endpoints: [{ provider_name: 'ElevenLabs', provider_slug: 'elevenlabs' }] },
  { id: 'heygen/heygen-voice-1-turbo', name: 'HeyGen: HeyGen Voice Turbo', description: 'streams', output_modalities: [sp({ voice: { type: 'enum', values: ['nadine', 'tabitha'] }, response_format: { type: 'enum', values: ['pcm'] } })], endpoints: [{ provider_name: 'HeyGen', provider_slug: 'heygen' }] },
  { id: 'google/gemini-3.8-flash-lite-tts', name: 'Google: Gemini 3.8 Flash Lite TTS', description: 'fast', output_modalities: [sp({ voice: { type: 'enum', values: ['Kore', 'Puck'] }, response_format: { type: 'enum', values: ['pcm'] }, instructions: { type: 'unknown' } })], endpoints: [{ provider_name: 'Google AI Studio', provider_slug: 'google-ai-studio' }] },
  { id: 'fish-audio/s2.1-pro', name: 'Fish Audio: S2.1 Pro', description: 'open-ended controls', output_modalities: [sp({ voice: { type: 'unknown' }, response_format: { type: 'enum', values: ['mp3', 'pcm'] }, speed: { type: 'range', min: 0.5, max: 2 }, instructions: { type: 'unknown' } })], endpoints: [{ provider_name: 'Fish Audio', provider_slug: 'fish-audio' }] },
  { id: 'bytedance-seed/seed-audio-1-0', name: 'ByteDance Seed: Seed Audio 1.0', description: 'prompt', output_modalities: [sp({ voice: { type: 'unknown' }, response_format: { type: 'enum', values: ['mp3', 'pcm'] }, speed: { type: 'range', min: 0.5, max: 2 } })], endpoints: [{ provider_name: 'Seed', provider_slug: 'seed' }] },
  { id: 'microsoft/mai-voice-2.1', name: 'Microsoft AI: MAI-Voice-2.1', description: '', output_modalities: [sp({ voice: { type: 'enum', values: ['en-US-Harper:MAI-Voice-2.1', 'it-IT-Luca:MAI-Voice-2.1'] }, response_format: { type: 'enum', values: ['mp3', 'pcm'] }, speed: { type: 'range', min: 0.5, max: 2 } })], endpoints: [{ provider_name: 'Azure', provider_slug: 'azure' }] },
]
const GENERAL = [
  { id: 'heygen/heygen-voice-1-turbo:free', name: 'HeyGen: HeyGen Voice Turbo (free)', supported_voices: [] },
  { id: 'minimax/speech-2.8-hd', name: 'MiniMax: Speech 2.8 HD', supported_voices: ['m1', 'm2'] },
  { id: 'openrouter/auto', name: 'Router', supported_voices: [] },
]

async function vendor(over) {
  const o = over || {}
  return mockServer((r, res) => {
    if (o.before && o.before(r, res)) return
    if (r.path === '/v1/audio/speech/models') return reply(res, o.catalogStatus || 200, { data: SPEECH })
    if (r.path === '/v1/models') return reply(res, 200, { data: GENERAL })
    if (r.path === '/v1/auth/key') return reply(res, o.keyStatus || 200, { data: { label: 'x' } })
    if (r.path === '/v1/audio/speech') {
      const j = r.json()
      if (/heygen/.test(j.model)) return reply(res, 200, Buffer.alloc(44100 * 2), { 'content-type': 'audio/pcm;rate=44100;channels=1' })
      return reply(res, 200, MP3)
    }
    if (r.path === '/v1/audio/transcriptions') return reply(res, 200, { text: 'ciao mondo', usage: { seconds: 1, cost: 0 } })
    return reply(res, 404, { error: { message: 'not found' } })
  })
}
const or = (m, over) => inst(Object.assign({ id: 'openrouter', baseUrl: m.origin + '/v1' }, over || {}))

test('openrouter: metadata, presets and capabilities', () => {
  checkMeta(a, { group: 'other', residency: 'varies' })
  assert.equal(a.type, 'openrouter')
  assert.equal(a.presets[0].baseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(a.presets[0].models.tts, DEFAULT_TTS)
  const c = a.capabilities(inst({}))
  assert.equal(c.tts, true)
  assert.equal(c.stt, true)
  assert.equal(c.ttsLangs, '*')
  assert.deepEqual(a.capabilities(inst({ options: { ttsLangs: 'en,it' } })).ttsLangs, ['en', 'it'])
  assert.deepEqual(c.formats, ['mp3', 'wav'])
  assert.equal(a.configured(inst({})), true)
  assert.equal(a.configured(inst({ key: '' })), false)
})

test('openrouter: a catalogue entry carries its voices, formats, speed range, instructions and limit', () => {
  const vox = normalizeModel(SPEECH[0])
  assert.equal(vox.label, 'Mistral: Voxtral TTS 3')
  assert.deepEqual(vox.voices.map((v) => v.id), ['gb_oliver_neutral', 'voice_482'])
  assert.deepEqual(vox.formats, ['mp3', 'pcm'])
  assert.equal(vox.speed, null)
  assert.equal(vox.instructions, false)
  assert.equal(vox.voiceUnknown, false)
  assert.deepEqual(vox.providers, ['mistral/eu', 'mistral/zdr'])
  const el = normalizeModel(SPEECH[1])
  assert.deepEqual(el.speed, [0.7, 1.2])
  assert.equal(el.maxChars, 5000, 'the limit is read from the description')
  const gem = normalizeModel(SPEECH[3])
  assert.equal(gem.instructions, true)
  assert.deepEqual(gem.formats, ['pcm'])
  const fish = normalizeModel(SPEECH[4])
  assert.equal(fish.voiceUnknown, true, 'no voice list published, the vendor takes its own ids')
  assert.equal(normalizeModel(SPEECH[5]).maxChars, 3000, 'a limit the catalogue text does not state')
})

test('openrouter: the general catalogue adds only real extras (free variants of a known model, models with voices)', () => {
  const merged = mergeCatalogues(SPEECH.map((m) => normalizeModel(m)), GENERAL)
  const ids = merged.map((x) => x.id)
  assert.equal(ids.length, SPEECH.length + 2)
  assert.ok(!ids.includes('openrouter/auto'), 'a router model with no voices is not a speech model')
  const free = merged.find((x) => x.id === 'heygen/heygen-voice-1-turbo:free')
  assert.equal(free.label, 'HeyGen: HeyGen Voice Turbo (free)')
  assert.deepEqual(free.voices.map((v) => v.id), ['nadine', 'tabitha'], 'a variant takes its base model voices')
  assert.deepEqual(free.formats, ['pcm'])
  const mini = merged.find((x) => x.id === 'minimax/speech-2.8-hd')
  assert.deepEqual(mini.voices.map((v) => v.id), ['m1', 'm2'])
  assert.deepEqual(mini.formats, ['mp3', 'pcm'], 'mp3 is asked for first when the catalogue does not say')
})

test('openrouter: a voice language is read from the id where it names one', () => {
  assert.deepEqual(voiceLangs('hexgrad/kokoro-82m', 'af_heart'), ['en'])
  assert.deepEqual(voiceLangs('hexgrad/kokoro-82m', 'if_sara'), ['it'])
  assert.deepEqual(voiceLangs('microsoft/mai-voice-2.1', 'it-IT-Luca:MAI-Voice-2.1'), ['it'])
  assert.deepEqual(voiceLangs('deepgram/aura-2', 'aura-2-cesare-it'), ['it'])
  assert.deepEqual(voiceLangs('mistralai/voxtral-mini-tts-3-0', 'fr_marie_happy'), ['fr'])
  assert.deepEqual(voiceLangs('mistralai/voxtral-mini-tts-3-0', 'voice_482'), [], 'a numbered Voxtral voice does not name its language')
  assert.deepEqual(voiceLangs('elevenlabs/eleven-v3', 'george'), [], 'multilingual voices do not name one')
})

test('openrouter: the catalogue is fetched once per 10 minutes and a failed refresh keeps the previous list', async () => {
  let status = 200
  const m = await vendor({ before: (r, res) => {
    if (r.path !== '/v1/audio/speech/models' || status === 200) return false
    reply(res, status, { error: { message: 'down' } })
    return true
  } })
  try {
    const i = or(m)
    const c1 = await catalogue(i)
    assert.equal(c1.list.length, SPEECH.length + 2)
    assert.equal(c1.error, '')
    await catalogue(i)
    assert.equal(m.reqs.filter((r) => r.path === '/v1/audio/speech/models').length, 1)
    i.state.orCatalog.at = Date.now() - 11 * 60 * 1000
    status = 500
    const c2 = await catalogue(i)
    assert.equal(c2.list.length, SPEECH.length + 2, 'the previous list is kept')
    assert.match(c2.error, /HTTP 500/)
    await catalogue(i)
    assert.equal(m.reqs.filter((r) => r.path === '/v1/audio/speech/models').length, 2, 'a failed catalogue is not retried for a minute')
  } finally { await m.close() }
})

test('openrouter: tts request shape follows the catalogue entry of the model', async () => {
  const m = await vendor()
  try {
    const i = or(m)
    await a.tts({ text: 'Ciao', voice: 'voice_482' }, i)
    assert.deepEqual(m.reqs.find((r) => r.path === '/v1/audio/speech').json(), { model: DEFAULT_TTS, input: 'Ciao', voice: 'voice_482', response_format: 'mp3' })
    assert.ok(m.reqs.find((r) => r.path === '/v1/audio/speech').headers.authorization.startsWith('Bearer '))
    // speed only to a model that publishes a range, clamped to it; instructions only where the model takes them
    await a.tts({ text: 'x', model: 'elevenlabs/eleven-v3', voice: 'george', speed: 1.9, instructions: 'calm' }, i)
    assert.deepEqual(m.reqs.at(-1).json(), { model: 'elevenlabs/eleven-v3', input: 'x', voice: 'george', response_format: 'mp3', speed: 1.2 })
    await a.tts({ text: 'x', model: 'google/gemini-3.8-flash-lite-tts', voice: 'Kore', speed: 1.5, instructions: 'warm and friendly' }, i)
    assert.deepEqual(m.reqs.at(-1).json(), { model: 'google/gemini-3.8-flash-lite-tts', input: 'x', voice: 'Kore', response_format: 'pcm', instructions: 'warm and friendly' })
    await a.tts({ text: 'x', voice: 'gb_oliver_neutral', speed: 1.5, instructions: 'calm' }, i)
    assert.deepEqual(m.reqs.at(-1).json(), { model: DEFAULT_TTS, input: 'x', voice: 'gb_oliver_neutral', response_format: 'mp3' })
  } finally { await m.close() }
})

test('openrouter: a voice belongs to one model: an unknown voice falls back to the instance voice, then to the model first voice', async () => {
  const m = await vendor()
  try {
    const out = await a.tts({ text: 'x', model: 'elevenlabs/eleven-v3', voice: 'gb_oliver_neutral' }, or(m, { defaultVoice: 'sarah' }))
    assert.equal(out.voice, 'sarah')
    assert.match(out.note, /gb_oliver_neutral.*eleven-v3.*sarah/)
    const out2 = await a.tts({ text: 'x', model: 'elevenlabs/eleven-v3' }, or(m))
    assert.equal(out2.voice, 'george')
    assert.match(out2.note, /no voice given/)
    // a model with no published voices takes the voice as given
    await a.tts({ text: 'x', model: 'fish-audio/s2.1-pro', voice: 'fish-model-id-123' }, or(m))
    assert.equal(m.reqs.at(-1).json().voice, 'fish-model-id-123')
    // Fish Audio requires a voice; Seed Audio infers one
    await assert.rejects(a.tts({ text: 'x', model: 'fish-audio/s2.1-pro' }, or(m)), (e) => e.code === 'bad_voice' && /Fish Audio model id/.test(e.message))
    await a.tts({ text: 'x', model: 'bytedance-seed/seed-audio-1-0' }, or(m, { defaultVoice: '' }))
    assert.equal(m.reqs.at(-1).json().voice, undefined)
  } finally { await m.close() }
})

test('openrouter: a model that is not in the catalogue is still called; the instance model is the default', async () => {
  const m = await vendor()
  try {
    const out = await a.tts({ text: 'x', voice: 'whatever' }, or(m, { models: { tts: 'elevenlabs/eleven-v4-private' } }))
    assert.equal(out.model, 'elevenlabs/eleven-v4-private')
    assert.equal(out.voice, 'whatever')
    assert.equal(m.reqs.at(-1).json().response_format, 'mp3')
    await a.tts({ text: 'x', model: 'not a model id' }, or(m, { models: { tts: 'elevenlabs/eleven-v4-private' } }))
    assert.equal(m.reqs.at(-1).json().model, 'elevenlabs/eleven-v4-private', 'an invalid model id falls back to the instance model instead of failing')
  } finally { await m.close() }
})

test('openrouter: PCM answers are wrapped into a WAV at the rate of the header', async () => {
  assert.equal(pcmRate('audio/pcm;rate=44100;channels=1'), 44100)
  assert.equal(pcmRate('audio/pcm'), 24000)
  const m = await vendor()
  try {
    const out = await a.tts({ text: 'x', model: 'heygen/heygen-voice-1-turbo:free', voice: 'nadine' }, or(m))
    assert.equal(out.mime, 'audio/wav')
    assert.equal(out.audio.slice(0, 4).toString('latin1'), 'RIFF')
    assert.equal(out.audio.readUInt32LE(24), 44100, 'sample rate from the header')
    assert.equal(out.audio.readUInt32LE(40), 44100 * 2, 'the PCM payload follows the 44 byte header')
    assert.equal(out.model, 'heygen/heygen-voice-1-turbo:free')
    const mp3 = await a.tts({ text: 'x' }, or(m))
    assert.equal(mp3.mime, 'audio/mpeg')
    assert.deepEqual(mp3.audio, MP3)
  } finally { await m.close() }
})

test('openrouter: provider routing options are sent only for slugs that serve the model', () => {
  const vox = normalizeModel(SPEECH[0])
  assert.deepEqual(providerRouting(inst({ options: { preferProviders: 'mistral/eu, elevenlabs' } }), vox), { order: ['mistral/eu'] })
  assert.deepEqual(providerRouting(inst({ options: { onlyProviders: 'mistral/eu', zdr: true } }), vox), { only: ['mistral/eu'], zdr: true })
  assert.equal(providerRouting(inst({ options: { preferProviders: 'elevenlabs' } }), vox), null)
  assert.equal(providerRouting(inst({ options: { preferProviders: 'anything' } }), null), null, 'no catalogue entry: the preference is dropped rather than sent blind')
  assert.equal(providerRouting(inst({}), vox), null)
})

test('openrouter: errors are typed the way the 1.x routes expect', async () => {
  const m = await vendor({ before: (r, res) => {
    if (r.path !== '/v1/audio/speech') return false
    const j = r.json()
    if (j.voice === 'nope') { reply(res, 404, { error: { message: 'Provider returned 404', code: 404 } }); return true }
    if (/does-not-exist/.test(j.model)) { reply(res, 400, { error: { message: 'Model x/does-not-exist does not exist', code: 400 } }); return true }
    return false
  } })
  try {
    const i = or(m)
    // a model outside the catalogue is not validated locally, so the vendor's answer is the one typed
    await assert.rejects(a.tts({ text: 'x', model: 'x/unknown-model', voice: 'nope' }, i), (e) => e.code === 'bad_voice' && /404/.test(e.message))
    await assert.rejects(a.tts({ text: 'x', model: 'x/does-not-exist' }, i), (e) => e.code === 'bad_voice' && /does not exist/.test(e.message))
  } finally { await m.close() }
  const bad = (status, message) => openrouterError('tts', { status, body: Buffer.from(JSON.stringify({ error: { message } })) })
  assert.equal(bad(401, 'No auth credentials found').code, 'bad_key')
  assert.equal(bad(402, 'Insufficient credits').code, 'quota_exceeded')
  assert.equal(bad(429, 'rate limited').code, 'quota_exceeded')
  assert.equal(bad(400, 'HeyGen Voice only supports response_format "pcm".').code, 'vendor', 'a format refusal is the vendor shape, not a bad voice')
  assert.equal(bad(502, 'provider offline').code, 'vendor')
  // a key-shaped value in an upstream body must never reach the error: scrub() masks it
  const shaped = ['s', 'k', '-', 'abcdefghijklmnopqrstuvwx'].join('')
  assert.ok(!bad(401, shaped).message.includes(shaped), 'key-shaped text is scrubbed')
})

test('openrouter: transcription posts the multipart file with the default model unless one is given', async () => {
  const m = await vendor()
  try {
    const i = or(m)
    const out = await a.stt({ audio: wavBuffer(), name: 'clip.wav', mime: 'audio/wav' }, i)
    assert.equal(out.text, 'ciao mondo')
    const req = m.reqs.find((r) => r.path === '/v1/audio/transcriptions')
    assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/)
    assert.ok(/name="model"\r\n\r\nopenai\/whisper-large-v3-turbo/.test(req.body.toString('latin1')))
    await a.stt({ audio: wavBuffer(), model: 'elevenlabs/scribe-v2' }, or(m, { models: { stt: 'mistralai/voxtral-mini-transcribe-3-0' } }))
    assert.ok(/name="model"\r\n\r\nelevenlabs\/scribe-v2/.test(m.reqs.at(-1).body.toString('latin1')))
    await a.stt({ audio: wavBuffer() }, or(m, { models: { stt: 'mistralai/voxtral-mini-transcribe-3-0' } }))
    assert.ok(/name="model"\r\n\r\nmistralai\/voxtral-mini-transcribe-3-0/.test(m.reqs.at(-1).body.toString('latin1')))
  } finally { await m.close() }
  assert.equal(DEFAULT_STT, 'openai/whisper-large-v3-turbo')
})

test('openrouter: health checks the key and counts the catalogue', async () => {
  const m = await vendor()
  try {
    const h = await a.health(or(m))
    assert.equal(h.status, 'up')
    assert.match(h.detail, /speech models/)
    const down = await vendor({ keyStatus: 401 })
    try { assert.equal((await a.health(or(down))).status, 'down') } finally { await down.close() }
    // a loopback instance (a local proxy under test) needs no key; a keyless CLOUD instance never counts as up
    assert.equal((await a.health(or(m, { key: '' }))).status, 'up')
    assert.equal((await a.health(or(m, { key: '', baseUrl: 'https://openrouter.ai/api/v1' }))).detail, 'no API key')
    assert.equal((await a.health(or(m))).detail, '9 speech models')
  } finally { await m.close() }
})

test('openrouter: voices and reader models come from the catalogue', async () => {
  const m = await vendor()
  try {
    const i = or(m)
    assert.deepEqual((await a.listVoices(i, { model: 'elevenlabs/eleven-v3' })).map((v) => v.id), ['george', 'sarah'])
    assert.deepEqual((await a.listVoices(i)).map((v) => v.id), ['gb_oliver_neutral', 'voice_482'], 'no model: the instance default')
    assert.deepEqual((await a.listVoices(i, { model: 'microsoft/mai-voice-2.1', lang: 'it' })).map((v) => v.id), ['it-IT-Luca:MAI-Voice-2.1'])
    const models = await a.ttsModels(i)
    assert.equal(models.find((x) => x.default).id, DEFAULT_TTS)
    assert.equal(models.find((x) => x.id === 'elevenlabs/eleven-v3').group, 'elevenlabs')
    assert.deepEqual(models.find((x) => x.id === 'google/gemini-3.8-flash-lite-tts').formats, ['pcm'])
    const legacy = await a.legacyConfig(i, true)
    assert.equal(legacy.models.tts.length, SPEECH.length + 2)
    assert.deepEqual(legacy.voices.map((v) => v.id), ['gb_oliver_neutral', 'voice_482'])
    assert.match(legacy.note, /voices are specific to each model/)
  } finally { await m.close() }
})

test('tts route: an OpenRouter instance in settings speaks through its credential pointer and lists its models in /config', async () => {
  const m = await vendor()
  const v = await voiceServer({ FAKE_OPENROUTER_KEY: 'fake-or-key-0000' }, { config: {
    providers: [{ id: 'or', type: 'openrouter', label: 'OpenRouter (test)', baseUrl: m.origin + '/v1', credential: 'env:FAKE_OPENROUTER_KEY', models: { tts: 'elevenlabs/eleven-v3' }, defaultVoice: 'george', inAuto: false }],
  } })
  try {
    const r = await v.call('POST', '/tts', { body: { text: 'Ciao', provider: 'or', voice: 'sarah' } })
    assert.equal(r.status, 200)
    assert.equal(r.headers['x-voice-engine'], 'or')
    assert.equal(r.headers['x-voice-voice'], 'sarah')
    assert.deepEqual(r.body, MP3)
    const req = m.reqs.find((x) => x.path === '/v1/audio/speech')
    assert.equal(req.json().model, 'elevenlabs/eleven-v3')
    assert.ok(req.headers.authorization.includes('fake-or-key-0000'))
    const cfg = await v.call('GET', '/config')
    const p = cfg.json.providers.find((x) => x.id === 'or')
    assert.equal(p.type, 'openrouter')
    assert.equal(p.tts, true)
    assert.equal(p.stt, true)
    const e = cfg.json.engines.or
    assert.equal(e.tts, true)
    assert.ok(Array.isArray(e.models.tts) && e.models.tts.length > 1)
    // the settings view names the pointer and never carries the key
    const view = await v.call('GET', '/settings')
    assert.equal(view.text.includes('fake-or-key-0000'), false)
    assert.equal(view.json.instances.find((x) => x.id === 'or').credential.kind, 'pointer')
    assert.ok(view.json.types.some((t) => t.type === 'openrouter'), 'the type is offered in the Add provider dialog')
  } finally { await v.close(); await m.close() }
})

test('tts route: an OpenRouter instance reports a refused key with the typed error code', async () => {
  const m = await mockServer((r, res) => (r.path === '/v1/audio/speech/models' ? reply(res, 200, { data: SPEECH }) : reply(res, 401, { error: { message: 'No auth credentials found' } })))
  const v = await voiceServer({}, { config: { providers: [{ id: 'or', type: 'openrouter', baseUrl: m.origin + '/v1', credential: 'fake-or-key-0000', inAuto: false }] } })
  try {
    const r = await v.call('POST', '/tts', { body: { text: 'Ciao', provider: 'or' } })
    assert.equal(r.status, 502)
    assert.equal(r.json.code, 'VOICE_PROVIDER_AUTH')
    assert.equal(r.json.legacyCode, 'bad_key')
    assert.equal(r.headers['x-voice-error-code'], 'bad_key')
  } finally { await v.close(); await m.close() }
})
