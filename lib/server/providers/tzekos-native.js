/**
 * Provider type `tzekos-native`: a Kokoro-82M server that speaks only the
 * tzekos-tts native TTS call. The 1.x `grey` engine (a CPU-only box, so
 * picking it never occupies the desktop GPU; measured 0.96 s load, 0.5x real time).
 *
 * RELAY CONTRACT (load-bearing, see spec 1.6): a relayed instance answers ONLY
 * `POST /api/tts` with JSON {text, voice}; every other path, and any query
 * string, gets 404 "path not relayed". So this adapter never probes: no
 * /health, no /api/voices, no GET at all. Health is always "unknown, assume up".
 * A relay kill switch answers 503, which surfaces as a typed `vendor` error.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub } from '../http.js'
import { applyAnnotations } from '../../shared/annotations.js'

export const KOKORO_VOICES = [
  // American English
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  // British English
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
  // Spanish, French, Hindi, Italian, Japanese, Brazilian Portuguese, Mandarin Chinese
  'ef_dora', 'em_alex', 'em_santa', 'ff_siwis', 'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi',
  'if_sara', 'im_nicola', 'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo',
  'pf_dora', 'pm_alex', 'pm_santa', 'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
  'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
]
/** The language each Kokoro letter stands for, and the espeak-ng tag its phonemizer needs. */
const KOKORO_LANG = { a: 'en', b: 'en', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt', z: 'zh' }
export const KOKORO_LANGUAGES = KOKORO_LANG
/**
 * Kokoro v1.0 (the pack already installed) has 54 voices in nine languages: the first letter of a voice is the
 * language and the second the accent or gender (bm_ = British male, af_ = American female). None of them is
 * Greek, so the engine never takes Greek. All 54 are served since 2026-11-25; the box previously exposed 14.
 */
const KOKORO_LANGS = ['en', 'es', 'fr', 'hi', 'it', 'ja', 'pt', 'zh']

const voicesOf = (inst) => (inst.options && Array.isArray(inst.options.voices) && inst.options.voices.length ? inst.options.voices : KOKORO_VOICES)

export default {
  type: 'tzekos-native',
  label: 'Kokoro (tzekos-tts native)',
  hq: 'self-hosted',
  euNote: 'Self-hosted: data stays wherever the server runs',
  group: 'self',
  residency: 'self',
  desc: 'A Kokoro-82M server with the tzekos-tts native POST /api/tts call (CPU only).',
  docs: 'https://github.com/hexgrad/kokoro',
  status: 'verified',
  verification: 'Verified against the reference Kokoro server and the relay contract (POST /api/tts only, no probes).',
  presets: [{ id: 'kokoro', label: 'Kokoro server', baseUrl: 'http://127.0.0.1:8790' }],
  configFields: ['baseUrl', 'credential', 'defaultVoice', 'options'],
  defaultBaseUrl: '',

  configured(inst) { return Boolean(inst.baseUrl && inst.secret()) },

  capabilities() {
    return {
      // every Kokoro voice is Spanish, French, Hindi, Italian, Japanese, Portuguese or Chinese besides English,
      // so the engine may be chosen for any of them; it is never for Greek (no Greek voice exists)
      tts: true, stt: false, ttsLangs: KOKORO_LANGS, sttLangs: [], detectsLanguage: false,
      streaming: false, alignment: 'none', nativeSpeed: null, ssml: false,
      maxChars: 6000, formats: ['wav'], quota: false, noProbe: true,
    }
  },

  async health(inst) {
    return { ok: this.configured(inst), status: this.configured(inst) ? 'unknown' : 'down', detail: 'not probed (a relayed endpoint answers POST /api/tts only)' }
  },

  async listVoices(inst) {
    // the language and the accent are IN the id; the picker reads them from here, this is only a hint
    return voicesOf(inst).map((v) => ({ id: v, name: v, langs: [KOKORO_LANG[v[0]] || 'en'] }))
  },

  async tts({ text, voice }, inst, signal) {
    const list = voicesOf(inst)
    const v = list.indexOf(String(voice || '')) >= 0 ? voice : (inst.defaultVoice && list.indexOf(inst.defaultVoice) >= 0 ? inst.defaultVoice : list[0])
    const up = await request(joinUrl(inst.baseUrl, '/api/tts'), {
      method: 'POST', signal, timeout: 300000,
      headers: { 'content-type': 'application/json', 'xi-api-key': inst.secret() },
      body: jsonBody({ text: applyAnnotations(String(text || ''), { type: 'tzekos-native', model: null, provider: inst.id }).text, voice: v }),
    })
    if (up.status !== 200) {
      const j = parseJson(up.body)
      const detail = j ? String(j.detail || j.error || '') : scrub(up.body.toString('utf8'), 120)
      throw voiceErr('grey tts ' + up.status + (detail ? ': ' + scrub(detail, 200) : ''), up.status === 401 ? 'bad_key' : 'vendor', 502)
    }
    // Kokoro answers WAV; the client sniffs RIFF and plays it unchanged.
    return { audio: up.body, mime: up.headers['content-type'] || 'audio/wav', voice: v, model: null, billedChars: 0, alignment: null }
  },

  async legacyConfig(inst) {
    return {
      models: { tts: voicesOf(inst), stt: [] },
      note: 'Kokoro-82M on a CPU-only server: never touches this box\'s GPU. Measured 0.96 s load and 0.5x real time. Always on.',
    }
  },

  chunkPlan() { return { first: 110, rest: 260 } },
}
