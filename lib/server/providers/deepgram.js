/**
 * Provider type `deepgram`: Aura-2 TTS (POST /v1/speak) and Nova-3 STT
 * (POST /v1/listen, raw audio body). EU processing through api.eu.deepgram.com.
 *
 * Verified on 2026-10-31 against developers.deepgram.com (markdown pages:
 * speak-request, listen-pre-recorded, regional-endpoints, models-languages-overview,
 * tts voices and languages, manage/models/list).
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, lang2 } from '../http.js'

const DEFAULT_BASE = 'https://api.deepgram.com'
const EU_BASE = 'https://api.eu.deepgram.com'

/** Aura-2 languages from the docs: English, Spanish, German, French, Dutch, Italian, Japanese. NO Greek. */
export const TTS_LANGS = ['en', 'es', 'de', 'fr', 'nl', 'it', 'ja']

/** Nova-3 monolingual language codes (docs table, base codes). Greek is el, Italian it, English en. */
export const STT_LANGS = [
  'af', 'ar', 'be', 'bn', 'bs', 'bg', 'ca', 'zh', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'gl', 'de', 'el', 'gu', 'he', 'hi',
  'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lv', 'lt', 'mk', 'ms', 'mr', 'no', 'fa', 'pl', 'pt', 'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sv',
  'tl', 'ta', 'te', 'th', 'tr', 'uk', 'vi', 'xh', 'zu',
]

/** Documented Aura-2 voices as name-language:gender (the docs have no listing API for these). */
const VOICES = ('agathe-fr:f agustina-es:f alvaro-es:m ama-ja:f amalthea-en:f andromeda-en:f antonia-es:f apollo-en:m '
  + 'aquila-es:m arcas-en:m aries-en:m asteria-en:f athena-en:f atlas-en:m aurelia-de:f aurora-en:f beatrix-nl:f '
  + 'callista-en:f carina-es:f celeste-es:f cesare-it:m cinzia-it:f cora-en:f cordelia-en:f cornelia-nl:f '
  + 'daphne-nl:f delia-en:f demetra-it:f diana-es:f dionisio-it:m draco-en:m ebisu-ja:m elara-de:f electra-en:f '
  + 'elio-it:m estrella-es:f fabian-de:m flavio-it:m fujin-ja:m gloria-es:f harmonia-en:f hector-fr:m helena-en:f '
  + 'hera-en:f hermes-en:m hestia-nl:f hyperion-en:m iris-en:f izanami-ja:f janus-en:f javier-es:m julius-de:m '
  + 'juno-en:f jupiter-en:m kara-de:f lara-de:f lars-nl:m leda-nl:f livia-it:f luciano-es:m luna-en:f maia-it:f '
  + 'mars-en:m melia-it:f minerva-en:f neptune-en:m nestor-es:m odysseus-en:m olivia-es:f ophelia-en:f orion-en:m '
  + 'orpheus-en:m pandora-en:f phoebe-en:f pluto-en:m rhea-nl:f roman-nl:m sander-nl:m saturn-en:m selena-es:f '
  + 'selene-en:f silvia-es:f sirio-es:m thalia-en:f theia-en:f uzume-ja:f valerio-es:m vesta-en:f viktoria-de:f zeus-en:m')
  .split(' ').map((s) => {
    const [n, g] = s.split(':')
    const k = n.lastIndexOf('-')
    return { id: 'aura-2-' + n, name: n.slice(0, k), langs: [n.slice(k + 1)], gender: g === 'm' ? 'male' : 'female', accent: '', tags: ['aura-2'] }
  })

const LANG_DEFAULT = { en: 'aura-2-thalia-en', es: 'aura-2-celeste-es', de: 'aura-2-viktoria-de', fr: 'aura-2-agathe-fr', nl: 'aura-2-rhea-nl', it: 'aura-2-livia-it', ja: 'aura-2-uzume-ja' }

const baseOf = (inst) => inst.baseUrl || DEFAULT_BASE
const hdr = (inst, extra) => Object.assign({ Authorization: 'Token ' + inst.secret() }, extra || {})
const isEu = (inst) => /(^|\/\/)api\.eu\.deepgram\.com/i.test(baseOf(inst))

/** Deepgram errors: {err_code, err_msg, request_id} or {category, message, details}. */
function detail(bodyText) {
  const j = parseJson(bodyText)
  if (j && typeof j === 'object') return String(j.err_msg || j.message || j.details || j.error || '')
  return scrub(bodyText, 200)
}

function mapError(what, status, bodyText, extra) {
  const msg = scrub(detail(bodyText), 200)
  if (status === 401 || status === 403) return voiceErr('Deepgram rejected the API key (' + status + ')', 'bad_key', 502)
  if (status === 402 || status === 429) return voiceErr('Deepgram ' + what + ': quota, credit or rate limit reached' + (msg ? ' (' + msg + ')' : ''), 'quota_exceeded', 429)
  if ((status === 400 || status === 404 || status === 422) && /language/i.test(msg)) return voiceErr('Deepgram ' + what + ': unsupported language (' + msg + ')', 'unsupported_lang', 400)
  if ((status === 400 || status === 404 || status === 422) && what === 'tts' && /model|voice/i.test(msg)) {
    return voiceErr('Deepgram does not serve the voice "' + String((extra && extra.voice) || '').slice(0, 80) + '" (' + msg + ')', 'bad_voice', 400)
  }
  return voiceErr('deepgram ' + what + ' ' + status + ': ' + msg, 'vendor', 502)
}

function pickVoice(voice, lang, inst) {
  const want = String(voice || '').trim()
  const l = lang ? lang2(lang) : ''
  const known = (id) => VOICES.find((v) => v.id === id)
  const fits = (id) => !l || (known(id) ? known(id).langs[0] === l : id.endsWith('-' + l))
  if (want && /^aura(-2)?-/.test(want) && fits(want)) return want
  const dv = inst.defaultVoice
  if (dv && /^aura(-2)?-/.test(dv) && fits(dv)) return dv
  return LANG_DEFAULT[l || 'en']
}

export default {
  type: 'deepgram',
  label: 'Deepgram',
  hq: 'US',
  euNote: 'US company with an EU endpoint (api.eu.deepgram.com) that keeps processing in the EU for /v1/listen and /v1/speak (not Whisper); the default endpoint is global.',
  group: 'other',
  residency: 'eu-region',
  desc: 'Nova-3 STT with word timings (incl. Greek) and Aura-2 TTS in 7 languages (no Greek); EU endpoint available.',
  docs: 'https://developers.deepgram.com/reference/text-to-speech/speak-request',
  status: 'verified',
  verification: 'Fetched 2026-10-31 from developers.deepgram.com: llms.txt, the markdown of the Single Text Request (POST /v1/speak, JSON {text}, query model/encoding/container/sample_rate/speed, Authorization: Token KEY), Pre-Recorded Audio (POST /v1/listen, response results.channels[0].alternatives[0].words and channels[0].detected_language), Regional Endpoints (EU base api.eu.deepgram.com serves /v1/listen, /v2/listen, /v1/speak, /v2/speak, Voice Agent and /v1/read, Whisper models excluded), Models and Languages Overview (nova-3 lists Greek el, Italian it, English en) and the Aura voices and languages page (Aura-2 languages: en, es, de, fr, nl, it, ja; NO Greek). The voice list is static (documented Aura-2 names). A raw audio request body with its own Content-Type is shown in the docs cURL example for /v1/listen. Not exercised live; Aura speed is documented but "not yet supported in all languages". Word timings for TTS are not offered (alignment none).',
  presets: [
    { id: 'deepgram', label: 'Deepgram (global)', baseUrl: DEFAULT_BASE, models: { tts: 'aura-2-thalia-en', stt: 'nova-3' }, defaultVoice: 'aura-2-thalia-en' },
    { id: 'deepgram-eu', label: 'Deepgram EU endpoint', baseUrl: EU_BASE, models: { tts: 'aura-2-thalia-en', stt: 'nova-3' }, defaultVoice: 'aura-2-thalia-en', group: 'other', residency: 'eu-region' },
  ],
  optionFields: [
    { key: 'smartFormat', label: 'Smart formatting', type: 'bool', default: true, help: 'smart_format and punctuate on /v1/listen.' },
  ],
  configFields: ['baseUrl', 'credential', 'models', 'defaultVoice', 'options'],
  defaultBaseUrl: DEFAULT_BASE,

  residencyOf(inst) { return isEu(inst) ? 'eu-region' : 'non-eu' },

  configured(inst) { return Boolean(inst.secret()) },

  capabilities() {
    return {
      tts: true, stt: true, ttsLangs: TTS_LANGS.slice(), sttLangs: STT_LANGS.slice(), detectsLanguage: true,
      streaming: false, alignment: 'none', nativeSpeed: [0.7, 1.5], ssml: false,
      maxChars: 2000, formats: ['wav'], quota: false,
    }
  },

  async health(inst, signal) {
    if (!this.configured(inst)) return { ok: false, status: 'down', detail: 'no API key' }
    try {
      const up = await request(joinUrl(baseOf(inst), '/v1/models'), { method: 'GET', signal, timeout: 8000, headers: hdr(inst, { accept: 'application/json' }) })
      if (up.status === 200) return { ok: true, status: 'up', detail: 'models endpoint reachable' }
      if (up.status === 401 || up.status === 403) return { ok: false, status: 'down', detail: 'API key rejected (' + up.status + ')' }
      return { ok: false, status: 'down', detail: 'models answered ' + up.status }
    } catch (e) {
      return { ok: false, status: 'down', detail: scrub(String((e && e.message) || e), 120) }
    }
  },

  async listVoices(inst, opts) {
    const l = opts && opts.lang ? lang2(opts.lang) : ''
    return VOICES.filter((v) => !l || v.langs[0] === l).map((v) => Object.assign({}, v, { langs: v.langs.slice(), tags: v.tags.slice() }))
  },

  async tts({ text, voice, lang, speed, model }, inst, signal) {
    const l = lang ? lang2(lang) : ''
    if (l && !TTS_LANGS.includes(l)) throw voiceErr('Deepgram Aura-2 does not speak "' + l + '" (supported: ' + TTS_LANGS.join(', ') + ')', 'unsupported_lang', 400)
    const vid = String(model || '').trim().startsWith('aura') ? String(model).trim() : pickVoice(voice, l, inst)
    const q = new URLSearchParams({ model: vid, encoding: 'linear16', container: 'wav', sample_rate: '24000' })
    const s = Number(speed)
    if (Number.isFinite(s) && s > 0 && s !== 1) q.set('speed', String(Math.min(1.5, Math.max(0.7, s))))
    const up = await request(joinUrl(baseOf(inst), '/v1/speak?' + q.toString()), {
      method: 'POST', signal, timeout: 120000,
      headers: hdr(inst, { 'content-type': 'application/json', accept: 'audio/wav' }),
      body: jsonBody({ text }),
    })
    if (up.status !== 200) throw mapError('tts', up.status, up.body.toString('utf8'), { voice: vid })
    const durationS = up.body.length > 44 ? (up.body.length - 44) / (24000 * 2) : null
    return { audio: up.body, mime: 'audio/wav', voice: vid, model: vid, billedChars: text.length, alignment: null, durationS }
  },

  async stt({ audio, mime, lang, model, wantWords }, inst, signal) {
    const q = new URLSearchParams({ model: String(model || '').trim() || (inst.models && inst.models.stt) || 'nova-3' })
    if (!(inst.options && (inst.options.smartFormat === false || inst.options.smartFormat === 'false'))) { q.set('smart_format', 'true'); q.set('punctuate', 'true') }
    let asked = ''
    if (lang) {
      asked = lang2(lang)
      if (!STT_LANGS.includes(asked)) throw voiceErr('Deepgram Nova-3 does not transcribe "' + asked + '"', 'unsupported_lang', 400)
      q.set('language', asked)
    } else q.set('detect_language', 'true')
    const up = await request(joinUrl(baseOf(inst), '/v1/listen?' + q.toString()), {
      method: 'POST', signal, timeout: 120000,
      headers: hdr(inst, { 'content-type': mime || 'audio/webm', accept: 'application/json' }), body: audio,
    })
    if (up.status !== 200) throw mapError('stt', up.status, up.body.toString('utf8'))
    const j = parseJson(up.body) || {}
    const ch = (j.results && Array.isArray(j.results.channels) && j.results.channels[0]) || {}
    const alt = (Array.isArray(ch.alternatives) && ch.alternatives[0]) || {}
    const words = wantWords !== false && Array.isArray(alt.words)
      ? alt.words.map((w) => ({ w: String(w.punctuated_word || w.word || ''), t0: Number(w.start) || 0, t1: Number(w.end) || 0 }))
      : null
    const dur = j.metadata && Number(j.metadata.duration)
    return {
      text: String(alt.transcript || '').trim(), language: ch.detected_language ? lang2(ch.detected_language) : (asked || null),
      confidence: typeof alt.confidence === 'number' ? alt.confidence : undefined, words, durationS: dur || undefined,
    }
  },
}
