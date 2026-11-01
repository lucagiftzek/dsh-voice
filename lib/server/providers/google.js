/**
 * Provider type `google`: Google Cloud Text-to-Speech v1 / v1beta1 and Speech-to-Text v1.
 *
 * Credential: an API key (X-Goog-Api-Key header). A value that starts with
 * "Bearer " or "ya29." is sent as an OAuth bearer token instead.
 *
 * Endpoints (setting "region": eu | us | global):
 *   TTS  https://eu-texttospeech.googleapis.com   /v1/text:synthesize, /v1/voices, /v1beta1/text:synthesize
 *   STT  https://eu-speech.googleapis.com         /v1/speech:recognize
 *
 * Word timings: v1beta1 text:synthesize with enableTimePointing SSML_MARK and a
 * <mark name="wN"/> before every word. Only voices that take SSML marks qualify
 * (Standard, Wavenet, Neural2, Polyglot, Studio, News). Chirp 3 HD takes a limited SSML
 * tag set without <mark>, Chirp HD and Journey take no marks: those return alignment null.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, isWav, toWav, lang2 } from '../http.js'
import { startsToWords } from '../alignment.js'
import { markWords } from '../ssml.js'

export const REGIONS = [
  { id: 'eu', label: 'EU multi-region (eu-texttospeech / eu-speech)', eu: true },
  { id: 'us', label: 'US multi-region', eu: false },
  { id: 'global', label: 'Global endpoint', eu: false },
]

const LOCALE = { en: 'en-US', el: 'el-GR', it: 'it-IT', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', pt: 'pt-PT', nl: 'nl-NL' }
const DEFAULT_VOICE = {
  en: 'en-US-Neural2-C', el: 'el-GR-Wavenet-B', it: 'it-IT-Neural2-A', de: 'de-DE-Neural2-B',
  fr: 'fr-FR-Neural2-A', es: 'es-ES-Neural2-A', pt: 'pt-PT-Wavenet-A', nl: 'nl-NL-Wavenet-A',
}
const LANGS = Object.keys(LOCALE)
const MARK_RE = /-(Standard|Wavenet|Neural2|Polyglot|Studio|News)-/
const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9-]+$/
const MP3_BPS = 32000

export const regionOf = (inst) => {
  const r = String(inst.region || (inst.options && inst.options.region) || 'eu').toLowerCase()
  return r === 'us' || r === 'global' ? r : 'eu'
}
export const isEuRegion = (r) => r === 'eu'

export function endpointsOf(inst) {
  if (inst.baseUrl) return { tts: String(inst.baseUrl), stt: String(inst.baseUrl) }
  const r = regionOf(inst)
  const p = r === 'global' ? '' : r + '-'
  return { tts: 'https://' + p + 'texttospeech.googleapis.com', stt: 'https://' + p + 'speech.googleapis.com' }
}

function auth(inst) {
  const s = String(inst.secret() || '').trim()
  if (/^bearer\s/i.test(s)) return { authorization: s.replace(/^bearer\s+/i, 'Bearer ') }
  if (/^ya29\./.test(s)) return { authorization: 'Bearer ' + s }
  return { 'x-goog-api-key': s }
}

function typed(status, body, what) {
  const msg = 'google ' + what + ' ' + status + ': ' + scrub(body, 200)
  if (status === 401 || status === 403) return voiceErr(msg, 'bad_key', 502)
  if (status === 429) return voiceErr(msg, 'quota_exceeded', 429)
  if (status === 400 && /voice/i.test(body)) return voiceErr(msg, 'bad_voice', 400)
  if (status === 400 && /(language|locale)/i.test(body)) return voiceErr(msg, 'unsupported_lang', 400)
  return voiceErr(msg, 'vendor', 502)
}

export function pickVoice(inst, voice, lang) {
  const v = String(voice || '').trim()
  if (VOICE_RE.test(v)) return v
  const d = String(inst.defaultVoice || '').trim()
  if (VOICE_RE.test(d) && (!lang || d.slice(0, 2).toLowerCase() === lang2(lang))) return d
  return DEFAULT_VOICE[lang2(lang)] || DEFAULT_VOICE.en
}

export const supportsMarks = (voice) => MARK_RE.test(voice)
const languageCodeOf = (voice) => voice.split('-').slice(0, 2).join('-')

async function synth(inst, version, payload, signal) {
  const up = await request(joinUrl(endpointsOf(inst).tts, '/' + version + '/text:synthesize'), {
    method: 'POST', signal, timeout: 120000,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, auth(inst)),
    body: jsonBody(payload),
  })
  if (up.status !== 200) throw typed(up.status, up.body.toString('utf8'), 'tts')
  const d = parseJson(up.body) || {}
  if (!d.audioContent) throw voiceErr('google tts: no audioContent in response', 'vendor', 502)
  return { audio: Buffer.from(d.audioContent, 'base64'), timepoints: Array.isArray(d.timepoints) ? d.timepoints : [] }
}

const secs = (s) => (s == null ? 0 : Number(String(s).replace(/s$/, '')) || 0)

export default {
  type: 'google',
  label: 'Google Cloud Speech',
  hq: 'US',
  euNote: 'Google (US company). The eu-texttospeech and eu-speech endpoints keep data at rest and in use in Europe; the global endpoint does not.',
  group: 'other',
  residency: 'varies',
  desc: 'Google Cloud voices (Wavenet, Neural2, Chirp 3 HD) with Greek and Italian, and Speech-to-Text; EU endpoint, API key.',
  docs: 'https://docs.cloud.google.com/text-to-speech/docs/reference/rest',
  status: 'partial',
  verification: [
    'Fetched 2026-10-31: regional endpoints page (eu-texttospeech.googleapis.com, EU multi-region, data stays in Europe), the v1beta1 text:synthesize and v1 voices.list discovery documents (request fields input.text/ssml, voice.languageCode/name, audioConfig.audioEncoding/speakingRate, enableTimePointing SSML_MARK, response audioContent base64 and timepoints[markName,timeSeconds], voices[languageCodes,name,ssmlGender]), the SSML page (mark timepoints), the Chirp 3 HD page (SSML tag list without mark), the voice list (Greek el-GR Wavenet-B, Standard-B and Chirp3-HD; Italian Neural2, Wavenet, Standard, Chirp-HD, Chirp3-HD), the Speech-to-Text v1 discovery document (speech:recognize, RecognitionConfig, enableWordTimeOffsets, WordInfo startTime/endTime, WEBM_OPUS and OGG_OPUS need a sample rate of 8000, 12000, 16000, 24000 or 48000, MP3 only in v1p1beta1), the STT regional endpoint page (eu-speech.googleapis.com with v1 recognize) and the STT language table (el-GR and it-IT, default model).',
    'Re-checked 2026-10-31 (pre-merge review): the v1beta1 discovery document has enableTimePointing [SSML_MARK] and timepoints[{markName, timeSeconds}], and /v1beta1/text:synthesize exists on eu-texttospeech.googleapis.com (unauthenticated call answers 403 like /v1, not 404); Chirp 3 HD has no <mark> tag. Google warns that marks in rapid succession may drop events: a word whose mark is missing is not highlighted on its own (the previous word stays lit). Unverified: that v1beta1 timepoints are served by the EU endpoint for every voice, that the EU endpoint offers every Wavenet/Neural2 voice (the endpoints page only shows icons for Chirp and Gemini), the mp3 bitrate used for the duration estimate (32 kbps assumed), the sample rate of browser WebM clips (48000 is sent), and word offsets for Greek on the default model.',
    'Credential: an API key (X-Goog-Api-Key); a value starting with "Bearer " or "ya29." is sent as an OAuth bearer token. Word timings: SSML marks on Standard, Wavenet, Neural2, Polyglot, Studio and News voices only; Chirp 3 HD, Chirp HD and Journey return no timings (client estimates).',
  ].join(' '),
  presets: [
    { id: 'google', label: 'Google Cloud (EU endpoint)', region: 'eu', defaultVoice: 'el-GR-Wavenet-B' },
    { id: 'google-global', label: 'Google Cloud (global endpoint)', region: 'global', defaultVoice: 'el-GR-Wavenet-B' },
  ],
  regions: REGIONS,
  optionFields: [
    { key: 'sttModel', label: 'STT model', type: 'text', help: 'Optional recognition model (for example latest_long). Empty uses the default model.' },
  ],
  configFields: ['credential', 'region', 'defaultVoice', 'options'],
  defaultBaseUrl: '',

  residencyOf(inst) { return isEuRegion(regionOf(inst)) ? 'eu-region' : 'non-eu' },

  configured(inst) { return Boolean(inst.secret()) },

  capabilities() {
    return {
      tts: true, stt: true,
      ttsLangs: LANGS.slice(), sttLangs: LANGS.slice(),
      detectsLanguage: false,
      streaming: false,
      alignment: 'word',
      nativeSpeed: [0.25, 2],
      ssml: true, maxChars: 5000, formats: ['mp3'], quota: false,
    }
  },

  async health(inst, signal) {
    if (!this.configured(inst)) return { ok: false, status: 'down', detail: 'no key' }
    try {
      const up = await request(joinUrl(endpointsOf(inst).tts, '/v1/voices?languageCode=el-GR'), { method: 'GET', headers: auth(inst), timeout: 8000, signal })
      if (up.status === 200) return { ok: true, status: 'up', detail: regionOf(inst) }
      if (up.status === 400 || up.status === 401 || up.status === 403) return { ok: false, status: 'down', detail: 'key rejected (' + up.status + ')' }
      return { ok: false, status: 'down', detail: 'status ' + up.status }
    } catch (e) { return { ok: false, status: 'down', detail: scrub(e && e.message, 120) } }
  },

  async listVoices(inst, opts, signal) {
    const want = opts && opts.lang ? lang2(opts.lang) : ''
    const code = want ? (LOCALE[want] || want) : ''
    const st = inst.state
    st.voiceCache = st.voiceCache || {}
    const hit = st.voiceCache[code]
    const now = Date.now()
    if (hit && now - hit.at < 600000) return hit.voices
    const up = await request(joinUrl(endpointsOf(inst).tts, '/v1/voices' + (code ? '?languageCode=' + encodeURIComponent(code) : '')), {
      method: 'GET', headers: auth(inst), timeout: 15000, signal,
    })
    if (up.status !== 200) throw typed(up.status, up.body.toString('utf8'), 'voices')
    const d = parseJson(up.body) || {}
    const voices = (d.voices || []).filter((v) => v && v.name).map((v) => {
      const codes = v.languageCodes || []
      const langs = []
      codes.forEach((c) => { const l = lang2(c); if (langs.indexOf(l) < 0) langs.push(l) })
      const kind = (/-(Chirp3-HD|Chirp-HD|Neural2|Wavenet|Standard|Studio|Polyglot|News|Journey)-/.exec(v.name) || [])[1]
      return {
        id: v.name, name: v.name, langs, gender: String(v.ssmlGender || '').toLowerCase(),
        accent: codes[0] || '', tags: [kind, supportsMarks(v.name) ? 'word-timings' : ''].filter(Boolean),
      }
    })
    st.voiceCache[code] = { at: now, voices }
    return voices
  },

  async tts({ text, voice, lang, speed, wantAlignment }, inst, signal) {
    const v = pickVoice(inst, voice, lang)
    const t = String(text)
    const audioConfig = { audioEncoding: 'MP3' }
    const s = Number(speed)
    if (s && s !== 1) audioConfig.speakingRate = Math.min(2, Math.max(0.25, s))
    const voiceSel = { languageCode: languageCodeOf(v), name: v }
    let note
    if (wantAlignment && supportsMarks(v)) {
      const mk = markWords(t)
      if (mk.marks.length) {
        try {
          const r = await synth(inst, 'v1beta1', {
            input: { ssml: '<speak>' + mk.body + '</speak>' }, voice: voiceSel, audioConfig,
            enableTimePointing: ['SSML_MARK'],
          }, signal)
          const byName = new Map(mk.marks.map((m) => [m.name, m]))
          const starts = r.timepoints.filter((p) => byName.has(p.markName)).map((p) => {
            const m = byName.get(p.markName)
            return { c0: m.c0, c1: m.c1, t0: Number(p.timeSeconds) || 0 }
          })
          const est = (r.audio.length * 8) / MP3_BPS
          const last = starts.length ? Math.max(...starts.map((x) => x.t0)) : 0
          const dur = Math.max(est, last)
          const items = starts.length ? startsToWords(starts, dur) : null
          return {
            audio: r.audio, mime: 'audio/mpeg', voice: v, model: '', billedChars: t.length,
            alignment: items ? { unit: 'word', items } : null, durationS: dur,
          }
        } catch (e) {
          if (signal && signal.aborted) throw e
          if (e.code === 'bad_key' || e.code === 'quota_exceeded' || e.code === 'bad_voice') throw e
          note = 'word timings unavailable (' + scrub(e && e.message, 80) + '); used plain synthesis'
        }
      }
    }
    const r = await synth(inst, 'v1', { input: { text: t }, voice: voiceSel, audioConfig }, signal)
    return {
      audio: r.audio, mime: 'audio/mpeg', voice: v, model: '', billedChars: t.length,
      alignment: null, durationS: (r.audio.length * 8) / MP3_BPS, note,
    }
  },

  async stt({ audio, lang, model, wantWords }, inst, signal) {
    const l2 = lang ? lang2(lang) : ''
    const config = { enableWordTimeOffsets: Boolean(wantWords), enableAutomaticPunctuation: true }
    if (lang) config.languageCode = String(lang).includes('-') ? lang : (LOCALE[l2] || l2)
    else { config.languageCode = 'el-GR'; config.alternativeLanguageCodes = ['it-IT', 'en-US'] }
    const m = model || (inst.options && inst.options.sttModel)
    if (m) config.model = m
    let buf = audio
    if (buf.length > 4 && buf.slice(0, 4).toString('latin1') === 'OggS') { config.encoding = 'OGG_OPUS'; config.sampleRateHertz = 48000 }
    else if (buf.length > 4 && buf.readUInt32BE(0) === 0x1a45dfa3) { config.encoding = 'WEBM_OPUS'; config.sampleRateHertz = 48000 }
    else if (!isWav(buf)) buf = await toWav(buf)
    const up = await request(joinUrl(endpointsOf(inst).stt, '/v1/speech:recognize'), {
      method: 'POST', signal, timeout: 120000,
      headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, auth(inst)),
      body: jsonBody({ config, audio: { content: buf.toString('base64') } }),
    })
    const body = up.body.toString('utf8')
    if (up.status !== 200) throw typed(up.status, body, 'stt')
    const d = parseJson(body) || {}
    const results = Array.isArray(d.results) ? d.results : []
    const alts = results.map((r) => (r.alternatives && r.alternatives[0]) || {})
    const text = alts.map((a) => String(a.transcript || '').trim()).filter(Boolean).join(' ')
    const words = []
    alts.forEach((a) => (a.words || []).forEach((w) => words.push({ w: w.word, t0: secs(w.startTime), t1: secs(w.endTime) })))
    const confs = alts.map((a) => Number(a.confidence)).filter((c) => c > 0)
    const rl = results.find((r) => r.languageCode)
    return {
      text, language: rl ? lang2(rl.languageCode) : (lang ? l2 : null),
      confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : undefined,
      words: wantWords && words.length ? words : null,
      durationS: d.totalBilledTime ? secs(d.totalBilledTime) : undefined,
    }
  },
}
