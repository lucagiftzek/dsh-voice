/**
 * Provider type `mistral`: Voxtral TTS + STT (and the polish chat model).
 *
 * Measured on the reference install, 2026-09-08: STT 0.43 s, TTS 1.07 s on a
 * one-line sentence. Voxtral TTS 3 (2026-10-30) reads Greek and Italian
 * correctly and accepts numbered voice_NNNN voices; the v1 checkpoint spells
 * Greek letter by letter and rejects numbered voices with a 400.
 * Voxtral output fades past ~45 s of audio, hence the 500/700 chunk plan.
 *
 * Request shape kept from 1.x (`voice`, JSON answer with base64 `audio_data`).
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, multipart } from '../http.js'

export const TTS3 = 'voxtral-mini-tts-3-0'
export const TTS_MODELS = [
  { id: TTS3, name: 'Voxtral TTS 3 (35 languages, emotion and pace tags)' },
  { id: 'voxtral-mini-tts-2603', name: 'Voxtral TTS v1 (English and French voices)' },
]

const defaults = (inst) => ({
  tts: (inst.models && inst.models.tts) || 'voxtral-mini-tts-latest',
  stt: (inst.models && inst.models.stt) || 'voxtral-mini-latest',
  voice: inst.defaultVoice || 'gb_oliver_neutral',
})

export function mistralModel(inst, m) {
  const t = String(m || '').trim()
  return TTS_MODELS.some((x) => x.id === t) ? t : defaults(inst).tts
}

/** Mistral voices look like gb_oliver_neutral (or voice_NNNN on TTS 3); anything else gets the default. */
export function mistralVoice(inst, v, model) {
  const t = String(v || '').trim()
  if (/^[a-z]{2}_[a-z]+_[a-z]+$/.test(t)) return t
  if (model === TTS3 && /^voice_\d+$/.test(t)) return t
  return defaults(inst).voice
}

function auth(inst) { return { authorization: 'Bearer ' + inst.secret() } }

function typed(status, body, what) {
  const msg = 'mistral ' + what + ' ' + status + ': ' + scrub(body, 200)
  if (status === 401 || status === 403) return voiceErr(msg, 'bad_key', 502)
  if (status === 429) return voiceErr(msg, 'quota_exceeded', 429)
  if (status === 400 && /voice/i.test(body)) return voiceErr(msg, 'bad_voice', 400)
  return voiceErr(msg, 'vendor', 502)
}

export default {
  type: 'mistral',
  label: 'Mistral',
  hq: 'FR',
  euNote: 'EU company; api.eu.mistral.ai keeps inference in EU/EFTA data centres',
  group: 'eu',
  residency: 'eu',
  desc: 'Voxtral text-to-speech and transcription from a French company; api.eu.mistral.ai keeps inference in the EU.',
  docs: 'https://docs.mistral.ai/studio-api/audio/text_to_speech',
  status: 'verified',
  verification: 'Request shapes carried from the 1.x adapter, which ran against the live API; the EU base URL and model names follow the Mistral docs read for the v2 spec on 2026-10-31. Voxtral TTS 3 voices per language were checked by ear, not by API.',
  presets: [
    { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai' },
    { id: 'mistral-eu', label: 'Mistral EU', baseUrl: 'https://api.eu.mistral.ai' },
  ],
  configFields: ['baseUrl', 'credential', 'models', 'defaultVoice'],
  defaultBaseUrl: 'https://api.mistral.ai',

  configured(inst) { return Boolean(inst.secret()) },

  capabilities() {
    return {
      tts: true, stt: true,
      // Routing languages as in 1.x (English voices; STT en/fr). Voxtral TTS 3
      // can speak 35 languages, but only an explicit pick or a fallback entry
      // sends it Greek: its preset voices have no Greek speaker.
      ttsLangs: ['en'], sttLangs: ['en', 'fr'], speaksLangs: '*',
      detectsLanguage: true, streaming: false, alignment: 'none', nativeSpeed: null,
      ssml: false, maxChars: 6000, formats: ['mp3'], quota: false,
    }
  },

  async health(inst) {
    return { ok: this.configured(inst), status: this.configured(inst) ? 'unknown' : 'down', detail: '' }
  },

  /** The account's voice catalogue, cached 10 minutes in inst.state. [] when the call fails. */
  async listVoices(inst) {
    const st = inst.state
    const now = Date.now()
    if (st.voices && st.voices.length && now - st.voicesAt < 600000) return st.voices
    try {
      const out = []
      for (let page = 1; page <= 6; page += 1) {
        const up = await request(joinUrl(inst.baseUrl, '/v1/audio/voices?limit=50&offset=' + ((page - 1) * 50)), {
          method: 'GET', headers: auth(inst), timeout: 8000,
        })
        if (up.status !== 200) break
        const d = parseJson(up.body) || {}
        const items = Array.isArray(d.items) ? d.items : []
        items.forEach((v) => {
          if (v && v.slug && !out.some((x) => x.id === v.slug)) {
            out.push({ id: v.slug, name: v.name || v.slug, languages: v.languages || [], langs: v.languages || [], gender: v.gender || '', tags: v.tags || [] })
          }
        })
        if (!items.length || out.length >= (Number(d.total) || 0)) break
      }
      if (out.length) { st.voices = out; st.voicesAt = now }
    } catch (e) { /* keep the previous list */ }
    return st.voices || []
  },

  async tts({ text, voice, model }, inst, signal) {
    const m = mistralModel(inst, model)
    const v = mistralVoice(inst, voice, m)
    const up = await request(joinUrl(inst.baseUrl, '/v1/audio/speech'), {
      method: 'POST', signal, timeout: 120000,
      headers: Object.assign({ 'content-type': 'application/json' }, auth(inst)),
      body: jsonBody({ model: m, input: text, voice: v }),
    })
    if (up.status !== 200) throw typed(up.status, up.body.toString('utf8'), 'tts')
    const parsed = parseJson(up.body) || {}
    const b64 = parsed.audio_data || parsed.audio || ''
    if (!b64) throw voiceErr('mistral tts: no audio_data in response', 'vendor', 502)
    return { audio: Buffer.from(b64, 'base64'), mime: 'audio/mpeg', voice: v, model: m, billedChars: text.length, alignment: null }
  },

  async stt({ audio, name, mime, lang, model }, inst, signal) {
    const fields = { model: model || defaults(inst).stt }
    const mp = multipart(fields, { field: 'file', name: name || 'dictation.webm', type: mime || 'audio/webm', data: audio })
    const up = await request(joinUrl(inst.baseUrl, '/v1/audio/transcriptions'), {
      method: 'POST', signal, timeout: 120000,
      headers: Object.assign({ 'content-type': mp.contentType }, auth(inst)),
      body: mp.body,
    })
    const body = up.body.toString('utf8')
    if (up.status !== 200) throw typed(up.status, body, 'stt')
    const parsed = parseJson(body) || {}
    return { text: parsed.text || '', language: parsed.language || null, words: null }
  },

  /** Chat completion for the polish step (kept on the direct key as in 1.x). */
  async chat({ system, text, model, maxTokens }, inst, signal) {
    const up = await request(joinUrl(inst.baseUrl, '/v1/chat/completions'), {
      method: 'POST', signal, timeout: 60000,
      headers: Object.assign({ 'content-type': 'application/json' }, auth(inst)),
      body: jsonBody({
        model: model || 'mistral-small-latest', temperature: 0.1, max_tokens: maxTokens || 600,
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
      }),
    })
    if (up.status !== 200) throw new Error('mistral polish ' + up.status)
    const d = parseJson(up.body)
    return (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || ''
  },

  /** The legacy /config block for engines.mistral. */
  async legacyConfig(inst, avail) {
    return {
      ttsLanguages: ['en'], sttLanguages: ['en', 'fr'],
      models: { tts: TTS_MODELS, default: defaults(inst).tts },
      voices: avail ? await this.listVoices(inst) : [],
      note: 'Voxtral. Measured 0.43s STT, 1.07s TTS. Voxtral TTS 3 speaks 35 languages including Greek and Italian; the v1 voices are English and French.',
    }
  },

  chunkPlan() { return { first: 500, rest: 700 } },
}
