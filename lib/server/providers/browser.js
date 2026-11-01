/**
 * Provider type `browser`: the Web Speech API in the page (speechSynthesis for
 * TTS, SpeechRecognition for live interim text). Synthesised client side, so
 * the host half only describes it; a server TTS request for it is a 400
 * `browser_only`. Free and instant; robotic. Chrome's SpeechRecognition sends
 * audio to Google, which is why live interim text is off by default.
 */
import { voiceErr } from '../http.js'

export default {
  type: 'browser',
  label: 'Browser voice (Web Speech)',
  hq: 'browser',
  euNote: 'Local OS voices stay on the device; cloud voices belong to the browser vendor',
  group: 'self',
  residency: 'device',
  desc: 'The browser\'s own Web Speech voices: free and instant, robotic; local OS voices stay on the device.',
  docs: 'https://developer.mozilla.org/docs/Web/API/Web_Speech_API',
  status: 'verified',
  verification: 'Web Speech API as documented on MDN; synthesised in the page.',
  presets: [{ id: 'browser', label: 'Browser voice', baseUrl: '' }],
  configFields: [],
  defaultBaseUrl: '',
  clientOnly: true,

  configured() { return true },

  capabilities() {
    return {
      tts: true, stt: false, ttsLangs: '*', sttLangs: [], detectsLanguage: false,
      streaming: false, alignment: 'word', nativeSpeed: [0.25, 4], ssml: false,
      maxChars: 100000, formats: [], quota: false, clientOnly: true,
    }
  },

  async health() { return { ok: true, status: 'up', detail: 'synthesised in the page' } },
  async listVoices() { return [] },
  async tts() { throw voiceErr('the browser voice is synthesised in the page, not here', 'browser_only', 400) },

  async legacyConfig() { return { note: 'The browser\'s own speech synthesis. Instant and free; robotic.' } },
  chunkPlan() { return { first: 110, rest: 260 } },
}
