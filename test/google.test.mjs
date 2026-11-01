import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import google, { pickVoice, supportsMarks, endpointsOf } from '../lib/server/providers/google.js'

const AUDIO = Buffer.from('FAKEMP3-GOOGLE-0123456789')
const NODASH = /[\u2013\u2014]/

test('google: metadata sanity', () => {
  assert.equal(google.type, 'google')
  assert.equal(google.group, 'other')
  assert.ok(['varies', 'eu-region', 'non-eu'].includes(google.residency))
  assert.ok(google.desc.length < 140 && !NODASH.test(google.desc))
  assert.ok(!NODASH.test(google.verification) && !NODASH.test(google.euNote))
  assert.ok(google.docs.startsWith('https://'))
  assert.ok(['verified', 'partial', 'unverified', 'planned'].includes(google.status))
  assert.ok(google.presets.length >= 1 && google.presets.every((p) => p.id))
  assert.equal(google.defaultBaseUrl, '')
  assert.equal(google.regions[0].id, 'eu')
  assert.equal(google.regions[0].eu, true)
})

test('google: capabilities', () => {
  const c = google.capabilities(inst())
  assert.deepEqual(c.ttsLangs.slice(0, 3), ['en', 'el', 'it'])
  assert.ok(c.sttLangs.includes('el') && c.sttLangs.includes('it'))
  assert.equal(c.alignment, 'word')
  assert.deepEqual(c.nativeSpeed, [0.25, 2])
  assert.equal(google.configured(inst()), true)
  assert.equal(google.configured(inst({ key: '' })), false)
})

test('google: region URLs, residencyOf, baseUrl wins', () => {
  assert.equal(endpointsOf(inst()).tts, 'https://eu-texttospeech.googleapis.com')
  assert.equal(endpointsOf(inst()).stt, 'https://eu-speech.googleapis.com')
  assert.equal(endpointsOf(inst({ region: 'us' })).tts, 'https://us-texttospeech.googleapis.com')
  assert.equal(endpointsOf(inst({ region: 'global' })).stt, 'https://speech.googleapis.com')
  assert.equal(endpointsOf(inst({ baseUrl: 'http://127.0.0.1:9', region: 'us' })).tts, 'http://127.0.0.1:9')
  assert.equal(google.residencyOf(inst()), 'eu-region')
  assert.equal(google.residencyOf(inst({ region: 'global' })), 'non-eu')
})

test('google: voice choice and SSML mark support', () => {
  assert.equal(pickVoice(inst(), 'el-GR-Wavenet-B', 'el'), 'el-GR-Wavenet-B')
  assert.equal(pickVoice(inst(), 'bogus', 'it'), 'it-IT-Neural2-A')
  assert.equal(pickVoice(inst({ defaultVoice: 'it-IT-Wavenet-E' }), '', 'it'), 'it-IT-Wavenet-E')
  assert.equal(supportsMarks('el-GR-Wavenet-B'), true)
  assert.equal(supportsMarks('it-IT-Neural2-A'), true)
  assert.equal(supportsMarks('el-GR-Chirp3-HD-Aoede'), false)
  assert.equal(supportsMarks('it-IT-Chirp-HD-D'), false)
})

test('google: tts with SSML marks, v1beta1, alignment indexes the sent text', async () => {
  const text = 'Καλημέρα κόσμε, τι κάνεις'
  const m = await mockServer((r, res) => reply(res, 200, {
    audioContent: AUDIO.toString('base64'),
    timepoints: [{ markName: 'w0', timeSeconds: 0 }, { markName: 'w1', timeSeconds: 0.7 }, { markName: 'w2', timeSeconds: 1.2 }, { markName: 'w3', timeSeconds: 1.5 }],
  }))
  try {
    const i = inst({ baseUrl: m.origin })
    const out = await google.tts({ text, voice: 'el-GR-Wavenet-B', lang: 'el', speed: 1.25, wantAlignment: true }, i)
    assert.deepEqual(out.audio, AUDIO)
    assert.equal(out.mime, 'audio/mpeg')
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/v1beta1/text:synthesize')
    assert.equal(r.headers['x-goog-api-key'].length > 0, true)
    const b = r.json()
    assert.deepEqual(b.enableTimePointing, ['SSML_MARK'])
    assert.equal(b.voice.name, 'el-GR-Wavenet-B')
    assert.equal(b.voice.languageCode, 'el-GR')
    assert.equal(b.audioConfig.audioEncoding, 'MP3')
    assert.equal(b.audioConfig.speakingRate, 1.25)
    assert.ok(b.input.ssml.startsWith('<speak>') && b.input.ssml.includes('<mark name="w0"/>'))
    const items = out.alignment.items
    assert.equal(items.length, 4)
    assert.deepEqual(items.map((x) => text.slice(x.c0, x.c1)), ['Καλημέρα', 'κόσμε,', 'τι', 'κάνεις'])
    for (let k = 1; k < items.length; k += 1) assert.ok(items[k].t0 >= items[k - 1].t0 && items[k - 1].t1 === items[k].t0)
    assert.ok(items[3].t1 >= items[3].t0)
  } finally { await m.close() }
})

test('google: Chirp 3 HD uses v1 plain text and alignment null', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { audioContent: AUDIO.toString('base64') }))
  try {
    const i = inst({ baseUrl: m.origin })
    const out = await google.tts({ text: 'Ciao mondo', voice: 'it-IT-Chirp3-HD-Aoede', lang: 'it', wantAlignment: true }, i)
    assert.equal(out.alignment, null)
    assert.equal(m.reqs[0].path, '/v1/text:synthesize')
    const b = m.reqs[0].json()
    assert.equal(b.input.text, 'Ciao mondo')
    assert.equal(b.enableTimePointing, undefined)
    assert.equal(b.audioConfig.speakingRate, undefined)
    await google.tts({ text: 'x', voice: 'it-IT-Neural2-A', lang: 'it', wantAlignment: false }, i)
    assert.equal(m.reqs[1].path, '/v1/text:synthesize')
  } finally { await m.close() }
})

test('google: v1beta1 failure falls back to v1 with a note', async () => {
  const m = await mockServer((r, res) => (r.path.startsWith('/v1beta1') ? reply(res, 500, 'beta down') : reply(res, 200, { audioContent: AUDIO.toString('base64') })))
  try {
    const out = await google.tts({ text: 'Ciao', voice: 'it-IT-Neural2-A', lang: 'it', wantAlignment: true }, inst({ baseUrl: m.origin }))
    assert.equal(out.alignment, null)
    assert.ok(out.note.includes('plain'))
    assert.deepEqual(m.reqs.map((r) => r.path), ['/v1beta1/text:synthesize', '/v1/text:synthesize'])
  } finally { await m.close() }
})

test('google: OAuth bearer credentials', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { audioContent: AUDIO.toString('base64') }))
  try {
    await google.tts({ text: 'x', lang: 'en' }, inst({ baseUrl: m.origin, key: 'ya29.fake-token-0000' }))
    await google.tts({ text: 'x', lang: 'en' }, inst({ baseUrl: m.origin, key: 'Bearer fake-token-0000' }))
    for (const r of m.reqs) { assert.ok(r.headers.authorization.startsWith('Bearer ')); assert.equal(r.headers['x-goog-api-key'], undefined) }
  } finally { await m.close() }
})

test('google: error mapping', async () => {
  const m = await mockServer((r, res) => {
    const t = r.json().input.text || ''
    if (t === 'q') return reply(res, 429, { error: { message: 'quota' } })
    if (t === 'v') return reply(res, 400, { error: { message: 'The requested voice does not exist' } })
    if (t === 's') return reply(res, 503, 'down')
    return reply(res, 403, { error: { message: 'API key not valid' } })
  })
  try {
    const i = inst({ baseUrl: m.origin })
    await assert.rejects(google.tts({ text: 'x', lang: 'en' }, i), (e) => e.code === 'bad_key' && e.status === 502)
    await assert.rejects(google.tts({ text: 'q', lang: 'en' }, i), (e) => e.code === 'quota_exceeded' && e.status === 429)
    await assert.rejects(google.tts({ text: 'v', lang: 'en' }, i), (e) => e.code === 'bad_voice' && e.status === 400)
    await assert.rejects(google.tts({ text: 's', lang: 'en' }, i), (e) => e.code === 'vendor')
  } finally { await m.close() }
})

test('google: stt request shape and word offsets', async () => {
  const m = await mockServer((r, res) => reply(res, 200, {
    results: [{ alternatives: [{ transcript: 'Καλημέρα κόσμε', confidence: 0.95, words: [
      { startTime: '0.400s', endTime: '1.200s', word: 'Καλημέρα' }, { startTime: '1.200s', endTime: '2s', word: 'κόσμε' },
    ] }], languageCode: 'el-gr' }],
    totalBilledTime: '15s',
  }))
  try {
    const i = inst({ baseUrl: m.origin, options: { sttModel: 'latest_long' } })
    const wav = wavBuffer()
    const out = await google.stt({ audio: wav, lang: 'el', wantWords: true }, i)
    assert.equal(out.text, 'Καλημέρα κόσμε')
    assert.equal(out.language, 'el')
    assert.equal(out.confidence, 0.95)
    assert.deepEqual(out.words, [{ w: 'Καλημέρα', t0: 0.4, t1: 1.2 }, { w: 'κόσμε', t0: 1.2, t1: 2 }])
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/v1/speech:recognize')
    assert.equal(r.headers['x-goog-api-key'].length > 0, true)
    const b = r.json()
    assert.equal(b.config.languageCode, 'el-GR')
    assert.equal(b.config.enableWordTimeOffsets, true)
    assert.equal(b.config.model, 'latest_long')
    assert.equal(b.config.encoding, undefined)
    assert.deepEqual(Buffer.from(b.audio.content, 'base64'), wav)
    const it = await google.stt({ audio: wav, lang: 'it', wantWords: false }, i)
    assert.equal(it.words, null)
    assert.equal(m.reqs[1].json().config.languageCode, 'it-IT')
    await google.stt({ audio: wav }, i)
    assert.deepEqual(m.reqs[2].json().config.alternativeLanguageCodes, ['it-IT', 'en-US'])
  } finally { await m.close() }
})

test('google: stt sends WEBM_OPUS and OGG_OPUS clips as they are', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { results: [] }))
  try {
    const i = inst({ baseUrl: m.origin })
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)])
    const ogg = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(32)])
    const a = await google.stt({ audio: webm, lang: 'en' }, i)
    await google.stt({ audio: ogg, lang: 'en' }, i)
    assert.equal(a.text, '')
    assert.equal(m.reqs[0].json().config.encoding, 'WEBM_OPUS')
    assert.equal(m.reqs[0].json().config.sampleRateHertz, 48000)
    assert.equal(m.reqs[1].json().config.encoding, 'OGG_OPUS')
  } finally { await m.close() }
})

test('google: stt errors', async () => {
  let status = 401
  const m = await mockServer((r, res) => reply(res, status, { error: { message: 'x' } }))
  try {
    const i = inst({ baseUrl: m.origin })
    await assert.rejects(google.stt({ audio: wavBuffer(), lang: 'en' }, i), (e) => e.code === 'bad_key')
    status = 429
    await assert.rejects(google.stt({ audio: wavBuffer(), lang: 'en' }, i), (e) => e.code === 'quota_exceeded')
    status = 500
    await assert.rejects(google.stt({ audio: wavBuffer(), lang: 'en' }, i), (e) => e.code === 'vendor')
  } finally { await m.close() }
})

test('google: listVoices maps and caches per language', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { voices: [
    { languageCodes: ['el-GR'], name: 'el-GR-Wavenet-B', ssmlGender: 'MALE', naturalSampleRateHertz: 24000 },
    { languageCodes: ['el-GR'], name: 'el-GR-Chirp3-HD-Aoede', ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
  ] }))
  try {
    const i = inst({ baseUrl: m.origin })
    const v = await google.listVoices(i, { lang: 'el' })
    assert.equal(v.length, 2)
    assert.deepEqual(v[0], { id: 'el-GR-Wavenet-B', name: 'el-GR-Wavenet-B', langs: ['el'], gender: 'male', accent: 'el-GR', tags: ['Wavenet', 'word-timings'] })
    assert.deepEqual(v[1].tags, ['Chirp3-HD'])
    await google.listVoices(i, { lang: 'el' })
    assert.equal(m.reqs.length, 1)
    assert.equal(m.reqs[0].path, '/v1/voices')
    assert.ok(m.reqs[0].query.includes('languageCode=el-GR'))
  } finally { await m.close() }
})

test('google: health probes the voice list', async () => {
  let status = 200
  const m = await mockServer((r, res) => reply(res, status, { voices: [] }))
  try {
    const i = inst({ baseUrl: m.origin })
    assert.equal((await google.health(i)).status, 'up')
    status = 403
    const h = await google.health(i)
    assert.equal(h.ok, false)
    assert.equal((await google.health(inst({ key: '', baseUrl: m.origin }))).status, 'down')
    assert.equal(m.reqs.length, 2)
  } finally { await m.close() }
})
