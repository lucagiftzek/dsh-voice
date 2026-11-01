import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mockServer, reply, closedPort, voiceServer, wavBuffer, multipartUpload } from './helpers.mjs'
import { harnessCookieName } from '../lib/server/security.js'

const AUDIO = Buffer.from('ROUTEAUDIO-0123456789')
const KEYS = {
  MISTRAL_API_KEY: 'fake-mistral-key-aaaa',
  MIMO_TOKEN_PLAN_API_KEY: 'fake-mimo-key-bbbb',
  TTS_API_KEY: 'fake-tts-key-cccc',
  GREY_TTS_API_KEY: 'fake-grey-key-dddd',
  ELEVENLABS_API_KEY: 'fake-eleven-key-eeee',
  GROQ_API_KEY: 'fake-groq-key-ffff',
}

/** A fake estate: one mock per vendor, a voice server wired to them. */
async function world(opts) {
  const o = opts || {}
  const w = {}
  w.mistral = await mockServer((r, res) => {
    if (r.path === '/v1/audio/voices') return reply(res, 200, { items: [], total: 0 })
    if (r.path === '/v1/audio/speech') return reply(res, 200, { audio_data: AUDIO.toString('base64') })
    if (r.path === '/v1/audio/transcriptions') return reply(res, 200, { text: 'mistral heard', language: 'en' })
    if (r.path === '/v1/chat/completions') return reply(res, 200, { choices: [{ message: { content: 'Polished by Mistral.' } }] })
    return reply(res, 404, {})
  })
  w.mimo = await mockServer((r, res) => {
    const m = String((r.json() || {}).model || '')
    if (/asr/.test(m)) return reply(res, 200, { choices: [{ message: { content: 'mimo heard' } }] })
    return reply(res, 200, { choices: [{ message: { audio: { data: AUDIO.toString('base64') } } }] })
  })
  w.eleven = await mockServer((r, res) => {
    if (r.path === '/v1/voices') return reply(res, 200, { voices: [{ voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' }] })
    if (r.path === '/v1/user/subscription') return reply(res, 200, { tier: 'free', character_limit: 10000, character_count: 100 })
    if (/with-timestamps$/.test(r.path)) {
      const t = r.json().text
      const chars = t.split('')
      return reply(res, 200, { audio_base64: AUDIO.toString('base64'), alignment: { characters: chars, character_start_times_seconds: chars.map((_, k) => k * 0.05), character_end_times_seconds: chars.map((_, k) => k * 0.05 + 0.05) } })
    }
    return reply(res, 200, AUDIO, { 'content-type': 'audio/mpeg' })
  })
  w.local = await mockServer((r, res) => {
    if (r.path === '/health') return reply(res, 200, { engines_available: ['maya', 'kokoro'], whisper_sizes: ['small'] })
    if (r.path === '/api/tts') return reply(res, 200, AUDIO, { 'content-type': 'audio/mpeg' })
    if (r.path === '/v1/speech-to-text-fast') return reply(res, 200, { text: 'local heard', language_code: 'el' })
    return reply(res, 404, {})
  })
  w.lfm3 = await mockServer((r, res) => (r.path === '/v1/models' ? reply(res, 200, { data: [{ id: 'lfm3-audio-2b' }] }) : reply(res, 404, {})))
  w.grey = await mockServer((r, res) => reply(res, 200, wavBuffer(), { 'content-type': 'audio/wav' }))
  const dead = await closedPort()
  w.env = Object.assign({
    DSH_VOICE_MISTRAL_BASE: w.mistral.origin,
    MIMO_TOKEN_PLAN_BASE_URL: w.mimo.origin + '/v1',
    DSH_VOICE_ELEVEN_BASE: w.eleven.origin,
    DSH_VOICE_TTS_PORT: String(w.local.port),
    DSH_VOICE_LFM3_PORT: String(w.lfm3.port),
    GREY_TTS_URL: w.grey.origin,
    DSH_VOICE_OLLAMA_PORT: String(dead),
  }, o.keys === undefined ? KEYS : o.keys, o.env || {})
  w.v = await voiceServer(w.env, o.server)
  w.close = async () => { await w.v.close(); for (const k of ['mistral', 'mimo', 'eleven', 'local', 'lfm3', 'grey']) await w[k].close() }
  return w
}

test('/config keeps every 1.x key and adds the v2 superset', async () => {
  const w = await world()
  try {
    const r = await w.v.call('GET', '/config')
    assert.equal(r.status, 200)
    const c = r.json
    assert.equal(c.ok, true)
    assert.equal(c.v, 2)
    for (const id of ['mistral', 'mimo', 'alibaba', 'groq', 'elevenlabs', 'local', 'grey', 'lfm3', 'browser']) {
      const e = c.engines[id]
      assert.ok(e, 'engine ' + id)
      for (const k of ['available', 'tts', 'stt']) assert.equal(typeof e[k], 'boolean', id + '.' + k)
    }
    assert.deepEqual(Object.keys(c.defaults).sort(), ['stt', 'tts', 'ttsNonEnglish'])
    assert.deepEqual(Object.keys(c.polish).sort(), ['fallback', 'localAvailable', 'primary'])
    assert.equal(typeof c.polish.localAvailable, 'boolean')
    assert.equal(typeof c.ttsHealth, 'number')
    assert.ok(Array.isArray(c.providers))
    assert.ok(c.routes && c.routes.en && c.routes.el && c.routes['*'])
    assert.ok(c.perLanguage && c.perLanguage.en)
    assert.deepEqual(c.engines.browser.available, true)
    assert.equal(c.engines.browser.tts, true)
    assert.equal(c.engines.browser.stt, false)
  } finally { await w.close() }
})

test('Luca-like env: mimo for English, local for Greek and Italian, ElevenLabs never chosen by auto', async () => {
  const w = await world()
  try {
    const c = (await w.v.call('GET', '/config')).json
    assert.deepEqual(c.defaults, { tts: 'mimo', stt: 'mimo', ttsNonEnglish: 'local' })
    assert.equal(c.routes.el.tts, 'local')
    assert.equal(c.routes.it.tts, 'local')
    assert.equal(c.routes.el.stt, 'local')
    assert.equal(c.routes.en.stt, 'mimo')
    assert.equal(c.engines.elevenlabs.available, true)
    for (const l of Object.keys(c.routes)) {
      assert.notEqual(c.routes[l].tts, 'elevenlabs', 'tts ' + l)
      assert.notEqual(c.routes[l].stt, 'elevenlabs', 'stt ' + l)
    }
    assert.equal(c.engines.groq.available, false)
    assert.equal(c.engines.lfm3.available, true)
    assert.equal(c.engines.grey.available, true)
    assert.equal(c.ttsHealth, 200)
  } finally { await w.close() }
})

test('legacy.engines (settings or env) makes groq available', async () => {
  const w1 = await world({ server: { config: { legacy: { engines: true } } } })
  try {
    const c = (await w1.v.call('GET', '/config')).json
    assert.equal(c.engines.groq.available, true)
    assert.equal(c.engines.groq.stt, true)
    assert.equal(c.engines.groq.tts, false)
  } finally { await w1.close() }
  const w2 = await world({ env: { DSH_VOICE_LEGACY_ENGINES: '1' } })
  try {
    assert.equal((await w2.v.call('GET', '/config')).json.engines.groq.available, true)
  } finally { await w2.close() }
})

test('/tts errors', async () => {
  const w = await world({ keys: { TTS_API_KEY: KEYS.TTS_API_KEY } })
  try {
    assert.equal((await w.v.call('POST', '/tts', { body: { text: '   ' } })).status, 400)
    assert.equal((await w.v.call('POST', '/tts', { body: { } })).status, 400)
    const bad = await w.v.call('POST', '/tts', { headers: { 'content-type': 'application/json' }, body: '{not json' })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error, 'bad json')
    const b = await w.v.call('POST', '/tts', { body: { text: 'hi', provider: 'browser' } })
    assert.equal(b.status, 400)
    assert.equal(b.json.code, 'VOICE_BROWSER_ONLY')
    assert.equal(b.json.legacyCode, 'browser_only')
    const g = await w.v.call('POST', '/tts', { body: { text: 'hi', provider: 'groq' } })
    assert.equal(g.status, 503)
    assert.match(g.json.error, /groq is speech-to-text only/)
    const m = await w.v.call('POST', '/tts', { body: { text: 'hi', provider: 'mistral' } })
    assert.equal(m.status, 503)
    assert.equal(m.json.error, 'MISTRAL_API_KEY not set for dsh-web')
  } finally { await w.close() }
  const w2 = await world({ server: { config: { legacy: { engines: true } } } })
  try {
    const g = await w2.v.call('POST', '/tts', { body: { text: 'hi', provider: 'groq' } })
    assert.equal(g.status, 503)
    assert.match(g.json.error, /speech-to-text only/)
  } finally { await w2.close() }
})

test('/tts: a vendor 401 is a 502 with x-voice-error-code bad_key', async () => {
  const w = await world()
  try {
    w.mistral.handler = (r, res) => reply(res, 401, { message: 'Unauthorized' })
    const r = await w.v.call('POST', '/tts', { body: { text: 'hello', provider: 'mistral' } })
    assert.equal(r.status, 502)
    assert.equal(r.headers['x-voice-error-code'], 'bad_key')
    assert.equal(r.json.code, 'VOICE_PROVIDER_AUTH')
    assert.equal(r.json.legacyCode, 'bad_key')
    assert.equal(r.json.ok, false)
    assert.equal(r.json.engine, 'mistral')
  } finally { await w.close() }
})

test('/tts returns audio with the engine headers', async () => {
  const w = await world()
  try {
    const r = await w.v.call('POST', '/tts', { body: { text: 'Hello', lang: 'en' } })
    assert.equal(r.status, 200)
    assert.equal(r.headers['x-voice-engine'], 'mimo')
    assert.deepEqual(r.body, AUDIO)
    const el = await w.v.call('POST', '/tts', { body: { text: 'Geia sou', lang: 'el' } })
    assert.equal(el.headers['x-voice-engine'], 'local')
    assert.equal(w.local.reqs.filter((q) => q.path === '/api/tts').length, 1)
    assert.equal(w.eleven.reqs.filter((q) => /text-to-speech/.test(q.path)).length, 0)
  } finally { await w.close() }
})

test('/tts?alignment=1 with ElevenLabs returns JSON audio_base64 + alignment', async () => {
  const w = await world()
  try {
    const r = await w.v.call('POST', '/tts?alignment=1', { body: { text: 'alpha beta', provider: 'elevenlabs' } })
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /json/)
    assert.equal(r.json.engine, 'elevenlabs')
    assert.deepEqual(Buffer.from(r.json.audio_base64, 'base64'), AUDIO)
    assert.equal(r.json.alignment.unit, 'word')
    assert.deepEqual(r.json.alignment.items.map((x) => 'alpha beta'.slice(x.c0, x.c1)), ['alpha', 'beta'])
  } finally { await w.close() }
})

test('/stt ?lang=el routes to local and forwards the multipart body unchanged', async () => {
  const w = await world()
  try {
    const up = multipartUpload(wavBuffer(), 'clip.wav')
    const r = await w.v.call('POST', '/stt?lang=el', { headers: { 'content-type': up.contentType }, body: up.body })
    assert.equal(r.status, 200)
    assert.deepEqual({ text: r.json.text, language: r.json.language, engine: r.json.engine }, { text: 'local heard', language: 'el', engine: 'local' })
    const q = w.local.reqs.find((x) => x.path === '/v1/speech-to-text-fast')
    assert.ok(q)
    assert.deepEqual(q.body, up.body)
    assert.equal(q.headers['content-type'], up.contentType)
  } finally { await w.close() }
})

test('/stt: a failing mistral falls back to local', async () => {
  const w = await world()
  try {
    w.mistral.handler = (r, res) => reply(res, 500, { message: 'boom' })
    const up = multipartUpload(wavBuffer(), 'clip.wav')
    const r = await w.v.call('POST', '/stt?provider=mistral&lang=en', { headers: { 'content-type': up.contentType }, body: up.body })
    assert.equal(r.status, 200)
    assert.equal(r.json.engine, 'local')
    assert.equal(r.json.fellBackFrom, 'mistral')
    assert.equal(r.json.text, 'local heard')
  } finally { await w.close() }
})

test('/stt: empty body 400, and the note-keeper style call (?lang=en only) works', async () => {
  const w = await world()
  try {
    const e = await w.v.call('POST', '/stt?lang=en', { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: Buffer.alloc(0) })
    assert.equal(e.status, 400)
    const up = multipartUpload(wavBuffer(), 'note.wav')
    const r = await w.v.call('POST', '/stt?lang=en', { headers: { 'content-type': up.contentType }, body: up.body })
    assert.equal(r.status, 200)
    assert.equal(r.json.engine, 'mimo')
    assert.equal(r.json.text, 'mimo heard')
  } finally { await w.close() }
})

test('/polish uses Mistral when it answers', async () => {
  const w = await world()
  try {
    const r = await w.v.call('POST', '/polish', { body: { text: 'um polish this uh' } })
    assert.equal(r.status, 200)
    assert.equal(r.json.polished, true)
    assert.equal(r.json.engine, 'mistral')
    assert.equal(r.json.text, 'Polished by Mistral.')
  } finally { await w.close() }
})

test('/polish with everything down returns the raw text, HTTP 200', async () => {
  const w = await world({ keys: {} })
  try {
    const r = await w.v.call('POST', '/polish', { body: { text: 'raw words here' } })
    assert.equal(r.status, 200)
    assert.equal(r.json.polished, false)
    assert.equal(r.json.text, 'raw words here')
    assert.ok(r.json.reason)
  } finally { await w.close() }
})

test('unknown route is 404 no such voice route', async () => {
  const w = await world()
  try {
    const r = await w.v.call('POST', '/nope', { body: {} })
    assert.equal(r.status, 404)
    assert.equal(r.json.error, 'no such voice route')
    assert.equal(r.json.code, 'VOICE_ROUTE_NOT_FOUND')
  } finally { await w.close() }
})

test('/settings is refused for a foreign Host and never leaks a credential', async () => {
  const w = await world()
  try {
    const evil = await w.v.call('GET', '/settings', { headers: { host: 'evil.example' } })
    assert.equal(evil.status, 403)
    const evilSession = await w.v.call('GET', '/session', { headers: { host: 'evil.example' } })
    assert.equal(evilSession.status, 403)
    const ok = await w.v.call('GET', '/settings')
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.equal(ok.json.secretMarker, '__set__')
    for (const val of Object.values(KEYS)) assert.ok(!ok.text.includes(val), 'leaked an env value')
    // env pointers are shown as pointers
    const mistral = ok.json.instances.find((i) => i.id === 'mistral')
    assert.equal(mistral.credential.kind, 'pointer')
    assert.equal(mistral.credential.shown, 'env:MISTRAL_API_KEY')
    assert.equal(mistral.credential.resolved, true)
  } finally { await w.close() }
})

test('PATCH /settings: gate, vault, redaction, keep-with-marker, pointers, unsafe base URL', async () => {
  const w = await world()
  const LITERAL = 'sk-literal-test-value'
  try {
    const host = '127.0.0.1:' + w.v.port
    const tok = (await w.v.call('GET', '/session')).json.token
    assert.ok(tok)
    const hdr = (token) => {
      const h = {
        'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://' + host,
        cookie: harnessCookieName(host) + '=session-value',
      }
      if (token) h['x-dsh-voice-token'] = token
      return h
    }
    const patch = (body, token) => w.v.call('PATCH', '/settings', { headers: hdr(token), body })

    // no token
    assert.equal((await patch({ providers: [] }, null)).status, 403)
    // token but no harness cookie
    const noCookie = hdr(tok)
    delete noCookie.cookie
    assert.equal((await w.v.call('PATCH', '/settings', { headers: noCookie, body: { providers: [] } })).status, 403)
    // unsafe base URL
    const unsafe = await patch({ providers: [{ id: 'metadata', type: 'mistral', baseUrl: 'http://169.254.169.254', credential: 'env:MISTRAL_API_KEY' }] }, tok)
    assert.equal(unsafe.status, 400)

    // add a provider with a literal key
    const added = await patch({ providers: [{ id: 'mistral-eu', type: 'mistral', baseUrl: 'https://api.eu.mistral.ai', credential: LITERAL }] }, tok)
    assert.equal(added.status, 200)
    assert.ok(!added.text.includes(LITERAL))
    const vaultFile = path.join(w.v.dataDir, 'vault.json')
    assert.equal(JSON.parse(fs.readFileSync(vaultFile, 'utf8'))['mistral-eu'], LITERAL)
    assert.equal(fs.statSync(vaultFile).mode & 0o777, 0o600)
    const settingsFile = path.join(w.v.dataDir, 'settings.json')
    assert.ok(!fs.readFileSync(settingsFile, 'utf8').includes(LITERAL))

    const got = await w.v.call('GET', '/settings')
    assert.equal(got.status, 200)
    assert.ok(!got.text.includes(LITERAL))
    const p = got.json.settings.providers.find((x) => x.id === 'mistral-eu')
    assert.equal(p.credential, '__set__')
    const instance = got.json.instances.find((x) => x.id === 'mistral-eu')
    assert.equal(instance.baseUrl, 'https://api.eu.mistral.ai')
    assert.equal(instance.credential.resolved, true)
    assert.equal(instance.available.tts, true)

    // the marker keeps the stored secret
    const kept = await patch({ providers: [{ id: 'mistral-eu', type: 'mistral', baseUrl: 'https://api.eu.mistral.ai', credential: '__set__', enabled: true }] }, tok)
    assert.equal(kept.status, 200)
    assert.equal(JSON.parse(fs.readFileSync(vaultFile, 'utf8'))['mistral-eu'], LITERAL)
    const again = (await w.v.call('GET', '/settings')).json
    assert.equal(again.settings.providers.find((x) => x.id === 'mistral-eu').credential, '__set__')
    assert.equal(again.instances.find((x) => x.id === 'mistral-eu').credential.resolved, true)

    // pointers are visible
    const ptr = await patch({ providers: [{ id: 'mistral-eu', type: 'mistral', baseUrl: 'https://api.eu.mistral.ai', credential: 'env:MISTRAL_API_KEY' }] }, tok)
    assert.equal(ptr.status, 200)
    const shown = (await w.v.call('GET', '/settings')).json
    assert.equal(shown.settings.providers.find((x) => x.id === 'mistral-eu').credential, 'env:MISTRAL_API_KEY')
    assert.equal(shown.instances.find((x) => x.id === 'mistral-eu').credential.shown, 'env:MISTRAL_API_KEY')
  } finally { await w.close() }
})
