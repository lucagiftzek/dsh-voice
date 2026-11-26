/**
 * Provider type `openai`: OpenAI itself, a thin named wrapper over the shared
 * OpenAI-shape functions in openai-compatible.js.
 *
 * Deprecations (developers.openai.com/api/docs/deprecations, read 2026-10-31):
 * tts-1, tts-1-hd and gpt-4o-mini-tts shut down 2027-01-06 (replacement is the
 * Realtime API, which is NOT usable from /v1/audio/speech). whisper-1,
 * gpt-4o-transcribe, gpt-4o-mini-transcribe and gpt-4o-transcribe-diarize shut
 * down 2027-02-26 (the 2025-03-20 mini snapshot on 2027-01-20); gpt-transcribe is the new
 * recommended file model. Until then whisper-1 is the only model that returns
 * word timestamps, so wantWords picks it unless a model is configured.
 *
 * Style control: no model here takes in-text tags. gpt-4o-mini-tts takes
 * `instructions` (free-text direction of tone, pace and pitch), which is where
 * the annotation layer sends them; tts-1 and tts-1-hd take neither, so every
 * annotation is removed before the text is spoken.
 */
import { openaiTts, openaiStt, openaiCaps, openaiHealth } from './openai-compatible.js'
import { adaptationFor } from '../../shared/annotations.js'

const VOICES_ALL = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']
const VOICES_LEGACY = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer']

/** The models the reader menus offer. A dated snapshot or another id set as the instance model is added as is. */
const MODELS = [
  { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts (steerable: tone, pace and pitch as instructions)', voices: VOICES_ALL, instructions: true },
  { id: 'tts-1-hd', label: 'tts-1-hd (higher quality, no style control)', voices: VOICES_LEGACY, instructions: false },
  { id: 'tts-1', label: 'tts-1 (faster, no style control)', voices: VOICES_LEGACY, instructions: false },
]

const voiceSetFor = (model) => (/^tts-1/.test(model) ? VOICES_LEGACY : VOICES_ALL)

function resolveVoice(voice, model) {
  if (/^voice_/.test(voice)) return { voice } // custom voice id
  const set = voiceSetFor(model)
  if (set.includes(voice)) return { voice }
  return { voice: 'alloy', note: 'voice "' + voice + '" is not offered by ' + model + '; used alloy' }
}

const takesInstructions = (model) => /^gpt-4o[a-z0-9.-]*-tts/.test(String(model || ''))

const CFG = { label: 'openai', type: 'openai', defaultModel: 'gpt-4o-mini-tts', defaultVoice: 'marin', resolveVoice, instructionsFor: takesInstructions }
const STT_CFG = { label: 'openai', defaultModel: 'gpt-transcribe', wordsModel: 'whisper-1', langField: 'languages' }

export default {
  type: 'openai',
  label: 'OpenAI',
  hq: 'US',
  euNote: 'Default api.openai.com processes in the US. The EU host eu.api.openai.com stores and processes in the EEA and Switzerland, but needs OpenAI sales approval and Modified Abuse Monitoring or Zero Data Retention, and costs 10 percent more.',
  group: 'other',
  residency: 'non-eu',
  desc: 'OpenAI speech: gpt-4o-mini-tts and tts-1 voices, whisper-1 word timings, gpt-transcribe. TTS models shut down 2027-01-06.',
  docs: 'https://developers.openai.com/api/docs/guides/text-to-speech',
  status: 'verified',
  verification: 'Fetched 2026-10-31: developers.openai.com text-to-speech guide (13 voices, tts-1 and tts-1-hd limited to 9, response formats, languages follow Whisper including Greek and Italian), '
    + 'speech-to-text guide (gpt-transcribe recommended, `languages` replaces `language` for it, response carries `languages: [{code}]`, whisper-1 gives word timestamps via verbose_json and timestamp_granularities[], 25 MB limit), '
    + 'deprecations page (tts-1, tts-1-hd, gpt-4o-mini-tts shut down 2027-01-06; whisper-1 and gpt-4o transcribe models 2027-02-26) and the your-data page (EU host eu.api.openai.com, regional storage and processing, MAM or ZDR required, sales eligibility, 10 percent uplift). '
    + 'Unverified: maximum input length of /audio/speech (4096 characters assumed), word timestamps for gpt-transcribe (treated as json only).',
  // Re-checked on the live API, 2026-11-25: the 13 voices (the API lists them in its bad-voice error), speed 0.25 to 4 (0.2 is refused with
  // "Expected a value >= 0.25", 4 is accepted), `instructions` accepted by gpt-4o-mini-tts, and bracketed words such as [laugh] in the
  // input are not a style control (the same sentence came back without them in one sample, which is not a contract).
  presets: [
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: { tts: 'gpt-4o-mini-tts', stt: 'gpt-transcribe' }, defaultVoice: 'marin', group: 'other', residency: 'non-eu' },
    { id: 'openai-eu', label: 'OpenAI EU (data residency, needs approval)', baseUrl: 'https://eu.api.openai.com/v1', models: { tts: 'gpt-4o-mini-tts', stt: 'gpt-transcribe' }, defaultVoice: 'marin', group: 'other', residency: 'eu-region' },
  ],
  optionFields: [
    { key: 'format', label: 'Audio format', type: 'select', choices: ['mp3', 'opus', 'aac', 'flac', 'wav'], help: 'response_format sent with every speech request.', default: 'mp3' },
  ],
  configFields: ['baseUrl', 'credential', 'models', 'defaultVoice', 'options'],
  defaultBaseUrl: 'https://api.openai.com/v1',

  residencyOf(inst) {
    return /^https:\/\/eu\.api\.openai\.com(\/|$)/.test(String(inst.baseUrl || '')) ? 'eu-region' : 'non-eu'
  },

  configured(inst) { return Boolean(inst.secret()) },

  capabilities(inst) {
    const inner = Object.assign({}, inst, { options: Object.assign({}, inst.options, { tts: true, stt: true }) })
    const caps = openaiCaps(inner, { tts: true, stt: true, ttsLangs: '*', sttLangs: '*', maxChars: 4096 })
    caps.alignment = 'none'
    return caps
  },

  async health(inst, signal) { return openaiHealth(inst, signal, this.configured(inst)) },

  async listVoices(inst, opts) {
    // built-in voices are multilingual (optimised for English), so there is no language filter
    const model = String((opts && opts.model) || (inst.models && inst.models.tts) || CFG.defaultModel)
    const set = voiceSetFor(model)
    return VOICES_ALL.map((id) => ({
      id, name: id, langs: [], gender: null, accent: null,
      tags: [VOICES_LEGACY.includes(id) ? 'all-models' : 'gpt-4o-mini-tts-only'].concat(id === 'marin' || id === 'cedar' ? ['recommended'] : []),
    })).filter((v) => set.includes(v.id))
  },

  /** The models the reader menus offer, each with the voices that model has. */
  async ttsModels(inst) {
    const current = String((inst.models && inst.models.tts) || CFG.defaultModel)
    const list = MODELS.slice()
    if (!list.some((m) => m.id === current)) list.unshift({ id: current, label: current, voices: voiceSetFor(current), instructions: takesInstructions(current) })
    return list.map((m) => ({
      id: m.id, label: m.label, group: 'openai', voices: m.voices.map((id) => ({ id, label: id })), voiceFree: false,
      speed: [0.25, 4], instructions: m.instructions, formats: ['mp3', 'opus', 'aac', 'flac', 'wav'], maxChars: 4096, default: m.id === current,
      note: 'Retires on 2027-01-06.',
    }))
  },

  async tts(args, inst, signal) { return openaiTts(Object.assign({}, args, { wantAlignment: false }), inst, signal, CFG) },
  async stt(args, inst, signal) { return openaiStt(args, inst, signal, STT_CFG) },
}
