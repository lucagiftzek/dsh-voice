/**
 * dsh-voice client: the player.
 *
 * Text is read ONE CHUNK AT A TIME, the next chunk requested the moment the
 * current one starts (time to first audio is the first sentence, not the whole
 * message). A message is first split into per-language SEGMENTS; each segment
 * is chunked for its engine and sent with its own `lang`. A failure on the
 * FIRST chunk throws (the caller may fall back to the browser voice); a later
 * failure retries once, then stops quietly instead of swapping voices
 * mid-sentence.
 *
 * Hooks for highlighting (the player stays generic; reader.js and the phase 3
 * reader tab drive the highlight):
 *   onChunk(job, audio|null)       a chunk starts (audio null for the browser voice)
 *   onTick(job, currentTime, audio) every animation frame while audio plays
 *   onBoundary(job, charIndex)     Web Speech word boundary inside the job text
 * Position always comes from the media clock, so pause, resume, seeking and a
 * speed change stay in sync by construction.
 */
import { readRate } from './store.js'

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
let current = null   // the one playing <audio>
let currentJobRef = null
let paused = false
let playToken = 0

export function currentAudio() { return current }
export function currentJob() { return currentJobRef }
export function isPaused() { return paused }

export function stopAll() {
  playToken += 1
  paused = false
  currentJobRef = null
  try { if (synth) synth.cancel() } catch (e) { /* no synth */ }
  if (current) {
    // Wake the pipeline before dropping the reference: pausing does not fire
    // 'ended', and the loop awaiting this chunk would otherwise hang forever.
    const c = current
    try { c.pause() } catch (e) { /* gone */ }
    current = null
    if (typeof c.onended === 'function') { try { c.onended() } catch (e) { /* contained */ } }
  }
}

export function pause() {
  if (current) { try { current.pause() } catch (e) { /* gone */ } }
  try { if (synth && synth.speaking) synth.pause() } catch (e) { /* no synth */ }
  paused = true
}
export function resume() {
  paused = false
  if (current) { current.play().catch(() => {}) }
  try { if (synth && synth.paused) synth.resume() } catch (e) { /* no synth */ }
}

// Browser voices that run on the device only (1 Nov 2026, server-loaded
// plugins). Chrome also lists online voices ("Google UK English" and friends,
// localService === false) that send the text to Google; the browser voice and
// the browser-voice fallback never pick those. Chrome fills getVoices()
// asynchronously, so the list is primed at load and on voiceschanged.
let voiceList = []
function refreshVoices() { try { voiceList = (synth && synth.getVoices()) || [] } catch (e) { voiceList = [] } }
if (synth) {
  refreshVoices()
  try { synth.addEventListener('voiceschanged', refreshVoices) } catch (e) { /* old engine */ }
}

/**
 * Pick an on-device voice: same language first (exact tag, then primary
 * subtag), then the device default, then any local voice. null when the device
 * has no local voice at all (the caller then stays silent instead of leaking
 * the text to an online voice).
 * @param {string} [lang]
 * @param {SpeechSynthesisVoice[]} [voices] injectable for tests
 */
export function localVoice(lang, voices) {
  if (!voices) { if (!voiceList.length) refreshVoices(); voices = voiceList }
  const local = (voices || []).filter((v) => v && v.localService === true)
  if (!local.length) return null
  const want = String(lang || '').toLowerCase().replace('_', '-')
  const primary = want.split('-')[0]
  const norm = (v) => String(v.lang || '').toLowerCase().replace('_', '-')
  return (want && local.find((v) => norm(v) === want)) ||
    (primary && local.find((v) => norm(v).split('-')[0] === primary)) ||
    local.find((v) => v.default) || local[0]
}

/** Does this device have any on-device speech voice? */
export function hasLocalVoice() { return localVoice('') !== null }

/**
 * Sentence-sized utterances: several engines drop a long one, and stop feels
 * immediate. hooks.onBoundary(charIndex) gets offsets into `text`.
 * Only on-device voices are used; returns false when there is none.
 */
export function speakBrowser(text, lang, onEnd, hooks) {
  if (!synth) return false
  const voice = localVoice(lang)
  if (!voice) return false
  const h = hooks || {}
  synth.cancel()
  const s = String(text)
  const chunks = s.match(/[^.!?\n]+[.!?]*\s*/g) || [s]
  const offsets = []
  let at = 0
  for (const c of chunks) { const i = s.indexOf(c, at); offsets.push(i < 0 ? at : i); at = (i < 0 ? at : i) + c.length }
  let i = 0
  const next = () => {
    if (i >= chunks.length) { if (onEnd) onEnd(); return }
    const base = offsets[i]
    const u = new window.SpeechSynthesisUtterance(chunks[i]); i += 1
    u.rate = readRate()
    u.voice = voice
    if (lang) u.lang = lang
    u.onstart = () => { if (h.onBoundary) h.onBoundary(base) }
    u.onboundary = (ev) => { if (h.onBoundary && (!ev.name || ev.name === 'word')) h.onBoundary(base + (ev.charIndex || 0)) }
    u.onend = next
    u.onerror = () => { if (onEnd) onEnd() }
    synth.speak(u)
  }
  next()
  return true
}

/** Browser voice over several segments, each in its own language. */
export function speakBrowserSegments(segments, onEnd, hooks) {
  if (!synth || !hasLocalVoice()) return false
  const my = playToken
  let k = 0
  const next = () => {
    if (playToken !== my) return
    if (k >= segments.length) { if (onEnd) onEnd(); return }
    const s = segments[k]; k += 1
    if (!speakBrowser(s.text, s.lang, next, hooks && hooks.forSegment ? hooks.forSegment(s) : null)) next()
  }
  synth.cancel()
  next()
  return true
}

/**
 * How finely each engine may be split (1.x plans, MEASURED: do not enlarge the
 * Mistral one, Voxtral output fades past ~45 s of audio; the local GPU models
 * pay a fixed cost per request, so they get coarse chunks).
 */
export function chunkPlan(engine) {
  if (engine === 'local' || engine === 'lfm3') return { first: 400, rest: 900 }
  if (engine === 'mistral') return { first: 500, rest: 700 }
  if (engine === 'mimo') return { first: 300, rest: 600 }
  return { first: 110, rest: 260 }
}

export function speechChunks(text, plan) {
  const t = String(text || '').trim()
  if (!t) return []
  const p0 = plan || { first: 110, rest: 260 }
  const firstMax = p0.first || 110
  const max = p0.rest || 260
  const parts = t.match(/[^.!?\n]+[.!?]*\s*/g) || [t]
  const out = []
  let cur = ''
  let limit = firstMax
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = '' }
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i]
    if (cur && cur.length + p.length > limit) { flush(); limit = max }
    cur += p
    while (cur.length > limit * 1.8) {
      const cut = cur.lastIndexOf(' ', limit * 1.8)
      const at = cut > limit * 0.6 ? cut : limit * 1.8
      out.push(cur.slice(0, at).trim())
      cur = cur.slice(at)
      limit = max
    }
  }
  flush()
  return out
}

function b64ToBlob(b64, mime) {
  const bin = window.atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new window.Blob([bytes], { type: mime || 'audio/mpeg' })
}

/** One synthesis request at normal speed, as raw bytes (for export). */
export async function fetchSpeechBytes(text, engine, lang, model, voice) {
  const r = await fetch('/api/voice/tts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, provider: engine || 'auto', lang, model: model || undefined, voice: voice || undefined }),
  })
  if (!r.ok) {
    let why = 'tts ' + r.status
    try { const j = (await r.json()) || {}; why = j.error || why } catch (e) { /* not json */ }
    throw new Error(why)
  }
  return new Uint8Array(await (await r.blob()).arrayBuffer())
}

/**
 * One synthesis request, resolved into a playable Audio with its blob URL.
 * wantAlignment asks /tts?alignment=1 (JSON + word timings) when the engine has them.
 */
export async function fetchSpeech(text, engine, lang, model, voice, wantAlignment) {
  const r = await fetch('/api/voice/tts' + (wantAlignment ? '?alignment=1' : ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, provider: engine || 'auto', lang, model: model || undefined, voice: voice || undefined }),
  })
  if (!r.ok) {
    let why = 'tts ' + r.status
    try {
      const j = (await r.json()) || {}
      why = j.error || why
      if (j.code) why = why + ' [' + j.code + ']'
    } catch (e) { /* not json */ }
    throw new Error(why)
  }
  let blob
  let words = null
  let engineUsed = r.headers.get('x-voice-engine') || engine
  if (wantAlignment && /json/.test(String(r.headers.get('content-type') || ''))) {
    const j = await r.json()
    blob = b64ToBlob(j.audio_base64 || '', j.mime)
    words = j.alignment && Array.isArray(j.alignment.items) ? j.alignment.items : null
    engineUsed = j.engine || engineUsed
  } else blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = new window.Audio(url)
  a._url = url
  a._engine = engineUsed
  a._words = words
  const rate = readRate()
  if (rate !== 1) {
    a.playbackRate = rate
    try { a.preservesPitch = true } catch (e) { /* old engine */ }
    try { a.mozPreservesPitch = true } catch (e) { /* old engine */ }
    try { a.webkitPreservesPitch = true } catch (e) { /* old engine */ }
  }
  return a
}

/**
 * Turn segments into jobs. engineFor(seg) -> { engine, model, voice, plan, alignment }.
 * 'browser' jobs are spoken in the page.
 */
export function planJobs(segments, engineFor) {
  const jobs = []
  segments.forEach((seg, si) => {
    const e = engineFor(seg)
    const base = { lang: seg.lang, langSource: seg.source, seg: si }
    if (e.engine === 'browser') { jobs.push(Object.assign({ text: seg.text, engine: 'browser', pauseBeforeMs: seg.pauseBeforeMs || 0 }, base)); return }
    speechChunks(seg.text, e.plan).forEach((c, k) => {
      jobs.push(Object.assign({ text: c, engine: e.engine, model: e.model, voice: e.voice, alignment: Boolean(e.alignment), pauseBeforeMs: k === 0 ? seg.pauseBeforeMs || 0 : 0 }, base))
    })
  })
  return jobs
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const frame = (fn) => (typeof window !== 'undefined' && window.requestAnimationFrame ? window.requestAnimationFrame(fn) : setTimeout(fn, 50))
const unframe = (id) => { if (typeof window !== 'undefined' && window.cancelAnimationFrame) window.cancelAnimationFrame(id); else clearTimeout(id) }

/**
 * Play jobs with one request in flight ahead of the audio.
 * opts: { onEnd, onFirstAudio, onChunk, onTick, onBoundary }
 */
export async function playJobs(jobs, opts) {
  const o = opts || {}
  stopAll()
  const my = playToken
  if (!jobs.length) return
  const fetchJob = (j) => (j.engine === 'browser' ? Promise.resolve(null) : fetchSpeech(j.text, j.engine, j.lang, j.model, j.voice, j.alignment))
  const safe = (fn, ...args) => { if (fn) { try { fn(...args) } catch (e) { /* a highlight must never stop a read */ } } }
  let i = 0
  let pending = fetchJob(jobs[0])
  while (i < jobs.length) {
    const job = jobs[i]
    let a
    try { a = await pending } catch (e) {
      if (i === 0) throw e
      try { a = await fetchJob(job) } catch (e2) { break }
    }
    if (playToken !== my) { if (a) { try { URL.revokeObjectURL(a._url) } catch (e) { /* gone */ } } break }
    const following = (i + 1 < jobs.length) ? fetchJob(jobs[i + 1]) : null
    if (following) following.catch(() => null)
    if (job.pauseBeforeMs) await sleep(job.pauseBeforeMs)
    while (paused && playToken === my) await sleep(100)
    if (playToken !== my) break
    currentJobRef = job
    let played
    if (job.engine === 'browser') {
      if (i === 0) safe(o.onFirstAudio)
      safe(o.onChunk, job, null)
      played = await new Promise((resolve) => {
        if (!speakBrowser(job.text, job.lang, () => resolve(true), { onBoundary: (ci) => safe(o.onBoundary, job, ci) })) resolve(false)
      })
    } else {
      current = a
      if (i === 0) safe(o.onFirstAudio)
      safe(o.onChunk, job, a)
      let raf = 0
      const loop = () => { if (current === a && playToken === my) { safe(o.onTick, job, a.currentTime, a); raf = frame(loop) } }
      played = await new Promise((resolve) => {
        a.onended = () => resolve(true)
        a.onerror = () => resolve(false)
        a.play().then(() => { raf = frame(loop) }).catch(() => resolve(false))
      })
      unframe(raf)
      try { URL.revokeObjectURL(a._url) } catch (e) { /* gone */ }
      if (current === a) current = null
    }
    if (!played && i === 0) throw new Error('the browser refused to play the audio')
    i += 1
    if (!following) break
    pending = following
  }
  if (playToken === my) { currentJobRef = null; safe(o.onEnd) }
}
