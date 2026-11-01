/**
 * Provider type `mimo`: Xiaomi MiMo-V2.5-TTS (built-in, designed or cloned
 * voices) and MiMo-V2.5-ASR on the Token Plan, all through
 * POST {base}/chat/completions.
 *
 * RELAY CONTRACT (spec 1.6): a relayed instance answers exactly
 * POST /v1/chat/completions (no query string) and only for model ids matching
 * ^mimo-v[\d.]+-(asr|tts)(-[a-z]+)?$. So: the base URL may be http with a port,
 * there is no /models listing and no probe of any kind, and this key is never
 * used for language detection or polish (those go through ctx.llm or Mistral).
 *
 * The text to speak goes in the ASSISTANT message (the vendor rejects it in the
 * user role); a user message, when present, is a style prompt.
 */
import fs from 'node:fs'
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, toWav, lang2 } from '../http.js'
import { expandHome } from '../credentials.js'

export const TTS_MODEL = 'mimo-v2.5-tts'
export const DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign'
export const CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
export const ASR_MODEL = 'mimo-v2.5-asr'
export const MODEL_RE = /^mimo-v[\d.]+-(asr|tts)(-[a-z]+)?$/
const VOICES_EN = ['Mia', 'Chloe', 'Milo', 'Dean']
// Chinese built-ins (documented ids, written as escapes): Bingtang, Moli, Suda, Baihua.
export const VOICES_ZH = [
  { id: '\u51b0\u7cd6', name: 'Bingtang (built-in, Chinese female)' },
  { id: '\u8309\u8389', name: 'Moli (built-in, Chinese female)' },
  { id: '\u82cf\u6253', name: 'Suda (built-in, Chinese male)' },
  { id: '\u767d\u6866', name: 'Baihua (built-in, Chinese male)' },
]
const VOICES = VOICES_EN.concat(VOICES_ZH.map((v) => v.id))
const LANGS = ['en', 'zh']
const DESIGN_PROMPT = 'A warm, calm, clear adult voice with a neutral accent and a steady, unhurried pace.'

const opt = (inst, k, d) => (inst.options && inst.options[k]) || d
const cloneSample = (inst) => expandHome(opt(inst, 'cloneSample', '~/.config/xiaomi-mimo/clone-sample.mp3'))
export function cloneAvailable(inst) { try { return fs.statSync(cloneSample(inst)).size > 0 } catch (e) { return false } }

async function chat(inst, body, timeout, signal) {
  if (!MODEL_RE.test(String(body.model || ''))) throw voiceErr('mimo: only MiMo audio model ids are allowed', 'vendor', 502)
  const up = await request(joinUrl(inst.baseUrl, '/chat/completions'), {
    method: 'POST', signal, timeout: timeout || 120000,
    headers: { authorization: 'Bearer ' + inst.secret(), 'content-type': 'application/json' },
    body: jsonBody(body),
  })
  const text = up.body.toString('utf8')
  if (up.status !== 200) {
    const msg = 'mimo ' + up.status + ': ' + scrub(text, 220)
    if (up.status === 401 || up.status === 403) throw voiceErr(msg, 'bad_key', 502)
    if (up.status === 429) throw voiceErr(msg, 'quota_exceeded', 429)
    throw voiceErr(msg, 'vendor', 502)
  }
  const j = parseJson(text)
  if (!j) throw voiceErr('mimo: answer is not JSON', 'vendor', 502)
  return j
}

export default {
  type: 'mimo',
  label: 'Xiaomi MiMo',
  hq: 'CN',
  euNote: 'Token Plan AMS cluster (Amsterdam host); residency terms unverified',
  group: 'other',
  residency: 'varies',
  desc: 'Xiaomi MiMo V2.5 TTS (built-in, designed or cloned voices) and ASR on the Token Plan (English, Chinese).',
  docs: 'https://mimo.mi.com/docs/en-US/updates/model',
  status: 'partial',
  verification: 'Carried from the 1.x adapter, which ran live. The vendor docs (mimo.mi.com/docs, a single-page app) confirm the model releases (mimo-v2.5-asr 2026-06-02, MiMo-V2.5-TTS series 2026-04-23) on the model updates page; no dedicated audio API reference page could be fetched, hence partial.',
  presets: [{ id: 'mimo', label: 'MiMo Token Plan (AMS)', baseUrl: 'https://token-plan-ams.xiaomimimo.com/v1' }],
  configFields: ['baseUrl', 'credential', 'defaultVoice', 'options'],
  defaultBaseUrl: 'https://token-plan-ams.xiaomimimo.com/v1',

  configured(inst) { return Boolean(inst.secret()) },

  capabilities() {
    return {
      tts: true, stt: true, ttsLangs: LANGS, sttLangs: LANGS, detectsLanguage: false,
      streaming: false, alignment: 'none', nativeSpeed: null, ssml: false,
      maxChars: 6000, formats: ['wav'], quota: false, noProbe: true,
    }
  },

  async health(inst) {
    return { ok: this.configured(inst), status: this.configured(inst) ? 'unknown' : 'down', detail: 'not probed (a relayed endpoint answers chat completions only)' }
  },

  async listVoices(inst) {
    return [{ id: 'auto', name: 'default voice' }]
      .concat(VOICES_EN.map((v) => ({ id: v, name: v + ' (built-in, English)', langs: ['en'] })))
      .concat(VOICES_ZH.map((v) => Object.assign({ langs: ['zh'] }, v)))
      .concat([{ id: 'design', name: 'designed voice (voicedesign)' }])
      .concat(cloneAvailable(inst) ? [{ id: 'clone', name: 'cloned voice (voiceclone)' }] : [])
  },

  /** voice: a built-in name | 'design' | 'clone' | anything else -> the cluster default voice. */
  async tts({ text, voice }, inst, signal) {
    const v = String(voice || inst.defaultVoice || '').trim()
    let model = TTS_MODEL
    const messages = [{ role: 'assistant', content: text }]
    const audioOpt = { format: 'wav' }
    if (v === 'design') {
      model = DESIGN_MODEL
      messages.unshift({ role: 'user', content: opt(inst, 'designPrompt', DESIGN_PROMPT) })
    } else if (v === 'clone') {
      if (!cloneAvailable(inst)) throw voiceErr('voice clone needs a reference sample on the server', 'bad_voice', 400)
      model = CLONE_MODEL
      const file = cloneSample(inst)
      const ext = /\.wav$/i.test(file) ? 'wav' : 'mpeg'
      messages.unshift({ role: 'user', content: '' })
      audioOpt.voice = 'data:audio/' + ext + ';base64,' + fs.readFileSync(file).toString('base64')
    } else {
      audioOpt.voice = VOICES.includes(v) ? v : 'mimo_default'
    }
    const d = await chat(inst, { model, messages, audio: audioOpt }, 180000, signal)
    const b64 = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.audio && d.choices[0].message.audio.data
    if (!b64) throw voiceErr('mimo tts: no audio in response', 'vendor', 502)
    return {
      audio: Buffer.from(b64, 'base64'), mime: 'audio/wav',
      voice: audioOpt.voice && audioOpt.voice.length < 30 ? audioOpt.voice : v, model, billedChars: text.length, alignment: null,
    }
  },

  async stt({ audio, lang }, inst, signal) {
    const wav = await toWav(audio)
    if (wav.length * 1.34 > 10 * 1024 * 1024) throw voiceErr('mimo stt: clip too long (10 MB base64 limit, about 3.5 minutes)', 'vendor', 413)
    const l = lang2(lang)
    const d = await chat(inst, {
      model: ASR_MODEL,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + wav.toString('base64') } }] }],
      asr_options: { language: LANGS.includes(l) ? l : 'auto' },
    }, 120000, signal)
    const m = d.choices && d.choices[0] && d.choices[0].message
    return { text: m && typeof m.content === 'string' ? m.content.trim() : '', language: null, words: null }
  },

  async legacyConfig(inst) {
    return {
      ttsLanguages: LANGS, sttLanguages: LANGS,
      models: { tts: [TTS_MODEL, DESIGN_MODEL].concat(cloneAvailable(inst) ? [CLONE_MODEL] : []), stt: [ASR_MODEL] },
      voices: await this.listVoices(inst),
      note: 'Xiaomi MiMo-V2.5-TTS (built-in, designed or cloned voices) and MiMo-V2.5-ASR on the Token Plan. English and Chinese only; Greek and Italian go to the local engine.',
    }
  },

  chunkPlan() { return { first: 300, rest: 600 } },
}
