import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst } from './helpers.mjs'
import acapela, { parseEvents } from '../lib/server/providers/acapela.js'

const DASH = /[\u2013\u2014]/
const KEY = 'user@example.test:fake-pass-0000'
const MP3 = Buffer.from('ID3FAKEMP3BYTES0123456789')
const EVENTS = [
  { EventKind: 'Word', ID: 1, SamplePosition: 2000, Time: 0.1, Flags: 'TTS_Word', WordOffset: 0, WordSize: 5, Word: 'Hello' },
  { EventKind: 'Phoneme', ID: 1, SamplePosition: 2000, Time: '0.1', Duration: 59, Viseme: 12 },
  { EventKind: 'Word', ID: 2, SamplePosition: 9000, Time: 0.45, Flags: 'TTS_Word', WordOffset: 6, WordSize: 5, Word: 'world' },
]

function service(over) {
  const o = Object.assign({ command: null, loginStatus: 200 }, over || {})
  return (r, res) => {
    if (r.method === 'POST' && r.path === '/api/login/') return o.loginStatus === 200 ? reply(res, 200, { token: 'tok-1' }) : reply(res, o.loginStatus, { error: 'Unable to login with provided credentials.' })
    if (r.method === 'GET' && r.path === '/api/account/') return reply(res, 200, { email: 'user@example.test', credit: 10, voices: [
      { name: 'Sharon22k_HQ', gender: 'female', language: 'English', locale: 'en-GB' },
      { name: 'Melina22k_NT', gender: 'female', language: 'Greek', locale: 'el-GR' },
      { name: 'Fabiana22k_HQ', gender: 'female', language: 'Italian', locale: 'it-IT' },
    ] })
    if (r.method === 'GET' && r.path === '/api/command/') {
      if (o.command) return o.command(r, res)
      const out = new URLSearchParams(r.query).get('output')
      return out === 'events' ? reply(res, 200, EVENTS) : reply(res, 200, MP3, { 'content-type': 'audio/mpeg' })
    }
    return reply(res, 404, {})
  }
}

test('acapela: metadata sanity', () => {
  assert.equal(acapela.type, 'acapela')
  assert.equal(acapela.group, 'eu')
  assert.ok(acapela.desc.length < 140)
  for (const s of [acapela.desc, acapela.euNote, acapela.verification, acapela.label]) assert.ok(!DASH.test(s))
  assert.match(acapela.docs, /^https:\/\//)
  assert.ok(['verified', 'partial', 'unverified', 'planned'].includes(acapela.status))
  assert.notEqual(acapela.status, 'planned')
  assert.ok(acapela.presets.every((x) => x.id))
})

test('acapela: credential must be email:password', () => {
  assert.equal(acapela.configured(inst({ key: KEY })), true)
  assert.equal(acapela.configured(inst({ key: 'just-a-key' })), false)
  assert.equal(acapela.configured(inst({ key: '' })), false)
  assert.equal(acapela.configured(inst({ key: 'user@example.test:' })), false)
})

test('acapela: capabilities are truthful', () => {
  const c = acapela.capabilities(inst())
  assert.equal(c.tts, true)
  assert.equal(c.stt, false)
  assert.deepEqual(c.ttsLangs, ['el', 'it', 'en'])
  assert.equal(c.alignment, 'word')
  assert.deepEqual(c.nativeSpeed, [0.3, 3.0])
})

test('acapela: tts logs in, sends documented params, returns audio and word alignment', async () => {
  const m = await mockServer(service())
  try {
    const i = inst({ key: KEY, baseUrl: m.origin })
    const text = 'Hello world'
    const out = await acapela.tts({ text, voice: 'Sharon22k_HQ', speed: 1.5, wantAlignment: true }, i)
    assert.deepEqual(out.audio, MP3)
    assert.equal(out.mime, 'audio/mpeg')
    assert.equal(out.voice, 'Sharon22k_HQ')
    assert.equal(out.billedChars, text.length)
    const login = m.reqs[0]
    assert.equal(login.method, 'POST')
    assert.equal(login.path, '/api/login/')
    assert.deepEqual(login.json(), { email: 'user@example.test', password: 'fake-pass-0000' })
    const cmd = m.reqs[1]
    assert.equal(cmd.path, '/api/command/')
    assert.equal(cmd.headers.authorization, 'Token tok-1')
    const q = new URLSearchParams(cmd.query)
    assert.equal(q.get('voice'), 'Sharon22k_HQ')
    assert.equal(q.get('text'), text)
    assert.equal(q.get('output'), 'file')
    assert.equal(q.get('type'), 'mp3')
    assert.equal(q.get('speed'), '150')
    const q2 = new URLSearchParams(m.reqs[2].query)
    assert.equal(q2.get('output'), 'events')
    assert.equal(q2.get('wordpos'), 'on')
    assert.equal(m.reqs.filter((r) => r.path === '/api/login/').length, 1)
    // alignment indexes the sent text, times monotone
    assert.equal(out.alignment.unit, 'word')
    const items = out.alignment.items
    assert.deepEqual(items.map((w) => text.slice(w.c0, w.c1)), ['Hello', 'world'])
    assert.equal(items[0].t0, 0.1)
    assert.equal(items[0].t1, 0.45)
    assert.ok(items[1].t1 > items[1].t0)
    for (let k = 1; k < items.length; k += 1) assert.ok(items[k].t0 >= items[k - 1].t1 - 1e-9)
    // token is reused
    await acapela.tts({ text }, i)
    assert.equal(m.reqs.filter((r) => r.path === '/api/login/').length, 1)
  } finally { await m.close() }
})

test('acapela: no events request without wantAlignment, failed events give null alignment', async () => {
  const m = await mockServer(service())
  try {
    const out = await acapela.tts({ text: 'Hi' }, inst({ key: KEY, baseUrl: m.origin }))
    assert.equal(out.alignment, null)
    assert.equal(m.reqs.filter((r) => new URLSearchParams(r.query).get('output') === 'events').length, 0)
  } finally { await m.close() }
  const m2 = await mockServer(service({ command: (r, res) => (new URLSearchParams(r.query).get('output') === 'events' ? reply(res, 500, {}) : reply(res, 200, MP3, { 'content-type': 'audio/mpeg' })) }))
  try {
    const out = await acapela.tts({ text: 'Hi', wantAlignment: true }, inst({ key: KEY, baseUrl: m2.origin }))
    assert.equal(out.alignment, null)
    assert.ok(out.audio.length > 0)
  } finally { await m2.close() }
})

test('acapela: invalid voice name degrades to the default voice', async () => {
  const m = await mockServer(service())
  try {
    const out = await acapela.tts({ text: 'x', voice: 'bad voice!' }, inst({ key: KEY, baseUrl: m.origin, defaultVoice: 'Melina22k_NT' }))
    assert.equal(out.voice, 'Melina22k_NT')
    assert.equal(new URLSearchParams(m.reqs[1].query).get('voice'), 'Melina22k_NT')
  } finally { await m.close() }
})

test('acapela: parseEvents keeps word events only', () => {
  assert.deepEqual(parseEvents(EVENTS), [{ text: 'Hello', t0: 0.1 }, { text: 'world', t0: 0.45 }])
  assert.deepEqual(parseEvents({ events: EVENTS }).length, 2)
  assert.deepEqual(parseEvents(null), [])
})

test('acapela: error mapping', async () => {
  const cases = [
    [{ loginStatus: 401 }, 'bad_key', 502],
    [{ command: (r, res) => reply(res, 400, { error: 'Not enough credit.' }) }, 'quota_exceeded', 429],
    [{ command: (r, res) => reply(res, 400, { error: 'Voice not allowed.' }) }, 'bad_voice', 400],
    [{ command: (r, res) => reply(res, 403, { error: 'You must be logged.' }) }, 'bad_key', 502],
    [{ command: (r, res) => reply(res, 500, { error: 'boom' }) }, 'vendor', 502],
    [{ command: (r, res) => reply(res, 429, {}) }, 'quota_exceeded', 429],
  ]
  for (const [over, code, status] of cases) {
    const m = await mockServer(service(over))
    try {
      await assert.rejects(acapela.tts({ text: 'x' }, inst({ key: KEY, baseUrl: m.origin })), (e) => e.code === code && e.status === status)
    } finally { await m.close() }
  }
})

test('acapela: a stale token is renewed once', async () => {
  let n = 0
  const m = await mockServer(service({ command: (r, res) => { n += 1; return n === 1 ? reply(res, 401, { detail: 'Invalid token.' }) : reply(res, 200, MP3, { 'content-type': 'audio/mpeg' }) } }))
  try {
    const i = inst({ key: KEY, baseUrl: m.origin, state: { token: 'old' } })
    const out = await acapela.tts({ text: 'x' }, i)
    assert.ok(out.audio.length > 0)
    assert.equal(m.reqs.filter((r) => r.path === '/api/login/').length, 1)
  } finally { await m.close() }
})

test('acapela: listVoices parses the account, filters by language, caches', async () => {
  const m = await mockServer(service())
  try {
    const i = inst({ key: KEY, baseUrl: m.origin })
    const all = await acapela.listVoices(i, {})
    assert.deepEqual(all.map((v) => [v.id, v.langs[0]]), [['Sharon22k_HQ', 'en'], ['Melina22k_NT', 'el'], ['Fabiana22k_HQ', 'it']])
    assert.deepEqual((await acapela.listVoices(i, { lang: 'el' })).map((v) => v.id), ['Melina22k_NT'])
    assert.equal(m.reqs.filter((r) => r.path === '/api/account/').length, 1)
  } finally { await m.close() }
})

test('acapela: health is offline and reflects the credential format', async () => {
  assert.equal((await acapela.health(inst({ key: KEY }))).status, 'unknown')
  assert.equal((await acapela.health(inst({ key: 'x' }))).status, 'down')
})

test('acapela: stt is not offered', async () => {
  assert.equal(typeof acapela.stt, 'undefined')
})
