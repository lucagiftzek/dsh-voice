/**
 * Provider type `tzekos-native` (id kept for saved settings): a Kokoro-82M server that speaks only the
 * native POST /api/tts call. The 1.x `grey` engine (a CPU-only box, so
 * picking it never occupies the desktop GPU; measured 0.96 s load, 0.5x real time).
 *
 * RELAY CONTRACT (load-bearing, see spec 1.6): a relayed instance answers ONLY
 * `POST /api/tts` with JSON {text, voice}; every other path, and any query
 * string, gets 404 "path not relayed". So this adapter never probes: no
 * /health, no /api/voices, no GET at all. Health is always "unknown, assume up".
 * A relay kill switch answers 503, which surfaces as a typed `vendor` error.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub } from '../http.js'

export const KOKORO_VOICES = ['bm_george', 'bm_fable', 'bm_daniel', 'bm_lewis', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'am_michael', 'am_adam', 'af_heart', 'af_bella', 'af_nicole', 'af_sarah']

const voicesOf = (inst) => (inst.options && Array.isArray(inst.options.voices) && inst.options.voices.length ? inst.options.voices : KOKORO_VOICES)

export default {
  type: 'tzekos-native',
  label: 'Kokoro (native /api/tts)',
  hq: 'self-hosted',
  euNote: 'Self-hosted: data stays wherever the server runs',
  group: 'self',
  residency: 'self',
  desc: 'A Kokoro-82M server with a native POST /api/tts call, for example behind a relay (CPU is enough).',
  docs: 'https://github.com/hexgrad/kokoro',
  status: 'verified',
  verification: 'Verified against the reference Kokoro server and the relay contract (POST /api/tts only, no probes).',
  presets: [{ id: 'kokoro', label: 'Kokoro server', baseUrl: 'http://127.0.0.1:8790' }],
  configFields: ['baseUrl', 'credential', 'defaultVoice', 'options'],
  defaultBaseUrl: '',

  configured(inst) { return Boolean(inst.baseUrl && inst.secret()) },

  capabilities() {
    return {
      tts: true, stt: false, ttsLangs: ['en'], sttLangs: [], detectsLanguage: false,
      streaming: false, alignment: 'none', nativeSpeed: null, ssml: false,
      maxChars: 6000, formats: ['wav'], quota: false, noProbe: true,
    }
  },

  async health(inst) {
    return { ok: this.configured(inst), status: this.configured(inst) ? 'unknown' : 'down', detail: 'not probed (a relayed endpoint answers POST /api/tts only)' }
  },

  async listVoices(inst) { return voicesOf(inst).map((v) => ({ id: v, name: v, langs: ['en'] })) },

  async tts({ text, voice }, inst, signal) {
    const list = voicesOf(inst)
    const v = list.indexOf(String(voice || '')) >= 0 ? voice : (inst.defaultVoice && list.indexOf(inst.defaultVoice) >= 0 ? inst.defaultVoice : list[0])
    const up = await request(joinUrl(inst.baseUrl, '/api/tts'), {
      method: 'POST', signal, timeout: 300000,
      headers: { 'content-type': 'application/json', 'xi-api-key': inst.secret() },
      body: jsonBody({ text, voice: v }),
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
