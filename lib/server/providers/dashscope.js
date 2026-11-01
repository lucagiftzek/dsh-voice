/**
 * Provider type `dashscope`: Alibaba Qwen3-TTS on the pay-as-you-go workspace
 * (the Token Plan key has no HTTP audio surface, measured 2026-09-08). Legacy
 * in 2.0: the `alibaba` instance is disabled unless legacy.engines is on and
 * DSH_VOICE_ALI_AUDIO=1. Qwen3-TTS speaks ten languages and NOT Greek.
 * The route answers WAV whatever the format says, so the bytes decide the type.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, multipart, audioType } from '../http.js'

export const LANGS = ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it']
export const VOICES = ['Cherry', 'Ethan', 'Serena', 'Chelsie', 'Dylan', 'Jada', 'Sunny']
const voiceOf = (v) => (VOICES.includes(String(v || '').trim()) ? String(v).trim() : 'Cherry')

export default {
  type: 'dashscope',
  label: 'Alibaba DashScope',
  hq: 'CN',
  euNote: 'International region is Singapore',
  group: 'other',
  residency: 'non-eu',
  desc: 'Alibaba Qwen3-TTS on the pay-as-you-go workspace (ten languages, no Greek). Legacy, off by default.',
  docs: 'https://www.alibabacloud.com/help/en/model-studio/qwen-tts',
  status: 'verified',
  verification: 'Carried from the 1.x adapter (live in 2026-09); legacy, off unless legacy.engines is on.',
  presets: [{ id: 'alibaba', label: 'DashScope (pay as you go)', baseUrl: 'https://dashscope-intl.aliyuncs.com' }],
  configFields: ['baseUrl', 'credential', 'models'],
  defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com',

  configured(inst) { return Boolean(inst.secret() && inst.baseUrl) },

  capabilities() {
    return {
      tts: true, stt: true, ttsLangs: LANGS, sttLangs: '*', detectsLanguage: false,
      streaming: false, alignment: 'none', nativeSpeed: null, ssml: false, maxChars: 6000, formats: ['mp3', 'wav'], quota: false,
    }
  },

  async health(inst) { return { ok: this.configured(inst), status: this.configured(inst) ? 'unknown' : 'down', detail: '' } },
  async listVoices() { return VOICES.map((v) => ({ id: v, name: v })) },

  async tts({ text, voice, model }, inst, signal) {
    const up = await request(joinUrl(inst.baseUrl, '/api/v1/services/aigc/multimodal-generation/generation'), {
      method: 'POST', signal, timeout: 120000,
      headers: { authorization: 'Bearer ' + inst.secret(), 'content-type': 'application/json' },
      body: jsonBody({ model: model || (inst.models && inst.models.tts) || 'qwen3-tts-flash', input: { text, voice: voiceOf(voice) }, parameters: { format: 'mp3' } }),
    })
    const body = up.body.toString('utf8')
    if (up.status !== 200) throw voiceErr('alibaba tts ' + up.status + ': ' + scrub(body, 220), 'vendor', 502)
    const parsed = parseJson(body) || {}
    const out = parsed.output || {}
    const b64 = (out.audio && (out.audio.data || out.audio.audio)) || parsed.audio_data || ''
    if (b64) { const buf = Buffer.from(b64, 'base64'); return { audio: buf, mime: audioType(buf, 'audio/mpeg'), voice: voiceOf(voice), alignment: null } }
    const url = out.audio && out.audio.url
    if (url) {
      const dl = await request(url, { method: 'GET', timeout: 60000, signal })
      if (dl.status === 200) return { audio: dl.body, mime: audioType(dl.body, dl.headers['content-type']), voice: voiceOf(voice), alignment: null }
    }
    throw voiceErr('alibaba tts: no audio in response', 'vendor', 502)
  },

  async stt({ audio, name, mime }, inst, signal) {
    const mp = multipart({ model: (inst.models && inst.models.stt) || 'qwen-audio-3.0-realtime-plus' }, { field: 'file', name: name || 'dictation.webm', type: mime || 'audio/webm', data: audio })
    const up = await request(joinUrl(inst.baseUrl, '/compatible-mode/v1/audio/transcriptions'), {
      method: 'POST', signal, timeout: 120000, headers: { authorization: 'Bearer ' + inst.secret(), 'content-type': mp.contentType }, body: mp.body,
    })
    const body = up.body.toString('utf8')
    if (up.status !== 200) throw voiceErr('alibaba stt ' + up.status + ': ' + scrub(body, 220), 'vendor', 502)
    const parsed = parseJson(body) || {}
    return { text: parsed.text || '', language: parsed.language || null, words: null }
  },

  async legacyConfig(inst) {
    return {
      model: (inst.models && inst.models.tts) || 'qwen3-tts-flash', ttsLanguages: LANGS, payg: Boolean(inst.options && inst.options.payg),
      defaultVoice: 'Cherry', voices: VOICES.map((v) => ({ id: v, name: v, labels: {} })),
      note: 'Qwen3-TTS on the pay-as-you-go workspace: billed per character, speaks ' + LANGS.length + ' languages, and NOT Greek. Retired from routing; legacy.engines re-enables it.',
    }
  },

  chunkPlan() { return { first: 110, rest: 260 } },
}
