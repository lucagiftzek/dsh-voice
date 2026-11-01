import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import { mockWsServer } from './ws-helper.mjs'
import amazon, { endpointsOf, marksToStarts, encodeEvent, decodeEvents, audioEvent, crc32, pickVoice } from '../lib/server/providers/amazon.js'

const AUDIO = Buffer.from('FAKEMP3-POLLY-0123456789')
const CRED = 'FAKEACCESSKEYID0000:fake-secret-0000'
const NODASH = /[\u2013\u2014]/
const mk = (o) => inst(Object.assign({ key: CRED }, o || {}))

function marksFor(text, times) {
  const buf = Buffer.from(text, 'utf8')
  const lines = []
  const re = /\S+/g
  let m
  let k = 0
  while ((m = re.exec(text))) {
    const start = Buffer.byteLength(text.slice(0, m.index), 'utf8')
    const end = start + Buffer.byteLength(m[0], 'utf8')
    lines.push(JSON.stringify({ time: times[k], type: 'word', start, end, value: buf.slice(start, end).toString('utf8') }))
    k += 1
  }
  return lines.join('\n') + '\n'
}

test('amazon: metadata sanity', () => {
  assert.equal(amazon.type, 'amazon')
  assert.equal(amazon.group, 'other')
  assert.ok(['varies', 'eu-region', 'non-eu'].includes(amazon.residency))
  assert.ok(amazon.desc.length < 140 && !NODASH.test(amazon.desc))
  assert.ok(!NODASH.test(amazon.verification) && !NODASH.test(amazon.euNote))
  assert.ok(amazon.docs.startsWith('https://'))
  assert.ok(['verified', 'partial', 'unverified', 'planned'].includes(amazon.status))
  assert.ok(amazon.presets.length >= 1 && amazon.presets.every((p) => p.id))
  assert.equal(amazon.defaultBaseUrl, '')
  assert.ok(amazon.regions.slice(0, 7).every((r) => r.eu) && amazon.regions.slice(7).every((r) => !r.eu))
})

test('amazon: capabilities (no Greek TTS, Greek STT) and credential parsing', () => {
  const c = amazon.capabilities(mk())
  assert.ok(!c.ttsLangs.includes('el'))
  assert.ok(c.ttsLangs.includes('it') && c.ttsLangs.includes('en'))
  assert.ok(c.sttLangs.includes('el') && c.sttLangs.includes('it') && c.sttLangs.includes('en'))
  assert.equal(c.alignment, 'word')
  assert.equal(amazon.capabilities(mk({ options: { engine: 'generative' } })).alignment, 'none')
  assert.equal(amazon.configured(mk()), true)
  assert.equal(amazon.configured(mk({ key: 'AKIA:secret:session' })), true)
  assert.equal(amazon.configured(mk({ key: 'no-colon-here' })), false)
  assert.equal(amazon.configured(mk({ key: '' })), false)
})

test('amazon: region URLs, residencyOf', () => {
  assert.equal(endpointsOf(mk()).polly, 'https://polly.eu-west-1.amazonaws.com')
  assert.equal(endpointsOf(mk({ region: 'eu-central-1' })).polly, 'https://polly.eu-central-1.amazonaws.com')
  assert.equal(endpointsOf(mk({ region: 'eu-central-1' })).ws, 'wss://transcribestreaming.eu-central-1.amazonaws.com:8443')
  assert.equal(endpointsOf(mk({ region: 'us-east-1', baseUrl: 'http://127.0.0.1:9' })).polly, 'http://127.0.0.1:9')
  assert.equal(amazon.residencyOf(mk({ region: 'eu-central-1' })), 'eu-region')
  assert.equal(amazon.residencyOf(mk({ region: 'us-east-1' })), 'non-eu')
})

test('amazon: speech mark byte offsets become string offsets (Italian accents)', () => {
  const text = 'Perché è così, città'
  const lines = marksFor(text, [0, 400, 700, 1200]).trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines[0].end - lines[0].start > 'Perché'.length)
  const starts = marksToStarts(text, lines)
  assert.deepEqual(starts.map((s) => text.slice(s.c0, s.c1)), ['Perché', 'è', 'così,', 'città'])
  assert.deepEqual(marksToStarts('x', [{ type: 'word', start: 5, end: 9, time: 1 }, { type: 'sentence', start: 0, end: 1, time: 0 }]), [])
})

test('amazon: voice pick', () => {
  assert.equal(pickVoice(mk(), 'Giorgio', 'it'), 'Giorgio')
  assert.equal(pickVoice(mk(), 'bad voice', 'it'), 'Bianca')
  assert.equal(pickVoice(mk(), '', 'en'), 'Joanna')
  assert.equal(pickVoice(mk(), '', 'el'), '')
})

test('amazon: tts request is signed, body fields, alignment from a second json call', async () => {
  const text = 'Perché è così, città'
  const m = await mockServer((r, res) => {
    const b = r.json()
    if (b.OutputFormat === 'json') return reply(res, 200, marksFor(text, [0, 400, 700, 1200]), { 'content-type': 'application/x-json-stream' })
    return reply(res, 200, AUDIO, { 'content-type': 'audio/mpeg' })
  })
  try {
    const i = mk({ baseUrl: m.origin, region: 'eu-central-1', key: CRED + ':fake-session-token' })
    const out = await amazon.tts({ text, voice: 'Bianca', lang: 'it', wantAlignment: true }, i)
    assert.deepEqual(out.audio, AUDIO)
    assert.equal(out.voice, 'Bianca')
    assert.equal(out.model, 'neural')
    assert.equal(out.billedChars, text.length * 2, 'Polly bills the speech-marks call too')
    assert.equal(m.reqs.length, 2)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/v1/speech')
    const h = r.headers
    assert.ok(/^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/eu-central-1\/polly\/aws4_request, SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*, Signature=[0-9a-f]{64}$/.test(h.authorization))
    assert.ok(h.authorization.includes('x-amz-date'))
    assert.ok(/^\d{8}T\d{6}Z$/.test(h['x-amz-date']))
    assert.equal(typeof h['x-amz-security-token'], 'string')
    assert.equal(h['content-type'], 'application/json')
    const b = r.json()
    assert.equal(b.OutputFormat, 'mp3')
    assert.equal(b.Text, text)
    assert.equal(b.TextType, 'text')
    assert.equal(b.VoiceId, 'Bianca')
    assert.equal(b.Engine, 'neural')
    const b2 = m.reqs[1].json()
    assert.equal(b2.OutputFormat, 'json')
    assert.deepEqual(b2.SpeechMarkTypes, ['word'])
    assert.equal(b2.Text, text)
    const items = out.alignment.items
    assert.deepEqual(items.map((x) => text.slice(x.c0, x.c1)), ['Perché', 'è', 'così,', 'città'])
    for (let k = 1; k < items.length; k += 1) { assert.ok(items[k].t0 > items[k - 1].t0); assert.equal(items[k - 1].t1, items[k].t0) }
    assert.equal(items[1].t0, 0.4)
  } finally { await m.close() }
})

test('amazon: no session token header without a token; wantAlignment false makes one call', async () => {
  const m = await mockServer((r, res) => reply(res, 200, AUDIO))
  try {
    const out = await amazon.tts({ text: 'Hello', lang: 'en', wantAlignment: false }, mk({ baseUrl: m.origin }))
    assert.equal(out.alignment, null)
    assert.equal(out.billedChars, 5)
    assert.equal(m.reqs.length, 1)
    assert.equal(m.reqs[0].headers['x-amz-security-token'], undefined)
    assert.equal(m.reqs[0].json().VoiceId, 'Joanna')
  } finally { await m.close() }
})

test('amazon: speed uses SSML and speech marks map back to the plain text', async () => {
  const text = 'Tom & Jerry'
  const m = await mockServer((r, res) => {
    const b = r.json()
    if (b.OutputFormat === 'json') {
      return reply(res, 200, [{ time: 0, type: 'word', start: 0, end: 3, value: 'Tom' }, { time: 300, type: 'word', start: 4, end: 9, value: '&amp;' }, { time: 500, type: 'word', start: 10, end: 15, value: 'Jerry' }].map((x) => JSON.stringify(x)).join('\n') + '\n')
    }
    return reply(res, 200, AUDIO)
  })
  try {
    const out = await amazon.tts({ text, lang: 'en', speed: 1.2, wantAlignment: true }, mk({ baseUrl: m.origin }))
    const b = m.reqs[0].json()
    assert.equal(b.TextType, 'ssml')
    assert.ok(b.Text.startsWith('<speak><prosody rate="120%">Tom &amp; Jerry'))
    assert.deepEqual(out.alignment.items.map((x) => text.slice(x.c0, x.c1)), ['Tom', '&', 'Jerry'])
  } finally { await m.close() }
})

test('amazon: generative engine skips speech marks; Greek and bad credential are typed errors', async () => {
  const m = await mockServer((r, res) => reply(res, 200, AUDIO))
  try {
    const out = await amazon.tts({ text: 'Hello', lang: 'en', wantAlignment: true }, mk({ baseUrl: m.origin, options: { engine: 'generative' } }))
    assert.equal(out.alignment, null)
    assert.equal(m.reqs.length, 1)
    assert.equal(m.reqs[0].json().Engine, 'generative')
    await assert.rejects(amazon.tts({ text: 'Καλημέρα', lang: 'el' }, mk({ baseUrl: m.origin })), (e) => e.code === 'unsupported_lang' && e.status === 400)
    await assert.rejects(amazon.tts({ text: 'x', lang: 'en' }, mk({ baseUrl: m.origin, key: 'garbage' })), (e) => e.code === 'bad_key')
    await assert.rejects(amazon.stt({ audio: wavBuffer(), lang: 'en' }, mk({ key: 'garbage' })), (e) => e.code === 'bad_key')
    assert.equal(m.reqs.length, 1)
  } finally { await m.close() }
})

test('amazon: tts error mapping', async () => {
  const m = await mockServer((r, res) => {
    const t = r.json().Text
    if (t === 'q') return reply(res, 400, { __type: 'ThrottlingException', message: 'slow' })
    if (t === 'l') return reply(res, 400, { __type: 'LanguageNotSupportedException', message: 'no' })
    if (t === 'v') return reply(res, 400, { __type: 'EngineNotSupportedException', message: 'This engine is not compatible with the voice' })
    if (t === 's') return reply(res, 500, { __type: 'ServiceFailureException' })
    return reply(res, 403, { message: 'The security token included in the request is invalid.' })
  })
  try {
    const i = mk({ baseUrl: m.origin })
    await assert.rejects(amazon.tts({ text: 'x', lang: 'en' }, i), (e) => e.code === 'bad_key' && e.status === 502)
    await assert.rejects(amazon.tts({ text: 'q', lang: 'en' }, i), (e) => e.code === 'quota_exceeded' && e.status === 429)
    await assert.rejects(amazon.tts({ text: 'l', lang: 'en' }, i), (e) => e.code === 'unsupported_lang')
    await assert.rejects(amazon.tts({ text: 'v', lang: 'en' }, i), (e) => e.code === 'bad_voice')
    await assert.rejects(amazon.tts({ text: 's', lang: 'en' }, i), (e) => e.code === 'vendor')
  } finally { await m.close() }
})

test('amazon: listVoices parses and caches per language', async () => {
  const m = await mockServer((r, res) => reply(res, 200, { Voices: [
    { Gender: 'Female', Id: 'Bianca', LanguageCode: 'it-IT', LanguageName: 'Italian', Name: 'Bianca', SupportedEngines: ['neural', 'standard'] },
    { Gender: 'Male', Id: 'Adriano', LanguageCode: 'it-IT', AdditionalLanguageCodes: ['en-US'], LanguageName: 'Italian', Name: 'Adriano', SupportedEngines: ['neural'] },
  ] }))
  try {
    const i = mk({ baseUrl: m.origin })
    const v = await amazon.listVoices(i, { lang: 'it' })
    assert.deepEqual(v[0], { id: 'Bianca', name: 'Bianca', langs: ['it'], gender: 'female', accent: 'it-IT', tags: ['neural', 'standard'] })
    assert.deepEqual(v[1].langs, ['it', 'en'])
    await amazon.listVoices(i, { lang: 'it' })
    assert.equal(m.reqs.length, 1)
    assert.equal(m.reqs[0].method, 'GET')
    assert.equal(m.reqs[0].path, '/v1/voices')
    assert.ok(m.reqs[0].query.includes('LanguageCode=it-IT'))
    assert.ok(m.reqs[0].headers.authorization.startsWith('AWS4-HMAC-SHA256 '))
    assert.deepEqual(await amazon.listVoices(i, { lang: 'el' }), [])
    assert.equal(pickVoice(i, 'Bianca', 'it'), 'Bianca')
  } finally { await m.close() }
})

test('amazon: health with and without credentials', async () => {
  let status = 200
  const m = await mockServer((r, res) => reply(res, status, { Voices: [] }))
  try {
    assert.equal((await amazon.health(mk({ baseUrl: m.origin }))).status, 'up')
    status = 403
    assert.equal((await amazon.health(mk({ baseUrl: m.origin }))).ok, false)
    assert.equal((await amazon.health(mk({ baseUrl: m.origin, key: 'garbage' }))).status, 'down')
    assert.equal(m.reqs.length, 2)
  } finally { await m.close() }
})

test('amazon: event stream codec round trip and CRC checks', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  const a = audioEvent(Buffer.from([1, 2, 3, 4]))
  const [ev] = decodeEvents(a)
  assert.equal(ev.headers[':event-type'], 'AudioEvent')
  assert.equal(ev.headers[':message-type'], 'event')
  assert.equal(ev.headers[':content-type'], 'application/octet-stream')
  assert.deepEqual(ev.payload, Buffer.from([1, 2, 3, 4]))
  assert.equal(decodeEvents(Buffer.concat([a, audioEvent(Buffer.alloc(0))])).length, 2)
  const bad = Buffer.from(a)
  bad[bad.length - 6] ^= 0xff
  assert.throws(() => decodeEvents(bad), (e) => e.code === 'vendor')
})

function transcriptEvent(results) {
  return encodeEvent({ ':content-type': 'application/json', ':event-type': 'TranscriptEvent', ':message-type': 'event' }, Buffer.from(JSON.stringify({ Transcript: { Results: results } })))
}

test('amazon: transcribe streaming over a presigned websocket', async () => {
  const got = { pcm: 0, frames: 0, ended: false, badCrc: false }
  const ws = await mockWsServer((conn) => {
    conn.on('message', (data, isBin) => {
      if (!isBin) return
      let evs
      try { evs = decodeEvents(data) } catch (e) { got.badCrc = true; return }
      for (const ev of evs) {
        got.frames += 1
        if (ev.payload.length) got.pcm += ev.payload.length
        else {
          got.ended = true
          conn.sendBinary(transcriptEvent([{ IsPartial: true, Alternatives: [{ Transcript: 'Καλ', Items: [] }] }]))
          conn.sendBinary(transcriptEvent([{
            IsPartial: false, LanguageCode: 'el-GR',
            Alternatives: [{ Transcript: 'Καλημέρα κόσμε.', Items: [
              { StartTime: 0.4, EndTime: 1.1, Type: 'pronunciation', Content: 'Καλημέρα' },
              { StartTime: 1.1, EndTime: 1.9, Type: 'pronunciation', Content: 'κόσμε' },
              { StartTime: 1.9, EndTime: 1.9, Type: 'punctuation', Content: '.' },
            ] }],
          }]))
          conn.close()
        }
      }
    })
  })
  try {
    const i = mk({ region: 'eu-central-1', options: { wsBaseUrl: ws.origin } })
    const wav = wavBuffer(16000)
    const out = await amazon.stt({ audio: wav, lang: 'el', wantWords: true }, i)
    assert.equal(out.text, 'Καλημέρα κόσμε.')
    assert.equal(out.language, 'el')
    assert.deepEqual(out.words, [{ w: 'Καλημέρα', t0: 0.4, t1: 1.1 }, { w: 'κόσμε', t0: 1.1, t1: 1.9 }])
    assert.equal(out.durationS, 1)
    assert.equal(got.pcm, 32000)
    assert.ok(got.frames > 2 && got.ended && !got.badCrc)
    const q = new URLSearchParams(ws.reqs[0].query)
    assert.equal(ws.reqs[0].path, '/stream-transcription-websocket')
    assert.equal(q.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256')
    assert.ok(q.get('X-Amz-Credential').includes('/eu-central-1/transcribe/aws4_request'))
    assert.ok(/^\d{8}T\d{6}Z$/.test(q.get('X-Amz-Date')))
    assert.equal(q.get('X-Amz-SignedHeaders'), 'host')
    assert.ok(/^[0-9a-f]{64}$/.test(q.get('X-Amz-Signature')))
    assert.equal(q.get('language-code'), 'el-GR')
    assert.equal(q.get('media-encoding'), 'pcm')
    assert.equal(q.get('sample-rate'), '16000')
    assert.equal(q.get('X-Amz-Security-Token'), null)
    const none = await amazon.stt({ audio: wav, lang: 'it', wantWords: false }, i)
    assert.equal(none.words, null)
    assert.equal(new URLSearchParams(ws.reqs[1].query).get('language-code'), 'it-IT')
    await amazon.stt({ audio: wav }, i)
    assert.equal(new URLSearchParams(ws.reqs[2].query).get('identify-language'), 'true')
  } finally { await ws.close() }
})

test('amazon: transcribe exceptions, refused upgrade', async () => {
  const kinds = ['UnrecognizedClientException', 'LimitExceededException', 'BadRequestException']
  let n = 0
  const ws = await mockWsServer((conn) => {
    conn.on('message', (data) => {
      const evs = decodeEvents(data)
      if (evs.some((e) => !e.payload.length)) {
        conn.sendBinary(encodeEvent({ ':content-type': 'application/json', ':exception-type': kinds[n % 3], ':message-type': 'exception' }, Buffer.from('failed')))
        n += 1
        conn.close()
      }
    })
  })
  try {
    const i = mk({ options: { wsBaseUrl: ws.origin } })
    await assert.rejects(amazon.stt({ audio: wavBuffer(800), lang: 'en' }, i), (e) => e.code === 'bad_key')
    await assert.rejects(amazon.stt({ audio: wavBuffer(800), lang: 'en' }, i), (e) => e.code === 'quota_exceeded' && e.status === 429)
    await assert.rejects(amazon.stt({ audio: wavBuffer(800), lang: 'en' }, i), (e) => e.code === 'vendor')
    ws.refuse = 403
    await assert.rejects(amazon.stt({ audio: wavBuffer(800), lang: 'en' }, i), (e) => e.code === 'bad_key')
  } finally { await ws.close() }
})
