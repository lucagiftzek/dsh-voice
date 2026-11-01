/**
 * Provider type `openai-compatible`: any server with the OpenAI audio shape
 * (POST {base}/audio/speech, POST {base}/audio/transcriptions, GET {base}/audio/voices).
 *
 * Carries the legacy `groq` instance (whisper-large-v3, measured word-exact on
 * Greek 2026-09-08) plus presets for OpenAI, Groq, Kokoro-FastAPI, Speaches,
 * LocalAI, openedai-speech and OVHcloud AI Endpoints.
 *
 * The shared functions `openaiTts`, `openaiStt`, `openaiVoices` and `openaiCaps`
 * are reused by `openai.js`.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, multipart, audioType, lang2 } from '../http.js'
import { tokensToWords } from '../alignment.js'

const VOICE_TTL_MS = 600000
const VOICE_FALLBACK_TTL_MS = 60000
const MIME = { mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav' }
const FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav']

/** Kokoro voice-name prefixes: first letter language, second letter gender. */
const KOKORO_LANG = { a: 'en', b: 'en', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt', z: 'zh' }
const KOKORO_ACCENT = { a: 'US', b: 'GB' }

/** Whisper verbose_json returns the language as an English name ("english"). */
const LANG_NAMES = {
  english: 'en', greek: 'el', italian: 'it', french: 'fr', german: 'de', spanish: 'es', portuguese: 'pt', dutch: 'nl',
  russian: 'ru', chinese: 'zh', japanese: 'ja', korean: 'ko', arabic: 'ar', turkish: 'tr', polish: 'pl', hindi: 'hi',
  ukrainian: 'uk', swedish: 'sv', danish: 'da', norwegian: 'no', finnish: 'fi', czech: 'cs', romanian: 'ro', bulgarian: 'bg',
  hungarian: 'hu', hebrew: 'he', indonesian: 'id', catalan: 'ca', croatian: 'hr', serbian: 'sr', slovak: 'sk', slovenian: 'sl',
}

const csv = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)

export function normLang(l) {
  const s = String(l || '').trim().toLowerCase()
  if (!s) return null
  if (LANG_NAMES[s]) return LANG_NAMES[s]
  return /^[a-z]{2}([-_][a-z0-9]+)?$/.test(s) ? s.slice(0, 2) : null
}

const authHeaders = (inst, extra) => {
  const h = Object.assign({}, extra || {})
  const k = inst.secret ? inst.secret() : ''
  if (k) h.authorization = 'Bearer ' + k
  return h
}

/** Map an upstream failure to a typed error. kind: 'tts' | 'stt'. */
export function openaiError(label, kind, up) {
  const body = up.body.toString('utf8')
  const msg = label + ' ' + kind + ' ' + up.status + ': ' + scrub(body, 200)
  if (up.status === 401 || up.status === 403) return voiceErr(msg, 'bad_key', 502)
  if (up.status === 429) return voiceErr(msg, 'quota_exceeded', 429)
  if ((up.status === 400 || up.status === 404 || up.status === 422) && /voice/i.test(body) && kind === 'tts') return voiceErr(msg, 'bad_voice', 400)
  if ((up.status === 400 || up.status === 422) && /language/i.test(body)) return voiceErr(msg, 'unsupported_lang', 400)
  return voiceErr(msg, 'vendor', 502)
}

/** Capabilities shared by every OpenAI-shaped adapter. d: defaults { tts, stt, ttsLangs, sttLangs, maxChars }. */
export function openaiCaps(inst, d) {
  const o = inst.options || {}
  const def = d || {}
  const tts = o.tts === undefined ? def.tts === true : o.tts === true
  const stt = o.stt === undefined ? def.stt !== false : o.stt !== false
  const tl = csv(o.ttsLangs)
  const sl = csv(o.sttLangs)
  return {
    tts, stt,
    ttsLangs: tts ? (tl.length ? (tl.includes('*') ? '*' : tl) : (def.ttsLangs || '*')) : [],
    sttLangs: stt ? (sl.length ? (sl.includes('*') ? '*' : sl) : (def.sttLangs || '*')) : [],
    detectsLanguage: stt,
    streaming: false,
    alignment: tts && o.captions === true ? 'word' : 'none',
    nativeSpeed: tts ? [0.25, 4] : null,
    ssml: false,
    maxChars: def.maxChars || 4000,
    formats: tts ? FORMATS.slice() : [],
    quota: false,
  }
}

const fmtOf = (inst) => {
  const f = String((inst.options || {}).format || 'mp3').toLowerCase()
  return FORMATS.includes(f) ? f : 'mp3'
}

/** The server root without a trailing /v1 (Kokoro-FastAPI keeps /dev/* beside /v1/*). */
const rootOf = (base) => String(base || '').replace(/\/+$/, '').replace(/\/v1$/, '')

/**
 * Shared TTS. cfg: { label, defaultModel, defaultVoice, resolveVoice(voice, model, inst) -> { voice, note } }.
 * With options.captions and wantAlignment, Kokoro-FastAPI's POST /dev/captioned_speech
 * returns JSON { audio: base64, timestamps: [{ word, start_time, end_time }] }.
 */
export async function openaiTts({ text, voice, speed, model, wantAlignment }, inst, signal, cfg) {
  const c = cfg || {}
  const label = c.label || inst.id || 'openai-compatible'
  const modelId = String(model || '').trim() || (inst.models && inst.models.tts) || c.defaultModel || 'tts-1'
  let vid = String(voice || '').trim() || inst.defaultVoice || c.defaultVoice || 'alloy'
  let note = ''
  if (c.resolveVoice) {
    const r = c.resolveVoice(vid, modelId, inst)
    vid = r.voice
    note = r.note || ''
  }
  const fmt = fmtOf(inst)
  const payload = { model: modelId, input: text, voice: vid, response_format: fmt }
  const sp = Number(speed)
  if (sp && sp !== 1 && sp >= 0.25 && sp <= 4) payload.speed = sp
  const wantCaptions = wantAlignment === true && (inst.options || {}).captions === true

  if (wantCaptions) {
    const up = await request(new URL(rootOf(inst.baseUrl) + '/dev/captioned_speech'), {
      method: 'POST', signal, timeout: 120000,
      headers: authHeaders(inst, { 'content-type': 'application/json', accept: 'application/json' }),
      body: jsonBody(Object.assign({ stream: false }, payload)),
    })
    if (up.status === 200) {
      const j = parseJson(up.body) || {}
      if (j.audio) {
        const tokens = Array.isArray(j.timestamps)
          ? j.timestamps.map((t) => ({ text: String((t && t.word) || ''), t0: Number(t && t.start_time) || 0, t1: Number(t && t.end_time) || 0 }))
          : []
        const items = tokensToWords(text, tokens)
        const last = tokens.length ? tokens[tokens.length - 1].t1 : null
        return {
          audio: Buffer.from(j.audio, 'base64'), mime: MIME[fmt], voice: vid, model: modelId, billedChars: text.length,
          alignment: items ? { unit: 'word', items } : null, durationS: last, note,
        }
      }
    } else if (up.status === 401 || up.status === 403 || up.status === 429) {
      throw openaiError(label, 'tts', up)
    }
    // 404 or any other answer: this server has no captioned route, fall through to plain speech
    note = (note ? note + '; ' : '') + 'no word timings from this server'
  }

  const up = await request(joinUrl(inst.baseUrl, '/audio/speech'), {
    method: 'POST', signal, timeout: 120000,
    headers: authHeaders(inst, { 'content-type': 'application/json' }),
    body: jsonBody(payload),
  })
  if (up.status !== 200) throw openaiError(label, 'tts', up)
  return {
    audio: up.body, mime: audioType(up.body, MIME[fmt]), voice: vid, model: modelId, billedChars: text.length,
    alignment: null, durationS: null, note,
  }
}

const wordsCapable = (model, inst) => /whisper/i.test(model) || (inst.options || {}).words === true

/**
 * Shared STT. cfg: { label, defaultModel, wordsModel, langField }.
 * wantWords on a whisper-family model sends response_format=verbose_json with
 * timestamp_granularities[]=word. langField 'languages' is for gpt-transcribe
 * (it replaces `language`, the two are never sent together).
 */
export async function openaiStt({ audio, name, mime, lang, model, wantWords }, inst, signal, cfg) {
  const c = cfg || {}
  const label = c.label || inst.id || 'openai-compatible'
  const configured = String(model || '').trim() || (inst.models && inst.models.stt) || ''
  const modelId = configured || (wantWords && c.wordsModel) || c.defaultModel || 'whisper-1'
  const fields = { model: modelId }
  const hint = lang ? lang2(lang) : ''
  if (hint) {
    if (c.langField === 'languages' && /^gpt-(live-)?transcribe$/.test(modelId)) fields['languages[]'] = hint
    else fields.language = hint
  }
  const verbose = wantWords === true && wordsCapable(modelId, inst)
  if (verbose) {
    fields.response_format = 'verbose_json'
    fields['timestamp_granularities[]'] = 'word'
  }
  const mp = multipart(fields, { field: 'file', name: name || 'dictation.webm', type: mime || 'audio/webm', data: audio })
  const up = await request(joinUrl(inst.baseUrl, '/audio/transcriptions'), {
    method: 'POST', signal, timeout: 120000,
    headers: authHeaders(inst, { 'content-type': mp.contentType }), body: mp.body,
  })
  if (up.status !== 200) throw openaiError(label, 'stt', up)
  const j = parseJson(up.body) || {}
  let language = normLang(j.language)
  if (!language && Array.isArray(j.languages) && j.languages[0]) language = normLang(j.languages[0].code || j.languages[0])
  let words = null
  if (verbose && Array.isArray(j.words)) {
    words = j.words.map((w) => ({ w: String((w && (w.word !== undefined ? w.word : w.text)) || '').trim(), t0: Number(w && w.start) || 0, t1: Number(w && w.end) || 0 })).filter((w) => w.w)
  }
  const out = { text: String(j.text || '').trim(), language: language || null, words }
  if (typeof j.duration === 'number') out.durationS = j.duration
  return out
}

/** One entry of a /audio/voices answer. Kokoro names carry language and gender in the first two letters. */
function voiceEntry(x, kokoroNames) {
  const id = typeof x === 'string' ? x : String((x && (x.id || x.voice_id || x.name)) || '')
  if (!id) return null
  const name = typeof x === 'object' && x.name ? String(x.name) : id
  let langs = []
  let gender = null
  let accent = null
  if (x && typeof x === 'object') {
    const l = x.language || x.lang || x.locale
    if (l) langs = [lang2(l)]
    if (Array.isArray(x.languages)) langs = x.languages.map(lang2)
    if (x.gender) gender = String(x.gender).toLowerCase()
  }
  if (kokoroNames && /^[a-z][fm]_/.test(id)) {
    langs = KOKORO_LANG[id[0]] ? [KOKORO_LANG[id[0]]] : langs
    gender = id[1] === 'f' ? 'female' : 'male'
    accent = KOKORO_ACCENT[id[0]] || null
  }
  return { id, name, langs: Array.from(new Set(langs)), gender, accent, tags: [] }
}

/** Voice list: GET {base}/audio/voices, else options.voices (comma string), else the default voice. Cached 10 min. */
export async function openaiVoices(inst, opts, signal, cfg) {
  const c = cfg || {}
  const lang = opts && opts.lang
  const st = inst.state
  const now = Date.now()
  let hit = st.voices
  if (!hit || now - hit.at > hit.ttl) {
    let list = null
    if (c.fetchVoices !== false) {
      try {
        const up = await request(joinUrl(inst.baseUrl, c.voicesPath || '/audio/voices'), {
          method: 'GET', signal, timeout: 8000, headers: authHeaders(inst, { accept: 'application/json' }),
        })
        if (up.status === 200) {
          const j = parseJson(up.body)
          const arr = Array.isArray(j) ? j : (j && Array.isArray(j.voices) ? j.voices : (j && Array.isArray(j.data) ? j.data : null))
          if (arr) {
            const first = arr[0]
            const firstId = String(typeof first === 'string' ? first : (first && (first.id || first.name)) || '')
            const kokoro = /^[a-z][fm]_/.test(firstId)
            list = arr.map((x) => voiceEntry(x, kokoro)).filter(Boolean)
          }
        }
      } catch (e) { /* fall back below */ }
    }
    if (list && list.length) {
      hit = { at: now, ttl: VOICE_TTL_MS, list }
    } else {
      const names = String((inst.options || {}).voices || '').split(',').map((x) => x.trim()).filter(Boolean)
      if (!names.length && inst.defaultVoice) names.push(inst.defaultVoice)
      hit = { at: now, ttl: VOICE_FALLBACK_TTL_MS, list: names.map((n) => voiceEntry(n, false)).filter(Boolean) }
    }
    st.voices = hit
  }
  const want = lang ? lang2(lang) : ''
  return want ? hit.list.filter((v) => !v.langs.length || v.langs.includes(want)) : hit.list.slice()
}

/** Cheap authenticated GET {base}/models. */
export async function openaiHealth(inst, signal, ok) {
  if (!ok) return { ok: false, status: 'down', detail: 'no API key' }
  try {
    const up = await request(joinUrl(inst.baseUrl, '/models'), { method: 'GET', signal, timeout: 6000, headers: authHeaders(inst, { accept: 'application/json' }) })
    if (up.status === 200) return { ok: true, status: 'up', detail: '' }
    if (up.status === 401 || up.status === 403) return { ok: false, status: 'down', detail: 'the server rejected the API key (' + up.status + ')' }
    if (up.status === 404 || up.status === 405) return { ok: true, status: 'unknown', detail: 'no /models route on this server' }
    return { ok: false, status: 'down', detail: 'HTTP ' + up.status }
  } catch (e) {
    return { ok: false, status: 'down', detail: scrub(String((e && e.message) || e), 120) }
  }
}

export function isLoopback(url) {
  try {
    const h = new URL(url).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
  } catch (e) { return false }
}

const SELF = { keyless: true }

export default {
  type: 'openai-compatible',
  label: 'OpenAI-compatible',
  hq: 'varies',
  euNote: 'Depends on the endpoint: self-hosted servers keep audio on your machine, OpenAI EU and OVHcloud are EU-processed, Groq is US only.',
  group: 'other',
  // May point at loopback and LAN servers (Kokoro-FastAPI, Speaches, LocalAI): see security.checkProviderEntry.
  selfHostable: true,
  residency: 'varies',
  desc: 'Any server with the OpenAI audio shape: /v1/audio/speech and /v1/audio/transcriptions (Groq, Kokoro-FastAPI, Speaches, LocalAI, OVHcloud).',
  docs: 'https://platform.openai.com/docs/api-reference/audio',
  status: 'partial',
  verification: 'Checked 2026-10-31. Confirmed from the vendor docs: OpenAI audio request shapes and the EU data residency host eu.api.openai.com (developers.openai.com data-residency table); '
    + 'Kokoro-FastAPI README (default port 8880, /v1/audio/voices, response_format and speed, POST /dev/captioned_speech with base64 audio and timestamps [{word,start_time,end_time}], '
    + 'voice names whose first letter is the language, languages English US/GB, Spanish, French, Hindi, Italian, Japanese, Brazilian Portuguese, Mandarin; Greek is NOT supported); '
    + 'Speaches README and usage pages (OpenAI-compatible /v1/audio/speech and /v1/audio/transcriptions, Kokoro and Piper TTS, faster-whisper STT, default port 8000; its voice list route is marked TODO in its docs so the voice list falls back to options.voices); '
    + 'openedai-speech README (tts-1 via Piper, tts-1-hd via XTTS, port 8000, project marked obsolete by its author); LocalAI docs list GET /v1/audio/voices and /v1/audio/speech on port 8080; '
    + 'OVHcloud AI Endpoints catalogue lists whisper-large-v3 and whisper-large-v3-turbo as speech-to-text models behind the base URL https://oai.endpoints.kepler.ai.cloud.ovh.net/v1. '
    + 'Unverified: that OVHcloud serves /audio/transcriptions word timestamps, OVHcloud speech output (its nvr-tts models) over /audio/speech (preset has TTS off), the EU hosting location of OVHcloud inference (OVHcloud is an EU company, so the preset is marked eu), LocalAI and Speaches word timestamp support.',
  presets: [
    { id: 'groq', label: 'Groq (whisper)', baseUrl: 'https://api.groq.com/openai/v1', models: { stt: 'whisper-large-v3' }, options: { stt: true, tts: false }, group: 'other', residency: 'non-eu' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: { tts: 'tts-1', stt: 'whisper-1' }, options: { stt: true, tts: true }, group: 'other', residency: 'non-eu' },
    { id: 'openai-eu', label: 'OpenAI EU (data residency, needs approval)', baseUrl: 'https://eu.api.openai.com/v1', models: { tts: 'tts-1', stt: 'whisper-1' }, options: { stt: true, tts: true }, group: 'other', residency: 'eu-region' },
    { id: 'kokoro-fastapi', label: 'Kokoro-FastAPI (self-hosted)', baseUrl: 'http://127.0.0.1:8880/v1', models: { tts: 'kokoro' }, defaultVoice: 'af_heart', options: Object.assign({ stt: false, tts: true, captions: true, ttsLangs: 'en,es,fr,hi,it,ja,pt,zh' }, SELF), group: 'self', residency: 'self' },
    { id: 'speaches', label: 'Speaches / faster-whisper-server (self-hosted)', baseUrl: 'http://127.0.0.1:8000/v1', models: { tts: 'speaches-ai/Kokoro-82M-v1.0-ONNX', stt: 'Systran/faster-whisper-small' }, defaultVoice: 'af_heart', options: Object.assign({ stt: true, tts: true }, SELF), group: 'self', residency: 'self' },
    { id: 'localai', label: 'LocalAI (self-hosted)', baseUrl: 'http://127.0.0.1:8080/v1', models: {}, options: Object.assign({ stt: true, tts: true }, SELF), group: 'self', residency: 'self' },
    { id: 'openedai-speech', label: 'openedai-speech (self-hosted, TTS)', baseUrl: 'http://127.0.0.1:8000/v1', models: { tts: 'tts-1' }, defaultVoice: 'alloy', options: Object.assign({ stt: false, tts: true }, SELF), group: 'self', residency: 'self' },
    { id: 'ovh', label: 'OVHcloud AI Endpoints (whisper)', baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', models: { stt: 'whisper-large-v3-turbo' }, options: { stt: true, tts: false }, group: 'eu', residency: 'eu' },
  ],
  optionFields: [
    { key: 'tts', label: 'Text to speech', type: 'bool', help: 'Turn on when the server offers /audio/speech.', default: false },
    { key: 'stt', label: 'Speech to text', type: 'bool', help: 'On unless switched off. Needs /audio/transcriptions.', default: true },
    { key: 'keyless', label: 'No API key needed', type: 'bool', help: 'Self-hosted servers usually have no key.', default: false },
    { key: 'format', label: 'Audio format', type: 'select', choices: FORMATS, help: 'response_format sent with every speech request.', default: 'mp3' },
    { key: 'captions', label: 'Word timings (Kokoro-FastAPI)', type: 'bool', help: 'Use POST /dev/captioned_speech for word timestamps. Only Kokoro-FastAPI has this route.', default: false },
    { key: 'words', label: 'Word timestamps for STT', type: 'bool', help: 'Send verbose_json with word granularity. Always on for whisper model names.', default: false },
    { key: 'ttsLangs', label: 'TTS languages', type: 'text', help: 'Comma list of 2-letter codes this server can speak, for example en,it. Empty means all.' },
    { key: 'sttLangs', label: 'STT languages', type: 'text', help: 'Comma list of 2-letter codes. Empty means all.' },
    { key: 'voices', label: 'Voices (fallback list)', type: 'text', help: 'Comma list used when the server has no /audio/voices route.' },
  ],
  configFields: ['baseUrl', 'credential', 'models', 'defaultVoice', 'options'],
  defaultBaseUrl: 'https://api.openai.com/v1',

  residencyOf(inst) {
    const u = String(inst.baseUrl || '')
    if (isLoopback(u)) return 'self'
    if (/^https:\/\/eu\.api\.openai\.com(\/|$)/.test(u)) return 'eu-region'
    if (/\.ovh\.net(\/|$)/.test(u)) return 'eu'
    if (/^https:\/\/(api\.openai\.com|api\.groq\.com)(\/|$)/.test(u)) return 'non-eu'
    return 'varies'
  },

  configured(inst) {
    return Boolean(inst.secret()) || (inst.options || {}).keyless === true
  },

  capabilities(inst) {
    return openaiCaps(inst, { tts: false, stt: true, ttsLangs: '*', sttLangs: '*', maxChars: 4000 })
  },

  async health(inst, signal) { return openaiHealth(inst, signal, this.configured(inst)) },
  async listVoices(inst, opts, signal) { return openaiVoices(inst, opts, signal) },
  async tts(args, inst, signal) { return openaiTts(args, inst, signal, { label: inst.id }) },
  async stt(args, inst, signal) { return openaiStt(args, inst, signal, { label: inst.id }) },

  async legacyConfig(inst) {
    return {
      sttLanguages: ['*'], model: (inst.models && inst.models.stt) || 'whisper-large-v3',
      note: 'whisper-large-v3 via Groq. Measured 0.46s on an 8 s Greek clip, word-exact. Cents per hour.',
    }
  },

  chunkPlan() { return { first: 110, rest: 260 } },
}
