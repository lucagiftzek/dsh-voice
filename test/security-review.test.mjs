// Review fixes (pre-merge): provider URL / credential redirection guard on
// PATCH /settings, cross-site refusal on the 1.x POST routes, polish rate limit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { voiceServer } from './helpers.mjs'
import { harnessCookieName, isInternalHost, checkProviderEntry, safeBaseUrl } from '../lib/server/security.js'
import { TYPES } from '../lib/server/registry.js'

// Private-range literals are assembled from parts, so the privacy check keeps flagging real ones.
const ip = (...p) => p.join('.')

test('isInternalHost: loopback, private, link-local, CGNAT, ULA, LAN names; public names pass', () => {
  for (const h of ['localhost', 'a.localhost', '127.0.0.1', ip(10, 1, 2, 3), ip(172, 16, 0, 1), ip(172, 31, 9, 9), ip(192, 168, 0, 10), '169.254.1.1', '100.64.0.1', '0.0.0.0',
    '::1', '[::1]', 'fd12:3456::1', 'fe80::1', 'nas', 'box.local', 'printer.lan', 'svc.internal', 'x.home.arpa', '::ffff:' + ip(10, 0, 0, 1), '']) {
    assert.equal(isInternalHost(h), true, h)
  }
  for (const h of ['api.mistral.ai', 'eu1.asr.api.speechmatics.com', '8.8.8.8', '172.32.0.1', '2a00:1450::1']) assert.equal(isInternalHost(h), false, h)
})

test('safeBaseUrl: userinfo and non-http schemes refused, ws allowed', () => {
  assert.equal(safeBaseUrl('https://user:pw@api.example.com'), false)
  assert.equal(safeBaseUrl('file:///etc/passwd'), false)
  assert.equal(safeBaseUrl('wss://westeurope.tts.speech.microsoft.com'), true)
  assert.equal(safeBaseUrl('http://169.254.169.254/latest'), false)
})

test('checkProviderEntry: cloud types need https + public host; self-hosted types may use the LAN', async () => {
  const chk = (p, current, lookup) => checkProviderEntry(p, { adapter: TYPES[p.type], current, lookup })
  assert.equal(await chk({ id: 'm2', type: 'mistral', baseUrl: 'https://api.eu.mistral.ai' }), null)
  assert.match(await chk({ id: 'm2', type: 'mistral', baseUrl: 'http://api.eu.mistral.ai' }), /https/)
  assert.match(await chk({ id: 'm2', type: 'mistral', baseUrl: 'https://127.0.0.1:9000' }), /internal/)
  assert.match(await chk({ id: 'm2', type: 'mistral', baseUrl: 'https://' + ip(10, 0, 0, 5) }), /internal/)
  // a public-looking name that resolves to a private address
  const lookup = async () => [{ address: ip(192, 168, 1, 9), family: 4 }]
  assert.match(await chk({ id: 'm2', type: 'mistral', baseUrl: 'https://rebind.example.com' }, null, lookup), /internal/)
  // a lookup failure does not block (a name that does not resolve reaches nothing)
  assert.equal(await chk({ id: 'm2', type: 'mistral', baseUrl: 'https://nx.example.com' }, null, async () => { throw new Error('ENOTFOUND') }), null)
  // option URLs are checked too
  assert.match(await chk({ id: 'az', type: 'azure', options: { wsBaseUrl: 'ws://127.0.0.1:1' } }), /wsBaseUrl/)
  assert.match(await chk({ id: 'sm', type: 'speechmatics', options: { ttsHost: 'http://' + ip(192, 168, 1, 2) } }), /ttsHost/)
  // self-hosted types
  assert.equal(await chk({ id: 'k', type: 'tzekos-native', baseUrl: 'http://' + ip(192, 168, 1, 50) + ':8790' }), null)
  assert.equal(await chk({ id: 'kf', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:8880/v1' }), null)
  assert.equal(await chk({ id: 'p', type: 'piper', baseUrl: 'http://127.0.0.1:5000' }), null)
  // an unchanged env-configured value stays saveable (a loopback MiMo relay)
  const cur = { id: 'mimo', type: 'mimo', baseUrl: 'http://127.0.0.1:8798/v1', options: {} }
  assert.equal(await chk({ id: 'mimo', type: 'mimo', baseUrl: 'http://127.0.0.1:8798/v1' }, cur), null)
  assert.match(await chk({ id: 'mimo', type: 'mimo', baseUrl: 'http://127.0.0.1:9999/v1' }, cur), /https/)
  // vault pointers only for the entry's own id
  assert.equal(await chk({ id: 'el2', type: 'elevenlabs', credential: 'vault:el2' }), null)
  assert.match(await chk({ id: 'el2', type: 'elevenlabs', credential: 'vault:mistral-eu' }), /another provider/)
})

async function gated(v) {
  const host = '127.0.0.1:' + v.port
  const tok = (await v.call('GET', '/session')).json.token
  const headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://' + host, cookie: harnessCookieName(host) + '=s', 'x-dsh-voice-token': tok }
  return (body) => v.call('PATCH', '/settings', { headers, body })
}

test('PATCH /settings refuses pointing a cloud credential at an internal host, keeps env-configured relays', async () => {
  const env = { MISTRAL_API_KEY: 'k-test', MIMO_TOKEN_PLAN_API_KEY: 'k-test', MIMO_TOKEN_PLAN_BASE_URL: 'http://127.0.0.1:8798/v1' }
  const v = await voiceServer(env)
  try {
    const patch = await gated(v)
    const bad = await patch({ providers: [{ id: 'mistral', type: 'mistral', baseUrl: 'http://127.0.0.1:6379', credential: 'env:MISTRAL_API_KEY' }] })
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /mistral/)
    const exfil = await patch({ providers: [{ id: 'grab', type: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io', credential: 'vault:mistral' }] })
    assert.equal(exfil.status, 400)
    // the relayed MiMo base (env) re-saved unchanged, e.g. by the Edit form
    const same = await patch({ providers: [{ id: 'mimo', type: 'mimo', baseUrl: 'http://127.0.0.1:8798/v1', credential: 'env:MIMO_TOKEN_PLAN_API_KEY', inAuto: true }] })
    assert.equal(same.status, 200)
    const lan = await patch({ providers: [{ id: 'kokoro-lan', type: 'tzekos-native', baseUrl: 'http://' + ip(192, 168, 1, 50) + ':8790', credential: 'env:GREY_TTS_API_KEY' }] })
    assert.equal(lan.status, 200)
  } finally { await v.close() }
})

test('1.x POST routes refuse cross-site browser requests, same-origin and header-less callers still work', async () => {
  const v = await voiceServer({})
  try {
    const host = '127.0.0.1:' + v.port
    const body = { text: 'hello' }
    const cross = await v.call('POST', '/polish', { headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, body })
    assert.equal(cross.status, 403)
    const otherOrigin = await v.call('POST', '/tts', { headers: { origin: 'https://evil.example' }, body })
    assert.equal(otherOrigin.status, 403)
    const nullOrigin = await v.call('POST', '/stt', { headers: { origin: 'null' }, body: 'x' })
    assert.equal(nullOrigin.status, 403)
    const same = await v.call('POST', '/polish', { headers: { 'sec-fetch-site': 'same-origin', origin: 'http://' + host }, body })
    assert.equal(same.status, 200)
    const plain = await v.call('POST', '/polish', { body })
    assert.equal(plain.status, 200)
  } finally { await v.close() }
})

test('polish is rate limited (security.rateLimit.polishPerMin)', async () => {
  const v = await voiceServer({}, { config: { security: { rateLimit: { polishPerMin: 2 } } } })
  try {
    const go = () => v.call('POST', '/polish', { body: { text: 'hello' } })
    assert.equal((await go()).status, 200)
    assert.equal((await go()).status, 200)
    assert.equal((await go()).status, 429)
  } finally { await v.close() }
})
