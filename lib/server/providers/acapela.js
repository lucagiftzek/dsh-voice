/**
 * Provider type `acapela`: TTS through the Acapela Cloud REST API.
 *
 * A public reference exists at https://acapela-cloud.com/docs_api/ (fetched
 * 2026-10-31). Documented there:
 *  - POST /api/login/ JSON {email, password} -> {token}; the token never expires
 *    until /api/logout/ and is sent as `Authorization: Token <token>`.
 *  - GET /api/account/ -> account info including "voices (name, gender, language, locale)"
 *    (exact JSON keys are not shown, so the parser is tolerant: UNVERIFIED shape).
 *  - GET|POST /api/command/ with voice, text, output (stream|file|events), type
 *    (mp3 default), speed 30..300 (default 100), wordpos=on, samplerate, bitrate.
 *    output=events returns a JSON file with events; a Word event has EventKind,
 *    Time (seconds), WordOffset/WordSize (bytes) and Word.
 *  - errors: 400 {error:'Not enough credit.'}, 400 {error:'Voice not allowed.'},
 *    401 {detail:'Invalid token.'}, 403 {error:'You must be logged.'}.
 * The credential is ONE string "email:password" (split at the first colon).
 */
import { request, joinUrl, parseJson, voiceErr, scrub, lang2 } from '../http.js'
import { tokensToWords, startsToWords } from '../alignment.js'

const HOST = 'https://www.acapela-cloud.com'
const DEFAULT_VOICE = 'Sharon22k_HQ'
const LANG_NAMES = { greek: 'el', italian: 'it', english: 'en' }

const root = (inst) => String(inst.baseUrl || HOST).replace(/\/+$/, '')

function creds(inst) {
  const s = String(inst.secret() || '')
  const i = s.indexOf(':')
  if (i < 1 || i === s.length - 1) return null
  return { email: s.slice(0, i), password: s.slice(i + 1) }
}

function typed(status, body, what) {
  const msg = 'acapela ' + what + ' ' + status + ': ' + scrub(body, 200)
  if (status === 401 || status === 403) return voiceErr(msg, 'bad_key', 502)
  if (status === 429) return voiceErr(msg, 'quota_exceeded', 429)
  if (/not enough credit/i.test(body)) return voiceErr(msg, 'quota_exceeded', 429)
  if (/voice not allowed/i.test(body)) return voiceErr(msg, 'bad_voice', 400)
  return voiceErr(msg, 'vendor', 502)
}

async function login(inst, signal) {
  const c = creds(inst)
  if (!c) throw voiceErr('acapela credential must be "email:password"', 'bad_key', 502)
  const up = await request(joinUrl(root(inst), '/api/login/'), {
    method: 'POST', signal, timeout: 20000,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(c)),
  })
  const body = up.body.toString('utf8')
  if (up.status !== 200) throw (up.status === 400 || up.status === 401 || up.status === 403)
    ? voiceErr('acapela login ' + up.status + ': ' + scrub(body, 120), 'bad_key', 502) : typed(up.status, body, 'login')
  const token = (parseJson(body) || {}).token
  if (!token) throw voiceErr('acapela login: no token in response', 'vendor', 502)
  inst.state.token = token
  return token
}

/** One authenticated call; a stale token (401) is renewed once. */
async function call(inst, signal, path, opts) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = inst.state.token || await login(inst, signal)
    const up = await request(joinUrl(root(inst), path), Object.assign({}, opts, {
      signal, headers: Object.assign({ authorization: 'Token ' + token }, (opts && opts.headers) || {}),
    }))
    if (up.status === 401 && attempt === 0) { inst.state.token = ''; continue }
    return up
  }
  throw voiceErr('acapela: token refused', 'bad_key', 502)
}

function voiceLang(v) {
  const loc = String(v.locale || '')
  if (/^[a-z]{2}[-_]/i.test(loc)) return lang2(loc)
  const l = String(v.language || '').toLowerCase()
  if (/^[a-z]{2,3}([-_]|$)/.test(l)) return l.slice(0, 2)
  return LANG_NAMES[l.split(/[\s(]/)[0]] || ''
}

export function parseEvents(raw) {
  const arr = Array.isArray(raw) ? raw : (raw && (raw.events || raw.Events)) || []
  return arr.filter((e) => e && e.EventKind === 'Word' && e.Word).map((e) => ({ text: String(e.Word), t0: Number(e.Time) || 0 }))
}

export default {
  type: 'acapela',
  label: 'Acapela Cloud',
  hq: 'FR',
  euNote: 'French company; the public API reference does not say where Acapela Cloud hosts or processes requests, so EU processing is not confirmed.',
  group: 'eu',
  residency: 'varies',
  desc: 'Acapela Cloud text to speech with Greek, Italian and English voices and word positions for highlighting.',
  docs: 'https://acapela-cloud.com/docs_api/',
  status: 'partial',
  verification:
    'Checked 2026-10-31: https://www.acapela-group.com/solutions/acapela-cloud/ (product page, links the API), https://acapela-cloud.com/docs_api/ (public API reference, no login), ' +
    'https://acapela-cloud.com/docs_tags/ and https://www.acapela-group.com/voices/available-languages/ (Greek and Italian are offered). ' +
    'Confirmed: POST /api/login/ (email, password -> token), Authorization "Token <t>", GET /api/command/ parameters voice/text/output/type/speed/wordpos, ' +
    'output=events JSON with Word events (EventKind, Time, WordOffset, WordSize, Word), error bodies for credit and voice. ' +
    'Unverified: the exact JSON of GET /api/account/ voices (parser is tolerant), the POST variant of /api/command/, hosting region, per-voice language list (depends on the account), ' +
    'and credit cost of the separate events call. Credential format here: one string "email:password".',
  presets: [{ id: 'acapela', label: 'Acapela Cloud', baseUrl: HOST, defaultVoice: DEFAULT_VOICE }],
  optionFields: [
    { key: 'wordEvents', label: 'Request word positions', type: 'bool', default: true, help: 'Adds one events request (output=events, wordpos=on) next to the audio request.' },
  ],
  configFields: ['baseUrl', 'credential', 'defaultVoice', 'options'],
  defaultBaseUrl: HOST,

  configured(inst) { return Boolean(creds(inst)) },

  capabilities() {
    return {
      tts: true, stt: false,
      ttsLangs: ['el', 'it', 'en'], sttLangs: [], detectsLanguage: false,
      streaming: false, alignment: 'word', nativeSpeed: [0.3, 3.0], ssml: false,
      maxChars: 700, formats: ['mp3'], quota: false,
    }
  },

  async health(inst) {
    return { ok: this.configured(inst), status: this.configured(inst) ? 'unknown' : 'down', detail: this.configured(inst) ? '' : 'credential must be email:password' }
  },

  async listVoices(inst, opts, signal) {
    const st = inst.state
    const now = Date.now()
    if (!(st.voices && now - st.voicesAt < 600000)) {
      const up = await call(inst, signal, '/api/account/', { method: 'GET', timeout: 10000 })
      if (up.status !== 200) throw typed(up.status, up.body.toString('utf8'), 'account')
      const d = parseJson(up.body) || {}
      const list = Array.isArray(d.voices) ? d.voices : []
      st.voices = list.filter((v) => v && v.name).map((v) => {
        const l = voiceLang(v)
        return { id: String(v.name), name: String(v.name), langs: l ? [l] : [], gender: String(v.gender || '').toLowerCase(), accent: String(v.locale || ''), tags: [] }
      })
      st.voicesAt = now
    }
    const want = opts && opts.lang ? lang2(opts.lang) : ''
    return st.voices.filter((v) => !want || v.langs.includes(want))
  },

  async tts({ text, voice, speed, wantAlignment }, inst, signal) {
    const v = /^[A-Za-z0-9_]{2,60}$/.test(String(voice || '')) ? String(voice) : (inst.defaultVoice || DEFAULT_VOICE)
    const q = { voice: v, text, output: 'file', type: 'mp3' }
    const sp = Number(speed)
    if (sp && Math.abs(sp - 1) > 0.01) q.speed = String(Math.max(30, Math.min(300, Math.round(sp * 100))))
    const qs = (extra) => '?' + new URLSearchParams(Object.assign({}, q, extra)).toString()
    const up = await call(inst, signal, '/api/command/' + qs(), { method: 'GET', timeout: 60000 })
    if (up.status !== 200) throw typed(up.status, up.body.toString('utf8'), 'tts')
    const ct = String(up.headers['content-type'] || '')
    if (!up.body.length || /json|text/.test(ct)) throw voiceErr('acapela tts: no audio in response: ' + scrub(up.body.toString('utf8'), 120), 'vendor', 502)
    const out = { audio: up.body, mime: 'audio/mpeg', voice: v, model: '', billedChars: String(text).length, alignment: null }
    const wantEvents = wantAlignment && !(inst.options && inst.options.wordEvents === false)
    if (wantEvents) {
      try {
        const ev = await call(inst, signal, '/api/command/' + qs({ output: 'events', wordpos: 'on' }), { method: 'GET', timeout: 30000 })
        if (ev.status === 200) {
          const toks = parseEvents(parseJson(ev.body))
          const found = tokensToWords(text, toks.map((t) => ({ text: t.text, t0: t.t0, t1: 0 })))
          if (found && found.length) {
            const last = found[found.length - 1].t0
            const items = startsToWords(found.map((f) => ({ c0: f.c0, c1: f.c1, t0: f.t0 })), last + 0.4)
            out.alignment = { unit: 'word', items }
            out.durationS = last + 0.4
          }
        }
      } catch (e) { /* alignment is optional: the client estimates */ }
    }
    return out
  },
}
