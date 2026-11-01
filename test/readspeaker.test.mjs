import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, inst } from './helpers.mjs'
import rs from '../lib/server/providers/readspeaker.js'

const DASH = /[\u2013\u2014]/
const MP3 = Buffer.from('ID3FAKE-READSPEAKER-AUDIO')

test('readspeaker: metadata sanity', () => {
  assert.equal(rs.type, 'readspeaker')
  assert.equal(rs.group, 'eu')
  assert.ok(rs.desc.length < 140)
  for (const s of [rs.desc, rs.euNote, rs.verification, rs.label]) assert.ok(!DASH.test(s))
  assert.match(rs.docs, /^https:\/\//)
  assert.ok(['verified', 'partial', 'unverified', 'planned'].includes(rs.status))
  assert.ok(rs.presets.every((x) => x.id))
  assert.equal(rs.configured(inst({ key: '' })), false)
  assert.equal(rs.configured(inst()), true)
})

test('readspeaker: capabilities are truthful (no alignment, no stt)', () => {
  const c = rs.capabilities(inst())
  assert.equal(c.tts, true)
  assert.equal(c.stt, false)
  assert.deepEqual(c.ttsLangs, ['el', 'it', 'en'])
  assert.deepEqual(c.sttLangs, [])
  assert.equal(c.alignment, 'none')
  assert.equal(c.nativeSpeed, null)
  assert.equal(c.maxChars, 5000)
})

test('readspeaker: tts posts the documented form fields', async () => {
  const m = await mockServer((r, res) => reply(res, 200, MP3, { 'content-type': 'audio/mpeg' }))
  try {
    const out = await rs.tts({ text: 'Welcome to ReadSpeaker.', voice: 'Adam', lang: 'en-GB', wantAlignment: true }, inst({ baseUrl: m.origin }))
    assert.deepEqual(out.audio, MP3)
    assert.equal(out.mime, 'audio/mpeg')
    assert.equal(out.voice, 'Adam')
    assert.equal(out.alignment, null)
    assert.equal(out.billedChars, 'WelcometoReadSpeaker.'.length)
    const r = m.reqs[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.path, '/a/eg/v2.0')
    assert.match(r.headers['content-type'], /^application\/x-www-form-urlencoded/)
    const f = new URLSearchParams(r.body.toString('utf8'))
    assert.equal(f.has('key') && f.get('key').length > 0, true)
    assert.equal(r.headers.authorization, undefined)
    assert.equal(f.get('voice'), 'Adam')
    assert.equal(f.get('lang'), 'en_uk')
    assert.equal(f.get('audioformat'), 'mp3')
    assert.equal(f.get('audiobitrate'), '48')
    assert.equal(f.get('streaming'), '0')
    assert.equal(f.get('text'), 'Welcome to ReadSpeaker.')
  } finally { await m.close() }
})

test('readspeaker: language codes, overrides and voice fallback', async () => {
  const m = await mockServer((r, res) => reply(res, 200, MP3, { 'content-type': 'audio/mpeg' }))
  try {
    const i = inst({ baseUrl: m.origin, defaultVoice: 'Adam', options: { langCodes: 'el=el_gr, it=it_it', bitrate: '64' } })
    await rs.tts({ text: 'γεια', lang: 'el', voice: 'bad voice!' }, i)
    await rs.tts({ text: 'ciao', lang: 'it', voice: 'Alice' }, inst({ baseUrl: m.origin, options: { langCodes: 'it=it_xx' } }))
    const a = new URLSearchParams(m.reqs[0].body.toString('utf8'))
    assert.equal(a.get('lang'), 'el_gr')
    assert.equal(a.get('voice'), 'Adam')
    assert.equal(a.get('audiobitrate'), '64')
    const b = new URLSearchParams(m.reqs[1].body.toString('utf8'))
    assert.equal(b.get('lang'), 'it_xx')
    assert.equal(b.get('voice'), 'Alice')
  } finally { await m.close() }
})

test('readspeaker: a streaming redirect is followed once', async () => {
  const m = await mockServer((r, res) => {
    if (r.path === '/a/eg/v2.0') { res.writeHead(302, { location: '/stream/abc' }); return res.end() }
    if (r.path === '/stream/abc') return reply(res, 200, MP3, { 'content-type': 'audio/mpeg' })
    return reply(res, 404, {})
  })
  try {
    const out = await rs.tts({ text: 'x' }, inst({ baseUrl: m.origin }))
    assert.deepEqual(out.audio, MP3)
    assert.equal(m.reqs[1].method, 'GET')
  } finally { await m.close() }
})

test('readspeaker: error mapping', async () => {
  const cases = [
    [401, 'denied', 'bad_key', 502],
    [403, 'denied', 'bad_key', 502],
    [429, 'slow down', 'quota_exceeded', 429],
    [400, 'unknown voice', 'bad_voice', 400],
    [400, 'lang not available', 'unsupported_lang', 400],
    [500, 'boom', 'vendor', 502],
  ]
  for (const [status, msg, code, http] of cases) {
    const m = await mockServer((r, res) => reply(res, status, msg))
    try {
      await assert.rejects(rs.tts({ text: 'x' }, inst({ baseUrl: m.origin })), (e) => e.code === code && e.status === http)
    } finally { await m.close() }
  }
  const m = await mockServer((r, res) => reply(res, 200, 'ERROR: invalid key'))
  try {
    await assert.rejects(rs.tts({ text: 'x' }, inst({ baseUrl: m.origin })), (e) => e.code === 'vendor')
  } finally { await m.close() }
})

test('readspeaker: static voices, health offline, stt absent', async () => {
  const all = await rs.listVoices(inst(), {})
  assert.deepEqual(all.map((v) => v.id), ['Adam'])
  assert.deepEqual(await rs.listVoices(inst(), { lang: 'el' }), [])
  assert.equal((await rs.health(inst())).status, 'unknown')
  assert.equal((await rs.health(inst({ key: '' }))).status, 'down')
  assert.equal(typeof rs.stt, 'undefined')
})
