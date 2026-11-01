import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst, wavBuffer } from './helpers.mjs'
import { mockWsServer } from './ws-helper.mjs'
import azure, { buildSsml, pickVoice, endpointsOf } from '../lib/server/providers/azure.js'

const AUDIO = Buffer.from('FAKEMP3-AZURE-0123456789')
const NODASH = /[\u2013\u2014]/

test('azure: metadata sanity', () => {
  assert.equal(azure.type, 'azure')
  assert.equal(azure.group, 'other')
  assert.ok(['varies', 'eu-region', 'non-eu'].includes(azure.residency))
  assert.ok(azure.desc.length < 140 && !NODASH.test(azure.desc))
  assert.ok(!NODASH.test(azure.verification) && !NODASH.test(azure.euNote))
  assert.ok(azure.docs.startsWith('https://'))
  assert.ok(['verified', 'partial', 'unverified', 'planned'].includes(azure.status))
  assert.ok(azure.presets.length >= 1 && azure.presets.every((p) => p.id))
  assert.equal(azure.defaultBaseUrl, '')
  assert.ok(azure.regions.slice(0, 9).every((r) => r.eu))
  assert.ok(azure.regions.slice(9).every((r) => !r.eu))
  assert.ok(azure.optionFields.some((f) => f.key === 'wordBoundary'))
})

test('azure: capabilities are truthful', () => {
  const c = azure.capabilities(inst())
  assert.equal(c.tts, true)
  assert.equal(c.stt, true)
  for (const l of ['el', 'it', 'en']) { assert.ok(c.ttsLangs.includes(l)); assert.ok(c.sttLangs.includes(l)) }
  assert.equal(c.alignment, 'word')
  assert.equal(azure.capabilities(inst({ options: { wordBoundary: false } })).alignment, 'none')
  assert.equal(c.ssml, true)
})

test('azure: configured needs only the key, residencyOf follows the region', () => {
  assert.equal(azure.configured(inst()), true)
  assert.equal(azure.configured(inst({ key: '' })), false)
  assert.equal(azure.residencyOf(inst({ region: 'swedencentral' })), 'eu-region')
  assert.equal(azure.residencyOf(inst({ region: 'italynorth' })), 'eu-region')
  assert.equal(azure.residencyOf(inst({ region: 'eastus' })), 'non-eu')
  assert.equal(azure.residencyOf(inst({ options: { region: 'francecentral' } })), 'eu-region')
  assert.equal(azure.residencyOf(inst()), 'eu-region')
})

test('azure: voice choice and ssml', () => {
  assert.equal(pickVoice(inst(), 'el-GR-NestorasNeural', 'el'), 'el-GR-NestorasNeural')
  assert.equal(pickVoice(inst(), 'junk voice!', 'el'), 'el-GR-AthinaNeural')
  assert.equal(pickVoice(inst(), '', 'it'), 'it-IT-ElsaNeural')
  assert.equal(pickVoice(inst({ defaultVoice: 'it-IT-DiegoNeural' }), '', 'it'), 'it-IT-DiegoNeural')
  assert.equal(pickVoice(inst({ defaultVoice: 'it-IT-DiegoNeural' }), '', 'el'), 'el-GR-AthinaNeural')
  const s = buildSsml('a < b & c', 'el-GR-AthinaNeural', 1.2)
  assert.ok(s.includes("xml:lang='el-GR'") && s.includes("name='el-GR-AthinaNeural'"))
  assert.ok(s.includes('a &lt; b &amp; c'))
  assert.ok(s.includes("<prosody rate='+20%'>"))
  assert.ok(!buildSsml('x', 'it-IT-ElsaNeural', 1).includes('prosody'))
})

test('azure: tts REST request shape, region URL and baseUrl win', async () => {
  const m = await mockServer((r, res) => reply(res, 200, AUDIO))
  try {
    const i = inst({ baseUrl: m.origin, region: 'westeurope', options: { wordBoundary: false } })
    const out = await azure.tts({ text: 'Καλημέρα κόσμε', lang: 'el', speed: 1, wantAlignment: true }, i)
    assert.deepEqual(out.audio, AUDIO)
    assert.equal(out.mime, 'audio/mpeg')
    assert.equal(out.alignment, null)
    assert.equal(out.voice, 'el-GR-AthinaNeural')
    assert.equal(out.billedChars, 14)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/cognitiveservices/v1')
    assert.equal(typeof r.headers['ocp-apim-subscription-key'], 'string')
    assert.equal(r.headers['ocp-apim-subscription-key'].length > 0, true)
    assert.equal(r.headers['content-type'], 'application/ssml+xml')
    assert.ok(r.headers['x-microsoft-outputformat'].startsWith('audio-'))
    assert.ok(r.headers['user-agent'].length > 0)
    const body = r.body.toString('utf8')
    assert.ok(body.includes('Καλημέρα κόσμε') && body.includes("name='el-GR-AthinaNeural'"))
  } finally { await m.close() }
})

test('azure: bearer credential goes to the Authorization header', async () => {
  const m = await mockServer((r, res) => reply(res, 200, AUDIO))
  try {
    const i = inst({ baseUrl: m.origin, key: 'Bearer fake-token-0000', options: { wordBoundary: false } })
    await azure.tts({ text: 'hi', lang: 'en' }, i)
    assert.ok(m.reqs[0].headers.authorization.startsWith('Bearer '))
    assert.equal(m.reqs[0].headers['ocp-apim-subscription-key'], undefined)
  } finally { await m.close() }
})

test('azure: region derives the vendor URLs and baseUrl wins', () => {
  const e = endpointsOf(inst({ region: 'swedencentral' }))
  assert.equal(e.tts, 'https://swedencentral.tts.speech.microsoft.com')
  assert.equal(e.stt, 'https://swedencentral.api.cognitive.microsoft.com')
  assert.equal(e.ws, 'wss://swedencentral.tts.speech.microsoft.com')
  assert.equal(endpointsOf(inst()).tts, 'https://westeurope.tts.speech.microsoft.com')
  assert.equal(endpointsOf(inst({ options: { region: 'italynorth' } })).tts, 'https://italynorth.tts.speech.microsoft.com')
  assert.equal(endpointsOf(inst({ region: 'bad region!' })).tts, 'https://westeurope.tts.speech.microsoft.com')
  const w = endpointsOf(inst({ region: 'swedencentral', baseUrl: 'http://127.0.0.1:9' }))
  assert.equal(w.tts, 'http://127.0.0.1:9')
  assert.equal(w.ws, 'ws://127.0.0.1:9')
})

function wordBoundary(text, off, dur, bt) {
  return { Type: 'WordBoundary', Data: { Offset: off, Duration: dur, text: { Text: text, Length: text.length, BoundaryType: bt || 'WordBoundary' } } }
}
function wsMessage(headers, body) {
  return Object.keys(headers).map((k) => k + ': ' + headers[k]).join('\r\n') + '\r\n\r\n' + (body || '')
}
function audioFrame(buf) {
  const h = Buffer.from('X-RequestId: abc\r\nPath: audio\r\nContent-Type: audio/mpeg\r\nX-StreamId: 1\r\n', 'latin1')
  const len = Buffer.alloc(2)
  len.writeUInt16BE(h.length)
  return Buffer.concat([len, h, buf])
}

test('azure: WebSocket word boundary alignment indexes the sent text (Greek accents)', async () => {
  const seen = []
  const ws = await mockWsServer((conn) => {
    conn.on('message', (data) => {
      seen.push(String(data))
      if (String(data).startsWith('Path: ssml')) {
        conn.sendText(wsMessage({ Path: 'turn.start' }, '{}'))
        conn.sendBinary(audioFrame(Buffer.from('AAAA')))
        conn.sendText(wsMessage({ Path: 'audio.metadata' }, JSON.stringify({ Metadata: [
          wordBoundary('Καλημέρα', 1000000, 4000000),
          wordBoundary('κόσμε', 6000000, 5000000),
          wordBoundary(',', 6500000, 100000, 'PunctuationBoundary'),
        ] })))
        conn.sendBinary(audioFrame(Buffer.from('BBBB')))
        conn.sendText(wsMessage({ Path: 'turn.end' }, '{}'))
      }
    })
  })
  const rest = await mockServer((r, res) => reply(res, 500, 'should not be used'))
  try {
    const i = inst({ baseUrl: rest.origin, options: { wsBaseUrl: ws.origin } })
    const text = 'Καλημέρα κόσμε'
    const out = await azure.tts({ text, lang: 'el', wantAlignment: true }, i)
    assert.equal(out.audio.toString(), 'AAAABBBB')
    assert.equal(out.alignment.unit, 'word')
    const items = out.alignment.items
    assert.equal(items.length, 2)
    assert.equal(text.slice(items[0].c0, items[0].c1), 'Καλημέρα')
    assert.equal(text.slice(items[1].c0, items[1].c1), 'κόσμε')
    assert.ok(Math.abs(items[0].t0 - 0.1) < 1e-9 && Math.abs(items[0].t1 - 0.5) < 1e-9)
    assert.ok(items[1].t0 > items[0].t0 && items[1].t1 >= items[1].t0)
    assert.equal(rest.reqs.length, 0)
    // handshake and protocol shape
    assert.ok(ws.reqs[0].path.endsWith('/cognitiveservices/websocket/v1'))
    assert.equal(ws.reqs[0].headers['ocp-apim-subscription-key'].length > 0, true)
    assert.equal(seen.length, 3)
    assert.ok(seen[0].startsWith('Path: speech.config'))
    assert.ok(seen[1].startsWith('Path: synthesis.context'))
    assert.ok(seen[1].includes('"wordBoundaryEnabled":true'))
    assert.ok(seen[2].includes('Content-Type: application/ssml+xml') && seen[2].includes('<speak'))
  } finally { await ws.close(); await rest.close() }
})

test('azure: socket failure falls back to REST with a note and alignment null', async () => {
  const ws = await mockWsServer()
  ws.refuse = 403
  const rest = await mockServer((r, res) => reply(res, 200, AUDIO))
  try {
    const i = inst({ baseUrl: rest.origin, options: { wsBaseUrl: ws.origin } })
    const out = await azure.tts({ text: 'hello', lang: 'en', wantAlignment: true }, i)
    assert.deepEqual(out.audio, AUDIO)
    assert.equal(out.alignment, null)
    assert.ok(out.note && out.note.includes('REST'))
    assert.equal(rest.reqs.length, 1)
    // the broken socket is skipped on the next reads (one failed handshake, not one per read)
    await azure.tts({ text: 'again', lang: 'en', wantAlignment: true }, i)
    assert.equal(ws.reqs.length, 1)
    assert.equal(rest.reqs.length, 2)
  } finally { await ws.close(); await rest.close() }
})

test('azure: wantAlignment false skips the socket', async () => {
  const ws = await mockWsServer()
  const rest = await mockServer((r, res) => reply(res, 200, AUDIO))
  try {
    const i = inst({ baseUrl: rest.origin, options: { wsBaseUrl: ws.origin } })
    await azure.tts({ text: 'hello', lang: 'en', wantAlignment: false }, i)
    assert.equal(ws.reqs.length, 0)
    assert.equal(rest.reqs.length, 1)
  } finally { await ws.close(); await rest.close() }
})

test('azure: error mapping 401 bad_key, 429 quota, 400 voice, 500 vendor', async () => {
  const m = await mockServer((r, res) => {
    const t = r.body.toString('utf8')
    if (t.includes('>q<')) return reply(res, 429, 'slow down')
    if (t.includes('>v<')) return reply(res, 400, 'Unsupported voice name')
    if (t.includes('>s<')) return reply(res, 500, 'boom')
    return reply(res, 401, 'Access denied')
  })
  try {
    const i = inst({ baseUrl: m.origin, options: { wordBoundary: false } })
    await assert.rejects(azure.tts({ text: 'x', lang: 'en' }, i), (e) => e.code === 'bad_key' && e.status === 502)
    await assert.rejects(azure.tts({ text: 'q', lang: 'en' }, i), (e) => e.code === 'quota_exceeded' && e.status === 429)
    await assert.rejects(azure.tts({ text: 'v', lang: 'en' }, i), (e) => e.code === 'bad_voice' && e.status === 400)
    await assert.rejects(azure.tts({ text: 's', lang: 'en' }, i), (e) => e.code === 'vendor')
  } finally { await m.close() }
})

test('azure: stt fast transcription request and parsed words', async () => {
  const m = await mockServer((r, res) => reply(res, 200, {
    durationMilliseconds: 2400,
    combinedPhrases: [{ text: 'Καλημέρα κόσμε.' }],
    phrases: [{
      offsetMilliseconds: 400, durationMilliseconds: 1600, text: 'Καλημέρα κόσμε.', locale: 'el-GR', confidence: 0.9,
      words: [
        { text: 'Καλημέρα', offsetMilliseconds: 400, durationMilliseconds: 800 },
        { text: 'κόσμε.', offsetMilliseconds: 1200, durationMilliseconds: 800 },
      ],
    }],
  }))
  try {
    const i = inst({ baseUrl: m.origin })
    const out = await azure.stt({ audio: wavBuffer(), name: 'clip.wav', mime: 'audio/wav', lang: 'el', wantWords: true }, i)
    assert.equal(out.text, 'Καλημέρα κόσμε.')
    assert.equal(out.language, 'el')
    assert.equal(out.durationS, 2.4)
    assert.deepEqual(out.words, [{ w: 'Καλημέρα', t0: 0.4, t1: 1.2 }, { w: 'κόσμε.', t0: 1.2, t1: 2 }])
    assert.ok(out.confidence > 0.89 && out.confidence < 0.91)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/speechtotext/transcriptions:transcribe')
    assert.ok(r.query.includes('api-version=2025-10-15'))
    assert.equal(r.headers['ocp-apim-subscription-key'].length > 0, true)
    assert.ok(r.headers['content-type'].startsWith('multipart/form-data'))
    const b = r.body.toString('latin1')
    assert.ok(b.includes('name="definition"') && b.includes('"locales":["el-GR"]'))
    assert.ok(b.includes('name="audio"'))
    const none = await azure.stt({ audio: wavBuffer(), lang: 'it', wantWords: false }, i)
    assert.equal(none.words, null)
    assert.ok(m.reqs[1].body.toString('latin1').includes('"locales":["it-IT"]'))
  } finally { await m.close() }
})

test('azure: stt errors', async () => {
  let status = 401
  const m = await mockServer((r, res) => reply(res, status, 'nope'))
  try {
    const i = inst({ baseUrl: m.origin })
    await assert.rejects(azure.stt({ audio: wavBuffer(), lang: 'en' }, i), (e) => e.code === 'bad_key')
    status = 429
    await assert.rejects(azure.stt({ audio: wavBuffer(), lang: 'en' }, i), (e) => e.code === 'quota_exceeded')
    status = 503
    await assert.rejects(azure.stt({ audio: wavBuffer(), lang: 'en' }, i), (e) => e.code === 'vendor')
  } finally { await m.close() }
})

test('azure: listVoices parses, filters by language and caches', async () => {
  const m = await mockServer((r, res) => reply(res, 200, [
    { Name: 'Microsoft Server Speech Text to Speech Voice (el-GR, AthinaNeural)', DisplayName: 'Athina', LocalName: 'Αθηνά', ShortName: 'el-GR-AthinaNeural', Gender: 'Female', Locale: 'el-GR', VoiceType: 'Neural', Status: 'GA' },
    { ShortName: 'en-US-JennyMultilingualNeural', LocalName: 'Jenny Multilingual', Gender: 'Female', Locale: 'en-US', SecondaryLocaleList: ['it-IT', 'de-DE'], VoiceType: 'Neural', StyleList: ['chat'] },
  ]))
  try {
    const i = inst({ baseUrl: m.origin })
    const el = await azure.listVoices(i, { lang: 'el' })
    assert.equal(el.length, 1)
    assert.deepEqual(el[0].langs, ['el'])
    assert.equal(el[0].id, 'el-GR-AthinaNeural')
    assert.equal(el[0].gender, 'female')
    const it = await azure.listVoices(i, { lang: 'it' })
    assert.deepEqual(it.map((v) => v.id), ['en-US-JennyMultilingualNeural'])
    assert.equal(m.reqs.length, 1)
    assert.equal(m.reqs[0].path, '/cognitiveservices/voices/list')
    assert.equal((await azure.listVoices(i, {})).length, 2)
    assert.equal(m.reqs.length, 1)
  } finally { await m.close() }
})

test('azure: health probes the voice list', async () => {
  let status = 200
  const m = await mockServer((r, res) => reply(res, status, status === 200 ? [] : 'no'))
  try {
    const i = inst({ baseUrl: m.origin })
    assert.deepEqual((await azure.health(i)).status, 'up')
    status = 401
    const h = await azure.health(i)
    assert.equal(h.ok, false)
    assert.equal(h.status, 'down')
    const nokey = await azure.health(inst({ key: '', baseUrl: m.origin }))
    assert.equal(nokey.status, 'down')
    assert.equal(m.reqs.length, 2)
  } finally { await m.close() }
})
