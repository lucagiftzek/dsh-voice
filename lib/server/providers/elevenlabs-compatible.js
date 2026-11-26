/**
 * Provider type `elevenlabs-compatible`: a self-hosted server with the
 * ElevenLabs request shape. Preset "Tzekos" is tzekos-tts, which also speaks a
 * native dialect (options.native = true, the 1.x `local` engine):
 *
 *   POST /api/tts {text, voice, format, engine}     maya / kokoro per request
 *   POST /v1/speech-to-text-fast?model=<size>       faster-whisper, the browser
 *                                                   multipart forwarded untouched
 *   GET  /health  engines_available, engines_inert, whisper_sizes
 *
 * Without options.native the generic ElevenLabs paths are used
 * (/v1/text-to-speech/{voice}, /v1/speech-to-text, /v1/voices).
 *
 * Maya1 speaks el/it/en and sounds best here, but it is a 3B model on a small
 * GPU: 8 to 24 s per read, hence the coarse 400/900 chunk plan.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, multipart } from '../http.js'
import { applyAnnotations } from '../../shared/annotations.js'
import { elevenTts, elevenStt, account, elevenVoices } from './elevenlabs.js'

const native = (inst) => Boolean(inst.options && inst.options.native)

/** Surface tzekos-tts's {"detail": "..."} in the error: the engine validation lives over there. */
function localErr(up, what) {
  let detail = ''
  const j = parseJson(up.body)
  if (j && j.detail) detail = String(j.detail)
  return voiceErr('local ' + what + ' ' + up.status + (detail ? ': ' + scrub(detail, 200) : ''), 'vendor', 502)
}

async function probeHealth(inst, signal) {
  try {
    const up = await request(joinUrl(inst.baseUrl, '/health'), { method: 'GET', timeout: 4000, signal })
    return up.status === 200 ? (parseJson(up.body) || {}) : null
  } catch (e) { return null }
}

export default {
  type: 'elevenlabs-compatible',
  label: 'Self-hosted (ElevenLabs-compatible)',
  hq: 'self-hosted',
  euNote: 'Self-hosted: data stays wherever the server runs',
  group: 'self',
  residency: 'self',
  desc: 'Any server speaking the ElevenLabs request shape (preset: Tzekos, a loopback tzekos-tts).',
  docs: 'https://elevenlabs.io/docs/api-reference/text-to-speech/convert',
  status: 'verified',
  verification: 'Verified against the reference tzekos-tts server source (native and ElevenLabs-shaped routes). Other servers with this shape are untested.',
  presets: [
    { id: 'tzekos', label: 'Tzekos', baseUrl: 'http://127.0.0.1:8771', options: { native: true, sttPath: '/v1/speech-to-text-fast' } },
    { id: 'elevenlabs-compatible', label: 'Generic ElevenLabs-compatible server', baseUrl: 'http://127.0.0.1:8000', options: {} },
  ],
  configFields: ['baseUrl', 'credential', 'models', 'defaultVoice', 'options'],
  defaultBaseUrl: 'http://127.0.0.1:8771',

  configured(inst) { return Boolean(inst.secret()) },

  capabilities(inst) {
    return {
      tts: true, stt: true, ttsLangs: '*', sttLangs: '*', detectsLanguage: true,
      streaming: false, alignment: native(inst) ? 'duration' : 'char', nativeSpeed: null,
      ssml: false, maxChars: 6000, formats: ['mp3', 'wav'], quota: !native(inst),
    }
  },

  async health(inst, signal) {
    if (!native(inst)) {
      const a = await account(inst)
      return { ok: !a.error, status: a.error ? 'down' : 'up', detail: a.error || '' }
    }
    const h = await probeHealth(inst, signal)
    inst.state.health = h
    inst.state.healthAt = Date.now()
    return { ok: Boolean(h), status: h ? 'up' : 'down', detail: h ? 'engines ' + ((h.engines_available || []).join(', ') || 'unknown') : 'no answer on /health' }
  },

  async listVoices(inst) {
    if (!native(inst)) return elevenVoices(await account(inst)).map((v) => ({ id: v.id, name: v.name }))
    try {
      const up = await request(joinUrl(inst.baseUrl, '/api/voices'), { method: 'GET', timeout: 4000, headers: { 'xi-api-key': inst.secret() } })
      const j = up.status === 200 ? parseJson(up.body) : null
      const list = Array.isArray(j) ? j : (j && (j.voices || j.items)) || []
      if (list.length) return list.map((v) => (typeof v === 'string' ? { id: v, name: v } : { id: String(v.id || v.voice_id || v.name), name: String(v.name || v.id || '') }))
    } catch (e) { /* fall through */ }
    return [{ id: 'founder', name: 'founder (default)' }]
  },

  /** Local models published by /health; null on an unpatched server (the client then hides the picker). */
  async models(inst, signal) {
    if (!native(inst)) return null
    const h = await probeHealth(inst, signal)
    inst.state.health = h
    inst.state.healthAt = Date.now()
    return h && h.engines_available ? { tts: h.engines_available, stt: h.whisper_sizes || [], inert: h.engines_inert || {} } : null
  },

  async tts(args, inst, signal) {
    if (!native(inst)) return elevenTts(args, inst, signal)
    const ann = applyAnnotations(String(args.text || ''), { type: 'elevenlabs-compatible', model: args.model, provider: inst.id })
    const body = { text: ann.text, voice: args.voice || inst.defaultVoice || 'founder', format: 'mp3' }
    if (args.model) body.engine = args.model
    const up = await request(joinUrl(inst.baseUrl, '/api/tts'), {
      method: 'POST', signal, timeout: 300000,
      headers: { 'content-type': 'application/json', 'xi-api-key': inst.secret() },
      body: jsonBody(body),
    })
    if (up.status !== 200) throw localErr(up, 'tts')
    return { audio: up.body, mime: up.headers['content-type'] || 'audio/mpeg', voice: null, model: args.model || null, billedChars: 0, alignment: null }
  },

  async stt(args, inst, signal) {
    if (!native(inst)) return elevenStt(args, inst, signal)
    // ?model= picks the whisper size; tzekos validates it and its 400 detail rides back.
    const safe = /^[a-z][a-z0-9.]{0,15}$/.test(String(args.model || '')) ? String(args.model) : ''
    const sttPath = (inst.options && inst.options.sttPath) || '/v1/speech-to-text-fast'
    let raw = args.raw
    let rawType = args.rawType
    if (!raw) {
      // A caller without the browser multipart (the provider test): wrap the audio.
      const mp = multipart({}, { field: 'file', name: args.name || 'clip.wav', type: args.mime || 'audio/wav', data: args.audio })
      raw = mp.body
      rawType = mp.contentType
    }
    const up = await request(joinUrl(inst.baseUrl, sttPath + (safe ? '?model=' + encodeURIComponent(safe) : '')), {
      method: 'POST', signal, timeout: 300000,
      headers: { 'content-type': rawType || 'application/octet-stream', 'xi-api-key': inst.secret() },
      body: raw,
    })
    if (up.status !== 200) throw localErr(up, 'stt')
    const parsed = parseJson(up.body) || {}
    return { text: parsed.text || '', language: parsed.language_code || null, words: null }
  },

  async legacyConfig(inst) {
    return {
      models: await this.models(inst),
      note: 'tzekos-tts on this box: maya/kokoro switch per request, whisper sizes for dictation; a cold model switch pays its load pause once.',
    }
  },

  chunkPlan(inst) { return native(inst) ? { first: 400, rest: 900 } : { first: 110, rest: 260 } },
}
