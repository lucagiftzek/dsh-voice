/**
 * Provider type `cartesia`: Sonic 3.6 TTS (bytes endpoint, plus word timestamps
 * over the /tts/websocket socket) and Ink Whisper batch STT.
 *
 * Verified on 2026-10-31 against docs.cartesia.ai (llms.txt, the markdown pages
 * of the bytes, websocket, voices and batch STT references, the Sonic 3.6 model
 * page and the regional endpoints page).
 */
import crypto from 'node:crypto'
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, multipart, lang2 } from '../http.js'
import { wsExchange } from '../ws.js'
import { tokensToWords } from '../alignment.js'

export const API_VERSION = '2026-08-14'
const DEFAULT_BASE = 'https://api.cartesia.ai'
const DEFAULT_VOICE = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4'
const SAMPLE_RATE = 24000
const VOICE_TTL_MS = 10 * 60 * 1000

/** Sonic 3.6 languages (docs: 44 base codes). */
export const TTS_LANGS = [
  'en', 'de', 'es', 'fr', 'ja', 'pt', 'zh', 'hi', 'ko', 'it', 'nl', 'pl', 'ru', 'sv', 'tr', 'tl', 'bg', 'ro', 'ar', 'cs',
  'el', 'fi', 'hr', 'ms', 'sk', 'da', 'ta', 'uk', 'hu', 'no', 'vi', 'bn', 'th', 'he', 'ka', 'id', 'te', 'gu', 'kn', 'ml',
  'mr', 'pa', 'or', 'ur',
]

/** Ink Whisper batch STT: two-letter codes of the documented `language` enum (yue and haw have three letters and are left out). */
export const STT_LANGS = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi', 'he', 'uk',
  'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk', 'te', 'fa', 'lv', 'bn',
  'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw', 'gl', 'mr', 'pa', 'si', 'km', 'sn',
  'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo', 'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my',
  'bo', 'tl', 'mg', 'as', 'tt', 'ln', 'ha', 'ba', 'jw', 'su',
]

const defaults = (inst) => ({
  tts: (inst.models && inst.models.tts) || 'sonic-3.6',
  stt: (inst.models && inst.models.stt) || 'ink-whisper',
  voice: inst.defaultVoice || DEFAULT_VOICE,
})

const baseOf = (inst) => inst.baseUrl || DEFAULT_BASE

const hdr = (inst, extra) => Object.assign({ 'X-API-Key': inst.secret(), 'Cartesia-Version': API_VERSION }, extra || {})

export const wantsWordTimestamps = (inst) => {
  const v = inst.options && inst.options.wordTimestamps
  return !(v === false || v === 'false' || v === 0 || v === '0')
}

/** Cartesia error bodies: { title, message, error_code, status_code }. */
function detail(bodyText) {
  const j = parseJson(bodyText)
  if (j && typeof j === 'object') {
    return { code: String(j.error_code || ''), message: String(j.message || j.title || j.error || '') }
  }
  return { code: '', message: scrub(bodyText, 200) }
}

function mapError(what, status, bodyText, voice) {
  const d = detail(bodyText)
  const msg = scrub(d.message, 200)
  if (status === 401 || status === 403) return voiceErr('Cartesia rejected the API key (' + status + ')', 'bad_key', 502)
  if (status === 429 || status === 402) return voiceErr('Cartesia ' + what + ': quota or rate limit reached' + (msg ? ' (' + msg + ')' : ''), 'quota_exceeded', 429)
  if ((status === 400 || status === 404 || status === 422) && /voice/i.test(d.code + ' ' + d.message)) {
    return voiceErr('Cartesia does not serve the voice "' + String(voice || '').slice(0, 80) + '" (' + msg + ')', 'bad_voice', 400)
  }
  if ((status === 400 || status === 422) && /language|locale/i.test(d.code + ' ' + d.message)) {
    return voiceErr('Cartesia ' + what + ': unsupported language (' + msg + ')', 'unsupported_lang', 400)
  }
  return voiceErr('cartesia ' + what + ' ' + status + ': ' + msg, 'vendor', 502)
}

/** 16 bit mono WAV around raw PCM. */
export function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1')
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

function genConfig(speed) {
  const s = Number(speed)
  if (!Number.isFinite(s) || s === 1 || s <= 0) return null
  return { speed: Math.min(1.5, Math.max(0.6, s)) }
}

async function ttsBytes(args, inst, signal) {
  const { text, vid, modelId, lang, speed } = args
  const payload = {
    model_id: modelId, transcript: text, voice: { id: vid },
    output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
  }
  if (lang) payload.language = lang
  const g = genConfig(speed)
  if (g) payload.generation_config = g
  const up = await request(joinUrl(baseOf(inst), '/tts/bytes'), {
    method: 'POST', signal, timeout: 120000,
    headers: hdr(inst, { 'content-type': 'application/json', accept: 'audio/wav' }),
    body: jsonBody(payload),
  })
  if (up.status !== 200) throw mapError('tts', up.status, up.body.toString('utf8'), vid)
  const durationS = up.body.length > 44 ? (up.body.length - 44) / (SAMPLE_RATE * 2) : null
  return { audio: up.body, mime: 'audio/wav', voice: vid, model: modelId, billedChars: text.length, alignment: null, durationS }
}

function wsUrl(inst) {
  const b = String(baseOf(inst)).replace(/\/+$/, '').replace(/^http/i, 'ws')
  return b + '/tts/websocket?cartesia_version=' + encodeURIComponent(API_VERSION)
}

/** One generation on /tts/websocket with add_timestamps: returns { pcm, tokens }. */
async function ttsSocket(args, inst, signal) {
  const { text, vid, modelId, lang, speed } = args
  const msg = {
    model_id: modelId, transcript: text, voice: { id: vid }, context_id: crypto.randomUUID(),
    output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
    add_timestamps: true, use_normalized_timestamps: false, continue: false,
  }
  if (lang) msg.language = lang
  const g = genConfig(speed)
  if (g) msg.generation_config = g
  const chunks = []
  const tokens = []
  const out = await wsExchange(wsUrl(inst), { headers: hdr(inst), signal, timeout: 15000, exchangeTimeout: 120000 },
    (ws) => ws.sendText(JSON.stringify(msg)),
    (data, isBinary) => {
      if (isBinary) return undefined
      const j = parseJson(data)
      if (!j) return undefined
      if (j.type === 'chunk' && j.data) chunks.push(Buffer.from(j.data, 'base64'))
      else if (j.type === 'timestamps' && j.word_timestamps) {
        const w = j.word_timestamps
        const words = Array.isArray(w.words) ? w.words : []
        for (let i = 0; i < words.length; i += 1) tokens.push({ text: String(words[i]), t0: Number((w.start || [])[i]) || 0, t1: Number((w.end || [])[i]) || 0 })
      } else if (j.type === 'error') {
        throw mapError('tts websocket', Number(j.status_code) || 502, JSON.stringify(j), vid)
      } else if (j.type === 'done') return { pcm: Buffer.concat(chunks), tokens }
      return undefined
    })
  if (!out.pcm.length) throw voiceErr('cartesia tts websocket: no audio', 'vendor', 502)
  return out
}

export default {
  type: 'cartesia',
  label: 'Cartesia',
  hq: 'US',
  euNote: 'US company. api.cartesia.ai routes each request to the closest endpoint; dedicated EU deployments (and zero data retention) are Enterprise only, by contract, and no public EU hostname is documented.',
  group: 'other',
  residency: 'non-eu',
  desc: 'Sonic 3.6 TTS in 44 languages incl. Greek and Italian, word timestamps over WebSocket, plus Ink Whisper batch STT.',
  docs: 'https://docs.cartesia.ai/api-reference/tts/bytes',
  status: 'partial',
  verification: 'Fetched 2026-10-31 from docs.cartesia.ai: llms.txt, the markdown of the bytes, websocket, voices list and batch STT references, the Sonic 3.6 page (44 languages incl. el, it, en; model ids sonic-3.6, sonic-3.5, sonic-3), the TTS endpoint comparison, authentication and regional endpoints pages. Confirmed: base https://api.cartesia.ai, headers X-API-Key (Authorization Bearer also accepted) and Cartesia-Version 2026-08-14, POST /tts/bytes, GET /voices (data, has_more, next_page), POST /stt multipart with model ink-whisper, wss /tts/websocket?cartesia_version=... with add_timestamps returning type "timestamps" messages carrying word_timestamps {words, start, end} and base64 "chunk" messages, ended by a "done" message. Re-checked 2026-10-31 (pre-merge review): the websocket reference language enum now lists the same 44 codes as the model page, el and it included. Residency: no public EU hostname (dedicated regional deployments are Enterprise only). Unverified live: word timestamps for Greek; the adapter falls back to /tts/bytes (no alignment) if the socket fails or returns no words. Not exercised live. Voice ids are sent as {id}.',
  presets: [
    { id: 'cartesia', label: 'Cartesia', baseUrl: DEFAULT_BASE, models: { tts: 'sonic-3.6', stt: 'ink-whisper' } },
  ],
  optionFields: [
    { key: 'wordTimestamps', label: 'Word timestamps over WebSocket', type: 'bool', default: true, help: 'Uses /tts/websocket with add_timestamps for word timings; falls back to the plain bytes endpoint (no timings) if the socket fails.' },
  ],
  configFields: ['baseUrl', 'credential', 'models', 'defaultVoice', 'options'],
  defaultBaseUrl: DEFAULT_BASE,

  configured(inst) { return Boolean(inst.secret()) },

  capabilities(inst) {
    const ws = inst ? wantsWordTimestamps(inst) : true
    return {
      tts: true, stt: true, ttsLangs: TTS_LANGS.slice(), sttLangs: STT_LANGS.slice(), detectsLanguage: false,
      streaming: false, alignment: ws ? 'word' : 'none', nativeSpeed: [0.6, 1.5], ssml: false,
      maxChars: 5000, formats: ['wav'], quota: false,
    }
  },

  async health(inst, signal) {
    if (!this.configured(inst)) return { ok: false, status: 'down', detail: 'no API key' }
    try {
      const up = await request(joinUrl(baseOf(inst), '/voices?limit=1'), { method: 'GET', signal, timeout: 8000, headers: hdr(inst, { accept: 'application/json' }) })
      if (up.status === 200) return { ok: true, status: 'up', detail: 'voices endpoint reachable' }
      if (up.status === 401 || up.status === 403) return { ok: false, status: 'down', detail: 'API key rejected (' + up.status + ')' }
      return { ok: false, status: 'down', detail: 'voices answered ' + up.status }
    } catch (e) {
      return { ok: false, status: 'down', detail: scrub(String((e && e.message) || e), 120) }
    }
  },

  async listVoices(inst, opts, signal) {
    const st = inst.state
    const now = Date.now()
    let list = st.voices && now - st.voicesAt < VOICE_TTL_MS ? st.voices : null
    if (!list) {
      list = []
      let after = ''
      for (let page = 0; page < 5; page += 1) {
        const up = await request(joinUrl(baseOf(inst), '/voices?limit=100' + (after ? '&starting_after=' + encodeURIComponent(after) : '')), {
          method: 'GET', signal, timeout: 10000, headers: hdr(inst, { accept: 'application/json' }),
        })
        if (up.status !== 200) throw mapError('voices', up.status, up.body.toString('utf8'))
        const j = parseJson(up.body) || {}
        for (const v of (Array.isArray(j.data) ? j.data : [])) {
          if (!v || !v.id) continue
          const accents = Array.isArray(v.accents) ? v.accents : []
          const langs = []
          const add = (c) => { if (!c) return; const l = lang2(c); if (!langs.includes(l)) langs.push(l) }
          add(v.language)
          for (const a of accents) if (a && a.is_native) add(a.locale)
          const nat = accents.find((a) => a && a.is_native)
          list.push({
            id: String(v.id), name: String(v.name || v.id), langs,
            gender: v.gender === 'masculine' ? 'male' : v.gender === 'feminine' ? 'female' : String(v.gender || ''),
            accent: nat ? String(nat.accent || '') : '', tags: [v.tagline].filter(Boolean),
          })
        }
        if (!j.has_more || !j.next_page) break
        after = String(j.next_page)
      }
      st.voices = list
      st.voicesAt = now
    }
    const want = opts && opts.lang ? lang2(opts.lang) : ''
    if (!want) return list.slice()
    return list.filter((v) => v.langs.includes(want)).concat(list.filter((v) => !v.langs.includes(want)))
  },

  async tts({ text, voice, lang, speed, model, wantAlignment }, inst, signal) {
    const d = defaults(inst)
    const vid = String(voice || '').trim() || d.voice
    const modelId = String(model || '').trim() || d.tts
    const l = lang ? lang2(lang) : ''
    if (l && !TTS_LANGS.includes(l)) throw voiceErr('Cartesia Sonic does not speak "' + l + '"', 'unsupported_lang', 400)
    const args = { text, vid, modelId, lang: l, speed }
    let note = ''
    if (wantAlignment && wantsWordTimestamps(inst)) {
      try {
        const out = await ttsSocket(args, inst, signal)
        const items = tokensToWords(text, out.tokens)
        return {
          audio: pcmToWav(out.pcm, SAMPLE_RATE), mime: 'audio/wav', voice: vid, model: modelId, billedChars: text.length,
          alignment: items ? { unit: 'word', items } : null, durationS: out.pcm.length / (SAMPLE_RATE * 2),
          note: items ? '' : 'Cartesia returned no word timestamps',
        }
      } catch (e) {
        if (e && (e.code === 'bad_voice' || e.code === 'unsupported_lang' || e.code === 'quota_exceeded')) throw e
        note = 'word timestamps unavailable (socket failed); used the plain endpoint'
      }
    }
    const r = await ttsBytes(args, inst, signal)
    if (note) r.note = note
    return r
  },

  async stt({ audio, name, mime, lang, model, wantWords }, inst, signal) {
    const d = defaults(inst)
    const fields = { model: String(model || '').trim() || d.stt }
    if (lang) {
      const l = lang2(lang)
      if (!STT_LANGS.includes(l)) throw voiceErr('Cartesia Ink does not transcribe "' + l + '"', 'unsupported_lang', 400)
      fields.language = l
    }
    if (wantWords !== false) fields['timestamp_granularities[]'] = 'word'
    const mp = multipart(fields, { field: 'file', name: name || 'dictation.webm', type: mime || 'audio/webm', data: audio })
    const up = await request(joinUrl(baseOf(inst), '/stt'), {
      method: 'POST', signal, timeout: 120000, headers: hdr(inst, { 'content-type': mp.contentType }), body: mp.body,
    })
    if (up.status !== 200) throw mapError('stt', up.status, up.body.toString('utf8'))
    const j = parseJson(up.body) || {}
    const words = Array.isArray(j.words) ? j.words.map((w) => ({ w: String(w.word || ''), t0: Number(w.start) || 0, t1: Number(w.end) || 0 })) : null
    return { text: String(j.text || '').trim(), language: j.language || fields.language || null, words, durationS: Number(j.duration) || undefined }
  },
}
