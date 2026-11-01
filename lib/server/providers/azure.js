/**
 * Provider type `azure`: Azure AI Speech (TTS + STT) on the regional REST
 * endpoints, with optional WordBoundary word timings over the TTS WebSocket.
 *
 * Credential: the Speech resource key (Ocp-Apim-Subscription-Key). A value that
 * starts with "Bearer " is sent as an Authorization header instead (token from
 * the issueToken endpoint or Entra). The region comes from inst.region.
 *
 * TTS REST:  POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1 (SSML)
 * Voices:    GET  https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list
 * TTS WS:    wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v1
 *            (speech.config, synthesis.context, ssml; turn.start, audio, audio.metadata, turn.end)
 * STT:       fast transcription, POST https://{region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe
 *
 * The WebSocket TTS protocol is not part of the public REST documentation. It was
 * taken from the MIT licensed Speech SDK for JavaScript sources (message paths,
 * header layout, metadataOptions). REST stays the fallback when the socket fails.
 */
import { request, joinUrl, parseJson, voiceErr, scrub, multipart, audioType, lang2 } from '../http.js'
import { wsConnect } from '../ws.js'
import { tokensToWords } from '../alignment.js'
import { escapeXml, prosodyRate } from '../ssml.js'
import crypto from 'node:crypto'

export const REGIONS = [
  { id: 'westeurope', label: 'West Europe (Netherlands)', eu: true },
  { id: 'northeurope', label: 'North Europe (Ireland)', eu: true },
  { id: 'swedencentral', label: 'Sweden Central', eu: true },
  { id: 'francecentral', label: 'France Central', eu: true },
  { id: 'germanywestcentral', label: 'Germany West Central', eu: true },
  { id: 'italynorth', label: 'Italy North', eu: true },
  { id: 'spaincentral', label: 'Spain Central', eu: true },
  { id: 'norwayeast', label: 'Norway East (EEA)', eu: true },
  { id: 'switzerlandnorth', label: 'Switzerland North (adequacy decision)', eu: true },
  { id: 'uksouth', label: 'UK South', eu: false },
  { id: 'eastus', label: 'East US', eu: false },
  { id: 'eastus2', label: 'East US 2', eu: false },
  { id: 'westus2', label: 'West US 2', eu: false },
  { id: 'westus3', label: 'West US 3', eu: false },
  { id: 'canadacentral', label: 'Canada Central', eu: false },
  { id: 'brazilsouth', label: 'Brazil South', eu: false },
  { id: 'australiaeast', label: 'Australia East', eu: false },
  { id: 'japaneast', label: 'Japan East', eu: false },
  { id: 'southeastasia', label: 'Southeast Asia', eu: false },
  { id: 'centralindia', label: 'Central India', eu: false },
]

const LOCALE = {
  en: 'en-US', el: 'el-GR', it: 'it-IT', de: 'de-DE', fr: 'fr-FR', es: 'es-ES',
  pt: 'pt-PT', nl: 'nl-NL', sv: 'sv-SE', pl: 'pl-PL', ro: 'ro-RO', bg: 'bg-BG',
}
const DEFAULT_VOICE = {
  en: 'en-US-JennyNeural', el: 'el-GR-AthinaNeural', it: 'it-IT-ElsaNeural', de: 'de-DE-KatjaNeural',
  fr: 'fr-FR-DeniseNeural', es: 'es-ES-ElviraNeural', pt: 'pt-PT-RaquelNeural', nl: 'nl-NL-ColetteNeural',
  sv: 'sv-SE-SofieNeural', pl: 'pl-PL-ZofiaNeural', ro: 'ro-RO-AlinaNeural', bg: 'bg-BG-KalinaNeural',
}
const LANGS = Object.keys(LOCALE)
const OUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
const MP3_BPS = 48000
const STT_API = '2025-10-15'
const UA = 'dsh-voice'

export const regionOf = (inst) => {
  const r = String(inst.region || (inst.options && inst.options.region) || 'westeurope').toLowerCase().trim()
  return /^[a-z0-9]{3,40}$/.test(r) ? r : 'westeurope'
}
export const isEuRegion = (r) => REGIONS.some((x) => x.id === r && x.eu)

function ttsBase(inst) { return inst.baseUrl ? String(inst.baseUrl) : 'https://' + regionOf(inst) + '.tts.speech.microsoft.com' }
function sttBase(inst) { return inst.baseUrl ? String(inst.baseUrl) : 'https://' + regionOf(inst) + '.api.cognitive.microsoft.com' }
function wsBase(inst) {
  const o = inst.options || {}
  if (o.wsBaseUrl) return String(o.wsBaseUrl)
  if (inst.baseUrl) return String(inst.baseUrl).replace(/^http/, 'ws')
  return 'wss://' + regionOf(inst) + '.tts.speech.microsoft.com'
}

/** The three base URLs for an instance (baseUrl wins over the region). */
export function endpointsOf(inst) { return { tts: ttsBase(inst), stt: sttBase(inst), ws: wsBase(inst) } }

function auth(inst) {
  const s = String(inst.secret() || '').trim()
  if (/^bearer\s/i.test(s)) return { authorization: s.replace(/^bearer\s+/i, 'Bearer ') }
  return { 'ocp-apim-subscription-key': s }
}

function typed(status, body, what) {
  const msg = 'azure ' + what + ' ' + status + ': ' + scrub(body, 200)
  if (status === 401 || status === 403) return voiceErr(msg, 'bad_key', 502)
  if (status === 429) return voiceErr(msg, 'quota_exceeded', 429)
  if (status === 400 && /voice/i.test(body)) return voiceErr(msg, 'bad_voice', 400)
  if (status === 400 && /(language|locale)/i.test(body)) return voiceErr(msg, 'unsupported_lang', 400)
  return voiceErr(msg, 'vendor', 502)
}

const wsOn = (inst) => {
  const v = inst.options && inst.options.wordBoundary
  return !(v === false || v === 'false' || v === 0 || v === '0')
}

/** A voice name like el-GR-AthinaNeural or it-IT-Alessio:DragonHDLatestNeural. */
const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z0-9:.-]+$/

export function pickVoice(inst, voice, lang) {
  const v = String(voice || '').trim()
  if (VOICE_RE.test(v)) return v
  const d = String(inst.defaultVoice || '').trim()
  if (VOICE_RE.test(d) && (!lang || d.slice(0, 2).toLowerCase() === lang2(lang))) return d
  return DEFAULT_VOICE[lang2(lang)] || (VOICE_RE.test(d) ? d : DEFAULT_VOICE.en)
}

export function buildSsml(text, voice, speed) {
  const xmlLang = voice.split('-').slice(0, 2).join('-')
  const rate = prosodyRate(speed)
  const body = escapeXml(text)
  const inner = rate ? "<prosody rate='" + rate + "'>" + body + '</prosody>' : body
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + xmlLang + "'><voice name='" + voice + "'>" + inner + '</voice></speak>'
}

/** The WebSocket text message layout: "Header: value" lines, a blank line, the body. */
function wsText(path, requestId, contentType, body) {
  return 'Path: ' + path + '\r\nX-RequestId: ' + requestId + '\r\nX-Timestamp: ' + new Date().toISOString() +
    '\r\nContent-Type: ' + contentType + '\r\n\r\n' + body
}

function headersOf(str) {
  const h = {}
  String(str).split(/\r\n/).forEach((line) => {
    const i = line.indexOf(':')
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  })
  return h
}

/** Synthesize over the socket. Resolves { audio, tokens } (tokens in seconds). */
async function wsSynth(inst, ssml, signal) {
  const rid = crypto.randomUUID().replace(/-/g, '')
  const url = new URL(wsBase(inst).replace(/\/+$/, '') + '/cognitiveservices/websocket/v1')
  const ws = await wsConnect(url, {
    headers: Object.assign({ 'X-ConnectionId': crypto.randomUUID().replace(/-/g, ''), 'User-Agent': UA }, auth(inst)),
    timeout: 8000, signal,
  })
  return new Promise((resolve, reject) => {
    const audio = []
    const tokens = []
    let over = false
    const end = (fn, v) => { if (over) return; over = true; clearTimeout(timer); try { ws.close() } catch (e) { /* gone */ } fn(v) }
    const timer = setTimeout(() => end(reject, voiceErr('azure websocket timeout', 'timeout', 504)), 60000)
    ws.on('error', (e) => end(reject, e))
    ws.on('close', () => end(reject, voiceErr('azure websocket closed before turn.end', 'vendor', 502)))
    ws.on('message', (data, isBin) => {
      try {
        if (isBin) {
          if (data.length < 2) return
          const hl = data.readUInt16BE(0)
          const h = headersOf(data.slice(2, 2 + hl).toString('latin1'))
          if (h.path === 'audio' && data.length > 2 + hl) audio.push(data.slice(2 + hl))
          return
        }
        const i = data.indexOf('\r\n\r\n')
        const h = headersOf(i >= 0 ? data.slice(0, i) : data)
        const body = i >= 0 ? data.slice(i + 4) : ''
        if (h.path === 'audio.metadata') {
          const j = parseJson(body) || {}
          ;(j.Metadata || []).forEach((m) => {
            if (m && m.Type === 'WordBoundary' && m.Data && m.Data.text) {
              const bt = m.Data.text.BoundaryType
              if (bt && bt !== 'WordBoundary') return
              const t0 = Number(m.Data.Offset) / 1e7
              tokens.push({ text: m.Data.text.Text, t0, t1: t0 + Number(m.Data.Duration || 0) / 1e7 })
            }
          })
        } else if (h.path === 'turn.end') {
          end(resolve, { audio: Buffer.concat(audio), tokens })
        }
      } catch (e) { end(reject, e) }
    })
    try {
      ws.sendText(wsText('speech.config', rid, 'application/json', JSON.stringify({ context: { system: { name: UA, version: '2' } } })))
      ws.sendText(wsText('synthesis.context', rid, 'application/json', JSON.stringify({
        synthesis: { audio: { outputFormat: OUT_FORMAT, metadataOptions: {
          bookmarkEnabled: false, punctuationBoundaryEnabled: false, sentenceBoundaryEnabled: false,
          sessionEndEnabled: true, visemeEnabled: false, wordBoundaryEnabled: true,
        } }, language: { autoDetection: false } },
      })))
      ws.sendText(wsText('ssml', rid, 'application/ssml+xml', ssml))
    } catch (e) { end(reject, e) }
  })
}

async function restSynth(inst, ssml, signal) {
  const up = await request(joinUrl(ttsBase(inst), '/cognitiveservices/v1'), {
    method: 'POST', signal, timeout: 120000,
    headers: Object.assign({ 'content-type': 'application/ssml+xml', 'x-microsoft-outputformat': OUT_FORMAT, 'user-agent': UA }, auth(inst)),
    body: Buffer.from(ssml, 'utf8'),
  })
  if (up.status !== 200) throw typed(up.status, up.body.toString('utf8'), 'tts')
  if (!up.body.length) throw voiceErr('azure tts: empty audio', 'vendor', 502)
  return up.body
}

export default {
  type: 'azure',
  label: 'Azure AI Speech',
  hq: 'US',
  euNote: 'Microsoft (US company) with EU regions: pick an EU region (West Europe, Sweden Central, Italy North and others) to keep processing there. Credential is the Speech resource key; the region is a separate setting.',
  group: 'other',
  residency: 'varies',
  desc: 'Microsoft neural voices (Greek Athina and Nestoras, many Italian) and fast transcription with word timestamps; EU regions.',
  docs: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech',
  status: 'partial',
  verification: [
    'Fetched 2026-10-31: Speech TTS REST reference (endpoint per region, headers Ocp-Apim-Subscription-Key / Authorization Bearer, Content-Type application/ssml+xml, X-Microsoft-OutputFormat, User-Agent, voices/list response fields, status codes 400/401/415/429/502/503), the STT short-audio REST page (60 s limit, wav pcm 16 kHz and ogg opus only), the fast transcription page and REST reference (multipart audio + definition {locales}, api-version 2025-10-15, wav/mp3/ogg/webm accepted, phrases[].words with offsetMilliseconds and durationMilliseconds), and the language support page (el-GR AthinaNeural and NestorasNeural, it-IT Elsa, Isabella, Diego and others, STT el-GR and it-IT).',
    'STT uses fast transcription (accepts webm and ogg directly, word timestamps documented) instead of the short-audio REST API. The regional host https://{region}.api.cognitive.microsoft.com is taken from the issueToken and endpoint examples; not confirmed for transcriptions:transcribe on every region.',
    'WordBoundary word timings over the TTS WebSocket are UNVERIFIED against official docs: Microsoft documents the socket only through the Speech SDK. The message layout (speech.config, synthesis.context with audio.metadataOptions.wordBoundaryEnabled, ssml, audio, audio.metadata, turn.end) was read from the MIT licensed Speech SDK for JavaScript sources and the open source edge-tts client; it has not been run against the live service. Option wordBoundary (default on) turns it off; any socket failure falls back to REST with alignment null (the client estimates at sentence level).',
    'Credential: the Speech resource key. Region: instance region setting (EU regions first). Not verified: per-region voice availability, quota numbers.',
  ].join(' '),
  presets: [
    { id: 'azure', label: 'Azure AI Speech (West Europe)', region: 'westeurope', defaultVoice: 'el-GR-AthinaNeural' },
    { id: 'azure-swedencentral', label: 'Azure AI Speech (Sweden Central)', region: 'swedencentral', defaultVoice: 'el-GR-AthinaNeural' },
    { id: 'azure-italynorth', label: 'Azure AI Speech (Italy North)', region: 'italynorth', defaultVoice: 'it-IT-ElsaNeural' },
  ],
  regions: REGIONS,
  optionFields: [
    { key: 'wordBoundary', label: 'Word timings over WebSocket', type: 'bool', default: true, help: 'Uses the TTS WebSocket for WordBoundary events (unverified protocol). Off or on failure: plain REST without timings.' },
  ],
  configFields: ['credential', 'region', 'defaultVoice', 'options'],
  defaultBaseUrl: '',

  residencyOf(inst) { return isEuRegion(regionOf(inst)) ? 'eu-region' : 'non-eu' },

  configured(inst) { return Boolean(inst.secret()) },

  capabilities(inst) {
    const ws = Boolean(inst && wsOn(inst))
    return {
      tts: true, stt: true,
      ttsLangs: LANGS.slice(), sttLangs: LANGS.slice(),
      detectsLanguage: true,
      streaming: false,
      alignment: ws ? 'word' : 'none',
      nativeSpeed: [0.5, 2],
      ssml: true, maxChars: 5000, formats: ['mp3'], quota: false,
    }
  },

  async health(inst, signal) {
    if (!this.configured(inst)) return { ok: false, status: 'down', detail: 'no key' }
    try {
      const up = await request(joinUrl(ttsBase(inst), '/cognitiveservices/voices/list'), { method: 'GET', headers: auth(inst), timeout: 8000, signal })
      if (up.status === 200) return { ok: true, status: 'up', detail: regionOf(inst) }
      if (up.status === 401 || up.status === 403) return { ok: false, status: 'down', detail: 'key or region rejected (' + up.status + ')' }
      return { ok: false, status: 'down', detail: 'status ' + up.status }
    } catch (e) { return { ok: false, status: 'down', detail: scrub(e && e.message, 120) } }
  },

  async listVoices(inst, opts, signal) {
    const st = inst.state
    const now = Date.now()
    if (!st.voices || !st.voices.length || now - (st.voicesAt || 0) > 600000) {
      const up = await request(joinUrl(ttsBase(inst), '/cognitiveservices/voices/list'), { method: 'GET', headers: auth(inst), timeout: 15000, signal })
      if (up.status !== 200) throw typed(up.status, up.body.toString('utf8'), 'voices')
      const arr = parseJson(up.body)
      if (!Array.isArray(arr)) throw voiceErr('azure voices: unexpected response', 'vendor', 502)
      st.voices = arr.filter((v) => v && v.ShortName).map((v) => {
        const langs = []
        ;[v.Locale].concat(v.SecondaryLocaleList || []).forEach((l) => { const c = lang2(l); if (l && langs.indexOf(c) < 0) langs.push(c) })
        return {
          id: v.ShortName, name: v.LocalName || v.DisplayName || v.ShortName, langs,
          gender: String(v.Gender || '').toLowerCase(), accent: v.Locale || '',
          tags: [v.VoiceType, v.Status].concat(v.StyleList || []).filter(Boolean),
        }
      })
      st.voicesAt = now
    }
    const want = opts && opts.lang ? lang2(opts.lang) : ''
    return want ? st.voices.filter((v) => v.langs.indexOf(want) >= 0) : st.voices
  },

  async tts({ text, voice, lang, speed, wantAlignment }, inst, signal) {
    const v = pickVoice(inst, voice, lang)
    const ssml = buildSsml(String(text), v, speed)
    let audio = null
    let alignment = null
    let note
    let durationS = 0
    const wsBlocked = Boolean(inst.state && inst.state.wsDownUntil && Date.now() < inst.state.wsDownUntil)
    if (wantAlignment && wsOn(inst) && !wsBlocked) {
      try {
        const r = await wsSynth(inst, ssml, signal)
        if (!r.audio.length) throw voiceErr('azure websocket: no audio', 'vendor', 502)
        audio = r.audio
        const items = tokensToWords(String(text), r.tokens)
        if (items && items.length) { alignment = { unit: 'word', items }; durationS = items[items.length - 1].t1 }
      } catch (e) {
        if (signal && signal.aborted) throw e
        // An unverified socket that fails once is skipped for ten minutes, so a broken one costs one handshake, not one per read.
        if (inst.state) inst.state.wsDownUntil = Date.now() + 10 * 60 * 1000
        note = 'websocket word timings failed (' + scrub(e && e.message, 80) + '); used REST without timings'
        audio = null
        alignment = null
      }
    }
    if (!audio) audio = await restSynth(inst, ssml, signal)
    const secs = (audio.length * 8) / MP3_BPS
    return {
      audio, mime: 'audio/mpeg', voice: v, model: '', billedChars: String(text).length,
      alignment, durationS: Math.max(durationS, secs), note,
    }
  },

  async stt({ audio, name, mime, lang, wantWords }, inst, signal) {
    const l2 = lang ? lang2(lang) : ''
    const locales = lang ? [String(lang).includes('-') ? lang : (LOCALE[l2] || l2)] : ['el-GR', 'it-IT', 'en-US']
    const mp = multipart({ definition: JSON.stringify({ locales }) }, {
      field: 'audio', name: name || 'dictation.webm', type: mime || audioType(audio, 'audio/webm'), data: audio,
    })
    const url = joinUrl(sttBase(inst), '/speechtotext/transcriptions:transcribe?api-version=' + STT_API)
    const up = await request(url, {
      method: 'POST', signal, timeout: 120000,
      headers: Object.assign({ 'content-type': mp.contentType, accept: 'application/json' }, auth(inst)),
      body: mp.body,
    })
    const body = up.body.toString('utf8')
    if (up.status !== 200) throw typed(up.status, body, 'stt')
    const d = parseJson(body) || {}
    const phrases = Array.isArray(d.phrases) ? d.phrases : []
    const text = (d.combinedPhrases && d.combinedPhrases.length
      ? d.combinedPhrases.map((p) => p.text).join(' ')
      : phrases.map((p) => p.text).join(' ')).trim()
    const words = []
    phrases.forEach((p) => (p.words || []).forEach((w) => {
      words.push({ w: w.text, t0: Number(w.offsetMilliseconds) / 1000, t1: (Number(w.offsetMilliseconds) + Number(w.durationMilliseconds || 0)) / 1000 })
    }))
    const confs = phrases.map((p) => Number(p.confidence)).filter((c) => c >= 0)
    const loc = phrases.find((p) => p.locale)
    return {
      text, language: loc ? lang2(loc.locale) : (lang ? l2 : null),
      confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : undefined,
      words: wantWords && words.length ? words : null,
      durationS: d.durationMilliseconds != null ? Number(d.durationMilliseconds) / 1000 : undefined,
    }
  },
}
