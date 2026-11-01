import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import mistral from '../lib/server/providers/mistral.js'
import elevenlabs, { account, refreshQuota, isDry } from '../lib/server/providers/elevenlabs.js'
import elevenCompat from '../lib/server/providers/elevenlabs-compatible.js'
import tzekosNative from '../lib/server/providers/tzekos-native.js'
import mimo from '../lib/server/providers/mimo.js'
import lfm3 from '../lib/server/providers/lfm3.js'
import openaiCompat from '../lib/server/providers/openai-compatible.js'
import browser from '../lib/server/providers/browser.js'

const AUDIO = Buffer.from('FAKEAUDIOBYTES-0123456789')
const field = (req, name) => {
  const m = new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)\\r\\n').exec(req.body.toString('latin1'))
  return m ? m[1] : null
}

test('mistral: tts request shape and decoded audio', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { audio_data: AUDIO.toString('base64') }))
  try {
    const i = inst({ baseUrl: m.origin, key: 'fake-mistral-key', defaultVoice: 'gb_oliver_neutral', models: { tts: 'voxtral-mini-tts-latest' } })
    const out = await mistral.tts({ text: 'Hello there', voice: 'gb_oliver_neutral' }, i)
    assert.ok(Buffer.isBuffer(out.audio))
    assert.deepEqual(out.audio, AUDIO)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/v1/audio/speech')
    assert.equal(r.headers.authorization, 'Bearer fake-mistral-key')
    assert.deepEqual(r.json(), { model: 'voxtral-mini-tts-latest', input: 'Hello there', voice: 'gb_oliver_neutral' })
  } finally { await m.close() }
})

test('mistral: voice normalisation', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { audio_data: AUDIO.toString('base64') }))
  try {
    const i = inst({ baseUrl: m.origin, defaultVoice: 'gb_oliver_neutral' })
    await mistral.tts({ text: 'a', voice: 'gb_oliver_neutral' }, i)
    await mistral.tts({ text: 'a', voice: 'voice_482', model: 'voxtral-mini-tts-3-0' }, i)
    await mistral.tts({ text: 'a', voice: 'voice_482' }, i)
    await mistral.tts({ text: 'a', voice: 'Junk Voice!' }, i)
    const v = m.reqs.map((r) => r.json().voice)
    assert.deepEqual(v, ['gb_oliver_neutral', 'voice_482', 'gb_oliver_neutral', 'gb_oliver_neutral'])
    assert.equal(m.reqs[1].json().model, 'voxtral-mini-tts-3-0')
  } finally { await m.close() }
})

test('mistral: 401 maps to bad_key, 429 to quota_exceeded', async () => {
  const m = await mockServer((r, res) => reply(res, r.json().input === 'q' ? 429 : 401, { message: 'nope' }))
  try {
    const i = inst({ baseUrl: m.origin })
    await assert.rejects(mistral.tts({ text: 'x' }, i), (e) => e.code === 'bad_key')
    await assert.rejects(mistral.tts({ text: 'q' }, i), (e) => e.code === 'quota_exceeded' && e.status === 429)
  } finally { await m.close() }
})

test('mistral: stt multipart with model field', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { text: 'hello world', language: 'en' }))
  try {
    const i = inst({ baseUrl: m.origin, key: 'fake-mistral-key', models: { stt: 'voxtral-mini-latest' } })
    const out = await mistral.stt({ audio: wavBuffer(), name: 'a.wav', mime: 'audio/wav' }, i)
    assert.equal(out.text, 'hello world')
    const r = m.reqs[0]
    assert.equal(r.path, '/v1/audio/transcriptions')
    assert.match(r.headers['content-type'], /^multipart\/form-data; boundary=/)
    assert.equal(r.headers.authorization, 'Bearer fake-mistral-key')
    assert.equal(field(r, 'model'), 'voxtral-mini-latest')
    assert.match(r.body.toString('latin1'), /name="file"; filename="a.wav"/)
  } finally { await m.close() }
})

test('mistral: listVoices pages /v1/audio/voices', async () => {
  const m = await mockServer((r, res) => {
    const off = Number(new URLSearchParams(r.query).get('offset'))
    const items = off === 0
      ? Array.from({ length: 50 }, (_, k) => ({ slug: 'v' + k, name: 'V' + k, languages: ['en'] }))
      : [{ slug: 'last', name: 'Last', languages: ['fr'] }]
    reply(res, 200, { items, total: 51 })
  })
  try {
    const i = inst({ baseUrl: m.origin })
    const v = await mistral.listVoices(i)
    assert.equal(v.length, 51)
    assert.equal(v[50].id, 'last')
    assert.equal(m.reqs.length, 2)
    assert.ok(m.reqs.every((r) => r.path === '/v1/audio/voices'))
    assert.deepEqual(m.reqs.map((r) => new URLSearchParams(r.query).get('offset')), ['0', '50'])
    await mistral.listVoices(i) // cached
    assert.equal(m.reqs.length, 2)
  } finally { await m.close() }
})

test('elevenlabs: tts path, header, plain audio', async () => {
  const m = await mockServer((r, res) => reply(res, 200, AUDIO, { 'content-type': 'audio/mpeg' }))
  try {
    const i = inst({ baseUrl: m.origin, key: 'fake-xi-key' })
    const out = await elevenlabs.tts({ text: 'Hello', voice: 'VOICE1', model: 'eleven_flash_v2_5' }, i)
    assert.deepEqual(out.audio, AUDIO)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/v1/text-to-speech/VOICE1')
    assert.equal(r.query, '?output_format=mp3_44100_128')
    assert.equal(r.headers['xi-api-key'], 'fake-xi-key')
    assert.equal(r.json().text, 'Hello')
    assert.equal(r.json().model_id, 'eleven_flash_v2_5')
  } finally { await m.close() }
})

test('elevenlabs: wantAlignment uses with-timestamps and word offsets index the sent text', async () => {
  const text = 'one two three'
  const chars = text.split('')
  const m = await mockServer((r, res) => reply(res, 200, {
    audio_base64: AUDIO.toString('base64'),
    alignment: {
      characters: chars,
      character_start_times_seconds: chars.map((_, k) => k * 0.1),
      character_end_times_seconds: chars.map((_, k) => k * 0.1 + 0.1),
    },
  }))
  try {
    const i = inst({ baseUrl: m.origin })
    const out = await elevenlabs.tts({ text, voice: 'V', wantAlignment: true }, i)
    assert.equal(m.reqs[0].path, '/v1/text-to-speech/V/with-timestamps')
    assert.deepEqual(out.audio, AUDIO)
    assert.equal(out.alignment.unit, 'word')
    assert.equal(out.alignment.items.length, 3)
    assert.deepEqual(out.alignment.items.map((w) => text.slice(w.c0, w.c1)), ['one', 'two', 'three'])
    assert.ok(out.alignment.items.every((w) => typeof w.t0 === 'number' && typeof w.t1 === 'number' && w.t1 >= w.t0))
  } finally { await m.close() }
})

test('elevenlabs: error mapping (quota, 401, 404)', async () => {
  const m = await mockServer((r, res) => {
    const t = r.json().text
    if (t === 'quota') return reply(res, 401, { detail: { code: 'quota_exceeded', message: 'You have 0 credits left' } })
    if (t === 'key') return reply(res, 401, { detail: { status: 'invalid_api_key', message: 'bad key' } })
    return reply(res, 404, { detail: { status: 'voice_not_found', message: 'no such voice' } })
  })
  try {
    const i = inst({ baseUrl: m.origin })
    await assert.rejects(elevenlabs.tts({ text: 'quota' }, i), (e) => e.code === 'quota_exceeded' && e.status === 429)
    await assert.rejects(elevenlabs.tts({ text: 'key' }, i), (e) => e.code === 'bad_key')
    await assert.rejects(elevenlabs.tts({ text: 'x', voice: 'nope' }, i), (e) => e.code === 'bad_voice')
  } finally { await m.close() }
})

test('elevenlabs: a voice missing from the cached account list is dropped with a note', async () => {
  const m = await mockServer((r, res) => reply(res, 200, AUDIO, { 'content-type': 'audio/mpeg' }))
  try {
    const i = inst({ baseUrl: m.origin, defaultVoice: 'DEFAULTVOICE' })
    i.state.acct = { at: Date.now(), voices: [{ id: 'mine', name: 'Mine' }], quota: null, error: null }
    const out = await elevenlabs.tts({ text: 'hi', voice: 'stranger' }, i)
    assert.match(m.reqs[0].path, /\/v1\/text-to-speech\/DEFAULTVOICE$/)
    assert.match(out.note, /not on this account/)
    const ok = await elevenlabs.tts({ text: 'hi', voice: 'mine' }, i)
    assert.match(m.reqs[1].path, /\/mine$/)
    assert.equal(ok.note, '')
  } finally { await m.close() }
})

test('elevenlabs: stt posts multipart with model_id and returns words', async () => {
  const m = await mockServer((r, res) => reply(res, 200, {
    text: ' hello world ', language_code: 'en',
    words: [{ text: 'hello', type: 'word', start: 0, end: 0.4 }, { text: ' ', type: 'spacing', start: 0.4, end: 0.5 }, { text: 'world', type: 'word', start: 0.5, end: 0.9 }],
  }))
  try {
    const i = inst({ baseUrl: m.origin, key: 'fake-xi-key' })
    const out = await elevenlabs.stt({ audio: wavBuffer(), name: 'a.wav', mime: 'audio/wav', lang: 'en-GB' }, i)
    const r = m.reqs[0]
    assert.equal(r.path, '/v1/speech-to-text')
    assert.equal(r.headers['xi-api-key'], 'fake-xi-key')
    assert.equal(field(r, 'model_id'), 'scribe_v2')
    assert.equal(field(r, 'language_code'), 'en')
    assert.equal(out.text, 'hello world')
    assert.deepEqual(out.words, [{ w: 'hello', t0: 0, t1: 0.4 }, { w: 'world', t0: 0.5, t1: 0.9 }])
  } finally { await m.close() }
})

test('elevenlabs: account(), refreshQuota(), isDry()', async () => {
  const m = await mockServer((r, res) => {
    if (r.path === '/v1/voices') return reply(res, 200, { voices: [{ voice_id: 'abc', name: 'Abc', category: 'premade', labels: { gender: 'male' } }] })
    if (r.path === '/v1/user/subscription') return reply(res, 200, { tier: 'free', character_limit: 10000, character_count: 10000 })
    return reply(res, 404, {})
  })
  try {
    const i = inst({ baseUrl: m.origin })
    const a = await account(i)
    assert.equal(a.voices.length, 1)
    assert.equal(a.voices[0].id, 'abc')
    assert.equal(a.quota.remaining, 0)
    assert.equal(a.quota.limit, 10000)
    assert.equal(isDry(i), true)
    const q = await refreshQuota(i)
    assert.equal(q.remaining, 0)
    i.state.acct.quota = { remaining: 50 }
    assert.equal(isDry(i), false)
    assert.equal(isDry(inst({})), false)
    const v = await elevenlabs.listVoices(i)
    assert.equal(v[0].id, 'abc')
  } finally { await m.close() }
})

test('elevenlabs-compatible native (local server preset): tts JSON on /api/tts', async () => {
  const m = await mockServer((r, res) => reply(res, 200, AUDIO, { 'content-type': 'audio/mpeg' }))
  try {
    const i = inst({ baseUrl: m.origin, key: 'fake-tts-key', defaultVoice: 'founder', options: { native: true } })
    const out = await elevenCompat.tts({ text: 'Hi', voice: '', model: 'maya' }, i)
    assert.deepEqual(out.audio, AUDIO)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/api/tts')
    assert.equal(r.query, '')
    assert.equal(r.headers['xi-api-key'], 'fake-tts-key')
    assert.deepEqual(r.json(), { text: 'Hi', voice: 'founder', format: 'mp3', engine: 'maya' })
    await elevenCompat.tts({ text: 'Hi', voice: 'other' }, i)
    assert.deepEqual(m.reqs[1].json(), { text: 'Hi', voice: 'other', format: 'mp3' })
  } finally { await m.close() }
})

test('elevenlabs-compatible native: stt forwards the raw upload untouched', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { text: 'ciao', language_code: 'it' }))
  try {
    const i = inst({ baseUrl: m.origin, options: { native: true, sttPath: '/v1/speech-to-text-fast' } })
    const raw = Buffer.concat([Buffer.from('--B\r\nContent-Disposition: form-data; name="file"; filename="x.webm"\r\n\r\n'), Buffer.from([0, 1, 2, 255, 254]), Buffer.from('\r\n--B--\r\n')])
    const out = await elevenCompat.stt({ audio: Buffer.from('ignored'), raw, rawType: 'multipart/form-data; boundary=B', model: 'small' }, i)
    assert.equal(out.text, 'ciao')
    assert.equal(out.language, 'it')
    const r = m.reqs[0]
    assert.equal(r.path, '/v1/speech-to-text-fast')
    assert.equal(r.query, '?model=small')
    assert.equal(r.headers['content-type'], 'multipart/form-data; boundary=B')
    assert.deepEqual(r.body, raw)
  } finally { await m.close() }
})

test('elevenlabs-compatible native: 400 detail surfaces, models() reads /health', async () => {
  const m = await mockServer((r, res) => {
    if (r.path === '/health') return reply(res, 200, { engines_available: ['maya', 'kokoro'], whisper_sizes: ['tiny', 'small'], engines_inert: {} })
    return reply(res, 400, { detail: 'whisper size not allowed' })
  })
  try {
    const i = inst({ baseUrl: m.origin, options: { native: true } })
    await assert.rejects(elevenCompat.stt({ audio: Buffer.from('a'), raw: Buffer.from('a'), rawType: 'audio/webm', model: 'huge' }, i), (e) => /whisper size not allowed/.test(e.message))
    await assert.rejects(elevenCompat.tts({ text: 'x' }, i), (e) => /whisper size not allowed/.test(e.message))
    const mod = await elevenCompat.models(i)
    assert.deepEqual(mod.tts, ['maya', 'kokoro'])
    assert.deepEqual(mod.stt, ['tiny', 'small'])
    assert.equal(m.reqs.at(-1).path, '/health')
  } finally { await m.close() }
})

test('elevenlabs-compatible with native false uses the ElevenLabs paths', async () => {
  const m = await mockServer((r, res) => {
    if (r.path === '/v1/speech-to-text') return reply(res, 200, { text: 'plain', language_code: 'en' })
    return reply(res, 200, AUDIO, { 'content-type': 'audio/mpeg' })
  })
  try {
    const i = inst({ baseUrl: m.origin, options: { native: false } })
    await elevenCompat.tts({ text: 'hello', voice: 'VV' }, i)
    assert.equal(m.reqs[0].path, '/v1/text-to-speech/VV')
    assert.equal(m.reqs[0].query, '?output_format=mp3_44100_128')
    const out = await elevenCompat.stt({ audio: wavBuffer(), name: 'a.wav', mime: 'audio/wav' }, i)
    assert.equal(out.text, 'plain')
    assert.equal(m.reqs[1].path, '/v1/speech-to-text')
    assert.equal(await elevenCompat.models(i), null)
  } finally { await m.close() }
})

test('tzekos-native (grey): exact /api/tts, voice fallback, no health probe, 503 is vendor', async () => {
  const m = await mockServer((r, res) => (r.json() && r.json().text === 'down' ? reply(res, 503, { error: 'relay disabled' }) : reply(res, 200, AUDIO, { 'content-type': 'audio/wav' })))
  try {
    const i = inst({ baseUrl: m.origin, key: 'fake-grey-key', defaultVoice: 'bm_george' })
    const h = await tzekosNative.health(i)
    assert.equal(h.status, 'unknown')
    assert.equal(m.reqs.length, 0)
    await tzekosNative.listVoices(i)
    assert.equal(m.reqs.length, 0)
    const out = await tzekosNative.tts({ text: 'Hello', voice: 'not_a_voice' }, i)
    assert.equal(out.voice, 'bm_george')
    assert.equal(m.reqs.length, 1)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.url, '/api/tts')
    assert.equal(r.headers['xi-api-key'], 'fake-grey-key')
    assert.deepEqual(r.json(), { text: 'Hello', voice: 'bm_george' })
    await tzekosNative.tts({ text: 'Hello', voice: 'bf_emma' }, i)
    assert.equal(m.reqs[1].json().voice, 'bf_emma')
    await assert.rejects(tzekosNative.tts({ text: 'down' }, i), (e) => e.code === 'vendor')
  } finally { await m.close() }
})

test('mimo: tts on exactly /v1/chat/completions', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { choices: [{ message: { audio: { data: AUDIO.toString('base64') } } }] }))
  try {
    const i = inst({ baseUrl: m.origin + '/v1', key: 'fake-mimo-key' })
    const out = await mimo.tts({ text: 'Say this', voice: 'Mia' }, i)
    assert.deepEqual(out.audio, AUDIO)
    assert.equal(out.voice, 'Mia')
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.url, '/v1/chat/completions')
    assert.equal(r.headers.authorization, 'Bearer fake-mimo-key')
    const b = r.json()
    assert.equal(b.model, 'mimo-v2.5-tts')
    assert.deepEqual(b.messages, [{ role: 'assistant', content: 'Say this' }])
    assert.equal(b.audio.voice, 'Mia')
    await mimo.tts({ text: 'Say this', voice: 'totally-unknown' }, i)
    assert.equal(m.reqs[1].json().audio.voice, 'mimo_default')
    await mimo.tts({ text: 'Say this' }, i)
    assert.equal(m.reqs[2].json().audio.voice, 'mimo_default')
  } finally { await m.close() }
})

test('mimo: stt sends mimo-v2.5-asr with input_audio; health and listVoices do not call out', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { choices: [{ message: { content: ' hello mimo ' } }] }))
  try {
    const i = inst({ baseUrl: m.origin + '/v1' })
    assert.equal((await mimo.health(i)).status, 'unknown')
    const v = await mimo.listVoices(i)
    assert.ok(v.some((x) => x.id === 'Mia'))
    assert.equal(m.reqs.length, 0)
    const out = await mimo.stt({ audio: wavBuffer(), lang: 'en' }, i)
    assert.equal(out.text, 'hello mimo')
    assert.equal(m.reqs.length, 1)
    assert.equal(m.reqs[0].url, '/v1/chat/completions')
    const b = m.reqs[0].json()
    assert.equal(b.model, 'mimo-v2.5-asr')
    assert.equal(b.messages[0].content[0].type, 'input_audio')
    assert.match(b.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/)
    assert.equal(b.asr_options.language, 'en')
  } finally { await m.close() }
})

test('lfm3: health depends on the model list', async () => {
  let ids = ['lfm3-audio-2b']
  const m = await mockServer((r, res) => (r.path === '/v1/models' ? reply(res, 200, { data: ids.map((id) => ({ id })) }) : reply(res, 404, {})))
  try {
    const i = inst({ baseUrl: m.origin, models: { tts: 'lfm3-audio-2b' } })
    assert.equal((await lfm3.health(i)).ok, true)
    assert.equal(m.reqs[0].method, 'GET')
    ids = ['something-else']
    const h = await lfm3.health(i)
    assert.equal(h.ok, false)
    assert.equal(h.status, 'down')
  } finally { await m.close() }
  const dead = await lfm3.health(inst({ baseUrl: 'http://127.0.0.1:1' }))
  assert.equal(dead.ok, false)
})

test('lfm3: tts language mapping and stt', async () => {
  const m = await mockServer((r, res) => {
    if (r.path === '/tts') return reply(res, 200, wavBuffer(), { 'content-type': 'audio/wav' })
    if (r.path === '/v1/audio/transcriptions') return reply(res, 200, { text: 'kalimera', language: 'el' })
    return reply(res, 404, {})
  })
  try {
    const i = inst({ baseUrl: m.origin, models: { tts: 'lfm3-audio-2b' }, defaultVoice: 'female' })
    const a = await lfm3.tts({ text: 'Yassou', lang: 'el' }, i)
    assert.equal(m.reqs[0].path, '/tts')
    assert.equal(m.reqs[0].method, 'POST')
    assert.deepEqual(m.reqs[0].json(), { model: 'lfm3-audio-2b', input: 'Yassou', voice: 'female', lang: 'el' })
    assert.equal(a.mime, 'audio/wav')
    await lfm3.tts({ text: 'x', lang: 'xx' }, i)
    assert.equal(m.reqs[1].json().lang, 'en')
    await lfm3.tts({ text: 'x', lang: 'it', voice: 'male' }, i)
    assert.equal(m.reqs[2].json().lang, 'it')
    assert.equal(m.reqs[2].json().voice, 'male')
    const s = await lfm3.stt({ audio: wavBuffer(), name: 'clip.webm' }, i)
    assert.equal(s.text, 'kalimera')
    const r = m.reqs[3]
    assert.equal(r.path, '/v1/audio/transcriptions')
    assert.equal(field(r, 'model'), 'lfm3-audio-2b')
    assert.match(r.body.toString('latin1'), /filename="clip.wav"/)
  } finally { await m.close() }
})

test('openai-compatible (groq shape): stt on the base path with model and language', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { text: 'kalimera', language: 'el' }))
  try {
    const i = inst({ baseUrl: m.origin + '/openai/v1', key: 'fake-groq-key', models: { stt: 'whisper-large-v3' }, options: { stt: true, tts: false } })
    const out = await openaiCompat.stt({ audio: wavBuffer(), name: 'a.wav', mime: 'audio/wav', lang: 'el' }, i)
    assert.equal(out.text, 'kalimera')
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/openai/v1/audio/transcriptions')
    assert.equal(r.headers.authorization, 'Bearer fake-groq-key')
    assert.equal(field(r, 'model'), 'whisper-large-v3')
    assert.equal(field(r, 'language'), 'el')
    const caps = openaiCompat.capabilities(i)
    assert.equal(caps.tts, false)
    assert.equal(caps.stt, true)
  } finally { await m.close() }
})

test('browser: tts throws browser_only', async () => {
  await assert.rejects(browser.tts({ text: 'x' }, inst({})), (e) => e.code === 'browser_only' && e.status === 400)
  assert.equal(browser.capabilities().clientOnly, true)
})
