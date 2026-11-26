/**
 * Provider type `openrouter`: OpenRouter's audio endpoints (one key for the
 * speech and transcription models of many vendors).
 *
 *   GET  {base}/audio/speech/models   the speech catalogue: every model with its voices,
 *                                     output formats, speed range and whether it takes
 *                                     delivery instructions
 *   GET  {base}/models?output_modalities=speech
 *                                     the general catalogue (adds the :free variants and the
 *                                     few models the speech catalogue leaves out)
 *   POST {base}/audio/speech          OpenAI-compatible speech: { model, input, voice,
 *                                     response_format: mp3 | pcm, speed?, instructions? }
 *   POST {base}/audio/transcriptions  OpenAI-compatible transcription (multipart file + model)
 *
 * base URL: https://openrouter.ai/api/v1.
 *
 * Testing: a loopback instance (a local proxy under test) needs no key, and a catalogue failure on an
 * instance WITH a key is a warning (the model lists stay usable); a catalogue failure on a keyless
 * instance refuses it, so a keyless cloud instance never looks usable.
 *
 * A voice belongs to ONE model (alloy is an OpenAI voice and is refused elsewhere), so
 * voices are listed and validated per model. Voices and parameters are read from the
 * catalogue, never hard-coded here: a model added on OpenRouter appears in the reader
 * menus without a plugin change.
 *
 * Measured on the live service, 2026-11-25 (see `verification`): mp3 models answer
 * audio/mpeg; PCM-only models (HeyGen Voice, Gemini TTS) answer
 * `audio/pcm;rate=44100;channels=1`, which is wrapped into a WAV for the browser.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, audioType, lang2 } from '../http.js'
import { openaiStt } from './openai-compatible.js'
import { isLoopbackHostname } from '../security.js'
import { applyAnnotations, adaptationFor } from '../../shared/annotations.js'
import { pcmToWav } from './cartesia.js'

export const DEFAULT_TTS = 'mistralai/voxtral-mini-tts-3-0'
export const DEFAULT_STT = 'openai/whisper-large-v3-turbo'
const CATALOG_TTL_MS = 10 * 60 * 1000
const ERROR_TTL_MS = 60000
/** author/slug, with the optional :variant suffix: elevenlabs/eleven-v3, google/gemini-3.8-flash-tts. */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/
const VARIANT_RE = /:(free|nitro|batch|thinking|floor)$/
/** Request limits the catalogue text does not state (OpenRouter TTS guide, 2026-11-25). */
const KNOWN_LIMIT = { 'bytedance-seed/seed-audio-1-0': 3000, 'heygen/heygen-voice-1': 10000, 'heygen/heygen-voice-1-turbo': 10000 }
/** Conservative cap for a model whose limit is not published (the smallest documented one). */
const DEFAULT_LIMIT = 3000

/** Kokoro voice ids start with a language letter (af_heart, bm_george, if_sara). */
const KOKORO_LANG = { a: 'en', b: 'en', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt', z: 'zh' }
/** Deepgram Aura-2 voice ids end with the language: aura-2-thalia-en, aura-2-cesare-it. */
const AURA_LANG = ['en', 'fr', 'es', 'ja', 'de', 'nl', 'it']

const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean)
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k)
export const validModel = (m) => MODEL_ID.test(String(m || '').trim())

/** Languages a voice id names. [] when the id does not say (a multilingual voice). */
export function voiceLangs(model, id) {
  const v = String(id || '')
  if (/kokoro/i.test(model)) return KOKORO_LANG[v[0]] ? [KOKORO_LANG[v[0]]] : []
  if (/mai-voice/i.test(model)) return [lang2(v.split('-').slice(0, 2).join('-'))]
  if (/aura-2/i.test(model)) { const s = v.slice(v.lastIndexOf('-') + 1); return AURA_LANG.includes(s) ? [s] : [] }
  if (/flux-tts/i.test(model)) return ['en']
  if (/voxtral/i.test(model)) return /^[a-z]{2}_/.test(v) ? [v.slice(0, 2)] : []
  return []
}

function limitOf(id, description) {
  const m = /(\d[\d,]*)[- ]character/.exec(String(description || ''))
  if (m) return Number(String(m[1]).replace(/,/g, '')) || 0
  return KNOWN_LIMIT[id] || 0
}

/**
 * One catalogue entry in the adapter's shape. `base` (optional) is the entry of the
 * model without the variant suffix, for a :free variant that publishes no parameters
 * of its own.
 */
export function normalizeModel(m, base) {
  const id = String((m && m.id) || '')
  const speech = ((Array.isArray(m && m.output_modalities) ? m.output_modalities : []).find((o) => o && o.type === 'speech')) || {}
  const p = speech.supported_parameters || {}
  const from = base || {}
  const voices = p.voice && Array.isArray(p.voice.values) ? p.voice.values.map(String)
    : (Array.isArray(m && m.supported_voices) ? m.supported_voices.map(String) : [])
  const formats = p.response_format && Array.isArray(p.response_format.values) ? p.response_format.values.map(String) : (from.formats || ['mp3', 'pcm'])
  return {
    id, label: String((m && m.name) || id), description: String((m && m.description) || ''),
    voices: voices.map((v) => ({ id: v, label: v, langs: voiceLangs(id, v) })),
    // No voice list is published: the vendor's own ids are taken (Fish Audio), or no voice is needed (Seed Audio).
    voiceUnknown: !voices.length && (has(p, 'voice') || Boolean(from.voiceUnknown)),
    formats, speed: p.speed ? [Number(p.speed.min), Number(p.speed.max)] : (from.speed || null),
    instructions: has(p, 'instructions') || Boolean(from.instructions),
    maxChars: limitOf(id, m && m.description) || from.maxChars || 0,
    providers: Array.isArray(m && m.endpoints) ? m.endpoints.map((e) => String((e && e.provider_slug) || '')).filter(Boolean) : (from.providers || []),
  }
}

/** The speech catalogue plus the general catalogue's extra ids (variants, late additions). */
export function mergeCatalogues(speechList, generalList) {
  const byId = new Map(speechList.map((x) => [x.id, x]))
  for (const m of Array.isArray(generalList) ? generalList : []) {
    const id = String((m && m.id) || '')
    if (!MODEL_ID.test(id) || byId.has(id)) continue
    const root = id.replace(VARIANT_RE, '')
    const base = byId.get(root) || byId.get(root.replace(/-free$/, '')) || null
    const ownVoices = Array.isArray(m && m.supported_voices) && m.supported_voices.length > 0
    if (!base && !ownVoices) continue
    const entry = normalizeModel(m, base || undefined)
    if (base) {
      entry.label = base.label + ' (' + id.slice(id.lastIndexOf(':') + 1) + ')'
      // a variant publishes no parameters of its own: it takes its base model voices
      if (!entry.voices.length) entry.voices = base.voices
      if (!entry.maxChars) entry.maxChars = base.maxChars
    }
    byId.set(id, entry)
  }
  return Array.from(byId.values())
}

const hdr = (inst, extra) => Object.assign({ authorization: 'Bearer ' + (inst.secret ? inst.secret() : ''), 'x-title': 'dsh-voice' }, extra || {})

/**
 * The speech catalogue, cached 10 minutes in inst.state (60 s after a failure, which
 * keeps the previous list). { at, list, error }.
 */
export async function catalogue(inst, signal, force) {
  const st = inst.state
  const now = Date.now()
  const hit = st.orCatalog
  if (!force && hit && now - hit.at < (hit.list && hit.list.length ? CATALOG_TTL_MS : ERROR_TTL_MS)) return hit
  const get = async (path) => {
    const up = await request(joinUrl(inst.baseUrl, path), { method: 'GET', signal, timeout: 12000, headers: hdr(inst, { accept: 'application/json' }) })
    if (up.status !== 200) throw new Error('HTTP ' + up.status)
    return (parseJson(up.body) || {}).data
  }
  let list = (hit && hit.list) || []
  let error = ''
  try {
    const [speech, general] = await Promise.all([
      get('/audio/speech/models'),
      get('/models?output_modalities=speech').catch(() => null),
    ])
    if (!Array.isArray(speech)) throw new Error('catalogue is not a list')
    const known = speech.map((m) => normalizeModel(m)).filter((x) => MODEL_ID.test(x.id))
    if (!known.length) throw new Error('empty catalogue')
    list = Array.isArray(general) ? mergeCatalogues(known, general) : known
  } catch (e) {
    error = scrub(String((e && e.message) || e), 160)
  }
  st.orCatalog = { at: now, list, error }
  return st.orCatalog
}

const entryOf = async (inst, model, signal) => {
  const cat = await catalogue(inst, signal)
  const id = validModel(model) ? String(model).trim() : (validModel(inst.models && inst.models.tts) ? inst.models.tts : DEFAULT_TTS)
  return { id, entry: cat.list.find((x) => x.id === id) || null, cat }
}

/** Map an upstream failure to a typed error. what: 'tts' | 'stt' | 'voices'. */
export function openrouterError(what, up) {
  const body = up.body.toString('utf8')
  const j = parseJson(body)
  const detail = scrub((j && j.error && j.error.message) || body, 200)
  const msg = 'openrouter ' + what + ' ' + up.status + ': ' + detail
  if (up.status === 401 || up.status === 403) return voiceErr(msg, 'bad_key', 502)
  if (up.status === 402 || up.status === 429) return voiceErr(msg, 'quota_exceeded', 429)
  // The vendor's "no such voice" comes back as a plain 404 from the provider, or as a 400 about the voice
  // (not a 400 about the format, which may name the product "HeyGen Voice").
  if (what === 'tts' && ((up.status === 404 && /provider returned 404/i.test(detail)) || (up.status === 400 && /voice/i.test(detail) && !/format/i.test(detail)))) return voiceErr(msg, 'bad_voice', 400)
  if (up.status === 400 && /model .* does not exist/i.test(detail)) return voiceErr(msg, 'bad_voice', 400)
  return voiceErr(msg, 'vendor', 502)
}

/** The model picked for a speech request: the request's, the instance's, then the default. */
export function speechModel(inst, model) {
  if (validModel(model)) return String(model).trim()
  if (validModel(inst.models && inst.models.tts)) return String(inst.models.tts).trim()
  return DEFAULT_TTS
}

/** `audio/pcm;rate=44100;channels=1` -> the sample rate (24000 when the header does not say). */
export function pcmRate(contentType) {
  const m = /rate=(\d{3,6})/i.exec(String(contentType || ''))
  return m ? Number(m[1]) : 24000
}

/**
 * Provider routing preferences of the instance, kept to the slugs that serve the
 * model. A model the catalogue does not know has no known providers, so its
 * preferences are dropped rather than sent blind.
 */
export function providerRouting(inst, entry) {
  const o = inst.options || {}
  const out = {}
  if (o.zdr === true) out.zdr = true
  const serving = entry && entry.providers.length ? entry.providers : []
  const keep = (list) => list.filter((s) => serving.includes(s))
  const order = keep(csv(o.preferProviders))
  const only = keep(csv(o.onlyProviders))
  if (order.length) out.order = order
  if (only.length) out.only = only
  return Object.keys(out).length ? out : null
}

export default {
  type: 'openrouter',
  label: 'OpenRouter',
  hq: 'US',
  euNote: 'US router. Each request goes to the vendor of the chosen model, so residency and price follow that vendor: pick EU vendors, or pin an EU endpoint with the instance option "Prefer providers" (for example mistral/eu).',
  group: 'other',
  residency: 'varies',
  desc: 'One key for many vendors\' speech models (ElevenLabs, Gemini TTS, Voxtral, Fish, HeyGen, Kokoro) with their voices, plus transcription.',
  docs: 'https://openrouter.ai/docs/guides/overview/multimodal/tts',
  status: 'verified',
  verification: 'Checked live on 2026-11-25 against the running service and its TTS guide: GET /api/v1/audio/speech/models (public, one entry per model with output_modalities[].supported_parameters: voice enum, response_format enum mp3 or pcm, speed range, instructions), '
    + 'POST /api/v1/audio/speech (raw audio bytes; Voxtral TTS 3 and ElevenLabs v3 answered audio/mpeg, the free HeyGen Voice answered audio/pcm;rate=44100;channels=1 and was wrapped into a WAV; '
    + 'speed was accepted by Eleven v3, whose catalogue publishes a range, and silently ignored by Voxtral TTS 3, which publishes none), '
    + 'POST /api/v1/audio/transcriptions (multipart file and model; openai/whisper-large-v3-turbo and mistralai/voxtral-mini-transcribe-3-0 answered text, and verbose_json with timestamp_granularities[] gave language, duration and words). '
    + 'Errors: an unknown voice is a 404 "Provider returned 404", an unknown model a 400 "Model ... does not exist", mp3 on a PCM-only model a 400 naming response_format. '
    + 'Unverified: the sample rate of PCM models other than HeyGen (the header is trusted), prices, and every model that was not called.',
  presets: [
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: { tts: DEFAULT_TTS, stt: DEFAULT_STT }, defaultVoice: 'gb_oliver_neutral', group: 'other', residency: 'varies' },
  ],
  optionFields: [
    { key: 'ttsLangs', label: 'TTS languages', type: 'text', help: 'Comma list of 2-letter codes this instance may speak in automatic routing, for example en,it,el. Empty means all.' },
    { key: 'preferProviders', label: 'Prefer providers', type: 'text', help: 'Comma list of OpenRouter provider slugs tried first for a model, for example mistral/eu. Only slugs that serve the chosen model are sent.' },
    { key: 'onlyProviders', label: 'Only these providers', type: 'text', help: 'Comma list of provider slugs the request may use. Careful: a model served by none of them answers that no endpoint was found.' },
    { key: 'zdr', label: 'Zero data retention', type: 'bool', help: 'Route only to endpoints that keep no logs (provider.zdr). Fewer endpoints: a model with none answers that no endpoint was found.', default: false },
  ],
  configFields: ['baseUrl', 'credential', 'models', 'defaultVoice', 'options'],
  defaultBaseUrl: 'https://openrouter.ai/api/v1',

  // the key may come from the environment; a loopback instance (a local proxy under test) needs none
  configured(inst) {
    if (inst.secret()) return true
    try { return isLoopbackHostname(new URL(String(inst.baseUrl || '')).hostname) } catch (e) { return false }
  },

  capabilities(inst) {
    const tl = csv((inst.options || {}).ttsLangs)
    return {
      tts: true, stt: true,
      ttsLangs: tl.length ? (tl.includes('*') ? '*' : tl) : '*', sttLangs: '*', detectsLanguage: true,
      streaming: false, alignment: 'none', nativeSpeed: [0.25, 4],
      ssml: false, maxChars: DEFAULT_LIMIT, formats: ['mp3', 'wav'], quota: false,
    }
  },

  async health(inst, signal) {
    if (!this.configured(inst)) return { ok: false, status: 'down', detail: 'no API key' }
    try {
      const up = await request(joinUrl(inst.baseUrl, '/auth/key'), { method: 'GET', signal, timeout: 8000, headers: hdr(inst, { accept: 'application/json' }) })
      if (up.status === 200) {
        const cat = await catalogue(inst, signal)
        return { ok: true, status: 'up', detail: cat.list.length ? cat.list.length + ' speech models' : ('key accepted, catalogue unavailable' + (cat.error ? ' (' + cat.error + ')' : '')) }
      }
      if (up.status === 401 || up.status === 403) return { ok: false, status: 'down', detail: 'OpenRouter rejected the API key (' + up.status + ')' }
      // a local proxy under test has no /auth/key route
      if (up.status === 404 && this.configured(inst) && !inst.secret()) {
        const cat = await catalogue(inst, signal)
        return { ok: cat.list.length > 0, status: cat.list.length ? 'up' : 'down', detail: cat.list.length ? cat.list.length + ' speech models (local proxy)' : 'no catalogue on ' + inst.baseUrl }
      }
      return { ok: false, status: 'down', detail: 'HTTP ' + up.status }
    } catch (e) {
      return { ok: false, status: 'down', detail: scrub(String((e && e.message) || e), 120) }
    }
  },

  /**
   * A keyed instance whose catalogue failed is still usable (the model lists fall back to the configured
   * models). Returns the reason to log, or '' when there is nothing to say.
   */
  async recheck(inst) {
    if (!inst.secret()) return ''
    const cat = await catalogue(inst)
    return cat.error ? 'catalogue unavailable: ' + cat.error : ''
  },

  /** Voices of one model (opts.model, else the instance's model). A language filter applies to ids that name a language. */
  async listVoices(inst, opts, signal) {
    const { id, entry } = await entryOf(inst, (opts || {}).model, signal)
    const want = opts && opts.lang ? lang2(opts.lang) : ''
    if (!entry || !entry.voices.length) return []
    return want ? entry.voices.filter((v) => !v.langs.length || v.langs.includes(want)) : entry.voices
  },

  /** The speech models this instance offers, for the reader menus. Each carries its own voices. */
  async ttsModels(inst, signal) {
    const cat = await catalogue(inst, signal)
    const current = speechModel(inst, '')
    return cat.list.map((m) => ({
      id: m.id, label: m.label, group: m.id.split('/')[0], voices: m.voices, voiceFree: m.voiceUnknown,
      speed: m.speed, instructions: m.instructions, formats: m.formats, maxChars: m.maxChars || DEFAULT_LIMIT,
      default: m.id === current, note: m.description,
    }))
  },

  async tts(args, inst, signal) {
    const { id: modelId, entry } = await entryOf(inst, args.model, signal)
    let note = ''
    // A voice belongs to one model: an unknown voice falls back to the instance's, then to the model's first.
    let vid = String(args.voice || '').trim()
    if (entry && entry.voices.length && !entry.voices.some((v) => v.id === vid)) {
      const own = String(inst.defaultVoice || '').trim()
      const use = entry.voices.some((v) => v.id === own) ? own : entry.voices[0].id
      note = (vid ? 'voice "' + vid + '" is not offered by ' + modelId : 'no voice given for ' + modelId) + '; used ' + use
      vid = use
    }
    if (!vid) vid = String(inst.defaultVoice || '').trim()
    // Fish Audio models publish no voice list but require one (a Fish Audio library id).
    if (!vid && entry && entry.voiceUnknown && /fish-audio/.test(modelId)) {
      throw voiceErr(modelId + ' needs a voice: set the instance voice to a Fish Audio model id', 'bad_voice', 400)
    }
    const formats = entry ? entry.formats : ['mp3']
    const fmt = formats.includes('mp3') ? 'mp3' : (formats[0] || 'mp3')
    // speech annotations: the family of the chosen model decides what reaches it (tags in its own syntax,
    // or the words alone plus a request-level instruction where it takes one)
    const ann = applyAnnotations(String(args.text || ''), { adaptation: adaptationFor('openrouter', modelId, inst.id) })
    const payload = { model: modelId, input: ann.text, response_format: fmt }
    if (!args.instructions && ann.instructions) args.instructions = ann.instructions
    if (vid) payload.voice = vid
    // Speed goes only to a model that publishes a range: others ignore it or refuse it.
    const range = entry && entry.speed
    const sp = Number(args.speed)
    if (range && Number.isFinite(sp) && sp !== 1) payload.speed = Math.min(range[1], Math.max(range[0], sp))
    // Delivery instructions (the annotation layer's output) go only to a model that takes them.
    if (args.instructions && entry && entry.instructions) payload.instructions = String(args.instructions).slice(0, 1000)
    const routing = providerRouting(inst, entry)
    if (routing) payload.provider = routing

    const up = await request(joinUrl(inst.baseUrl, '/audio/speech'), {
      method: 'POST', signal, timeout: 120000,
      headers: hdr(inst, { 'content-type': 'application/json' }),
      body: jsonBody(payload),
    })
    const ctype = String(up.headers['content-type'] || '')
    if (up.status !== 200 || /^application\/json/i.test(ctype)) throw openrouterError('tts', up)
    if (!up.body.length) throw voiceErr('openrouter tts: empty audio', 'vendor', 502)
    if (/^audio\/pcm/i.test(ctype)) {
      return { audio: pcmToWav(up.body, pcmRate(ctype)), mime: 'audio/wav', voice: vid || null, model: modelId, billedChars: args.text.length, alignment: null, note }
    }
    return { audio: up.body, mime: audioType(up.body, 'audio/mpeg'), voice: vid || null, model: modelId, billedChars: args.text.length, alignment: null, note }
  },

  async stt(args, inst, signal) {
    const models = Object.assign({ stt: DEFAULT_STT }, inst.models || {})
    const model = String(args.model || '').trim()
    return openaiStt(Object.assign({}, args, { model: validModel(model) ? model : '' }), Object.assign({}, inst, { models }), signal,
      { label: 'openrouter', defaultModel: DEFAULT_STT, wordsModel: DEFAULT_STT })
  },

  async legacyConfig(inst, avail) {
    if (!avail) return { models: { tts: [{ id: DEFAULT_TTS, name: 'Voxtral TTS 3' }], default: DEFAULT_TTS }, voices: [], note: 'OpenRouter is not configured.' }
    const cat = await catalogue(inst)
    const { id, entry } = await entryOf(inst, '', undefined)
    return {
      models: { tts: cat.list.map((m) => ({ id: m.id, name: m.label })), default: id },
      voices: entry ? entry.voices : [],
      voicesError: cat.error || undefined,
      note: cat.list.length
        ? cat.list.length + ' speech models through one key (ElevenLabs, Gemini TTS, Voxtral, Fish, HeyGen, Microsoft, Deepgram, Kokoro and others); voices are specific to each model. '
          + 'The vendor of the chosen model sets the residency and the price. Speech tags follow each model (see its entry in the tag menu).'
        : 'The speech catalogue is unavailable' + (cat.error ? ' (' + cat.error + ')' : '') + '.',
    }
  },

  chunkPlan() { return { first: 110, rest: 260 } },
}
