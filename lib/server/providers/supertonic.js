/**
 * Provider type `supertonic`: Supertonic 3 (Supertone, 10 voices, 32 languages) behind the small Rust service
 * that keeps the model resident on the speech box. It speaks the same wire shape as the Kokoro service
 * (`POST /api/tts` with `{text, voice}` and an `xi-api-key`, answering WAV), so it needs no credential of its
 * own beyond the service key, and it never probes: one POST and nothing else.
 *
 * WHY IT EARNS A SLOT BESIDE KOKORO: it is the only self-hosted engine here that speaks Greek, and it holds
 * 32 languages with 10 voices, where Kokoro has 9 languages (no Greek) with 54 voices. Measured on the speech
 * box 2026-11-25: 469 MB resident, about 1.4 s for a paragraph, against Kokoro's 643 MB.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub } from '../http.js'
import { applyAnnotations } from '../../shared/annotations.js'

/** The ten built-in voice styles. Each one works in every supported language. */
export const SUPERTONIC_VOICES = ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5']

/** The 31 languages plus language-agnostic, exactly as the service reports them. */
export const SUPERTONIC_LANGS = ['ar', 'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hi', 'hu',
  'id', 'it', 'ja', 'ko', 'lv', 'lt', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'es', 'sv', 'tr', 'uk', 'vi', 'na']

/** A short label per language, for the pickers; `na` means the model decides from the text. */
export const SUPERTONIC_LANG_NAMES = {
  ar: 'Arabic', bg: 'Bulgarian', hr: 'Croatian', cs: 'Czech', da: 'Danish', nl: 'Dutch', en: 'English',
  et: 'Estonian', fi: 'Finnish', fr: 'French', de: 'German', el: 'Greek', hi: 'Hindi', hu: 'Hungarian',
  id: 'Indonesian', it: 'Italian', ja: 'Japanese', ko: 'Korean', lv: 'Latvian', lt: 'Lithuanian', pl: 'Polish',
  pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak', sl: 'Slovenian', es: 'Spanish', sv: 'Swedish',
  tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese', na: 'auto (the model decides)',
}

const voicesOf = (inst) => (inst.options && Array.isArray(inst.options.voices) && inst.options.voices.length ? inst.options.voices : SUPERTONIC_VOICES)

/**
 * The language code to send. The service takes `na` when the text should decide, so an empty or unknown tag
 * becomes `na` rather than a wrong guess, and a regional tag (`en-GB`) is cut to its base.
 */
export function supertonicLang(lang) {
  const code = String(lang || '').trim().toLowerCase()
  const base = code.split(/[-_]/)[0]
  return SUPERTONIC_LANGS.indexOf(base) >= 0 && base !== 'na' ? base : 'na'
}

export default {
  type: 'supertonic',
  label: 'Supertonic 3 (self-hosted, Rust)',
  hq: 'self-hosted',
  euNote: 'Self-hosted: data stays wherever the server runs',
  group: 'self',
  residency: 'self',
  desc: 'Supertonic 3 on the resident Rust service: 10 voices, 32 languages including Greek, CPU only.',
  docs: 'https://huggingface.co/Supertone/supertonic-3',
  status: 'verified',
  verification: 'Verified against the resident server built from the supertonic3-tts crate: POST /api/tts with {text, voice, language} and an xi-api-key, answering WAV at 44.1 kHz.',
  presets: [{ id: 'supertonic', label: 'Supertonic service', baseUrl: 'http://127.0.0.1:8791' }],
  configFields: ['baseUrl', 'credential', 'defaultVoice', 'options'],
  defaultBaseUrl: '',

  // the service requires its key, like the Kokoro one: a base URL alone is not a usable instance
  configured(inst) { return Boolean(inst.baseUrl && inst.secret()) },

  capabilities() {
    return {
      tts: true, stt: false, ttsLangs: SUPERTONIC_LANGS.filter((l) => l !== 'na'), sttLangs: [], detectsLanguage: true,
      streaming: false, alignment: 'none', nativeSpeed: null, ssml: false,
      maxChars: 6000, formats: ['wav'], quota: false, noProbe: true,
    }
  },

  async health(inst) {
    // the service answers GET /health, but it is a plain local service: one cheap GET is honest here
    if (!this.configured(inst)) return { ok: false, status: 'down', detail: 'no service key' }
    try {
      const r = await request(joinUrl(inst.baseUrl, '/health'), { method: 'GET', timeout: 4000 })
      if (r.status !== 200) return { ok: false, status: 'down', detail: 'HTTP ' + r.status }
      const j = parseJson(r.body) || {}
      return { ok: true, status: 'up', detail: (Array.isArray(j.voices) ? j.voices.length + ' voices' : 'up') + (Array.isArray(j.languages) ? ', ' + j.languages.length + ' languages' : '') }
    } catch (e) { return { ok: false, status: 'down', detail: scrub(String((e && e.message) || e), 120) } }
  },

  async listVoices(inst) {
    // every voice works in every language, so the language list is a capability, not a per-voice fact
    return voicesOf(inst).map((v) => ({ id: v, name: v, langs: [] }))
  },

  async tts({ text, voice, lang }, inst, signal) {
    const list = voicesOf(inst)
    const want = String(voice || '').trim()
    const v = list.indexOf(want) >= 0 ? want : (inst.defaultVoice && list.indexOf(inst.defaultVoice) >= 0 ? inst.defaultVoice : list[0])
    // the annotation layer knows this family already (free-text cues plus an emphasis tag), so tone is honoured
    const ann = applyAnnotations(String(text || ''), { type: 'supertonic', model: null, provider: inst.id })
    const up = await request(joinUrl(inst.baseUrl, '/api/tts'), {
      method: 'POST', signal, timeout: 300000,
      headers: { 'content-type': 'application/json', 'xi-api-key': inst.secret() },
      body: jsonBody({ text: ann.text, voice: v, language: supertonicLang(lang) }),
    })
    if (up.status !== 200) {
      const j = parseJson(up.body)
      const detail = j ? String(j.detail || j.error || '') : scrub(up.body.toString('utf8'), 120)
      throw voiceErr('supertonic tts ' + up.status + (detail ? ': ' + scrub(detail, 200) : ''), up.status === 401 ? 'bad_key' : 'vendor', 502)
    }
    return { audio: up.body, mime: up.headers['content-type'] || 'audio/wav', voice: v, model: null, billedChars: 0, alignment: null, note: ann.notesText || undefined }
  },

  async legacyConfig(inst) {
    return {
      models: { tts: voicesOf(inst), stt: [] },
      note: 'Supertonic 3 on a CPU-only service: 10 voices over 32 languages (Greek included). Measured 469 MB resident, about 1.4 s a paragraph.',
    }
  },

  chunkPlan() { return { first: 110, rest: 260 } },
}