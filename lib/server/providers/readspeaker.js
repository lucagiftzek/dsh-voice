/**
 * Provider type `readspeaker`: TTS through speechCloud API (SCAPI), Swedish company.
 *
 * What is public (fetched 2026-10-31):
 *  - https://www.readspeaker.com/solutions/speech-production/readspeaker-speechcloud-api/ has a
 *    curl example: POST https://tts.readspeaker.com/a/eg/v2.0 form fields key, voice
 *    (Adam), lang (en_uk), audioformat (mp3), audiobitrate (48), text. The page itself says
 *    the endpoint shape is "illustrative" and defers to the customer portal.
 *  - Product Specification PDF (SCAPI 4.19, 2 June 2026, docs.readspeaker.com/assets/speechcloudapi/ps/):
 *    parameters exist for language, voice, volume, pitch, speaking rate, audio format/container,
 *    sample rate, bit depth, bitrate, streaming (1 = default, redirect to a streaming server;
 *    0 = audio after full generation); 5,000 characters per request excluding whitespace;
 *    timing data by a separate JSON call or by the RSDS audio format (MP3 48 kbit/s only, not
 *    all voices); a REST call lists the customer's languages and voices as JSON.
 * NOT public: the parameter NAMES for speed/pitch/volume, the voices-list URL, the RSDS byte
 * layout and the timing JSON shape (all in the customer portal). So this adapter sends only the
 * documented example fields plus `streaming=0`, returns alignment null and uses a static voice list.
 */
import { request, joinUrl, voiceErr, scrub, lang2 } from '../http.js'

const HOST = 'https://tts.readspeaker.com'
const PATH = '/a/eg/v2.0'
const DEFAULT_VOICE = 'Adam'
// en_uk is the documented example. el_gr and it_it follow the same pattern but are UNVERIFIED;
// override them per instance with the langCodes option.
const DEFAULT_LANGS = { en: 'en_uk', el: 'el_gr', it: 'it_it' }
const VOICES = [
  { id: 'Adam', name: 'Adam (English, UK, male)', langs: ['en'], gender: 'male', accent: 'en_uk', tags: ['sample'] },
]

function langCode(inst, l) {
  const map = Object.assign({}, DEFAULT_LANGS)
  const raw = String((inst.options && inst.options.langCodes) || '')
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=').map((x) => (x || '').trim())
    if (/^[a-z]{2}$/.test(k || '') && /^[a-z]{2}_[a-z]{2}$/i.test(v || '')) map[k] = v.toLowerCase()
  }
  return map[l] || map.en
}

function typed(status, body, what) {
  const msg = 'readspeaker ' + what + ' ' + status + ': ' + scrub(body, 200)
  if (status === 401 || status === 403) return voiceErr(msg, 'bad_key', 502)
  if (status === 429) return voiceErr(msg, 'quota_exceeded', 429)
  if (status === 400 && /voice/i.test(body)) return voiceErr(msg, 'bad_voice', 400)
  if (status === 400 && /lang/i.test(body)) return voiceErr(msg, 'unsupported_lang', 400)
  return voiceErr(msg, 'vendor', 502)
}

export default {
  type: 'readspeaker',
  label: 'ReadSpeaker speechCloud',
  hq: 'SE',
  euNote: 'Swedish company (Uppsala), GDPR and ISO 27001 stated; the public material does not name the hosting region.',
  group: 'eu',
  residency: 'varies',
  desc: 'ReadSpeaker speechCloud text to speech with Greek, Italian and English voices; word timings are not wired yet.',
  docs: 'https://www.readspeaker.com/solutions/speech-production/readspeaker-speechcloud-api/',
  status: 'partial',
  verification:
    'Checked 2026-10-31: the speechCloud product page (curl example for POST https://tts.readspeaker.com/a/eg/v2.0 with key, voice, lang, audioformat, audiobitrate, text), ' +
    'the public Product Specification PDF (SCAPI 4.19, streaming 1/0, 5,000 characters excluding whitespace, RSDS timing is MP3 48 kbit/s only and not for all voices) and ' +
    'https://www.readspeaker.com/languages-voices/ (Greek, female voice only, and Italian are TTS languages). ' +
    'Confirmed: endpoint, the key in the form body, the example fields, streaming semantics, the character limit. ' +
    'Unverified because they live in the customer portal: the language codes for Greek and Italian (el_gr and it_it are guesses, override with the langCodes option), ' +
    'voice names for Greek and Italian (set a default voice), parameter names for speed, pitch and volume (not sent), the voices-list call (static list), and the RSDS and timing JSON layouts, ' +
    'so word alignment is returned as null and the client estimates it.',
  presets: [{ id: 'readspeaker', label: 'ReadSpeaker speechCloud', baseUrl: HOST, defaultVoice: DEFAULT_VOICE }],
  optionFields: [
    { key: 'langCodes', label: 'Language codes', type: 'text', default: 'el=el_gr,it=it_it,en=en_uk', help: 'Comma list of lang=code pairs sent as the lang field. Greek and Italian defaults are unverified.' },
    { key: 'bitrate', label: 'MP3 bitrate (kbit/s)', type: 'select', choices: ['16', '24', '32', '48', '64', '128'], default: '48', help: 'Allowed values from the product page.' },
  ],
  configFields: ['baseUrl', 'credential', 'defaultVoice', 'options'],
  defaultBaseUrl: HOST,

  configured(inst) { return Boolean(inst.secret()) },

  capabilities() {
    return {
      tts: true, stt: false,
      ttsLangs: ['el', 'it', 'en'], sttLangs: [], detectsLanguage: false,
      streaming: false, alignment: 'none', nativeSpeed: null, ssml: true,
      maxChars: 5000, formats: ['mp3'], quota: false,
    }
  },

  async health(inst) {
    const ok = this.configured(inst)
    return { ok, status: ok ? 'unknown' : 'down', detail: ok ? '' : 'no API key' }
  },

  async listVoices(inst, opts) {
    const l = opts && opts.lang ? lang2(opts.lang) : ''
    return VOICES.filter((v) => !l || v.langs.includes(l)).map((v) => Object.assign({}, v))
  },

  async tts({ text, voice, lang }, inst, signal) {
    const l = lang ? lang2(lang) : 'en'
    const v = /^[A-Za-z0-9_-]{2,40}$/.test(String(voice || '')) ? String(voice) : (inst.defaultVoice || DEFAULT_VOICE)
    const bitrate = ['16', '24', '32', '48', '64', '128'].includes(String(inst.options && inst.options.bitrate)) ? String(inst.options.bitrate) : '48'
    const form = new URLSearchParams({
      key: inst.secret(), voice: v, lang: langCode(inst, l), audioformat: 'mp3', audiobitrate: bitrate, streaming: '0', text: String(text),
    })
    const body = Buffer.from(form.toString())
    const root = String(inst.baseUrl || HOST).replace(/\/+$/, '')
    const opts = { method: 'POST', signal, timeout: 60000, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }
    let up = await request(joinUrl(root, PATH), opts)
    if ([301, 302, 303, 307, 308].includes(up.status) && up.headers.location) {
      // streaming=1 style redirect to a streaming server: follow once
      up = await request(new URL(up.headers.location, joinUrl(root, PATH)), { method: 'GET', signal, timeout: 60000 })
    }
    const ct = String(up.headers['content-type'] || '')
    if (up.status !== 200) throw typed(up.status, up.body.toString('utf8'), 'tts')
    if (!up.body.length || /text|json|html|xml/.test(ct)) throw typed(200, up.body.toString('utf8'), 'tts (no audio)')
    return { audio: up.body, mime: 'audio/mpeg', voice: v, model: '', billedChars: String(text).replace(/\s/g, '').length, alignment: null }
  },
}
