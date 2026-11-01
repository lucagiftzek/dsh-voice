/**
 * Provider type `lfm3`: LFM3-Audio-2B in a llama.cpp router (POST /tts,
 * POST /v1/audio/transcriptions, GET /v1/models for the probe).
 *
 * Measured 2026-10-29 on the reference box: 5.35 s cold, 0.7 to 1.0 s warm;
 * Greek and Italian really are Greek and Italian. The only unlimited engine
 * here that speaks all three of the owner's languages, but it shares the GPU,
 * so it is never in the generic automatic chains except as a fallback.
 *
 * agent:false is LOAD-BEARING: llama-server closes an idle connection and
 * Node's keep-alive agent hands the dead socket to the next request (every
 * second read failed with ECONNRESET before this, 2026-10-29).
 *
 * Health gates routing for this type only (1.x parity): optimistic until the
 * first probe, then "down" when the router does not list the audio model.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, multipart, toWav, audioType, lang2 } from '../http.js'

export const LANGS = ['en', 'it', 'el', 'fr', 'de', 'es', 'pt', 'nl', 'da', 'fi', 'pl', 'sv', 'tr', 'ar', 'he', 'ja', 'ko', 'zh']
const VOICES = ['female', 'male']
const model = (inst) => (inst.models && inst.models.tts) || 'lfm3-audio-2b'

export default {
  type: 'lfm3',
  label: 'Liquid LFM3 Audio (local)',
  hq: 'self-hosted',
  euNote: 'Local model: audio never leaves the machine',
  group: 'self',
  residency: 'self',
  desc: 'Liquid LFM3-Audio-2B behind a llama.cpp router: local TTS and STT, 18 languages including Greek and Italian.',
  docs: 'https://huggingface.co/LiquidAI',
  status: 'verified',
  verification: 'Verified live on the reference install in 1.x (router /tts and /v1/audio/transcriptions).',
  presets: [{ id: 'lfm3', label: 'LFM3 Audio (llama.cpp)', baseUrl: 'http://127.0.0.1:11435' }],
  configFields: ['baseUrl', 'models', 'defaultVoice'],
  defaultBaseUrl: 'http://127.0.0.1:11435',

  configured() { return true },

  capabilities() {
    return {
      tts: true, stt: true, ttsLangs: LANGS, sttLangs: LANGS, detectsLanguage: false,
      streaming: false, alignment: 'none', nativeSpeed: null, ssml: false,
      maxChars: 6000, formats: ['wav'], quota: false, healthGatesRouting: true,
    }
  },

  async health(inst, signal) {
    try {
      const up = await request(joinUrl(inst.baseUrl, '/v1/models'), { method: 'GET', timeout: 4000, agent: false, signal })
      if (up.status !== 200) return { ok: false, status: 'down', detail: 'router answered ' + up.status }
      const ids = ((parseJson(up.body) || {}).data || []).map((m) => String(m.id || ''))
      const ok = ids.indexOf(model(inst)) >= 0
      return { ok, status: ok ? 'up' : 'down', detail: ok ? 'model loaded' : 'router does not serve ' + model(inst) }
    } catch (e) {
      return { ok: false, status: 'down', detail: 'no answer' }
    }
  },

  async listVoices() { return VOICES.map((v) => ({ id: v, name: v + ' voice', langs: LANGS })) },

  async tts({ text, voice, lang }, inst, signal) {
    const v = VOICES.indexOf(String(voice || '').trim()) >= 0 ? String(voice).trim() : (inst.defaultVoice || 'female')
    const l = LANGS.includes(lang2(lang)) ? lang2(lang) : 'en'
    const up = await request(joinUrl(inst.baseUrl, '/tts'), {
      method: 'POST', signal, agent: false, timeout: 240000,
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ model: model(inst), input: text, voice: v, lang: l }),
    })
    if (up.status !== 200) {
      throw voiceErr('LFM3 audio failed (' + up.status + '): ' + scrub(up.body.toString('utf8'), 200)
        + '. The lfm3 container may still be loading the speech model.', 'vendor', 502)
    }
    return { audio: up.body, mime: audioType(up.body, 'audio/wav'), voice: v, model: model(inst), billedChars: 0, alignment: null, language: l }
  },

  async stt({ audio, name }, inst, signal) {
    const wav = await toWav(audio)
    const base = String(name || 'dictation').replace(/\.[^.]+$/, '')
    const mp = multipart({ model: model(inst) }, { field: 'file', name: base + '.wav', type: 'audio/wav', data: wav })
    const up = await request(joinUrl(inst.baseUrl, '/v1/audio/transcriptions'), {
      method: 'POST', signal, agent: false, timeout: 180000,
      headers: { 'content-type': mp.contentType }, body: mp.body,
    })
    if (up.status !== 200) throw voiceErr('lfm3 stt ' + up.status + ': ' + scrub(up.body.toString('utf8'), 200), 'vendor', 502)
    const parsed = parseJson(up.body) || {}
    return { text: parsed.text || '', language: parsed.language || null, words: null }
  },

  async legacyConfig(inst, avail) {
    const hp = (() => { try { const u = new URL(inst.baseUrl); return u.host } catch (e) { return inst.baseUrl } })()
    return {
      model: model(inst), ttsLanguages: LANGS, sttLanguages: LANGS, defaultVoice: 'female',
      voices: VOICES.map((v) => ({ id: v, name: v + ' voice' })),
      note: avail
        ? 'LFM3-Audio-2B (llama.cpp router on ' + hp + '): unlimited, speaks ' + LANGS.length
          + ' languages including English, Italian and Greek, and transcribes too. Measured 0.7-1.0 s warm, about 5 s for the first read while the model loads. It borrows the same GPU as ollama and ComfyUI.'
        : 'The lfm3 router on ' + hp + ' does not answer, or does not serve ' + model(inst) + '.',
    }
  },

  chunkPlan() { return { first: 400, rest: 900 } },
}
