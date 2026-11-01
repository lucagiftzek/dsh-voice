/**
 * dsh-voice: the Latin-script language scorer (spec 4.1 step 4).
 *
 * Per sentence: stopword hits plus weighted cue patterns per language; the
 * winner's margin over the runner-up, scaled by how much evidence there is,
 * becomes the confidence. A two-word sentence therefore never claims 0.99,
 * which is what sends it to smoothing (or to the model) instead of flipping
 * the language of a whole paragraph. Only enabled languages compete; English
 * and Italian are always candidates because they are the defaults.
 */
import { SETS, CUES } from './stopwords.js'

const WORD_RE = /\p{L}+/gu

/** Normalise for hashing and comparison: NFC, lowercase, single spaces, no edge punctuation. */
export function normaliseSentence(s) {
  return String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').replace(/^[\s"'([{]+|[\s.,;:!?"')\]}\u037E\u2026]+$/g, '').trim()
}

/**
 * Score one Latin-script sentence. Returns { lang, conf, margin, scores } or
 * null when there is no evidence at all.
 */
export function latinScore(sentence, enabled) {
  const s = String(sentence || '').toLowerCase()
  const words = s.match(WORD_RE) || []
  if (!words.length) return null
  const pool = new Set(['en', 'it'])
  for (const l of Array.isArray(enabled) ? enabled : []) if (SETS[l]) pool.add(l)
  const scores = {}
  for (const l of pool) {
    let sc = 0
    const set = SETS[l]
    for (const w of words) if (set.has(w)) sc += 1
    for (const [re, wgt] of CUES[l] || []) {
      const m = s.match(re)
      if (m) sc += Math.min(3, m.length) * wgt
    }
    scores[l] = sc
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [best, bs] = ranked[0]
  const second = ranked[1] ? ranked[1][1] : 0
  if (bs <= 0) return null
  const margin = (bs - second) / (bs + second)
  const evidence = Math.min(1, bs / 3)
  const conf = Math.min(0.99, 0.5 + 0.49 * margin * evidence)
  return { lang: best, conf: Math.round(conf * 1000) / 1000, margin: Math.round(margin * 1000) / 1000, scores }
}

/** Three or more consecutive Latin words inside a sentence written in another script. */
export function hasLatinRun(sentence) {
  return /(?:[A-Za-z][A-Za-z'-]*[\s,]+){2,}[A-Za-z][A-Za-z'-]*/.test(String(sentence || ''))
}
