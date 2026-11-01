// Error catalog: drift against docs/ERRORS.md, and the standard error shape on the routes.
// This plugin registers no agent tools, so there is no tool error to test.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mockServer, reply, voiceServer, closedPort } from './helpers.mjs'
import { E, codeFor } from '../lib/errors.js'

const SECRET = 'fake-mistral-key-zzzz'

test('ERRORS.md documents every catalog code (table row and section)', () => {
  const md = fs.readFileSync(new URL('../docs/ERRORS.md', import.meta.url), 'utf8')
  assert.deepEqual(E.missingFromDoc(md), [])
  assert.ok(Object.keys(E.codes).length >= 25)
  assert.ok(E.has('VOICE_INTERNAL'))
})

test('TROUBLESHOOTING.md links only to anchors it defines', () => {
  const md = fs.readFileSync(new URL('../docs/TROUBLESHOOTING.md', import.meta.url), 'utf8')
  const ids = new Set([...md.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]))
  for (const m of md.matchAll(/^#{1,4} (.+)$/gm)) ids.add(m[1].toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'))
  for (const m of md.matchAll(/\]\(#([a-z0-9-]+)\)/g)) assert.ok(ids.has(m[1]), 'missing anchor ' + m[1])
  const errors = fs.readFileSync(new URL('../docs/ERRORS.md', import.meta.url), 'utf8')
  for (const m of errors.matchAll(/TROUBLESHOOTING\.md#([a-z0-9-]+)/g)) assert.ok(ids.has(m[1]), 'ERRORS.md points at a missing anchor ' + m[1])
})

test('codeFor maps legacy vendor codes and falls back', () => {
  assert.equal(codeFor({ code: 'bad_key' }), 'VOICE_PROVIDER_AUTH')
  assert.equal(codeFor({ code: 'quota_exceeded' }), 'VOICE_PROVIDER_QUOTA')
  assert.equal(codeFor({ code: 'weird' }), 'VOICE_PROVIDER_FAILED')
  assert.equal(codeFor(new Error('x'), 'VOICE_INTERNAL'), 'VOICE_INTERNAL')
  assert.equal(codeFor({ code: 'VOICE_RATE_LIMITED' }), 'VOICE_RATE_LIMITED')
})

function shape(r, code, status) {
  assert.equal(r.status, status)
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(r.json.ok, false)
  assert.equal(r.json.code, code)
  assert.equal(typeof r.json.error, 'string')
  assert.ok(r.json.message && r.json.hint, 'message and hint')
  assert.equal(r.json.docs, 'docs/ERRORS.md#' + code.toLowerCase())
}

test('route errors carry the standard shape and keep status and legacy string', async () => {
  const vendor = await mockServer((r, res) => reply(res, 401, { message: 'Unauthorized' }))
  const dead = await closedPort()
  const v = await voiceServer({ DSH_VOICE_MISTRAL_BASE: vendor.origin, MISTRAL_API_KEY: SECRET, DSH_VOICE_OLLAMA_PORT: String(dead) })
  try {
    shape(await v.call('POST', '/nope', { body: {} }), 'VOICE_ROUTE_NOT_FOUND', 404)
    const nf = await v.call('POST', '/nope', { body: {} })
    assert.equal(nf.json.error, 'no such voice route')

    const bad = await v.call('POST', '/tts', { body: 'not json', headers: { 'content-type': 'application/json' } })
    shape(bad, 'VOICE_BAD_REQUEST', 400)
    assert.equal(bad.json.error, 'bad json')

    const get = await v.call('GET', '/tts')
    shape(get, 'VOICE_METHOD_NOT_ALLOWED', 405)
    assert.equal(get.json.error, 'POST only')

    const browser = await v.call('POST', '/tts', { body: { text: 'hi', provider: 'browser' } })
    shape(browser, 'VOICE_BROWSER_ONLY', 400)
    assert.equal(browser.json.legacyCode, 'browser_only')

    const unavailable = await v.call('POST', '/tts', { body: { text: 'hi', provider: 'groq' } })
    shape(unavailable, 'VOICE_PROVIDER_UNAVAILABLE', 503)
    assert.match(unavailable.json.error, /groq/)

    const cross = await v.call('POST', '/tts', { body: { text: 'hi' }, headers: { 'sec-fetch-site': 'cross-site' } })
    shape(cross, 'VOICE_CROSS_SITE', 403)
    assert.equal(cross.json.error, 'cross-site request refused')
    assert.equal(cross.json.legacyCode, 'cross_site')

    const readGate = await v.call('GET', '/settings', { headers: { host: 'evil.example' } })
    shape(readGate, 'VOICE_READ_REFUSED', 403)
    assert.match(readGate.json.error, /untrusted Host/)

    const writeGate = await v.call('PATCH', '/settings', { body: {} })
    shape(writeGate, 'VOICE_WRITE_REFUSED', 403)
    assert.ok(writeGate.json.layer)

    const auth = await v.call('POST', '/tts', { body: { text: 'hello', provider: 'mistral' } })
    shape(auth, 'VOICE_PROVIDER_AUTH', 502)
    assert.equal(auth.json.legacyCode, 'bad_key')
    assert.equal(auth.headers['x-voice-error-code'], 'bad_key')
    assert.equal(auth.json.engine, 'mistral')

    const unknown = await v.call('GET', '/voices?provider=nope')
    shape(unknown, 'VOICE_PROVIDER_UNKNOWN', 404)
    assert.equal(unknown.json.error, 'unknown provider')

    for (const r of [nf, bad, auth, readGate]) assert.ok(!r.text.includes(SECRET), 'no secret in an error body')
  } finally { await v.close(); await vendor.close() }
})

test('the legacy 503 sentences survive the scrubber unchanged', () => {
  const sentences = ['ELEVENLABS_API_KEY not set for dsh-web', 'MiMo token-plan key not found (~/.config/xiaomi-mimo/credentials)', 'GREY_TTS_URL / GREY_TTS_API_KEY not set for dsh-web', 'the LFM3 audio model is not answering on 127.0.0.1:11435']
  for (const s of sentences) assert.equal(E.body('VOICE_PROVIDER_UNAVAILABLE', { message: s }).error, s)
})

test('the scrubber masks key-shaped text in dynamic messages', () => {
  const b = E.body('VOICE_PROVIDER_FAILED', { message: 'upstream said sk-' + 'a'.repeat(30) })
  assert.ok(!b.message.includes('a'.repeat(30)))
})
