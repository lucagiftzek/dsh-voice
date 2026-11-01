/**
 * Provider type `xtts`: Coqui XTTS-v2 behind daswer123/xtts-api-server (default port 8020).
 * Verified from server.py 2026-10-31: POST /tts_to_audio/ JSON { text, speaker_wav, language }
 * returns audio/wav (24 kHz); GET /speakers, GET /speakers_list, GET /languages;
 * language must be one of the server's supported codes (400 otherwise).
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, lang2 } from '../http.js'

const TTL_MS = 600000
/** XTTS-v2 model card (huggingface.co/coqui/XTTS-v2): 17 languages. Greek is NOT supported. */
export const XTTS_LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'tr', 'ru', 'nl', 'cs', 'ar', 'zh', 'hu', 'ko', 'ja', 'hi']

const csv = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
const hdr = (inst, extra) => {
  const h = Object.assign({}, extra || {})
  const k = inst.secret ? inst.secret() : ''
  if (k) h.authorization = 'Bearer ' + k
  return h
}
/** Server code for a 2-letter tag: Chinese is zh-cn there. */
const serverLang = (l) => (l === 'zh' ? 'zh-cn' : l)

function allowed(inst) {
  const forced = csv((inst.options || {}).ttsLangs)
  return forced.length && !forced.includes('*') ? forced : XTTS_LANGS
}

export default {
  type: 'xtts',
  label: 'Coqui XTTS-v2 (self-hosted)',
  hq: 'self',
  euNote: 'Runs on your own machine. Model licence is CPML (non-commercial) and Coqui, the company behind it, is defunct, so there is no vendor support.',
  group: 'self',
  residency: 'self',
  desc: 'Self-hosted voice cloning in 17 languages including Italian (no Greek); needs a reference speaker clip. Non-commercial licence.',
  docs: 'https://github.com/daswer123/xtts-api-server',
  status: 'partial',
  verification: 'Fetched 2026-10-31: xtts-api-server README and server.py (POST /tts_to_audio/ {text, speaker_wav, language}, GET /speakers, GET /speakers_list, GET /languages, default port 8020) and the coqui/XTTS-v2 model card '
    + '(17 languages: en es fr de it pt pl tr ru nl cs ar zh-cn ja hu ko hi; Greek is NOT supported; licence Coqui Public Model License, non-commercial; Coqui AI is defunct). '
    + 'Unverified: exact JSON shape of /speakers and /languages (parsed leniently), per-request character limit (set to a conservative 200), speed (the server only has a global setting, so no per-request speed). The server needs a speaker_wav name or path on every call: set a default voice.',
  presets: [
    { id: 'local', label: 'xtts-api-server (local)', baseUrl: 'http://127.0.0.1:8020', options: { keyless: true }, group: 'self', residency: 'self' },
  ],
  optionFields: [
    { key: 'ttsLangs', label: 'Languages', type: 'text', help: 'Comma list of 2-letter codes to restrict the 17 XTTS languages (for example en,it).' },
    { key: 'keyless', label: 'No API key needed', type: 'bool', help: 'xtts-api-server has no authentication.', default: true },
  ],
  configFields: ['baseUrl', 'credential', 'defaultVoice', 'options'],
  defaultBaseUrl: 'http://127.0.0.1:8020',

  configured(inst) { return Boolean(inst.baseUrl) },

  capabilities(inst) {
    return {
      tts: true, stt: false, ttsLangs: allowed(inst), sttLangs: [], detectsLanguage: false, streaming: false,
      alignment: 'none', nativeSpeed: null, ssml: false, maxChars: 200, formats: ['wav'], quota: false,
    }
  },

  async health(inst, signal) {
    try {
      const up = await request(joinUrl(inst.baseUrl, '/languages'), { method: 'GET', signal, timeout: 6000, headers: hdr(inst) })
      if (up.status === 200) return { ok: true, status: 'up', detail: '' }
      return { ok: false, status: 'down', detail: 'HTTP ' + up.status }
    } catch (e) { return { ok: false, status: 'down', detail: scrub(String((e && e.message) || e), 120) } }
  },

  async listVoices(inst, opts, signal) {
    const st = inst.state
    const now = Date.now()
    if (!st.xtts || now - st.xtts.at > TTL_MS) {
      let arr = null
      for (const p of ['/speakers', '/speakers_list']) {
        const up = await request(joinUrl(inst.baseUrl, p), { method: 'GET', signal, timeout: 8000, headers: hdr(inst) })
        if (up.status === 200) { const j = parseJson(up.body); if (Array.isArray(j)) { arr = j; break } }
      }
      if (!arr) throw voiceErr('xtts speakers: no speaker list from this server', 'vendor', 502)
      const list = arr.map((x) => {
        const id = typeof x === 'string' ? x : String((x && (x.voice_id || x.name)) || '')
        const name = typeof x === 'string' ? x : String((x && (x.name || x.voice_id)) || '')
        return id ? { id, name, langs: [], gender: null, accent: null, tags: ['clone'] } : null
      }).filter(Boolean)
      st.xtts = { at: now, list }
    }
    return st.xtts.list.slice()
  },

  async tts({ text, voice, lang }, inst, signal) {
    const l = lang2(lang)
    if (!allowed(inst).includes(l)) throw voiceErr('xtts does not speak "' + l + '" (supported: ' + allowed(inst).join(', ') + ')', 'unsupported_lang', 400)
    const speaker = String(voice || '').trim() || inst.defaultVoice
    if (!speaker) throw voiceErr('xtts needs a reference speaker (voice) for every request; set a default voice', 'bad_voice', 400)
    const up = await request(joinUrl(inst.baseUrl, '/tts_to_audio/'), {
      method: 'POST', signal, timeout: 180000, headers: hdr(inst, { 'content-type': 'application/json' }),
      body: jsonBody({ text, speaker_wav: speaker, language: serverLang(l) }),
    })
    if (up.status !== 200) {
      const t = up.body.toString('utf8')
      const m = 'xtts tts ' + up.status + ': ' + scrub(t, 200)
      if (up.status === 401 || up.status === 403) throw voiceErr(m, 'bad_key', 502)
      if (up.status === 429) throw voiceErr(m, 'quota_exceeded', 429)
      if (/language/i.test(t) && up.status === 400) throw voiceErr(m, 'unsupported_lang', 400)
      if (/speaker|voice|wav/i.test(t) && (up.status === 400 || up.status === 404 || up.status === 500)) throw voiceErr(m, 'bad_voice', 400)
      throw voiceErr(m, 'vendor', 502)
    }
    return { audio: up.body, mime: 'audio/wav', voice: speaker, model: 'xtts_v2', billedChars: text.length, alignment: null, durationS: null }
  },
}
