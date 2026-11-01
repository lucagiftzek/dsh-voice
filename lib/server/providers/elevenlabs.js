/**
 * Provider type `elevenlabs`: TTS (with character alignment) + Scribe STT, plus
 * the account's voice list and credit balance.
 *
 * Measured on the reference account: flash v2.5 bills HALF a credit per
 * character (13 credits for 26 characters, 2026-09-22), so the free tier's
 * 10,000 credits are about 20,000 characters a month. Having a key is not
 * having credits: a spent balance is skipped by automatic routing and the menu
 * says so before the click.
 *
 * The same functions serve the `elevenlabs-compatible` type (self-hosted
 * servers with the ElevenLabs request shape) through a different base URL.
 */
import { request, joinUrl, jsonBody, parseJson, voiceErr, scrub, multipart } from '../http.js'
import { charsToWords } from '../alignment.js'

export const CREDITS_PER_CHAR = 0.5
const TTL_MS = 300000
const TTL_ERR_MS = 60000
const QUOTA_MIN_MS = 3000

const defaults = (inst) => ({
  tts: (inst.models && inst.models.tts) || 'eleven_flash_v2_5',
  stt: (inst.models && inst.models.stt) || 'scribe_v2',
  voice: inst.defaultVoice || 'onwK4e9ZLuTAKqWW03F9',
})

const hdr = (inst, extra) => Object.assign({ 'xi-api-key': inst.secret() }, extra || {})

/** ElevenLabs puts {"detail":{"code","message"}} inside its 4xx bodies. */
export function elevenDetail(bodyText) {
  try {
    const d = JSON.parse(bodyText).detail
    if (d && typeof d === 'object') return { code: String(d.code || d.status || ''), message: String(d.message || '') }
    if (typeof d === 'string') return { code: '', message: d }
  } catch (e) { /* not json */ }
  return { code: '', message: scrub(bodyText, 200) }
}

export function quotaFrom(s) {
  const limit = Number(s && s.character_limit) || 0
  const used = Number(s && s.character_count) || 0
  return {
    tier: String((s && s.tier) || 'unknown'), used, limit,
    remaining: Math.max(0, limit - used),
    resetsAt: s && s.next_character_count_reset_unix ? s.next_character_count_reset_unix * 1000 : null,
  }
}

export function quotaSentence(q) {
  if (!q) return ''
  const when = q.resetsAt ? new Date(q.resetsAt).toISOString().slice(0, 10) : ''
  if (q.remaining <= 0) {
    return 'ElevenLabs credits are EXHAUSTED (' + q.used + ' of ' + q.limit + ' used on the ' + q.tier
      + ' plan' + (when ? ', next reset ' + when : '') + ')'
  }
  return q.remaining + ' of ' + q.limit + ' ElevenLabs credits left on the ' + q.tier + ' plan' + (when ? ', next reset ' + when : '')
}

export const charsLeft = (q) => (q ? Math.floor(q.remaining / CREDITS_PER_CHAR) : 0)

async function getJson(inst, path, timeout) {
  const up = await request(joinUrl(inst.baseUrl, path), { method: 'GET', headers: hdr(inst, { accept: 'application/json' }), timeout: timeout || 8000 })
  if (up.status !== 200) throw new Error('elevenlabs ' + path.split('?')[0] + ' ' + up.status + ': ' + scrub(up.body.toString('utf8'), 160))
  return parseJson(up.body) || {}
}

/** Voice catalogue + balance cached per instance (inst.state.acct). A cold cache blocks, a warm one refreshes in the background. */
export async function account(inst, force) {
  const st = inst.state
  const now = Date.now()
  const a = st.acct || { at: 0, voices: null, quota: null, error: null }
  const ttl = (a.error && !a.voices) ? TTL_ERR_MS : TTL_MS
  if (!force && a.at && now - a.at < ttl) return a
  if (!inst.secret()) {
    st.acct = { at: now, voices: null, quota: null, error: 'no API key for this ElevenLabs instance' }
    return st.acct
  }
  let voices = null
  let quota = null
  let error = null
  try {
    const v = await getJson(inst, '/v1/voices?page_size=100', 8000)
    voices = (Array.isArray(v.voices) ? v.voices : []).map((x) => ({
      id: String(x.voice_id || ''), name: String(x.name || x.voice_id || ''),
      category: x.category ? String(x.category) : null,
      labels: x.labels && typeof x.labels === 'object' ? x.labels : {},
    })).filter((x) => x.id)
  } catch (e) { error = String((e && e.message) || e) }
  try { quota = quotaFrom(await getJson(inst, '/v1/user/subscription', 8000)) } catch (e) { /* a balance is a nicety */ }
  st.acct = { at: now, voices, quota, error }
  return st.acct
}

/** Refresh only the balance, rate-limited to one vendor call per 3 s. */
export async function refreshQuota(inst) {
  const st = inst.state
  const now = Date.now()
  st.acct = st.acct || { at: 0, voices: null, quota: null, error: null }
  if (st.quotaAt && now - st.quotaAt < QUOTA_MIN_MS) return st.acct.quota
  try {
    st.acct.quota = quotaFrom(await getJson(inst, '/v1/user/subscription', 8000))
    st.quotaAt = now
  } catch (e) { /* keep the balance we had */ }
  return st.acct.quota
}

export function isDry(inst) {
  const q = inst.state.acct && inst.state.acct.quota
  return Boolean(q && q.remaining <= 0)
}

/** Shared TTS for elevenlabs and elevenlabs-compatible. */
export async function elevenTts({ text, voice, model, wantAlignment, lang }, inst, signal, opts) {
  const o = opts || {}
  const d = defaults(inst)
  let vid = String(voice || '').trim()
  let note = ''
  const acct = inst.state.acct
  if (vid && acct && acct.voices && acct.voices.length && !acct.voices.some((x) => x.id === vid)) {
    note = 'voice not on this account; used the default'
    vid = ''
  }
  vid = vid || d.voice
  const modelId = String(model || '').trim() || d.tts
  const fmt = 'mp3_44100_128'
  const path = '/v1/text-to-speech/' + encodeURIComponent(vid) + (wantAlignment ? '/with-timestamps' : '') + '?output_format=' + fmt
  const payload = { text, model_id: modelId, voice_settings: { stability: 0.35, similarity_boost: 0.75 } }
  if (o.languageCode && lang) payload.language_code = String(lang).slice(0, 2)
  const up = await request(joinUrl(inst.baseUrl, path), {
    method: 'POST', signal, timeout: 120000,
    headers: hdr(inst, { 'content-type': 'application/json', accept: wantAlignment ? 'application/json' : 'audio/mpeg' }),
    body: jsonBody(payload),
  })
  const ctype = String(up.headers['content-type'] || '')
  if (up.status !== 200 || (!wantAlignment && ctype.includes('json'))) {
    const bodyText = up.body.toString('utf8')
    const det = elevenDetail(bodyText)
    if (det.code === 'quota_exceeded' || /quota/i.test(det.message)) {
      if (inst.state.acct && inst.state.acct.quota) inst.state.acct.quota = Object.assign({}, inst.state.acct.quota, { remaining: 0 })
      const q = inst.state.acct && inst.state.acct.quota
      throw voiceErr('ElevenLabs has no credits left for this read. ' + (det.message || quotaSentence(q))
        + ' This message asked for about ' + Math.ceil(text.length * CREDITS_PER_CHAR) + ' credits. ' + quotaSentence(q)
        + '. Pick another voice engine, or upgrade the ElevenLabs plan.', 'quota_exceeded', 429)
    }
    if (up.status === 401) throw voiceErr('ElevenLabs rejected the API key (401). ' + (det.message || 'check the credential of this instance'), 'bad_key', 502)
    if (up.status === 404 || /voice/.test(det.code)) {
      throw voiceErr('ElevenLabs does not serve the voice "' + vid + '" on this account (' + (det.message || up.status) + '). Pick another voice.', 'bad_voice', 400)
    }
    throw voiceErr('elevenlabs tts ' + up.status + ': ' + (det.message || scrub(bodyText, 200)), 'vendor', 502)
  }
  if (!wantAlignment) return { audio: up.body, mime: 'audio/mpeg', voice: vid, model: modelId, billedChars: text.length, alignment: null, note }
  const j = parseJson(up.body) || {}
  if (!j.audio_base64) throw voiceErr('elevenlabs tts: no audio_base64 in the with-timestamps answer', 'vendor', 502)
  const al = j.alignment || j.normalized_alignment || null
  const words = al ? charsToWords(text, al) : null
  const durationS = al && al.character_end_times_seconds && al.character_end_times_seconds.length
    ? al.character_end_times_seconds[al.character_end_times_seconds.length - 1] : null
  return {
    audio: Buffer.from(j.audio_base64, 'base64'), mime: 'audio/mpeg', voice: vid, model: modelId, billedChars: text.length,
    alignment: words ? { unit: 'word', items: words } : null, durationS, note,
  }
}

/** Shared Scribe-shaped STT. */
export async function elevenStt({ audio, name, mime, lang, model }, inst, signal) {
  const fields = { model_id: model || defaults(inst).stt }
  if (lang) fields.language_code = String(lang).slice(0, 2)
  const mp = multipart(fields, { field: 'file', name: name || 'dictation.webm', type: mime || 'audio/webm', data: audio })
  const up = await request(joinUrl(inst.baseUrl, '/v1/speech-to-text'), {
    method: 'POST', signal, timeout: 120000, headers: hdr(inst, { 'content-type': mp.contentType }), body: mp.body,
  })
  const body = up.body.toString('utf8')
  if (up.status !== 200) {
    const det = elevenDetail(body)
    if (up.status === 401) throw voiceErr('ElevenLabs rejected the API key (401)', 'bad_key', 502)
    if (det.code === 'quota_exceeded') throw voiceErr('ElevenLabs has no credits left: ' + det.message, 'quota_exceeded', 429)
    throw voiceErr('elevenlabs stt ' + up.status + ': ' + (det.message || scrub(body, 200)), 'vendor', 502)
  }
  const j = parseJson(body) || {}
  const words = Array.isArray(j.words)
    ? j.words.filter((w) => w && (w.type === undefined || w.type === 'word')).map((w) => ({ w: String(w.text || ''), t0: Number(w.start) || 0, t1: Number(w.end) || 0 }))
    : null
  return { text: String(j.text || '').trim(), language: j.language_code || null, confidence: j.language_probability || null, words }
}

export function elevenVoices(acct) {
  return (acct && acct.voices) || []
}

export default {
  type: 'elevenlabs',
  label: 'ElevenLabs',
  hq: 'US',
  euNote: 'EU data residency (api.eu.residency.elevenlabs.io) on Enterprise only, with a separate workspace and key',
  group: 'other',
  residency: 'eu-region',
  desc: 'Best Greek and Italian cloud voices, character-level word timings; EU residency endpoint on Enterprise.',
  docs: 'https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps',
  status: 'verified',
  verification: 'Request shapes carried from the 1.x adapter (live use) and the with-timestamps reference read for the v2 spec on 2026-10-31. The EU residency host is documented but needs an Enterprise workspace, so it was not exercised.',
  presets: [
    { id: 'elevenlabs', label: 'ElevenLabs', baseUrl: 'https://api.elevenlabs.io' },
    { id: 'elevenlabs-eu', label: 'ElevenLabs EU residency', baseUrl: 'https://api.eu.residency.elevenlabs.io' },
  ],
  configFields: ['baseUrl', 'credential', 'models', 'defaultVoice'],
  defaultBaseUrl: 'https://api.elevenlabs.io',

  configured(inst) { return Boolean(inst.secret()) },

  capabilities() {
    return {
      tts: true, stt: true, ttsLangs: '*', sttLangs: '*', detectsLanguage: true,
      streaming: false, alignment: 'char', nativeSpeed: [0.7, 1.2], ssml: false,
      maxChars: 5000, formats: ['mp3'], quota: true,
    }
  },

  async health(inst) {
    if (!this.configured(inst)) return { ok: false, status: 'down', detail: 'no API key' }
    const a = await account(inst)
    const q = a.quota
    return { ok: !a.error, status: a.error ? 'down' : 'up', detail: a.error || quotaSentence(q), quota: q }
  },

  async listVoices(inst) {
    const a = await account(inst)
    return elevenVoices(a).map((v) => ({ id: v.id, name: v.name, langs: null, gender: (v.labels || {}).gender || '', accent: (v.labels || {}).accent || '', tags: [v.category].filter(Boolean) }))
  },

  tts(args, inst, signal) { return elevenTts(args, inst, signal) },
  stt(args, inst, signal) { return elevenStt(args, inst, signal) },

  quota: refreshQuota,
  isDry,

  async legacyConfig(inst, avail) {
    let a = inst.state.acct || { voices: null, quota: null, error: null }
    if (avail) {
      if (!a.at) a = await account(inst)
      else account(inst).catch(() => {})
    }
    return {
      ttsLanguages: ['el', '+31 more on flash v2.5'], model: defaults(inst).tts,
      defaultVoice: defaults(inst).voice,
      voices: a.voices, voicesError: a.error || null,
      quota: a.quota ? Object.assign({}, a.quota, { charsRemaining: charsLeft(a.quota) }) : null,
      creditsPerChar: CREDITS_PER_CHAR,
      note: 'ElevenLabs: speaks Greek, Italian and English (flash v2.5: 32 languages; multilingual v2: 29).'
        + (a.quota ? ' ' + quotaSentence(a.quota) + '; at about half a credit per character that is roughly '
          + Math.round(a.quota.limit / CREDITS_PER_CHAR).toLocaleString('en-US') + ' characters a period.' : '')
        + (a.error ? ' Voice list unavailable: ' + a.error : ''),
    }
  },

  chunkPlan() { return { first: 110, rest: 260 } },
}
