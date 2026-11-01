/**
 * Provider type `fish`: Fish Audio cloud API (https://api.fish.audio).
 * TTS: POST /v1/tts, Bearer key, `model` HEADER (s2.1-pro, s2.1-pro-free, s2-pro, drama-3, s1),
 * JSON { text, reference_id, format, prosody: { speed }, ... } returns the audio bytes.
 * STT: POST /v1/asr multipart, `model` HEADER transcribe-1-pro; ignore_timestamps=false gives
 * word segments [{ text, start, end }]. Voices: GET /model (public library or own, languages per voice).
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, multipart, lang2 } from '../http.js'

const TTL_MS = 600000
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg' }
const FORMATS = ['mp3', 'wav', 'opus']
/**
 * Languages confirmed in the docs: the text-normalisation table of the TTS guide plus the S1 list
 * (English, Chinese, Japanese, German, French, Spanish, Korean, Arabic, Russian, Dutch, Italian, Polish, Portuguese).
 * S2.1-Pro claims 83 languages but publishes no list, so Greek is UNVERIFIED and left out.
 */
const LANGS = ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ar', 'tr', 'tl', 'nl', 'pl']

const csv = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
const langs = (v, def) => { const l = csv(v); return l.length ? (l.includes('*') ? '*' : l) : def }
const key = (inst) => (inst.secret ? inst.secret() : '')

function fail(kind, up) {
  const t = up.body.toString('utf8')
  const m = 'fish ' + kind + ' ' + up.status + ': ' + scrub(t, 200)
  if (up.status === 401 || up.status === 403) return voiceErr(m, 'bad_key', 502)
  if (up.status === 402 || up.status === 429) return voiceErr(m, 'quota_exceeded', 429)
  if ((up.status === 400 || up.status === 404 || up.status === 422) && /reference|model not found|voice/i.test(t) && kind === 'tts') return voiceErr(m, 'bad_voice', 400)
  return voiceErr(m, 'vendor', 502)
}

export default {
  type: 'fish',
  label: 'Fish Audio',
  hq: 'US',
  euNote: 'No EU region is documented; audio goes to Fish Audio (company seat US, unverified). Treat as non-EU.',
  group: 'other',
  residency: 'non-eu',
  desc: 'Expressive cloud TTS with a large voice library and voice cloning, plus transcribe-1-pro speech to text with word timings.',
  docs: 'https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech',
  status: 'partial',
  verification: 'Fetched 2026-10-31 from docs.fish.audio: Text to Speech (POST /v1/tts, Bearer, `model` header, body fields, formats mp3/wav/opus/pcm, prosody.speed 0.5 to 2), '
    + 'Speech to Text (POST /v1/asr multipart, model header transcribe-1-pro, language hint, ignore_timestamps, segments [{text,start,end}], language_code, speaker markers in text), List Models (GET /model, items with _id, title, languages, tags), '
    + 'models overview (S2.1-Pro 83 languages without a list; S1 deprecated, retires 2026-12-31; transcribe-1 retires 2026-12-31), TTS guide (normalisation languages incl. Italian). '
    + 'Unverified: Greek support (not in any published list, so not advertised; override with the languages option), EU residency or an EU endpoint, company seat, TTS word timestamps (a with-timestamps route is mentioned but not documented, so alignment is none), maximum text length, STT language list.',
  presets: [
    { id: 'fish', label: 'Fish Audio', baseUrl: 'https://api.fish.audio', models: { tts: 's2.1-pro', stt: 'transcribe-1-pro' }, group: 'other', residency: 'non-eu' },
    { id: 'fish-free', label: 'Fish Audio (free dev model)', baseUrl: 'https://api.fish.audio', models: { tts: 's2.1-pro-free', stt: 'transcribe-1-pro' }, group: 'other', residency: 'non-eu' },
  ],
  optionFields: [
    { key: 'format', label: 'Audio format', type: 'select', choices: FORMATS, help: 'Output format of speech.', default: 'mp3' },
    { key: 'ttsLangs', label: 'TTS languages', type: 'text', help: 'Comma list of 2-letter codes. Add el here if your tests show Greek works.' },
    { key: 'sttLangs', label: 'STT languages', type: 'text', help: 'Comma list of 2-letter codes. Empty uses the verified list.' },
    { key: 'ownVoices', label: 'Only my own voices', type: 'bool', help: 'List only voices of your workspace instead of the public library.', default: false },
  ],
  configFields: ['baseUrl', 'credential', 'models', 'defaultVoice', 'options'],
  defaultBaseUrl: 'https://api.fish.audio',

  configured(inst) { return Boolean(key(inst)) },

  capabilities(inst) {
    const o = inst.options || {}
    return {
      tts: true, stt: true, ttsLangs: langs(o.ttsLangs, LANGS), sttLangs: langs(o.sttLangs, LANGS), detectsLanguage: true,
      streaming: false, alignment: 'none', nativeSpeed: [0.5, 2], ssml: false, maxChars: 4000, formats: FORMATS.slice(), quota: false,
    }
  },

  async health(inst, signal) {
    if (!this.configured(inst)) return { ok: false, status: 'down', detail: 'no API key' }
    try {
      const up = await request(joinUrl(inst.baseUrl, '/model?page_size=1'), { method: 'GET', signal, timeout: 6000, headers: { authorization: 'Bearer ' + key(inst) } })
      if (up.status === 200) return { ok: true, status: 'up', detail: '' }
      if (up.status === 401 || up.status === 403) return { ok: false, status: 'down', detail: 'Fish Audio rejected the API key (' + up.status + ')' }
      return { ok: false, status: 'down', detail: 'HTTP ' + up.status }
    } catch (e) { return { ok: false, status: 'down', detail: scrub(String((e && e.message) || e), 120) } }
  },

  async listVoices(inst, opts, signal) {
    const want = opts && opts.lang ? lang2(opts.lang) : ''
    const own = (inst.options || {}).ownVoices === true
    const ck = (own ? 'own:' : 'pub:') + want
    const st = inst.state
    st.fishVoices = st.fishVoices || {}
    const hit = st.fishVoices[ck]
    if (hit && Date.now() - hit.at < TTL_MS) return hit.list.slice()
    const q = ['page_size=50', 'sort_by=score']
    if (own) q.push('self=true')
    if (want) q.push('language=' + encodeURIComponent(want))
    const up = await request(joinUrl(inst.baseUrl, '/model?' + q.join('&')), { method: 'GET', signal, timeout: 10000, headers: { authorization: 'Bearer ' + key(inst), accept: 'application/json' } })
    if (up.status !== 200) throw fail('voices', up)
    const j = parseJson(up.body) || {}
    const list = (Array.isArray(j.items) ? j.items : []).map((x) => ({
      id: String(x._id || ''), name: String(x.title || x._id || ''),
      langs: Array.from(new Set((Array.isArray(x.languages) ? x.languages : []).map(lang2))),
      gender: null, accent: null, tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
    })).filter((v) => v.id)
    st.fishVoices[ck] = { at: Date.now(), list }
    return list.slice()
  },

  async tts({ text, voice, speed, model }, inst, signal) {
    const modelId = String(model || '').trim() || (inst.models && inst.models.tts) || 's2.1-pro'
    const fmt = FORMATS.includes(String((inst.options || {}).format || 'mp3')) ? String((inst.options || {}).format || 'mp3') : 'mp3'
    const vid = String(voice || '').trim() || inst.defaultVoice || ''
    const body = { text, format: fmt, normalize: true }
    if (vid) body.reference_id = vid
    const sp = Number(speed)
    if (sp && sp !== 1) body.prosody = { speed: Math.min(2, Math.max(0.5, sp)) }
    const up = await request(joinUrl(inst.baseUrl, '/v1/tts'), {
      method: 'POST', signal, timeout: 120000,
      headers: { authorization: 'Bearer ' + key(inst), 'content-type': 'application/json', model: modelId }, body: jsonBody(body),
    })
    if (up.status !== 200) throw fail('tts', up)
    return { audio: up.body, mime: MIME[fmt], voice: vid || null, model: modelId, billedChars: text.length, alignment: null, durationS: null }
  },

  async stt({ audio, name, mime, lang, model, wantWords }, inst, signal) {
    const modelId = String(model || '').trim() || (inst.models && inst.models.stt) || 'transcribe-1-pro'
    const fields = {}
    if (lang) fields.language = lang2(lang)
    fields.ignore_timestamps = wantWords ? 'false' : 'true'
    if (modelId === 'transcribe-1-pro') { fields.tag_audio_events = 'false'; fields.diarize = 'false' }
    const mp = multipart(fields, { field: 'audio', name: name || 'dictation.webm', type: mime || 'audio/webm', data: audio })
    const up = await request(joinUrl(inst.baseUrl, '/v1/asr'), {
      method: 'POST', signal, timeout: 180000,
      headers: { authorization: 'Bearer ' + key(inst), 'content-type': mp.contentType, model: modelId }, body: mp.body,
    })
    if (up.status !== 200) throw fail('stt', up)
    const j = parseJson(up.body) || {}
    const words = wantWords && Array.isArray(j.segments)
      ? j.segments.map((s) => ({ w: String((s && s.text) || '').trim(), t0: Number(s && s.start) || 0, t1: Number(s && s.end) || 0 })).filter((w) => w.w)
      : null
    const text = String(j.text || '').replace(/<\|speaker:\d+\|>/g, ' ').replace(/\s+/g, ' ').trim()
    return { text, language: j.language_code ? lang2(j.language_code) : null, words, durationS: typeof j.duration === 'number' ? j.duration : undefined }
  },
}
