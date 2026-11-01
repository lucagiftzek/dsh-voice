/**
 * dsh-voice: reading timelines (pure, shared by the chat highlighter and the
 * reader tab).
 *
 * A chunk of speech has words [{ c0, c1, t0, t1 }] in the chunk's own
 * character offsets. They come from the provider (ElevenLabs character
 * alignment collapsed to words on the server), from Web Speech `boundary`
 * events, or from estimateWordTimings() when the provider gives none: each
 * word weighs its letters plus a pause after punctuation, scaled to the real
 * duration of the audio. Playback position always comes from the media clock
 * (audio.currentTime), so pause, resume, seeking and speed changes stay in
 * sync without any bookkeeping.
 */
import { splitSentences } from '../lang/segment.js'

/** Pause weights in "characters" at a nominal 14 characters per second. */
export const PAUSE = { comma: 2, stop: 5, para: 7 }
const WORD_RE = /\S+/g

/** Words of a text with their offsets: [{ c0, c1, w }]. */
export function wordsOf(text) {
  const out = []
  const s = String(text || '')
  let m
  WORD_RE.lastIndex = 0
  while ((m = WORD_RE.exec(s))) out.push({ c0: m.index, c1: m.index + m[0].length, w: m[0] })
  return out
}

/** Pause weight after a word, from its trailing punctuation and the gap that follows. */
function pauseAfter(word, gap) {
  if (/\n\s*\n/.test(gap)) return PAUSE.para
  if (/[.!?\u2026\u037E]["'\u201d\u2019)\]]*$/.test(word) || /\n/.test(gap)) return PAUSE.stop
  if (/[,;:\u0387]["'\u201d\u2019)\]]*$/.test(word)) return PAUSE.comma
  return 0
}

/** Letter weight of a word: letters and digits, at least 1 (a number still takes time). */
function weightOf(w) {
  const m = String(w).match(/[\p{L}\p{N}]/gu)
  return Math.max(1, m ? m.length : 0)
}

/**
 * Proportional estimate for providers without timestamps.
 * Returns [{ c0, c1, t0, t1 }] spanning [0, durationS].
 */
export function estimateWordTimings(text, durationS) {
  const s = String(text || '')
  const words = wordsOf(s)
  const dur = Number(durationS)
  if (!words.length || !(dur > 0)) return []
  const units = words.map((w, i) => {
    const gap = s.slice(w.c1, i + 1 < words.length ? words[i + 1].c0 : s.length)
    return { speak: weightOf(w.w), pause: pauseAfter(w.w, gap) }
  })
  // The final pause is not spoken: the chunk ends with the last word.
  units[units.length - 1].pause = 0
  const total = units.reduce((a, u) => a + u.speak + u.pause, 0)
  const k = dur / total
  const out = []
  let t = 0
  words.forEach((w, i) => {
    const t0 = t
    const t1 = t0 + units[i].speak * k
    out.push({ c0: w.c0, c1: w.c1, t0: round(t0), t1: round(t1) })
    t = t1 + units[i].pause * k
  })
  return out
}

const round = (x) => Math.round(x * 1000) / 1000

/** Sentence spans of a chunk, trimmed: [{ c0, c1 }]. */
export function sentenceSpans(text) {
  const out = []
  let at = 0
  for (const p of splitSentences(String(text || ''))) {
    const lead = p.length - p.trimStart().length
    const core = p.trim()
    if (core) out.push({ c0: at + lead, c1: at + lead + core.length })
    at += p.length
  }
  return out
}

/** Index of the item active at time t (last item with t0 <= t), or -1 before the first. */
export function activeIndex(items, t) {
  if (!items || !items.length || !(t >= items[0].t0)) return -1
  let lo = 0
  let hi = items.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (items[mid].t0 <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The word containing (or just before) a character offset, for Web Speech boundary events. */
export function wordAtChar(text, charIndex) {
  const words = wordsOf(text)
  let best = null
  for (const w of words) {
    if (w.c0 <= charIndex) best = w
    else break
  }
  return best ? { c0: best.c0, c1: best.c1 } : null
}

/** Sentence containing an offset. */
export function sentenceAt(spans, offset) {
  for (const s of spans) if (offset >= s.c0 && offset < s.c1) return s
  for (let i = spans.length - 1; i >= 0; i -= 1) if (spans[i].c0 <= offset) return spans[i]
  return spans[0] || null
}

/**
 * Position inside one chunk at media time t: { word, sentence, wordIndex }.
 * Before the first word the first sentence is active (sentence highlight is
 * always on), and after the last word the last one stays lit.
 */
export function positionAt(chunk, t) {
  const words = chunk.words || []
  const spans = chunk.sentences || (chunk.sentences = sentenceSpans(chunk.text))
  const i = activeIndex(words, t)
  const word = i >= 0 ? words[i] : null
  const sentence = word ? sentenceAt(spans, word.c0) : (spans[0] || null)
  return { word, sentence, wordIndex: i }
}

/** Start time of the sentence after / before the one active at t (null when there is none in this chunk). */
export function sentenceSeek(chunk, t, dir) {
  const words = chunk.words || []
  const spans = chunk.sentences || (chunk.sentences = sentenceSpans(chunk.text))
  if (!words.length || !spans.length) return null
  const pos = positionAt(chunk, t)
  const k = pos.sentence ? spans.indexOf(pos.sentence) : 0
  const startOf = (span) => { const w = words.find((x) => x.c0 >= span.c0); return w ? w.t0 : null }
  if (dir > 0) return k + 1 < spans.length ? startOf(spans[k + 1]) : null
  const cur = startOf(spans[k])
  // Within the first second of a sentence, "previous" means the one before.
  if (cur !== null && t - cur > 1 && dir < 0) return cur
  return k > 0 ? startOf(spans[k - 1]) : 0
}
