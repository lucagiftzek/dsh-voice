/**
 * dsh-voice client: the reading controller (one global player for the page).
 *
 * read(item, { replace }) segments a text (markers, heuristics, then the model
 * pass through POST /api/voice/detect when some sentence is unsure), plans the
 * jobs, plays them, and drives the highlight: sentence always (unless
 * reading.highlight is 'off'), word when reading.highlight is 'word', from
 * provider timings (ElevenLabs), Web Speech boundaries, or the proportional
 * estimate. A second read replaces the current one (reading.queue 'replace',
 * the 1.x behaviour) or queues behind it; auto-read always queues.
 *
 * The now-playing store tells every speaker button which message is being
 * read, in which language (the badge) and in what state.
 *
 * item: { messageId, md, code, cfg, engine, prefs, getContainer, auto }
 * Reusable by the reader tab (phase 3): getContainer may return any element
 * that renders the same text.
 */
import * as React from 'react'
import { buildSegments } from '../../lib/shared/lang/segment.js'
import { estimateWordTimings, positionAt, wordAtChar, sentenceSpans, sentenceAt, sentenceSeek } from '../../lib/shared/highlight/timeline.js'
import { createHighlighter } from './highlight.js'
import { planJobs, playJobs, stopAll, chunkPlan, speakBrowserSegments, pause, resume, isPaused, currentAudio, currentJob, fetchSpeechBytes } from './player.js'
import { joinParts, webAudioDecoder } from './export.js'
import { takesTags, carryTags } from './tags.js'
import { autoFor, directionEngine, readPref, FALLBACK_KEY, MODEL_KEY, localPick, loadQuota, refreshConfig } from './store.js'

// ---------------------------------------------------------------- now playing
const IDLE = { messageId: null, state: 'idle', why: '', lang: '', langSource: '', auto: false, queued: 0, engine: '' }
let now = Object.assign({}, IDLE)
const listeners = new Set()
function setNow(patch) {
  now = Object.assign({}, now, patch)
  listeners.forEach((fn) => { try { fn(now) } catch (e) { /* contained */ } })
}
export function getNow() { return now }
export function subscribeNow(fn) { listeners.add(fn); return () => listeners.delete(fn) }
/** The now-playing state as seen by one message (idle when another message is playing). */
export function useNowPlaying(messageId) {
  const [v, setV] = React.useState(now)
  React.useEffect(() => subscribeNow(setV), [])
  return v.messageId === messageId ? v : IDLE
}

// ---------------------------------------------------------------- detection
const detectMemo = new Map()
const memoKey = (md) => md.length + ':' + md.slice(0, 64) + ':' + md.slice(-64)

/** Segments for a text: local heuristics, then the server model pass when unsure (bounded by the detection timeout). */
export async function segmentsFor(md, cfg, opts) {
  const o = opts || {}
  const det = (cfg && cfg.detection) || {}
  const markers = !(cfg && cfg.markers && cfg.markers.enabled === false)
  if (o.code) return buildSegments(md, { code: true, markers: false })
  const mode = det.mode || 'heuristic+model'
  const enabled = cfg && cfg.languages && cfg.languages.enabled
  const built = buildSegments(md, { markers, detection: mode === 'off' ? 'off' : 'heuristic', enabled, minConfidence: det.minConfidence })
  if (mode !== 'heuristic+model' || !det.llm || !built.uncertain || !built.uncertain.length) return built
  const k = memoKey(md)
  if (detectMemo.has(k)) return Object.assign({}, built, { segments: detectMemo.get(k) })
  try {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = setTimeout(() => { if (ac) ac.abort() }, (Number(det.timeoutMs) || 2500) + 800)
    const r = await fetch('/api/voice/detect', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: md }), signal: ac ? ac.signal : undefined,
    })
    clearTimeout(timer)
    const j = r.ok ? await r.json() : null
    if (j && Array.isArray(j.segments) && j.segments.length) {
      if (detectMemo.size > 50) detectMemo.delete(detectMemo.keys().next().value)
      detectMemo.set(k, j.segments)
      return Object.assign({}, built, { segments: j.segments, model: j.model })
    }
  } catch (e) { /* timeout or offline: the heuristics stand */ }
  return built
}

// ---------------------------------------------------------------- reading
const queue = []
let active = null   // { item, hl, chunk }

function hlMode(cfg) { return (cfg && cfg.reading && cfg.reading.highlight) || 'word' }

function voiceFor(engine, prefs) {
  const p = prefs || {}
  if (engine === 'mimo') return p.mimo && p.mimo !== 'auto' ? p.mimo : ''
  if (engine === 'lfm3') return p.lfm3 || 'female'
  if (engine === 'elevenlabs') return p.el && p.el !== 'auto' ? p.el : ''
  if (engine === 'alibaba') return p.ali && p.ali !== 'auto' ? p.ali : ''
  return ''
}

function engineAlignment(cfg, id) {
  const e = cfg && cfg.engines && cfg.engines[id]
  const a = e && e.v2 && e.v2.alignment
  return a === 'char' || a === 'word'
}

/**
 * Plan the jobs of an item: per segment, marker overrides first, then the
 * item's own provider / model / voice override (the reader tab's pickers),
 * then the composer pick and its remembered voice.
 */
export function jobsFor(item, segs, mode) {
  const cfg = item.cfg
  const engine = item.engine || 'auto'
  const picked = directionEngine(engine, cfg, 'tts')
  const ttsModel = localPick(cfg, engine, readPref(MODEL_KEY, 'auto'), 'tts')
  const jobs = planJobs(segs, (seg) => {
    const segEngine = seg.provider || picked
    const resolved = segEngine === 'auto' ? autoFor(cfg, seg.lang) : segEngine
    if (resolved === 'browser') return { engine: 'browser' }
    const own = segEngine === engine
    return {
      engine: segEngine,
      model: seg.model || (own && item.model) || (segEngine === 'local' ? ttsModel : ''),
      voice: seg.voice || (own && item.voice) || voiceFor(segEngine, item.prefs),
      plan: chunkPlan(segEngine),
      alignment: mode === 'word' && engineAlignment(cfg, resolved),
    }
  })
  // Voxtral TTS 3 tags last one request: carry emotion and pace across the chunks of a segment.
  const bySeg = new Map()
  jobs.forEach((j, i) => { if (takesTags(j.engine, j.model)) { if (!bySeg.has(j.seg)) bySeg.set(j.seg, []); bySeg.get(j.seg).push(i) } })
  for (const idx of bySeg.values()) carryTags(idx.map((i) => jobs[i].text)).forEach((t, k) => { jobs[idx[k]].text = t })
  return jobs
}

/** Highlight state for the chunk that is playing. */
function chunkState(job) {
  return { text: job.text, words: null, sentences: sentenceSpans(job.text) }
}

function showPos(hl, mode, pos) {
  if (!hl || mode === 'off') return
  hl.show(pos.sentence, mode === 'word' ? pos.word : null)
}

function browserHooks(a, mode) {
  return {
    forSegment: (seg) => ({
      onBoundary: (ci) => {
        if (!a.hl) return
        if (a.segText !== seg.text) { a.segText = seg.text; a.hl.startChunk(seg.text); a.spans = sentenceSpans(seg.text) }
        const w = wordAtChar(seg.text, ci)
        showPos(a.hl, mode, { word: w, sentence: sentenceAt(a.spans, ci) })
      },
    }),
  }
}

async function start(item) {
  stopAll()
  if (active && active.hl) active.hl.clear()
  const cfg = item.cfg
  const mode = hlMode(cfg)
  const a = { item, hl: null, chunk: null }
  active = a
  setNow({ messageId: item.messageId, state: 'working', why: '', lang: '', langSource: '', auto: Boolean(item.auto), queued: queue.length, engine: item.engine })
  const built = await segmentsFor(item.md, cfg, { code: item.code })
  if (active !== a) return
  const segs = built.segments
  if (!segs.length) { finish(a); return }
  const container = mode !== 'off' && item.getContainer ? item.getContainer(segs[0].text) : null
  if (container) a.hl = createHighlighter({ container })
  const engine = item.engine || 'auto'
  if (engine === 'browser') {
    setNow({ state: 'speaking', lang: segs[0].lang, langSource: segs[0].source })
    if (!speakBrowserSegments(segs, () => finish(a), browserHooks(a, mode))) finish(a)
    return
  }
  const jobs = jobsFor(item, segs, mode)
  try {
    await playJobs(jobs, {
      onFirstAudio: () => { if (active === a) setNow({ state: isPaused() ? 'paused' : 'speaking' }) },
      onChunk: (job, audio) => {
        if (active !== a) return
        setNow({ lang: job.lang, langSource: job.langSource || '' })
        a.chunk = chunkState(job)
        job.state = a.chunk
        if (audio && audio._words && audio._words.length) a.chunk.words = audio._words
        if (a.hl) { a.hl.startChunk(job.text); showPos(a.hl, mode, positionAt(a.chunk, 0)) }
      },
      onTick: (job, t, audio) => {
        if (active !== a || !a.chunk) return
        if (!a.chunk.words && audio && isFinite(audio.duration) && audio.duration > 0) a.chunk.words = estimateWordTimings(job.text, audio.duration)
        showPos(a.hl, mode, positionAt(a.chunk, t))
      },
      onBoundary: (job, ci) => {
        if (active !== a || !a.chunk) return
        showPos(a.hl, mode, { word: wordAtChar(job.text, ci), sentence: sentenceAt(a.chunk.sentences, ci) })
      },
      onEnd: () => finish(a),
    })
    if (item.engine === 'elevenlabs' || item.engine === 'auto') loadQuota()
  } catch (e) {
    if (active !== a) return
    const reason = String(e && e.message || e)
    if (item.engine === 'elevenlabs' || item.engine === 'auto') loadQuota()
    // A vendor outage must not mean silence, but it must not SOUND like the
    // chosen engine either: the browser voice takes over only when allowed,
    // and the row says which voice is speaking and why.
    if (readPref(FALLBACK_KEY, '1') !== '0' && speakBrowserSegments(segs, () => finish(a), browserHooks(a, mode))) {
      setNow({ state: 'fallback', why: reason })
      if (/quota|credit/i.test(reason)) refreshConfig()
      return
    }
    if (a.hl) a.hl.clear()
    setNow({ state: 'error', why: reason })
    setTimeout(() => { if (active === a && now.state === 'error') { active = null; setNow(Object.assign({}, IDLE, { queued: queue.length })) } }, 8000)
  }
}

function finish(a) {
  if (active !== a) return
  if (a.hl) a.hl.clear()
  active = null
  if (queue.length) { const next = queue.shift(); start(next); return }
  setNow(Object.assign({}, IDLE))
}

const busy = () => now.state === 'working' || now.state === 'speaking' || now.state === 'paused' || now.state === 'fallback'

/** Read an item. replace=false queues behind a read in progress. */
export function read(item, opts) {
  const o = opts || {}
  const replace = o.replace !== undefined ? o.replace : !(item.cfg && item.cfg.reading && item.cfg.reading.queue === 'append')
  if (!replace && busy()) {
    if (!queue.some((q) => q.messageId === item.messageId && q.code === item.code)) queue.push(item)
    setNow({ queued: queue.length })
    return
  }
  queue.length = 0
  start(item)
}

/** Stop everything and clear the queue. */
export function stop() {
  queue.length = 0
  stopAll()
  if (active && active.hl) active.hl.clear()
  active = null
  setNow(Object.assign({}, IDLE))
}

/** Stop only what auto-read started (the person started typing). */
export function stopAuto() {
  const hadAuto = queue.some((q) => q.auto)
  for (let i = queue.length - 1; i >= 0; i -= 1) if (queue[i].auto) queue.splice(i, 1)
  if (now.auto && busy()) stop()
  else if (hadAuto) setNow({ queued: queue.length })
}

export function togglePause() {
  if (!busy()) return
  if (isPaused()) { resume(); setNow({ state: 'speaking' }) } else { pause(); setNow({ state: 'paused' }) }
}

/** Jump to the next (dir 1) or previous (dir -1) sentence of the current chunk; past its end, the next chunk. */
export function skipSentence(dir) {
  const a = currentAudio()
  const job = currentJob()
  if (!a || !job || !job.state) return
  const t = sentenceSeek(job.state, a.currentTime, dir)
  try {
    if (t === null) a.currentTime = dir > 0 ? (isFinite(a.duration) ? a.duration : a.currentTime) : 0
    else a.currentTime = t
  } catch (e) { /* not seekable yet */ }
}

/**
 * Export an item as one audio file (normal speed). onProgress(done, total).
 * Returns { bytes, mime, ext, strategy }; throws when a part would be the browser voice.
 */
export async function exportItem(item, format, onProgress, decode) {
  const built = await segmentsFor(item.md, item.cfg, { code: item.code })
  const jobs = jobsFor(item, built.segments, 'off')
  if (!jobs.length) throw new Error('nothing to export')
  if (jobs.some((j) => j.engine === 'browser')) throw new Error('the browser voice cannot be exported: pick a server voice for every language')
  const parts = []
  for (let i = 0; i < jobs.length; i += 1) {
    if (onProgress) onProgress(i, jobs.length)
    const j = jobs[i]
    parts.push({ bytes: await fetchSpeechBytes(j.text, j.engine, j.lang, j.model, j.voice), pauseBeforeMs: j.pauseBeforeMs || 0 })
  }
  if (onProgress) onProgress(jobs.length, jobs.length)
  return joinParts(parts, format, decode || webAudioDecoder())
}

// ---------------------------------------------------------------- message registry
// Speaker buttons register their message, so a shortcut or the reader tab can
// read "the current reply" without a chat snapshot of their own.
const messages = new Map()
export function registerMessage(id, entry) { messages.set(id, entry); return () => { if (messages.get(id) === entry) messages.delete(id) } }
export function lastMessage(order) {
  const ids = (order || []).filter((id) => messages.has(id))
  if (ids.length) return Object.assign({ messageId: ids[ids.length - 1] }, messages.get(ids[ids.length - 1]))
  const all = Array.from(messages.keys())
  return all.length ? Object.assign({ messageId: all[all.length - 1] }, messages.get(all[all.length - 1])) : null
}

/** Test hook: the internal queue length. */
export function queueLength() { return queue.length }
