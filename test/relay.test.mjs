import test from 'node:test'
import assert from 'node:assert/strict'
import { mockServer, reply, closedPort, voiceServer, wavBuffer } from './helpers.mjs'

const MODEL_RE = /^mimo-v[\d.]+-(asr|tts)(-[a-z]+)?$/
const AUDIO = Buffer.from('RELAYAUDIO-0123456789')

/** Relays that answer 404 "path not relayed" for everything except the one allowed POST. */
async function relays(mode) {
  const notRelayed = (res) => reply(res, 404, { error: 'path not relayed' })
  const off = (res) => reply(res, 503, { error: 'relay disabled' })
  const kokoro = await mockServer((r, res) => {
    if (!(r.method === 'POST' && r.url === '/api/tts')) return notRelayed(res)
    if (mode === 'off') return off(res)
    return reply(res, 200, wavBuffer(), { 'content-type': 'audio/wav' })
  })
  const mimo = await mockServer((r, res) => {
    if (!(r.method === 'POST' && r.url === '/v1/chat/completions')) return notRelayed(res)
    const model = (r.json() || {}).model
    if (!MODEL_RE.test(String(model))) return notRelayed(res)
    if (mode === 'off') return off(res)
    return reply(res, 200, { choices: [{ message: { audio: { data: AUDIO.toString('base64') }, content: 'text' } }] })
  })
  return { kokoro, mimo }
}

async function relayEnv(kokoro, mimo) {
  return {
    MIMO_TOKEN_PLAN_API_KEY: 'fake-mimo-key',
    MIMO_TOKEN_PLAN_BASE_URL: 'http://127.0.0.1:' + mimo.port + '/v1',
    GREY_TTS_URL: 'http://127.0.0.1:' + kokoro.port,
    GREY_TTS_API_KEY: 'fake-grey-key',
    DSH_VOICE_TTS_PORT: String(await closedPort()),
    DSH_VOICE_LFM3_PORT: String(await closedPort()),
    DSH_VOICE_OLLAMA_PORT: String(await closedPort()),
  }
}

test('Relayed install contract: only POST /api/tts and POST /v1/chat/completions ever reach the relays', async () => {
  const { kokoro, mimo } = await relays('on')
  const v = await voiceServer(await relayEnv(kokoro, mimo))
  try {
    const cfg = await v.call('GET', '/config')
    assert.equal(cfg.status, 200)
    const e = cfg.json.engines
    assert.equal(e.mimo.available, true)
    assert.equal(e.grey.available, true)
    assert.equal(e.mistral.available, false)
    assert.equal(e.local.available, false)
    assert.equal(e.lfm3.available, false)
    assert.equal(e.elevenlabs.available, false)

    const g = await v.call('POST', '/tts', { body: { text: 'Hello from grey', provider: 'grey' } })
    assert.equal(g.status, 200)
    assert.equal(g.headers['x-voice-engine'], 'grey')
    assert.ok(g.body.length > 44)

    const a = await v.call('POST', '/tts', { body: { text: 'Hello from auto', provider: 'auto', lang: 'en' } })
    assert.equal(a.status, 200)
    assert.equal(a.headers['x-voice-engine'], 'mimo')
    assert.deepEqual(a.body, AUDIO)

    // dictation through MiMo as well: the ASR call is still a model-gated chat completion
    const up = await v.call('GET', '/config')
    assert.equal(up.status, 200)

    for (const r of kokoro.reqs.concat(mimo.reqs)) {
      assert.equal(r.method, 'POST', 'unexpected ' + r.method + ' ' + r.url)
      assert.ok(r.url === '/api/tts' || r.url === '/v1/chat/completions', 'unexpected path ' + r.url)
      assert.equal(r.query, '')
    }
    assert.equal(kokoro.reqs.length, 1)
    assert.equal(mimo.reqs.length, 1)
    assert.equal(kokoro.reqs[0].url, '/api/tts')
    assert.equal(mimo.reqs[0].url, '/v1/chat/completions')
    assert.match(mimo.reqs[0].json().model, MODEL_RE)
  } finally { await v.close(); await kokoro.close(); await mimo.close() }
})

test('Relayed install: /config alone sends nothing to the relays', async () => {
  const { kokoro, mimo } = await relays('on')
  const v = await voiceServer(await relayEnv(kokoro, mimo))
  try {
    for (let k = 0; k < 2; k += 1) assert.equal((await v.call('GET', '/config')).status, 200)
    assert.equal(kokoro.reqs.length, 0)
    assert.equal(mimo.reqs.length, 0)
  } finally { await v.close(); await kokoro.close(); await mimo.close() }
})

test('Relayed install: STT through MiMo is a model-gated chat completion', async () => {
  const kokoro = await mockServer((r, res) => reply(res, 404, { error: 'path not relayed' }))
  const mimo = await mockServer((r, res) => {
    if (!(r.method === 'POST' && r.url === '/v1/chat/completions' && MODEL_RE.test(String((r.json() || {}).model)))) return reply(res, 404, { error: 'path not relayed' })
    return reply(res, 200, { choices: [{ message: { content: 'relayed words' } }] })
  })
  const v = await voiceServer(await relayEnv(kokoro, mimo))
  try {
    const wav = wavBuffer()
    const b = '----bb'
    const body = Buffer.concat([Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="file"; filename="c.wav"\r\nContent-Type: audio/wav\r\n\r\n'), wav, Buffer.from('\r\n--' + b + '--\r\n')])
    const r = await v.call('POST', '/stt?lang=en', { headers: { 'content-type': 'multipart/form-data; boundary=' + b }, body })
    assert.equal(r.status, 200)
    assert.deepEqual({ text: r.json.text, engine: r.json.engine }, { text: 'relayed words', engine: 'mimo' })
    assert.equal(mimo.reqs.length, 1)
    assert.equal(mimo.reqs[0].json().model, 'mimo-v2.5-asr')
    assert.equal(kokoro.reqs.length, 0)
  } finally { await v.close(); await kokoro.close(); await mimo.close() }
})

test('Relay kill switch (503) gives a typed 502 vendor error, no crash', async () => {
  const { kokoro, mimo } = await relays('off')
  const v = await voiceServer(await relayEnv(kokoro, mimo))
  try {
    const g = await v.call('POST', '/tts', { body: { text: 'hello', provider: 'grey' } })
    assert.equal(g.status, 502)
    assert.equal(g.headers['x-voice-error-code'], 'vendor')
    assert.equal(g.json.engine, 'grey')
    const m = await v.call('POST', '/tts', { body: { text: 'hello', provider: 'auto', lang: 'en' } })
    assert.equal(m.status, 502)
    assert.equal(m.headers['x-voice-error-code'], 'vendor')
    assert.equal(m.json.engine, 'mimo')
    // the server is still alive
    assert.equal((await v.call('GET', '/config')).status, 200)
  } finally { await v.close(); await kokoro.close(); await mimo.close() }
})

test('An install with only Mistral + MiMo keys in env (Mistral + MiMo keys, empty home) yields mistral and mimo available', async () => {
  const env = {
    MISTRAL_API_KEY: 'fake-mistral-key',
    MIMO_TOKEN_PLAN_API_KEY: 'fake-mimo-key',
    DSH_VOICE_TTS_PORT: String(await closedPort()),
    DSH_VOICE_LFM3_PORT: String(await closedPort()),
    DSH_VOICE_OLLAMA_PORT: String(await closedPort()),
  }
  const v = await voiceServer(env)
  try {
    const cfg = await v.call('GET', '/config')
    assert.equal(cfg.status, 200)
    const e = cfg.json.engines
    assert.equal(e.mistral.available, true)
    assert.equal(e.mimo.available, true)
    assert.equal(e.grey.available, false)
    assert.equal(e.local.available, false)
    assert.equal(e.lfm3.available, false)
    assert.equal(e.elevenlabs.available, false)
    assert.equal(cfg.json.defaults.tts, 'mimo')
  } finally { await v.close() }
})
