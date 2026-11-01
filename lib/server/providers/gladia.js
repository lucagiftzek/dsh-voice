/**
 * Provider type `gladia`: STT over the pre-recorded v2 API (French company).
 *
 * Verified 2026-10-31 against docs.gladia.io (OpenAPI pages for upload,
 * pre-recorded init and get, authentication, language detection, supported
 * languages, supported formats, data retention):
 *  - header `x-gladia-key`; base https://api.gladia.io
 *  - POST /v2/upload multipart field `audio` -> {audio_url, audio_metadata}
 *  - POST /v2/pre-recorded JSON {audio_url, model, language_config:{languages, code_switching}}
 *    -> {id, result_url}
 *  - GET  /v2/pre-recorded/{id} -> {status: queued|processing|done|error, error_code,
 *    result:{transcription:{full_transcript, languages, utterances:[{words:[{word,start,end,confidence}]}]}}}
 *  - models solaria-1 (default, has Greek), solaria-3 and solaria-fusion; Greek is
 *    marked "Yes" for solaria-1 and "No" for solaria-3 in the language table.
 * Not found in the docs: any regional endpoint or EU processing statement, so the
 * residency is reported as unknown. Live (WebSocket) transcription is not implemented.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, multipart, toWav, lang2 } from '../http.js'

const STT_LANGS = ['el', 'it', 'en']
const MODELS = ['solaria-1', 'solaria-3', 'solaria-fusion']

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(voiceErr('request aborted', 'timeout', 504)) }, { once: true })
})

const root = (inst) => String(inst.baseUrl || 'https://api.gladia.io').replace(/\/+$/, '')
const auth = (inst) => ({ 'x-gladia-key': inst.secret() })

function typed(status, body, what) {
  const msg = 'gladia ' + what + ' ' + status + ': ' + scrub(body, 200)
  if (status === 401 || status === 403) return voiceErr(msg, 'bad_key', 502)
  if (status === 429) return voiceErr(msg, 'quota_exceeded', 429)
  if ((status === 400 || status === 422) && /language/i.test(body)) return voiceErr(msg, 'unsupported_lang', 400)
  return voiceErr(msg, 'vendor', 502)
}

/** Containers listed by the docs (wav mp3 flac ogg opus m4a mp4 aac); webm is converted to wav. */
function acceptedContainer(buf) {
  if (!buf || buf.length < 12) return false
  const h = buf.slice(0, 4).toString('latin1')
  if (h === 'RIFF' || h === 'OggS' || h === 'fLaC') return true
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return true
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return true
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
}

/** Solaria model for a language: only solaria-1 lists Greek, so Greek forces it. */
export function pickModel(want, lang) {
  const m = MODELS.includes(want) ? want : 'solaria-1'
  if (lang === 'el' && m === 'solaria-3') return 'solaria-1'
  return m
}

export function parseResult(result) {
  const t = (result && result.transcription) || {}
  const words = []
  let conf = 0
  for (const u of t.utterances || []) {
    for (const x of u.words || []) {
      const wd = String(x.word || '').trim()
      if (!wd) continue
      words.push({ w: wd, t0: Number(x.start) || 0, t1: Number(x.end) || 0 })
      conf += Number(x.confidence) || 0
    }
  }
  let text = String(t.full_transcript || '').trim()
  if (!text) text = (t.utterances || []).map((u) => String(u.text || '').trim()).filter(Boolean).join(' ')
  const language = (t.languages && t.languages[0]) || ((t.utterances && t.utterances[0] && t.utterances[0].language) || null)
  return { text, words, language, confidence: words.length ? conf / words.length : undefined }
}

export default {
  type: 'gladia',
  label: 'Gladia',
  hq: 'FR',
  euNote: 'French company; the docs name no regional endpoint or processing location, so EU processing is not confirmed. Enterprise zero retention disables upload.',
  group: 'eu',
  residency: 'varies',
  desc: 'French speech to text (Solaria models) with automatic language detection and word timings for Greek, Italian and English.',
  docs: 'https://docs.gladia.io/api-reference/v2/pre-recorded/init',
  status: 'partial',
  verification:
    'Checked 2026-10-31 on docs.gladia.io (OpenAPI for POST /v2/upload, POST /v2/pre-recorded, GET /v2/pre-recorded/{id}, authentication, language detection, supported languages and formats, data retention). ' +
    'Confirmed: x-gladia-key header, upload field audio, init body (audio_url, model, language_config.languages/code_switching), status values queued/processing/done/error, ' +
    'result.transcription.utterances[].words[] with word/start/end/confidence, models solaria-1/solaria-3/solaria-fusion, el/it/en supported (Greek on solaria-1 only), formats wav mp3 flac ogg opus m4a mp4 (webm is converted to wav). ' +
    'Unverified: batch regions (none documented, so no region setting and EU processing is unconfirmed), DELETE /v2/pre-recorded/{id} cleanup and the list call used by health(). ' +
    'Live WebSocket transcription is not implemented.',
  presets: [{ id: 'gladia', label: 'Gladia', baseUrl: 'https://api.gladia.io', models: { stt: 'solaria-1' } }],
  optionFields: [
    { key: 'pollMs', label: 'Poll interval (ms)', type: 'number', default: 1000, help: 'Delay between result polls.' },
  ],
  configFields: ['baseUrl', 'credential', 'models', 'options'],
  defaultBaseUrl: 'https://api.gladia.io',

  configured(inst) { return Boolean(inst.secret()) },

  capabilities() {
    return {
      tts: false, stt: true,
      ttsLangs: [], sttLangs: STT_LANGS.slice(), detectsLanguage: true,
      streaming: false, alignment: 'none', nativeSpeed: null, ssml: false,
      maxChars: 0, formats: [], quota: false,
    }
  },

  async health(inst, signal) {
    if (!this.configured(inst)) return { ok: false, status: 'down', detail: 'no API key' }
    try {
      const up = await request(joinUrl(root(inst), '/v2/pre-recorded?limit=1'), { method: 'GET', headers: auth(inst), timeout: 8000, signal })
      if (up.status === 200) return { ok: true, status: 'up', detail: '' }
      if (up.status === 401 || up.status === 403) return { ok: false, status: 'down', detail: 'key rejected' }
      return { ok: false, status: 'unknown', detail: 'http ' + up.status }
    } catch (e) { return { ok: false, status: 'down', detail: scrub(e.message, 80) } }
  },

  async listVoices() { return [] },

  async tts() { throw voiceErr('gladia has no text to speech', 'disabled', 503) },

  async stt({ audio, name, mime, lang, model, wantWords }, inst, signal) {
    const l = lang && lang !== 'auto' ? lang2(lang) : ''
    const m = pickModel(model || (inst.models && inst.models.stt), l)
    let data = audio
    let fname = name || 'dictation.wav'
    let ctype = mime || 'audio/wav'
    if (!acceptedContainer(audio)) { data = await toWav(audio); fname = fname.replace(/\.[A-Za-z0-9]+$/, '') + '.wav'; ctype = 'audio/wav' }
    const base = root(inst)
    const mp = multipart({}, { field: 'audio', name: fname, type: ctype, data })
    const up = await request(joinUrl(base, '/v2/upload'), {
      method: 'POST', signal, timeout: 120000,
      headers: Object.assign({ 'content-type': mp.contentType }, auth(inst)), body: mp.body,
    })
    if (up.status !== 200 && up.status !== 201) throw typed(up.status, up.body.toString('utf8'), 'upload')
    const audioUrl = (parseJson(up.body) || {}).audio_url
    if (!audioUrl) throw voiceErr('gladia upload: no audio_url in response', 'vendor', 502)

    const language_config = l ? { languages: [l], code_switching: false } : { languages: STT_LANGS.slice(), code_switching: false }
    const init = await request(joinUrl(base, '/v2/pre-recorded'), {
      method: 'POST', signal, timeout: 60000,
      headers: Object.assign({ 'content-type': 'application/json' }, auth(inst)),
      body: jsonBody({ audio_url: audioUrl, model: m, language_config }),
    })
    if (init.status !== 200 && init.status !== 201) throw typed(init.status, init.body.toString('utf8'), 'init')
    const id = (parseJson(init.body) || {}).id
    if (!id) throw voiceErr('gladia init: no job id in response', 'vendor', 502)

    const every = Math.max(1, Number(inst.options && inst.options.pollMs) || 1000)
    const deadline = Date.now() + 180000
    try {
      for (;;) {
        const st = await request(joinUrl(base, '/v2/pre-recorded/' + encodeURIComponent(id)), { method: 'GET', headers: auth(inst), timeout: 30000, signal })
        if (st.status !== 200) throw typed(st.status, st.body.toString('utf8'), 'result')
        const doc = parseJson(st.body) || {}
        if (doc.status === 'done') {
          const p = parseResult(doc.result)
          const out = { text: p.text, language: p.language || (l || null), words: wantWords === false ? null : p.words }
          if (p.confidence !== undefined) out.confidence = p.confidence
          const dur = doc.result && doc.result.metadata && Number(doc.result.metadata.audio_duration)
          if (dur) out.durationS = dur
          return out
        }
        if (doc.status === 'error') {
          const code = Number(doc.error_code) || 0
          throw voiceErr('gladia transcription failed (error_code ' + code + ')', code === 429 ? 'quota_exceeded' : 'vendor', code === 429 ? 429 : 502)
        }
        if (Date.now() > deadline) throw voiceErr('gladia stt: job did not finish in time', 'timeout', 504)
        await sleep(every, signal)
      }
    } finally {
      request(joinUrl(base, '/v2/pre-recorded/' + encodeURIComponent(id)), { method: 'DELETE', headers: auth(inst), timeout: 8000 }).catch(() => {})
    }
  },
}
