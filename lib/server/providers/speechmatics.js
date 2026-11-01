/**
 * Provider type `speechmatics`: STT over the Batch REST API (v2) plus the
 * English-only TTS preview.
 *
 * Verified 2026-10-31 against docs.speechmatics.com (batch quickstart, input,
 * output, synchronous, limits, authentication, regions, languages, TTS quickstart):
 *  - POST {host}/v2/jobs/  multipart: `data_file` (audio) + `config` (JSON string),
 *    header `Authorization: Bearer <key>`, answers 201 {id}.
 *  - GET  {host}/v2/jobs/{id}  -> {job:{status: running|done|rejected, errors?}}.
 *  - GET  {host}/v2/jobs/{id}/transcript?format=json-v2 -> results[] with
 *    type word|punctuation, start_time, end_time, alternatives[0].content,
 *    punctuation carries attaches_to.
 *  - Batch hosts: eu1.asr.api.speechmatics.com (all customers), eu2 (enterprise
 *    failover only), us1, au1. The endpoint chosen IS the region.
 *  - TTS preview: POST https://preview.tts.speechmatics.com/generate/<voice>,
 *    JSON {"text"}, Bearer key, answers a 16 kHz mono wav. English voices only.
 * Not verified: DELETE /v2/jobs/{id} (only listed in the API reference menu),
 * the `limit` query of the job list used by health(). Realtime WebSocket is left
 * out on purpose: the protocol page was not readable here.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, multipart, toWav, lang2 } from '../http.js'

const STT_LANGS = ['el', 'it', 'en']
const TTS_VOICES = [
  { id: 'sarah', name: 'Sarah (English, UK, female)', langs: ['en'], gender: 'female', accent: 'en-GB', tags: ['preview'] },
  { id: 'theo', name: 'Theo (English, UK, male)', langs: ['en'], gender: 'male', accent: 'en-GB', tags: ['preview'] },
  { id: 'megan', name: 'Megan (English, US, female)', langs: ['en'], gender: 'female', accent: 'en-US', tags: ['preview'] },
  { id: 'jack', name: 'Jack (English, US, male)', langs: ['en'], gender: 'male', accent: 'en-US', tags: ['preview'] },
]
const TTS_HOST = 'https://preview.tts.speechmatics.com'

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(voiceErr('request aborted', 'timeout', 504)) }, { once: true })
})

function regionOf(inst) { return String(inst.region || (inst.options && inst.options.region) || 'eu1').toLowerCase() }

/** Batch API root (".../v2"). An explicit baseUrl always wins over the region. */
export function apiBase(inst) {
  const b = String(inst.baseUrl || '').replace(/\/+$/, '')
  if (b) return b.replace(/\/v2$/, '') + '/v2'
  const r = regionOf(inst)
  return 'https://' + (/^[a-z]{2}[0-9]$/.test(r) ? r : 'eu1') + '.asr.api.speechmatics.com/v2'
}

function auth(inst) { return { authorization: 'Bearer ' + inst.secret() } }

function typed(status, body, what) {
  const msg = 'speechmatics ' + what + ' ' + status + ': ' + scrub(body, 200)
  if (status === 401 || status === 403) return voiceErr(msg, 'bad_key', 502)
  if (status === 429) return voiceErr(msg, 'quota_exceeded', 429)
  if (status === 404 && what === 'tts') return voiceErr(msg, 'bad_voice', 400)
  if (status === 400 && /voice/i.test(body)) return voiceErr(msg, 'bad_voice', 400)
  if (status === 400 && /language/i.test(body)) return voiceErr(msg, 'unsupported_lang', 400)
  return voiceErr(msg, 'vendor', 502)
}

/** Formats the batch API accepts as is (wav mp3 aac ogg amr m4a mp4 flac); webm is not on the list. */
function acceptedContainer(buf) {
  if (!buf || buf.length < 12) return false
  const h = buf.slice(0, 4).toString('latin1')
  if (h === 'RIFF' || h === 'OggS' || h === 'fLaC') return true
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return true
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return true
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
}

/** json-v2 results -> { text, words, language, confidence }. */
export function parseTranscript(doc) {
  const results = (doc && Array.isArray(doc.results)) ? doc.results : []
  const lp = (doc && doc.metadata && doc.metadata.language_pack_info) || {}
  const delim = typeof lp.word_delimiter === 'string' ? lp.word_delimiter : ' '
  let text = ''
  let glue = true // no delimiter needed before the next token
  const words = []
  let conf = 0
  let lang = ''
  for (const r of results) {
    const alt = (r.alternatives && r.alternatives[0]) || {}
    const c = String(alt.content || '')
    if (!c) continue
    if (r.type === 'punctuation') {
      const at = r.attaches_to || 'previous'
      if (at === 'previous' || at === 'both') { text += c; glue = at === 'both' }
      else if (at === 'next') { text += (glue ? '' : delim) + c; glue = true }
      else { text += (glue ? '' : delim) + c; glue = false }
      continue
    }
    if (r.type !== 'word' && r.type !== 'entity') continue
    text += (glue ? '' : delim) + c
    glue = false
    words.push({ w: c, t0: Number(r.start_time) || 0, t1: Number(r.end_time) || 0 })
    conf += Number(alt.confidence) || 0
    if (!lang && alt.language) lang = alt.language
  }
  text = text.trim()
  const md = (doc && doc.metadata) || {}
  const li = md.language_identification
  if (!lang && li && li.results && li.results[0] && li.results[0].alternatives && li.results[0].alternatives[0]) lang = li.results[0].alternatives[0].language
  if (!lang && md.transcription_config) lang = md.transcription_config.language || ''
  return { text, words, language: lang && lang !== 'auto' ? lang2(lang) : null, confidence: words.length ? conf / words.length : undefined }
}

export default {
  type: 'speechmatics',
  label: 'Speechmatics',
  hq: 'GB',
  euNote: 'UK company; the EU1 endpoint (eu1.asr.api.speechmatics.com) processes batch audio in Europe. The TTS preview host does not state a region.',
  group: 'eu',
  residency: 'eu-region',
  desc: 'High accuracy transcription with Greek, Italian and English on a pinned EU1 batch endpoint; free English TTS preview.',
  docs: 'https://docs.speechmatics.com/speech-to-text/batch/quickstart',
  status: 'partial',
  verification:
    'Checked 2026-10-31 on docs.speechmatics.com (batch quickstart, input, output, synchronous, limits, authentication, regions, languages, TTS quickstart). ' +
    'Confirmed: POST /v2/jobs/ multipart (data_file + config JSON) with a Bearer key, status polling on GET /v2/jobs/{id} (running, done, rejected), ' +
    'GET /v2/jobs/{id}/transcript?format=json-v2 with word start_time/end_time, hosts eu1 (all customers) and eu2 (enterprise failover), el/it/en in the language list, ' +
    'accepted containers (wav mp3 aac ogg amr m4a mp4 flac; webm is converted to wav), TTS preview endpoint preview.tts.speechmatics.com/generate/<voice> with four English voices and wav 16 kHz output. ' +
    'Unverified: DELETE /v2/jobs/{id} cleanup and the job list used by health() (only named in the API reference menu), the preview TTS data region and its stability (preview, pricing announced separately). ' +
    'Realtime WebSocket (wss://eu.rt.speechmatics.com/v2) is not implemented: the protocol reference could not be read, so it is left out.',
  presets: [
    { id: 'speechmatics-eu1', label: 'Speechmatics EU1', region: 'eu1', models: { stt: 'enhanced' } },
    { id: 'speechmatics-eu2', label: 'Speechmatics EU2 (enterprise failover)', region: 'eu2', models: { stt: 'enhanced' } },
  ],
  regions: [
    { id: 'eu1', label: 'EU1 (Europe)', eu: true },
    { id: 'eu2', label: 'EU2 (Europe, enterprise failover only)', eu: true },
    { id: 'us1', label: 'US1 (USA)', eu: false },
    { id: 'au1', label: 'AU1 (Australia)', eu: false },
  ],
  optionFields: [
    { key: 'ttsHost', label: 'TTS preview host', type: 'text', default: TTS_HOST, help: 'English-only preview synthesis; the host states no region.' },
    { key: 'pollSeconds', label: 'Wait per status poll (s)', type: 'number', default: 10, help: 'Passed as the wait query to the job status call.' },
  ],
  residencyOf(inst) {
    if (inst.baseUrl) return 'varies'
    const r = regionOf(inst)
    return r === 'eu1' || r === 'eu2' ? 'eu-region' : 'non-eu'
  },
  configFields: ['baseUrl', 'credential', 'region', 'models', 'defaultVoice', 'options'],
  defaultBaseUrl: '',

  configured(inst) { return Boolean(inst.secret()) },

  capabilities() {
    return {
      tts: true, stt: true,
      ttsLangs: ['en'], sttLangs: STT_LANGS.slice(), detectsLanguage: true,
      streaming: false, alignment: 'none', nativeSpeed: null, ssml: false,
      maxChars: 3000, formats: ['wav'], quota: false,
    }
  },

  async health(inst, signal) {
    if (!this.configured(inst)) return { ok: false, status: 'down', detail: 'no API key' }
    try {
      const up = await request(joinUrl(apiBase(inst), '/jobs/?limit=1'), { method: 'GET', headers: auth(inst), timeout: 8000, signal })
      if (up.status === 200) return { ok: true, status: 'up', detail: regionOf(inst) }
      if (up.status === 401 || up.status === 403) return { ok: false, status: 'down', detail: 'key rejected' }
      return { ok: false, status: 'unknown', detail: 'http ' + up.status }
    } catch (e) { return { ok: false, status: 'down', detail: scrub(e.message, 80) } }
  },

  async listVoices(inst, opts) {
    const l = opts && opts.lang ? lang2(opts.lang) : ''
    return TTS_VOICES.filter((v) => !l || v.langs.includes(l)).map((v) => Object.assign({}, v))
  },

  async tts({ text, voice, lang }, inst, signal) {
    if (lang && lang2(lang) !== 'en') throw voiceErr('speechmatics TTS preview speaks English only', 'unsupported_lang', 400)
    const known = (id) => TTS_VOICES.some((v) => v.id === id)
    const want = String(voice || '').toLowerCase()
    const dflt = String(inst.defaultVoice || '').toLowerCase()
    const v = known(want) ? want : (known(dflt) ? dflt : 'sarah')
    const host = inst.baseUrl ? String(inst.baseUrl).replace(/\/+$/, '') : String((inst.options && inst.options.ttsHost) || TTS_HOST).replace(/\/+$/, '')
    const up = await request(joinUrl(host, '/generate/' + v + '?output_format=wav_16000'), {
      method: 'POST', signal, timeout: 60000,
      headers: Object.assign({ 'content-type': 'application/json' }, auth(inst)),
      body: jsonBody({ text }),
    })
    if (up.status !== 200) throw typed(up.status, up.body.toString('utf8'), 'tts')
    if (!up.body.length) throw voiceErr('speechmatics tts: empty audio', 'vendor', 502)
    const durationS = up.body.length > 44 ? (up.body.length - 44) / 32000 : 0
    return { audio: up.body, mime: 'audio/wav', voice: v, model: 'preview', billedChars: String(text).length, alignment: null, durationS }
  },

  async stt({ audio, name, mime, lang, model, wantWords }, inst, signal) {
    const l = lang && lang !== 'auto' ? lang2(lang) : ''
    const m = model || (inst.models && inst.models.stt) || 'enhanced'
    let data = audio
    let fname = name || 'dictation.wav'
    let ctype = mime || 'audio/wav'
    if (!acceptedContainer(audio)) { data = await toWav(audio); fname = fname.replace(/\.[A-Za-z0-9]+$/, '') + '.wav'; ctype = 'audio/wav' }
    const tc = { language: l || (m === 'melia-1' ? 'multi' : 'auto'), model: m }
    const config = { type: 'transcription', transcription_config: tc }
    if (!l && m !== 'melia-1') config.language_identification_config = { expected_languages: STT_LANGS.slice(), low_confidence_action: 'allow' }
    const mp = multipart({ config: JSON.stringify(config) }, { field: 'data_file', name: fname, type: ctype, data })
    const base = apiBase(inst)
    const created = await request(joinUrl(base, '/jobs/'), {
      method: 'POST', signal, timeout: 120000,
      headers: Object.assign({ 'content-type': mp.contentType }, auth(inst)), body: mp.body,
    })
    if (created.status !== 200 && created.status !== 201) throw typed(created.status, created.body.toString('utf8'), 'stt')
    const id = (parseJson(created.body) || {}).id
    if (!id) throw voiceErr('speechmatics stt: no job id in response', 'vendor', 502)
    const wait = Math.max(0, Math.min(30, Number(inst.options && inst.options.pollSeconds) || 10))
    const deadline = Date.now() + 180000
    try {
      for (;;) {
        const st = await request(joinUrl(base, '/jobs/' + encodeURIComponent(id) + '?wait=' + wait), { method: 'GET', headers: auth(inst), timeout: (wait + 15) * 1000, signal })
        if (st.status !== 200) throw typed(st.status, st.body.toString('utf8'), 'stt status')
        const job = (parseJson(st.body) || {}).job || {}
        if (job.status === 'done') {
          const tr = await request(joinUrl(base, '/jobs/' + encodeURIComponent(id) + '/transcript?format=json-v2'), { method: 'GET', headers: auth(inst), timeout: 30000, signal })
          if (tr.status !== 200) throw typed(tr.status, tr.body.toString('utf8'), 'stt transcript')
          const doc = parseJson(tr.body) || {}
          const p = parseTranscript(doc)
          const out = { text: p.text, language: p.language || (l || null), words: wantWords === false ? null : p.words }
          if (p.confidence !== undefined) out.confidence = p.confidence
          if (doc.job && Number(doc.job.duration)) out.durationS = Number(doc.job.duration)
          return out
        }
        if (job.status === 'rejected' || job.status === 'deleted') {
          const msg = (job.errors && job.errors[0] && job.errors[0].message) || 'job ' + job.status
          const isLang = /language/i.test(msg)
          throw voiceErr('speechmatics stt rejected: ' + scrub(msg, 160), isLang ? 'unsupported_lang' : 'vendor', isLang ? 400 : 502)
        }
        if (Date.now() > deadline) throw voiceErr('speechmatics stt: job did not finish in time', 'timeout', 504)
        await sleep(250, signal)
      }
    } finally {
      // Best effort privacy cleanup (the service keeps jobs 7 days); failures are ignored.
      request(joinUrl(base, '/jobs/' + encodeURIComponent(id)), { method: 'DELETE', headers: auth(inst), timeout: 8000 }).catch(() => {})
    }
  },
}
