/**
 * Provider type `piper`: the Piper HTTP server of OHF-Voice/piper1-gpl
 * (`python3 -m piper.http_server -m <voice>`, default port 5000).
 * Verified request shape (docs/API_HTTP.md, 2026-10-31): POST /synthesize with JSON
 * { text, voice?, speaker?, speaker_id?, length_scale?, noise_scale?, noise_w_scale? }
 * returns audio/wav; GET /voices returns { "<voice name>": { <voice config> } }.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, lang2 } from '../http.js'

const TTL_MS = 600000

const csv = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
const hdr = (inst, extra) => {
  const h = Object.assign({}, extra || {})
  const k = inst.secret ? inst.secret() : ''
  if (k) h.authorization = 'Bearer ' + k
  return h
}

/** Piper voice names look like el_GR-rapunzelina-medium: language_REGION-name-quality. */
export function langOfVoice(name) {
  const m = /^([a-z]{2,3})_[A-Za-z]{2}-/.exec(String(name || ''))
  return m ? m[1].slice(0, 2).toLowerCase() : ''
}

/** Seconds of a PCM wav, from its fmt and data chunks. */
export function wavSeconds(buf) {
  if (!buf || buf.length < 44 || buf.slice(0, 4).toString('latin1') !== 'RIFF') return null
  let byteRate = 0
  let pos = 12
  while (pos + 8 <= buf.length) {
    const id = buf.slice(pos, pos + 4).toString('latin1')
    let size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') byteRate = buf.readUInt32LE(pos + 16)
    if (id === 'data') {
      if (size === 0xffffffff || pos + 8 + size > buf.length) size = buf.length - pos - 8
      return byteRate ? size / byteRate : null
    }
    pos += 8 + size + (size % 2)
  }
  return null
}

async function loadVoices(inst, signal, force) {
  const st = inst.state
  const now = Date.now()
  if (!force && st.piper && now - st.piper.at < TTL_MS) return st.piper.list
  const up = await request(joinUrl(inst.baseUrl, '/voices'), { method: 'GET', signal, timeout: 8000, headers: hdr(inst, { accept: 'application/json' }) })
  if (up.status !== 200) throw voiceErr('piper voices ' + up.status + ': ' + scrub(up.body.toString('utf8'), 160), up.status === 401 || up.status === 403 ? 'bad_key' : 'vendor', 502)
  const j = parseJson(up.body) || {}
  const list = Object.keys(j).map((id) => {
    const cfg = j[id] || {}
    const l = (cfg.language && cfg.language.family) || langOfVoice(id) || (cfg.espeak && cfg.espeak.voice ? lang2(cfg.espeak.voice) : '')
    const sp = Number(cfg.num_speakers) || 1
    return { id, name: id, langs: l ? [lang2(l)] : [], gender: null, accent: null, tags: sp > 1 ? ['multi-speaker'] : [] }
  })
  st.piper = { at: now, list }
  return list
}

export default {
  type: 'piper',
  label: 'Piper (self-hosted)',
  hq: 'self',
  euNote: 'Runs on your own machine, nothing leaves it.',
  group: 'self',
  residency: 'self',
  desc: 'Fast local neural voices through the Piper HTTP server; many languages including Greek and Italian voices.',
  docs: 'https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_HTTP.md',
  status: 'verified',
  verification: 'Fetched 2026-10-31: piper1-gpl docs/API_HTTP.md and src/piper/http_server.py (routes GET /, GET /info, GET /voices, GET /all-voices, POST /synthesize; default port 5000). '
    + 'NOTE the brief assumed POST /, the real route is POST /synthesize. The voices catalogue (rhasspy/piper-voices voices.json) lists el_GR-joy-medium, el_GR-rapunzelina-low, el_GR-rapunzelina-medium and it_IT-paola-medium, it_IT-riccardo-x_low, it_IT-serena-medium, it_IT-serena-high. '
    + 'The server only serves voices downloaded to its data dir. Unverified: word alignment (the web page shows phoneme alignment for the last utterance via /info, shape not documented, so alignment is none), authentication (the server has none; a bearer is sent only if you put one in front).',
  presets: [
    { id: 'local', label: 'Piper HTTP server (local)', baseUrl: 'http://127.0.0.1:5000', options: { keyless: true }, group: 'self', residency: 'self' },
  ],
  optionFields: [
    { key: 'ttsLangs', label: 'Languages', type: 'text', help: 'Comma list of 2-letter codes. Filled from the voice list after Test; set it by hand to override.' },
    { key: 'keyless', label: 'No API key needed', type: 'bool', help: 'The Piper server has no authentication.', default: true },
  ],
  configFields: ['baseUrl', 'credential', 'defaultVoice', 'options'],
  defaultBaseUrl: 'http://127.0.0.1:5000',

  configured(inst) { return Boolean(inst.baseUrl) },

  capabilities(inst) {
    const o = inst.options || {}
    const forced = csv(o.ttsLangs)
    const seen = inst.state && inst.state.piper ? Array.from(new Set(inst.state.piper.list.flatMap((v) => v.langs))) : []
    return {
      tts: true, stt: false,
      ttsLangs: forced.includes('*') ? '*' : (forced.length ? forced : seen),
      sttLangs: [], detectsLanguage: false, streaming: false, alignment: 'none', nativeSpeed: [0.5, 2],
      ssml: false, maxChars: 4000, formats: ['wav'], quota: false,
    }
  },

  async health(inst, signal) {
    try {
      const list = await loadVoices(inst, signal, true)
      return { ok: true, status: 'up', detail: list.length + ' voices' }
    } catch (e) {
      return { ok: false, status: 'down', detail: scrub(String((e && e.message) || e), 120) }
    }
  },

  async listVoices(inst, opts, signal) {
    const list = await loadVoices(inst, signal, false)
    const want = opts && opts.lang ? lang2(opts.lang) : ''
    return want ? list.filter((v) => v.langs.includes(want)) : list.slice()
  },

  async tts({ text, voice, lang, speed }, inst, signal) {
    let vid = String(voice || '').trim()
    let note = ''
    let list = null
    try { list = await loadVoices(inst, signal, false) } catch (e) { list = null }
    if (list && list.length) {
      if (vid && !list.some((v) => v.id === vid)) { note = 'voice not on this server; used a matching one'; vid = '' }
      if (!vid && lang) { const m = list.find((v) => v.langs.includes(lang2(lang))); if (m) vid = m.id }
    }
    vid = vid || inst.defaultVoice || ''
    const body = { text }
    if (vid) body.voice = vid
    const sp = Number(speed)
    if (sp && sp !== 1 && sp > 0) body.length_scale = Math.round((1 / sp) * 1000) / 1000
    const up = await request(joinUrl(inst.baseUrl, '/synthesize'), {
      method: 'POST', signal, timeout: 120000, headers: hdr(inst, { 'content-type': 'application/json' }), body: jsonBody(body),
    })
    if (up.status !== 200) {
      const t = up.body.toString('utf8')
      if (up.status === 401 || up.status === 403) throw voiceErr('piper tts ' + up.status + ': ' + scrub(t, 200), 'bad_key', 502)
      if (up.status === 429) throw voiceErr('piper tts 429: ' + scrub(t, 200), 'quota_exceeded', 429)
      if ((up.status === 400 || up.status === 404 || up.status === 500) && /voice/i.test(t)) throw voiceErr('piper tts ' + up.status + ': ' + scrub(t, 200), 'bad_voice', 400)
      throw voiceErr('piper tts ' + up.status + ': ' + scrub(t, 200), 'vendor', 502)
    }
    return { audio: up.body, mime: 'audio/wav', voice: vid || null, model: null, billedChars: text.length, alignment: null, durationS: wavSeconds(up.body), note }
  },
}
