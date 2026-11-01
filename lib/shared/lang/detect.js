/**
 * dsh-voice: cheap language heuristics (spec 4.1 steps 3 to 5).
 *
 * Step 3, script: Greek, Cyrillic, Arabic, Hebrew and CJK decide themselves.
 * Step 4, Latin scoring (heuristics.js): en / it, plus fr / de / es when they
 * are enabled. A sentence with no Latin evidence takes the message default
 * (the v1 guess), so an unmarked English reply still routes as in 1.x.
 *
 * setLatinScorer(fn) replaces the built-in scorer (tests, experiments);
 * fn(sentence, enabledLangs) -> { lang, conf } | null.
 * The model pass (server, POST /api/voice/detect) refines sentences whose
 * confidence stays under detection.minConfidence; see lib/server/detect.js.
 */
import { latinScore, hasLatinRun } from './heuristics.js'

const RANGES = [
  ['el', /[\u0370-\u03FF\u1F00-\u1FFF]/g],
  ['ru', /[\u0400-\u04FF]/g],
  ['ar', /[\u0600-\u06FF]/g],
  ['he', /[\u0590-\u05FF]/g],
  ['zh', /[\u4E00-\u9FFF]/g],
]
const LETTER_RE = /\p{L}/gu

const count = (s, re) => { const m = String(s).match(re); return m ? m.length : 0 }

/** Script share for one sentence: { lang, conf } when a non-Latin script dominates, else null. */
export function scriptLang(sentence) {
  const s = String(sentence || '')
  const letters = count(s, LETTER_RE)
  if (!letters) return null
  for (const [lang, re] of RANGES) {
    const n = count(s, re)
    if (n / letters > 0.5) return { lang, conf: 0.99 }
  }
  return null
}

/** The v1 message-level guess (lib/client.js guessLang in 1.x), kept verbatim for parity. */
export function guessLangV1(text) {
  const s = String(text || '')
  if (/[\u0370-\u03FF\u1F00-\u1FFF]/.test(s)) return 'el'
  if (/[\u4E00-\u9FFF]/.test(s)) return 'zh'
  if (/[\u0400-\u04FF]/.test(s)) return 'ru'
  if (/[\u0600-\u06FF]/.test(s)) return 'ar'
  if (/\b(le|la|les|des|une|est|pour|avec|vous|nous|cette)\b/i.test(s)) return 'fr'
  return 'en'
}

let latinScorer = null
/** Replace the built-in Latin scorer. Pass null to restore it. */
export function setLatinScorer(fn) { latinScorer = typeof fn === 'function' ? fn : null }

/**
 * Language of one sentence: { lang, conf, source, mixed? }.
 * source is 'script', 'heuristic' or 'default'.
 */
export function sentenceLang(sentence, defaultLang, enabled) {
  const sc = scriptLang(sentence)
  if (sc) {
    // A Greek sentence holding an English phrase is the case the model is for.
    if (sc.lang === 'el' && hasLatinRun(sentence)) return { lang: 'el', conf: 0.7, source: 'script', mixed: true }
    return { lang: sc.lang, conf: sc.conf, source: 'script' }
  }
  let r = null
  try { r = latinScorer ? latinScorer(sentence, enabled) : latinScore(sentence, enabled) } catch (e) { r = null }
  if (r && r.lang) return { lang: r.lang, conf: Number(r.conf) || 0.5, source: 'heuristic' }
  return { lang: defaultLang || 'en', conf: 0.5, source: 'default' }
}

/** Words in a sentence (letters or digits runs). */
export function wordCount(s) {
  const m = String(s || '').match(/[\p{L}\p{N}]+/gu)
  return m ? m.length : 0
}
