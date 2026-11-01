/**
 * Provider type `assemblyai`: speech-to-text only (REST: upload, create
 * transcript, poll). EU processing through api.eu.assemblyai.com.
 *
 * Verified on 2026-10-31 against assemblyai.com/docs (markdown pages: upload,
 * transcript submit and get, model selection, supported languages, cloud
 * endpoints and data residency, Universal-3.5 Pro page).
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, lang2 } from '../http.js'

const DEFAULT_BASE = 'https://api.assemblyai.com'
const EU_BASE = 'https://api.eu.assemblyai.com'

/** Universal-3.5 Pro (18 languages, NO Greek). */
export const U3_LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ar', 'da', 'nl', 'fi', 'he', 'hi', 'ja', 'zh', 'no', 'sv', 'tr', 'vi']

/** Universal-2 languages that map to a two-letter code (the docs list 99 languages by name; Greek is in the "good accuracy" group). */
export const U2_LANGS = [
  'en', 'es', 'fr', 'de', 'id', 'it', 'ja', 'nl', 'pl', 'pt', 'ru', 'sv', 'tr', 'uk', 'ca',
  'ar', 'az', 'bg', 'bs', 'zh', 'cs', 'da', 'el', 'et', 'fi', 'gl', 'he', 'hi', 'hr', 'hu', 'ko', 'mk', 'ms', 'no', 'ro', 'sk', 'tl', 'th', 'ur', 'vi',
  'af', 'be', 'cy', 'fa', 'hy', 'is', 'kk', 'lt', 'lv', 'mi', 'mr', 'sl', 'sw', 'ta',
  'am', 'as', 'bn', 'gu', 'ha', 'ka', 'km', 'kn', 'lb', 'ln', 'lo', 'ml', 'mn', 'mt', 'my', 'ne', 'oc', 'pa', 'ps', 'sd', 'sn', 'so', 'sr', 'te', 'tg', 'uz', 'yo',
]
const ALL_LANGS = Array.from(new Set(U2_LANGS.concat(U3_LANGS)))

const baseOf = (inst) => inst.baseUrl || DEFAULT_BASE
const hdr = (inst, extra) => Object.assign({ authorization: inst.secret() }, extra || {})
const isEu = (inst) => /(^|\/\/)api\.eu\.assemblyai\.com/i.test(baseOf(inst))
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(voiceErr('request aborted', 'timeout', 504)) }, { once: true })
})

function mapError(what, status, bodyText) {
  const j = parseJson(bodyText)
  const msg = scrub(j && (j.error || j.message) ? String(j.error || j.message) : bodyText, 200)
  if (status === 401 || status === 403) return voiceErr('AssemblyAI rejected the API key (' + status + ')', 'bad_key', 502)
  if (status === 402 || status === 429) return voiceErr('AssemblyAI ' + what + ': quota, credit or rate limit reached' + (msg ? ' (' + msg + ')' : ''), 'quota_exceeded', 429)
  if (status === 400 && /language/i.test(msg)) return voiceErr('AssemblyAI ' + what + ': unsupported language (' + msg + ')', 'unsupported_lang', 400)
  return voiceErr('assemblyai ' + what + ' ' + status + ': ' + msg, 'vendor', 502)
}

function modelsFor(model, l) {
  const m = String(model || '').trim()
  if (m) return [m]
  if (!l) return ['universal-3-5-pro', 'universal-2']
  return U3_LANGS.includes(l) ? ['universal-3-5-pro', 'universal-2'] : ['universal-2']
}

export default {
  type: 'assemblyai',
  label: 'AssemblyAI',
  hq: 'US',
  euNote: 'US company with an EU endpoint (api.eu.assemblyai.com) that processes and stores audio and transcripts in the EU; account and usage data stay in the US.',
  group: 'other',
  residency: 'eu-region',
  desc: 'Speech-to-text only: Universal-3.5 Pro (18 languages) with Universal-2 fallback for Greek, word timings; EU endpoint.',
  docs: 'https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit',
  status: 'verified',
  verification: 'Fetched 2026-10-31 from assemblyai.com/docs: llms.txt, markdown of Upload a media file (POST /v2/upload, application/octet-stream, header authorization, answer upload_url), Transcribe audio and Get a transcript (audio_url, speech_models, language_code, language_detection, status queued/processing/completed/error, words [{text,start,end in ms,confidence}], audio_duration, language_code, language_confidence, error), Model selection (current ids universal-3-5-pro and universal-2; the old speech_model field is deprecated), Supported languages and the Universal-3.5 Pro page (18 languages: no Greek, Italian yes; Universal-2 99 languages incl. Greek, Italian, English) and Cloud Endpoints (EU base api.eu.assemblyai.com). The universal-2 list in this adapter covers only languages given by name in the docs accuracy groups that map to a two-letter code. Not exercised live. Polling interval is inst.options.pollMs (default 1500) and the total wait is capped by inst.options.maxWaitMs (default 180000).',
  presets: [
    { id: 'assemblyai', label: 'AssemblyAI (US)', baseUrl: DEFAULT_BASE, models: { stt: 'universal-3-5-pro' } },
    { id: 'assemblyai-eu', label: 'AssemblyAI EU endpoint', baseUrl: EU_BASE, models: { stt: 'universal-3-5-pro' }, group: 'other', residency: 'eu-region' },
  ],
  optionFields: [
    { key: 'pollMs', label: 'Poll interval (ms)', type: 'number', default: 1500, help: 'How often the transcript status is polled.' },
    { key: 'maxWaitMs', label: 'Maximum wait (ms)', type: 'number', default: 180000, help: 'Give up after this long.' },
  ],
  configFields: ['baseUrl', 'credential', 'models', 'options'],
  defaultBaseUrl: DEFAULT_BASE,

  residencyOf(inst) { return isEu(inst) ? 'eu-region' : 'non-eu' },

  configured(inst) { return Boolean(inst.secret()) },

  capabilities() {
    return {
      tts: false, stt: true, ttsLangs: [], sttLangs: ALL_LANGS.slice(), detectsLanguage: true,
      streaming: false, alignment: 'none', nativeSpeed: null, ssml: false, maxChars: 0, formats: [], quota: false,
    }
  },

  async health(inst) {
    if (!this.configured(inst)) return { ok: false, status: 'down', detail: 'no API key' }
    return { ok: true, status: 'unknown', detail: 'key present; AssemblyAI has no free probe endpoint' }
  },

  async listVoices() { return [] },

  async tts() { throw voiceErr('AssemblyAI is speech-to-text only in this adapter', 'vendor', 400) },

  async stt({ audio, lang, model, wantWords }, inst, signal) {
    const l = lang ? lang2(lang) : ''
    if (l && !ALL_LANGS.includes(l)) throw voiceErr('AssemblyAI does not transcribe "' + l + '"', 'unsupported_lang', 400)
    const opts = inst.options || {}
    const pollMs = Math.max(1, Number(opts.pollMs) || 1500)
    const maxWait = Math.max(pollMs, Number(opts.maxWaitMs) || 180000)

    const up = await request(joinUrl(baseOf(inst), '/v2/upload'), {
      method: 'POST', signal, timeout: 120000, headers: hdr(inst, { 'content-type': 'application/octet-stream' }), body: audio,
    })
    if (up.status !== 200) throw mapError('upload', up.status, up.body.toString('utf8'))
    const uploadUrl = (parseJson(up.body) || {}).upload_url
    if (!uploadUrl) throw voiceErr('assemblyai upload: no upload_url in the answer', 'vendor', 502)

    const req = { audio_url: uploadUrl, speech_models: modelsFor(model || (inst.models && inst.models.stt && inst.models.stt !== 'universal-3-5-pro' ? inst.models.stt : ''), l) }
    if (l) req.language_code = l
    else req.language_detection = true
    const cr = await request(joinUrl(baseOf(inst), '/v2/transcript'), {
      method: 'POST', signal, timeout: 30000, headers: hdr(inst, { 'content-type': 'application/json' }), body: jsonBody(req),
    })
    if (cr.status !== 200) throw mapError('transcript', cr.status, cr.body.toString('utf8'))
    const id = (parseJson(cr.body) || {}).id
    if (!id) throw voiceErr('assemblyai transcript: no id in the answer', 'vendor', 502)

    const t0 = Date.now()
    for (;;) {
      const g = await request(joinUrl(baseOf(inst), '/v2/transcript/' + encodeURIComponent(id)), {
        method: 'GET', signal, timeout: 30000, headers: hdr(inst, { accept: 'application/json' }),
      })
      if (g.status !== 200) throw mapError('poll', g.status, g.body.toString('utf8'))
      const j = parseJson(g.body) || {}
      if (j.status === 'completed') {
        const words = wantWords !== false && Array.isArray(j.words)
          ? j.words.map((w) => ({ w: String(w.text || ''), t0: (Number(w.start) || 0) / 1000, t1: (Number(w.end) || 0) / 1000 }))
          : null
        return {
          text: String(j.text || '').trim(), language: j.language_code ? lang2(j.language_code) : (l || null),
          confidence: typeof j.language_confidence === 'number' ? j.language_confidence : undefined,
          words, durationS: Number(j.audio_duration) || undefined,
        }
      }
      if (j.status === 'error') {
        const e = scrub(j.error || '', 200)
        throw voiceErr('assemblyai transcript failed: ' + e, /language/i.test(e) ? 'unsupported_lang' : 'vendor', /language/i.test(e) ? 400 : 502)
      }
      if (Date.now() - t0 + pollMs > maxWait) throw voiceErr('assemblyai transcript still ' + String(j.status) + ' after ' + maxWait + ' ms', 'timeout', 504)
      await sleep(pollMs, signal)
    }
  },
}
