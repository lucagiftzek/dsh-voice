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
 */
import { openaiTts, openaiStt, openaiCaps, openaiHealth } from './openai-compatible.js'

const VOICES_ALL = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']
const VOICES_LEGACY = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer']

const voiceSetFor = (model) => (/^tts-1/.test(model) ? VOICES_LEGACY : VOICES_ALL)

function resolveVoice(voice, model) {
  if (/^voice_/.test(voice)) return { voice } // custom voice id
  const set = voiceSetFor(model)
  if (set.includes(voice)) return { voice }
  return { voice: 'alloy', note: 'voice "' + voice + '" is not offered by ' + model + '; used alloy' }
}

const CFG = { label: 'openai', defaultModel: 'gpt-4o-mini-tts', defaultVoice: 'marin', resolveVoice }
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
    + 'Unverified: maximum input length of /audio/speech (4096 characters assumed), word timestamps for gpt-transcribe (treated as json only), speed range 0.25 to 4 (from memory of the API reference).',
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

  async listVoices() {
    // built-in voices are multilingual (optimised for English), so there is no language filter
    return VOICES_ALL.map((id) => ({
      id, name: id, langs: [], gender: null, accent: null,
      tags: VOICES_LEGACY.includes(id) ? ['all-models'] : ['gpt-4o-mini-tts-only'].concat(id === 'marin' || id === 'cedar' ? ['recommended'] : []),
    }))
  },

  async tts(args, inst, signal) { return openaiTts(Object.assign({}, args, { wantAlignment: false }), inst, signal, CFG) },
  async stt(args, inst, signal) { return openaiStt(args, inst, signal, STT_CFG) },
}
