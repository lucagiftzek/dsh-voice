/**
 * Provider type `amazon`: Amazon Polly (TTS) and Amazon Transcribe streaming (STT),
 * both signed with the hand written SigV4 in ../sigv4.js (no SDK).
 *
 * Credential: "ACCESSKEYID:SECRET" or "ACCESSKEYID:SECRET:SESSIONTOKEN" (or the JSON
 * form accepted by parseAwsCredential). The region comes from inst.region.
 *
 * Polly:      POST https://polly.{region}.amazonaws.com/v1/speech      (mp3, then json speech marks)
 *             GET  https://polly.{region}.amazonaws.com/v1/voices
 * Transcribe: wss://transcribestreaming.{region}.amazonaws.com:8443/stream-transcription-websocket
 *             presigned URL, application/vnd.amazon.eventstream frames (AudioEvent in, TranscriptEvent out)
 */
import zlib from 'node:zlib'
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, isWav, toWav, lang2 } from '../http.js'
import { signRequest, presignUrl, parseAwsCredential } from '../sigv4.js'
import { wsConnect } from '../ws.js'
import { startsToWords, tokensToWords } from '../alignment.js'
import { escapeXml, prosodyRate } from '../ssml.js'

export const REGIONS = [
  { id: 'eu-central-1', label: 'Europe (Frankfurt)', eu: true },
  { id: 'eu-west-1', label: 'Europe (Ireland)', eu: true },
  { id: 'eu-west-2', label: 'Europe (London, UK)', eu: true },
  { id: 'eu-west-3', label: 'Europe (Paris), Polly only', eu: true },
  { id: 'eu-north-1', label: 'Europe (Stockholm), Polly only', eu: true },
  { id: 'eu-south-2', label: 'Europe (Spain), Polly only', eu: true },
  { id: 'eu-central-2', label: 'Europe (Zurich)', eu: true },
  { id: 'us-east-1', label: 'US East (N. Virginia)', eu: false },
  { id: 'us-east-2', label: 'US East (Ohio)', eu: false },
  { id: 'us-west-2', label: 'US West (Oregon)', eu: false },
  { id: 'ca-central-1', label: 'Canada (Central)', eu: false },
  { id: 'ap-southeast-1', label: 'Asia Pacific (Singapore)', eu: false },
  { id: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)', eu: false },
]

/** Polly languages with a verified default neural voice (Polly has no Greek). */
const DEFAULT_VOICE = { en: 'Joanna', it: 'Bianca', de: 'Vicki', fr: 'Lea', es: 'Lucia', pt: 'Ines', nl: 'Laura', sv: 'Elin', pl: 'Ola', da: 'Sofie' }
const POLLY_LOCALE = { en: 'en-US', it: 'it-IT', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', pt: 'pt-PT', nl: 'nl-NL', sv: 'sv-SE', pl: 'pl-PL', da: 'da-DK' }
const TTS_LANGS = Object.keys(DEFAULT_VOICE)
const STT_LOCALE = { en: 'en-US', it: 'it-IT', el: 'el-GR', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', pt: 'pt-PT', nl: 'nl-NL' }
const STT_LANGS = Object.keys(STT_LOCALE)
const ENGINES = ['neural', 'standard', 'long-form', 'generative']
const MP3_BPS = 48000

export const regionOf = (inst) => {
  const r = String(inst.region || (inst.options && inst.options.region) || 'eu-west-1').toLowerCase().trim()
  return /^[a-z]{2}-[a-z]+-\d$/.test(r) ? r : 'eu-west-1'
}
export const isEuRegion = (r) => /^eu-/.test(r)
const engineOf = (inst) => {
  const e = String((inst.options && inst.options.engine) || 'neural')
  return ENGINES.includes(e) ? e : 'neural'
}

export function endpointsOf(inst) {
  const r = regionOf(inst)
  const o = inst.options || {}
  return {
    polly: inst.baseUrl ? String(inst.baseUrl) : 'https://polly.' + r + '.amazonaws.com',
    ws: o.wsBaseUrl ? String(o.wsBaseUrl) : 'wss://transcribestreaming.' + r + '.amazonaws.com:8443',
  }
}

const creds = (inst) => parseAwsCredential(inst.secret())

function badKey(what) { return voiceErr('amazon ' + what + ': credential is not ACCESSKEYID:SECRET[:SESSIONTOKEN]', 'bad_key', 502) }

function typed(status, body, what) {
  const msg = 'amazon ' + what + ' ' + status + ': ' + scrub(body, 200)
  if (status === 401 || status === 403) return voiceErr(msg, 'bad_key', 502)
  if (status === 429 || /ThrottlingException|TooManyRequests/.test(body)) return voiceErr(msg, 'quota_exceeded', 429)
  if (status === 400 && /LanguageNotSupported|language/i.test(body)) return voiceErr(msg, 'unsupported_lang', 400)
  if (status === 400 && /voice|engine/i.test(body)) return voiceErr(msg, 'bad_voice', 400)
  return voiceErr(msg, 'vendor', 502)
}

/** Signed call to Polly. */
async function polly(inst, method, pathAndQuery, bodyObj, signal) {
  const c = creds(inst)
  if (!c) throw badKey('polly')
  const url = joinUrl(endpointsOf(inst).polly, pathAndQuery)
  const body = bodyObj ? jsonBody(bodyObj) : undefined
  const headers = signRequest({
    method, url, region: regionOf(inst), service: 'polly', credentials: c, body,
    headers: bodyObj ? { 'content-type': 'application/json' } : {},
  })
  delete headers.host
  return request(url, { method, headers, body, signal, timeout: method === 'POST' ? 120000 : 15000 })
}

export function pickVoice(inst, voice, lang) {
  const v = String(voice || '').trim()
  if (/^[A-Z][a-z]{2,15}$/.test(v)) return v
  const d = String(inst.defaultVoice || '').trim()
  if (/^[A-Z][a-z]{2,15}$/.test(d) && !lang) return d
  if (/^[A-Z][a-z]{2,15}$/.test(d) && lang && inst.state && inst.state.voiceLang && inst.state.voiceLang[d] === lang2(lang)) return d
  return DEFAULT_VOICE[lang2(lang)] || ''
}

/** Speech marks: byte offsets (UTF-8) in the text that was sent -> JS string offsets. */
export function marksToStarts(sent, lines) {
  const buf = Buffer.from(sent, 'utf8')
  const out = []
  for (const m of lines) {
    if (!m || m.type !== 'word') continue
    const s = Number(m.start)
    const e = Number(m.end)
    if (!(e > s) || e > buf.length) continue
    const c0 = buf.slice(0, s).toString('utf8').length
    out.push({ c0, c1: c0 + buf.slice(s, e).toString('utf8').length, t0: Number(m.time) / 1000 })
  }
  return out
}

// ---------------------------------------------------------------- event stream

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
export function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function strHeader(name, value) {
  const n = Buffer.from(name, 'utf8')
  const v = Buffer.from(value, 'utf8')
  const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length)
  out[0] = n.length
  n.copy(out, 1)
  out[1 + n.length] = 7
  out.writeUInt16BE(v.length, 2 + n.length)
  v.copy(out, 4 + n.length)
  return out
}

/** One application/vnd.amazon.eventstream message with string headers. */
export function encodeEvent(headers, payload) {
  const h = Buffer.concat(Object.keys(headers).map((k) => strHeader(k, headers[k])))
  const p = payload || Buffer.alloc(0)
  const total = 12 + h.length + p.length + 4
  const b = Buffer.alloc(total)
  b.writeUInt32BE(total, 0)
  b.writeUInt32BE(h.length, 4)
  b.writeUInt32BE(crc32(b.slice(0, 8)), 8)
  h.copy(b, 12)
  p.copy(b, 12 + h.length)
  b.writeUInt32BE(crc32(b.slice(0, total - 4)), total - 4)
  return b
}

export const audioEvent = (pcm) => encodeEvent({ ':content-type': 'application/octet-stream', ':event-type': 'AudioEvent', ':message-type': 'event' }, pcm)

/** Decode every message in a buffer: [{ headers, payload }]. Throws on a bad CRC. */
export function decodeEvents(buf) {
  const out = []
  let at = 0
  while (at + 16 <= buf.length) {
    const total = buf.readUInt32BE(at)
    const hl = buf.readUInt32BE(at + 4)
    if (total < 16 || at + total > buf.length) break
    if (buf.readUInt32BE(at + 8) !== crc32(buf.slice(at, at + 8))) throw voiceErr('amazon eventstream: prelude crc mismatch', 'vendor', 502)
    if (buf.readUInt32BE(at + total - 4) !== crc32(buf.slice(at, at + total - 4))) throw voiceErr('amazon eventstream: message crc mismatch', 'vendor', 502)
    const headers = {}
    let p = at + 12
    const hend = p + hl
    while (p < hend) {
      const nl = buf[p]; p += 1
      const name = buf.slice(p, p + nl).toString('utf8'); p += nl
      const type = buf[p]; p += 1
      let val = true
      if (type === 0) val = true
      else if (type === 1) val = false
      else if (type === 2) { val = buf.readInt8(p); p += 1 }
      else if (type === 3) { val = buf.readInt16BE(p); p += 2 }
      else if (type === 4) { val = buf.readInt32BE(p); p += 4 }
      else if (type === 5 || type === 8) { val = Number(buf.readBigInt64BE(p)); p += 8 }
      else if (type === 9) { val = buf.slice(p, p + 16).toString('hex'); p += 16 }
      else { const l = buf.readUInt16BE(p); p += 2; val = type === 7 ? buf.slice(p, p + l).toString('utf8') : buf.slice(p, p + l); p += l }
      headers[name] = val
    }
    out.push({ headers, payload: buf.slice(hend, at + total - 4) })
    at += total
  }
  return out
}

/** PCM (s16le) and its sample rate out of a wav buffer. */
export function wavToPcm(wav) {
  let rate = 16000
  let at = 12
  while (at + 8 <= wav.length) {
    const id = wav.slice(at, at + 4).toString('latin1')
    const len = wav.readUInt32LE(at + 4)
    if (id === 'fmt ') rate = wav.readUInt32LE(at + 12)
    if (id === 'data') return { pcm: wav.slice(at + 8, len ? Math.min(wav.length, at + 8 + len) : wav.length), rate }
    at += 8 + len + (len % 2)
  }
  return { pcm: wav.slice(44), rate }
}

const sec = (x) => Number(x) || 0

export default {
  type: 'amazon',
  label: 'Amazon Polly and Transcribe',
  hq: 'US',
  euNote: 'Amazon (US company). Pick an EU region (Frankfurt, Ireland and others) to process there. Credential format: ACCESSKEYID:SECRET or ACCESSKEYID:SECRET:SESSIONTOKEN. Polly has no Greek voice.',
  group: 'other',
  residency: 'varies',
  desc: 'Amazon Polly voices with word timings (Italian, no Greek) and Transcribe streaming speech to text; EU regions, SigV4.',
  docs: 'https://docs.aws.amazon.com/polly/latest/dg/what-is.html',
  status: 'partial',
  verification: [
    'Fetched 2026-10-31: Polly SynthesizeSpeech API reference (JSON body Engine, LanguageCode, OutputFormat json|mp3|..., SpeechMarkTypes, Text, TextType, VoiceId; engines standard, neural, long-form, generative; 6000 character limit; LanguageCode list has no Greek), DescribeVoices (GET /v1/voices?Engine=&LanguageCode=, response Voices[Id,Name,Gender,LanguageCode,SupportedEngines]), the speech marks pages (json lines with time in ms, type, start and end in BYTES of the UTF-8 input, value; available for neural, long-form and standard, not generative), the Transcribe supported languages table (el-GR and it-IT streaming), the Transcribe WebSocket setup page (presigned URL on port 8443, query language-code, media-encoding, sample-rate, signed header host, event stream encoding with CRC32 prelude and message checksums, AudioEvent headers, TranscriptEvent and exception headers, empty AudioEvent ends the stream) and the AWS endpoint tables (Polly in eu-central-1, eu-west-1, eu-west-2, eu-west-3, eu-north-1, eu-south-2, eu-central-2; Transcribe streaming in eu-central-1, eu-west-1, eu-west-2, eu-central-2).',
    'STT uses the streaming WebSocket (batch Transcribe needs S3). Re-checked 2026-10-31 (pre-merge review) against the Transcribe API reference (Result, Alternative, Item pages): TranscriptEvent Results[IsPartial, LanguageCode, ResultId, Alternatives[Transcript, Items[Content, StartTime, EndTime, Type pronunciation|punctuation]]] and the event-stream headers match; el-GR is listed for streaming. Unverified: the identify-language and language-options query parameters used when no language is given, and whether audio sent faster than real time is accepted (chunks of 100 ms are sent with a short pause). Neural default voices per language come from the VoiceId list, not from a per language voice table.',
    'Word timings: a second SynthesizeSpeech call with OutputFormat json and SpeechMarkTypes word (billed again by Polly as characters); not available on the generative engine, where alignment is null. Byte offsets are converted to string offsets.',
    'Credential parse failure gives bad_key.',
  ].join(' '),
  presets: [
    { id: 'amazon', label: 'Amazon Polly and Transcribe (Frankfurt)', region: 'eu-central-1', defaultVoice: 'Bianca' },
    { id: 'amazon-ireland', label: 'Amazon Polly and Transcribe (Ireland)', region: 'eu-west-1', defaultVoice: 'Bianca' },
  ],
  regions: REGIONS,
  optionFields: [
    { key: 'engine', label: 'Polly engine', type: 'select', choices: ENGINES, default: 'neural', help: 'neural by default. generative has no word timings. The voice must support the engine.' },
  ],
  configFields: ['credential', 'region', 'defaultVoice', 'options'],
  defaultBaseUrl: '',

  residencyOf(inst) { return isEuRegion(regionOf(inst)) ? 'eu-region' : 'non-eu' },

  configured(inst) { return Boolean(creds(inst)) },

  capabilities(inst) {
    return {
      tts: true, stt: true,
      ttsLangs: TTS_LANGS.slice(), sttLangs: STT_LANGS.slice(),
      detectsLanguage: true,
      streaming: false,
      alignment: inst && engineOf(inst) === 'generative' ? 'none' : 'word',
      nativeSpeed: [0.5, 2],
      ssml: true, maxChars: 3000, formats: ['mp3'], quota: false,
    }
  },

  async health(inst, signal) {
    if (!creds(inst)) return { ok: false, status: 'down', detail: 'credential not ACCESSKEYID:SECRET' }
    try {
      const up = await polly(inst, 'GET', '/v1/voices?Engine=neural&LanguageCode=it-IT', null, signal)
      if (up.status === 200) return { ok: true, status: 'up', detail: regionOf(inst) }
      if (up.status === 401 || up.status === 403) return { ok: false, status: 'down', detail: 'credential rejected (' + up.status + ')' }
      return { ok: false, status: 'down', detail: 'status ' + up.status }
    } catch (e) { return { ok: false, status: 'down', detail: scrub(e && e.message, 120) } }
  },

  async listVoices(inst, opts, signal) {
    const want = opts && opts.lang ? lang2(opts.lang) : ''
    const code = want ? (POLLY_LOCALE[want] || '') : ''
    if (want && !code) return []
    const st = inst.state
    st.voiceCache = st.voiceCache || {}
    const hit = st.voiceCache[code]
    const now = Date.now()
    if (hit && now - hit.at < 600000) return hit.voices
    const q = '?IncludeAdditionalLanguageCodes=true' + (code ? '&LanguageCode=' + code : '')
    const up = await polly(inst, 'GET', '/v1/voices' + q, null, signal)
    if (up.status !== 200) throw typed(up.status, up.body.toString('utf8'), 'voices')
    const d = parseJson(up.body) || {}
    const voices = (d.Voices || []).filter((v) => v && v.Id).map((v) => {
      const langs = []
      ;[v.LanguageCode].concat(v.AdditionalLanguageCodes || []).forEach((c) => { const l = lang2(c); if (c && langs.indexOf(l) < 0) langs.push(l) })
      return { id: v.Id, name: v.Name || v.Id, langs, gender: String(v.Gender || '').toLowerCase(), accent: v.LanguageCode || '', tags: v.SupportedEngines || [] }
    })
    st.voiceLang = st.voiceLang || {}
    voices.forEach((v) => { if (v.langs[0]) st.voiceLang[v.id] = v.langs[0] })
    st.voiceCache[code] = { at: now, voices }
    return voices
  },

  async tts({ text, voice, lang, speed, wantAlignment }, inst, signal) {
    const l2 = lang2(lang)
    if (l2 === 'el') throw voiceErr('amazon polly has no Greek voice', 'unsupported_lang', 400)
    const v = pickVoice(inst, voice, lang)
    if (!v) throw voiceErr('amazon polly has no voice for language ' + l2, 'unsupported_lang', 400)
    const t = String(text)
    const engine = engineOf(inst)
    const rate = prosodyRate(speed)
    const ssml = rate ? '<speak><prosody rate="' + (100 + Math.round((Number(speed) - 1) * 100)) + '%">' + escapeXml(t) + '</prosody></speak>' : ''
    const base = { Text: ssml || t, TextType: ssml ? 'ssml' : 'text', VoiceId: v, Engine: engine }
    if (POLLY_LOCALE[l2] && !voice) base.LanguageCode = POLLY_LOCALE[l2]
    const up = await polly(inst, 'POST', '/v1/speech', Object.assign({ OutputFormat: 'mp3' }, base), signal)
    if (up.status !== 200) throw typed(up.status, up.body.toString('utf8'), 'tts')
    if (!up.body.length) throw voiceErr('amazon tts: empty audio', 'vendor', 502)
    const out = {
      audio: up.body, mime: 'audio/mpeg', voice: v, model: engine, billedChars: t.length,
      alignment: null, durationS: (up.body.length * 8) / MP3_BPS,
    }
    if (wantAlignment && engine !== 'generative') {
      try {
        const mk = await polly(inst, 'POST', '/v1/speech', Object.assign({ OutputFormat: 'json', SpeechMarkTypes: ['word'] }, base), signal)
        if (mk.status !== 200) throw typed(mk.status, mk.body.toString('utf8'), 'speech marks')
        // Polly bills a speech-marks request like a speech request (Polly FAQ): the text counts twice.
        out.billedChars += t.length
        const lines = mk.body.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => parseJson(l)).filter(Boolean)
        let starts
        if (ssml) {
          // offsets index the SSML document: map the words back to the plain text by value
          const un = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
          const toks = lines.filter((m) => m.type === 'word').map((m) => ({ text: un(m.value), t0: sec(m.time) / 1000, t1: 0 }))
          const placed = tokensToWords(t, toks)
          starts = placed ? placed.map((p) => ({ c0: p.c0, c1: p.c1, t0: p.t0 })) : []
        } else starts = marksToStarts(t, lines)
        if (starts.length) {
          const last = Math.max(...starts.map((x) => x.t0))
          out.durationS = Math.max(out.durationS, last)
          out.alignment = { unit: 'word', items: startsToWords(starts, out.durationS) }
        }
      } catch (e) {
        if (signal && signal.aborted) throw e
        if (e.code === 'bad_key' || e.code === 'quota_exceeded') throw e
        out.note = 'word timings unavailable (' + scrub(e && e.message, 80) + ')'
      }
    }
    return out
  },

  async stt({ audio, lang, wantWords }, inst, signal) {
    const c = creds(inst)
    if (!c) throw badKey('transcribe')
    const buf = isWav(audio) ? audio : await toWav(audio)
    const { pcm, rate } = wavToPcm(buf)
    const l2 = lang ? lang2(lang) : ''
    const query = { 'media-encoding': 'pcm', 'sample-rate': String(rate) }
    if (lang) query['language-code'] = String(lang).includes('-') ? lang : (STT_LOCALE[l2] || l2)
    else { query['identify-language'] = 'true'; query['language-options'] = 'el-GR,it-IT,en-US' }
    const url = presignUrl({
      method: 'GET', url: endpointsOf(inst).ws.replace(/\/+$/, '') + '/stream-transcription-websocket',
      region: regionOf(inst), service: 'transcribe', credentials: c, expires: 300, query,
    })
    const ws = await wsConnect(url, { timeout: 8000, signal })
    return new Promise((resolve, reject) => {
      const results = []
      let over = false
      let sent = false
      const finish = (fn, v) => { if (over) return; over = true; clearTimeout(timer); try { ws.close() } catch (e) { /* gone */ } fn(v) }
      const timer = setTimeout(() => finish(reject, voiceErr('amazon transcribe timeout', 'timeout', 504)), 120000)
      const done = () => {
        const alts = results.map((r) => (r.Alternatives && r.Alternatives[0]) || {})
        const text = alts.map((a) => String(a.Transcript || '').trim()).filter(Boolean).join(' ')
        const words = []
        alts.forEach((a) => (a.Items || []).forEach((it) => {
          if (it.Type === 'pronunciation') words.push({ w: it.Content, t0: sec(it.StartTime), t1: sec(it.EndTime) })
        }))
        const lc = results.find((r) => r.LanguageCode)
        finish(resolve, {
          text, language: lc ? lang2(lc.LanguageCode) : (lang ? l2 : null),
          words: wantWords && words.length ? words : null,
          durationS: pcm.length / 2 / rate,
        })
      }
      ws.on('error', (e) => finish(reject, e))
      ws.on('close', () => (sent ? done() : finish(reject, voiceErr('amazon transcribe closed early', 'vendor', 502))))
      ws.on('message', (data, isBin) => {
        try {
          if (!isBin) return
          for (const ev of decodeEvents(data)) {
            const mt = ev.headers[':message-type']
            if (mt === 'exception') {
              const kind = String(ev.headers[':exception-type'] || '')
              const msg = 'amazon transcribe ' + kind + ': ' + scrub(ev.payload.toString('utf8'), 160)
              if (/Unrecognized|AccessDenied|Signature/.test(kind)) return finish(reject, voiceErr(msg, 'bad_key', 502))
              if (/LimitExceeded|Throttl/.test(kind)) return finish(reject, voiceErr(msg, 'quota_exceeded', 429))
              if (/language/i.test(msg)) return finish(reject, voiceErr(msg, 'unsupported_lang', 400))
              return finish(reject, voiceErr(msg, 'vendor', 502))
            }
            if (ev.headers[':event-type'] === 'TranscriptEvent') {
              const j = parseJson(ev.payload) || {}
              ;((j.Transcript && j.Transcript.Results) || []).forEach((r) => { if (!r.IsPartial) results.push(r) })
            }
          }
        } catch (e) { finish(reject, e) }
      })
      ;(async () => {
        const chunk = Math.max(2, Math.floor(rate / 10) * 2)
        for (let at = 0; at < pcm.length && !over; at += chunk) {
          ws.sendBinary(audioEvent(pcm.slice(at, at + chunk)))
          if (pcm.length > chunk * 4) await new Promise((r) => setTimeout(r, 5))
        }
        sent = true
        if (!over) ws.sendBinary(audioEvent(Buffer.alloc(0)))
      })().catch((e) => finish(reject, e))
    })
  },
}
