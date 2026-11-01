/**
 * dsh-voice: speakable text, sentences and per-language segments
 * (shared by the host and the browser bundle).
 *
 * A message becomes segments[] = { text, lang, source, conf, voice?, provider?,
 * model?, speed?, pauseBeforeMs? }. Markers win; unmarked text is split into
 * sentences and each sentence gets a language from detect.js; short sentences
 * inherit their neighbour (smoothing); consecutive sentences of one language
 * are merged. The caller then chunks each segment for its engine.
 */
import { encodeMarkers, decodeMarkers } from './markers.js'
import { sentenceLang, guessLangV1, wordCount } from './detect.js'

/**
 * Markdown to something worth hearing (v1 speakableProse, unchanged rules).
 * Code is removed rather than read: the prose read says a block was skipped and
 * a separate button reads code on request.
 */
export function speakableProse(md) {
  let blocks = 0
  let s = String(md || '')
  s = s.replace(/```[\s\S]*?```/g, () => { blocks += 1; return '\n(code block skipped)\n' })
  s = s.replace(/^ {4}[^\n]*$/gm, '')
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*>\s?/gm, '')
  s = s.replace(/^\s*\|.*\|\s*$/gm, '')
  s = s.replace(/^[-=_]{3,}\s*$/gm, '')
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return { text: s, codeBlocks: blocks }
}

/** Code blocks only, for the separate code button (v1 speakableCode). */
export function speakableCode(md) {
  const out = []
  const re = /```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g
  let m
  let i = 0
  while ((m = re.exec(String(md || '')))) {
    i += 1
    out.push('Code block ' + i + (m[1] ? ', ' + m[1] : '') + '. ' + m[2].trim())
  }
  return out.join('\n\n')
}

const ABBREV = {
  en: ['e.g', 'i.e', 'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'no', 'fig', 'approx'],
  it: ['sig', 'sig.ra', 'dott', 'dott.ssa', 'pag', 'pagg', 'ecc', 'prof', 'avv', 'ing', 'es', 'cfr'],
  el: ['\u03ba', '\u03c0.\u03c7', '\u03b4\u03b7\u03bb', '\u03bb.\u03c7', '\u03b2\u03bb', '\u03ba.\u03bb.\u03c0', '\u03c3\u03b5\u03bb', '\u03b1\u03c1'],
}
const ABBREV_ALL = new Set([].concat(ABBREV.en, ABBREV.it, ABBREV.el))
const GREEK_RE = /[\u0370-\u03FF\u1F00-\u1FFF]/

/**
 * Split text into sentences, keeping every character (the pieces concatenate
 * back to the input). Stops: . ! ? and the ellipsis, the Greek question mark
 * U+037E, and ';' after Greek text (Greek writes its question mark as ';').
 * The Greek ano teleia U+0387 is a semicolon, not a stop. Newlines end a
 * sentence too. A '.' after a known abbreviation or before a lowercase letter
 * does not split.
 */
export function splitSentences(text) {
  const s = String(text || '')
  const out = []
  let start = 0
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    let stop = false
    if (c === '\n') stop = true
    else if (c === '!' || c === '?' || c === '\u2026' || c === '\u037E') stop = true
    else if (c === ';') stop = GREEK_RE.test(s.slice(Math.max(start, i - 40), i))
    else if (c === '.') {
      const before = s.slice(start, i)
      const word = (/([\p{L}.]+)$/u.exec(before) || [])[1] || ''
      const after = s.slice(i + 1)
      const next = (/^\s*(\S)/.exec(after) || [])[1] || ''
      if (word && ABBREV_ALL.has(word.toLowerCase())) stop = false
      else if (/^\d/.test(after)) stop = false
      else if (next && /\p{Ll}/u.test(next)) stop = false
      else stop = /^(\s|$|["'\u201d\u2019)\]])/.test(after)
    }
    if (!stop) continue
    let j = i + 1
    while (j < s.length && /[.!?"'\u201d\u2019)\]]/.test(s[j]) && s[j] !== '\n') j += 1
    while (j < s.length && /[ \t\n\r]/.test(s[j])) j += 1
    out.push(s.slice(start, j))
    start = j
    i = j - 1
  }
  if (start < s.length) out.push(s.slice(start))
  return out.filter((x) => x.length)
}

/**
 * Build the per-language segments of one message.
 *
 * opts.markers    true (default): honour in-text markers
 * opts.detection  'heuristic+model' | 'heuristic' (per-sentence script detection) | 'off' (v1: one language per message)
 * opts.defaultLang  force the language of unmarked Latin text (a manual language pick)
 * opts.enabled    enabled languages, passed to the phase 2 scorer
 * opts.code       true: read code blocks instead of prose (the { } button)
 * opts.resolve    (sentence) -> { lang, conf } | { lang, spans } | null: the cached model answer
 * opts.minConfidence  below it (default 0.75) a sentence is listed in `uncertain`
 * Returns { segments, codeBlocks, plain, uncertain }.
 */
export function buildSegments(md, opts) {
  const o = opts || {}
  const useMarkers = o.markers !== false
  let runs
  let codeBlocks = 0
  if (o.code) {
    runs = [{ text: speakableCode(md), lang: null, marked: false }]
  } else if (useMarkers) {
    const enc = encodeMarkers(md)
    const prose = speakableProse(enc.text)
    codeBlocks = prose.codeBlocks
    runs = decodeMarkers(prose.text, enc.directives)
  } else {
    const prose = speakableProse(md)
    codeBlocks = prose.codeBlocks
    runs = [{ text: prose.text, lang: null, marked: false }]
  }
  const unmarked = runs.filter((r) => !r.lang).map((r) => r.text).join(' ')
  const detection = o.detection || 'heuristic+model'

  // The default for unmarked Latin text: a manual pick, else the v1 guess over
  // the text WITHOUT its Greek sentences (so a Greek reply with one English
  // sentence does not turn the English into Greek, and an all-English reply
  // stays exactly where v1 put it).
  let defaultLang = o.defaultLang || ''
  if (!defaultLang) {
    defaultLang = detection === 'off'
      ? guessLangV1(unmarked)
      : guessLangV1(splitSentences(unmarked).filter((x) => !GREEK_RE.test(x)).join(' ') || '')
  }

  const minConf = typeof o.minConfidence === 'number' ? o.minConfidence : 0.75
  const sentences = []
  for (const r of runs) {
    if (r.lang) {
      sentences.push(Object.assign({}, r, { lang: r.lang, source: 'marker', conf: 1 }))
      continue
    }
    if (detection === 'off' || o.defaultLang) {
      sentences.push(Object.assign({}, r, { lang: defaultLang, source: o.defaultLang ? 'manual' : 'default', conf: 0.5 }))
      continue
    }
    const parts = splitSentences(r.text)
    if (!parts.length && r.pauseBeforeMs) sentences.push(Object.assign({}, r, { lang: defaultLang, source: 'default', conf: 0.5 }))
    parts.forEach((p, k) => {
      const extra = {}
      if (k === 0 && r.pauseBeforeMs) extra.pauseBeforeMs = r.pauseBeforeMs
      if (r.voice) extra.voice = r.voice
      if (r.provider) extra.provider = r.provider
      // A resolver (the model pass, cached) beats the heuristics but never a marker.
      const res = o.resolve ? o.resolve(p) : null
      if (res && Array.isArray(res.spans) && res.spans.length) {
        splitBySpans(p, res.lang || defaultLang, res.spans).forEach((piece, n) => {
          sentences.push(Object.assign({}, n === 0 ? extra : {}, { text: piece.text, lang: piece.lang, source: 'model', conf: 0.95 }))
        })
        return
      }
      if (res && res.lang) {
        sentences.push(Object.assign({}, extra, { text: p, lang: res.lang, source: 'model', conf: Number(res.conf) || 0.95 }))
        return
      }
      const d = sentenceLang(p, defaultLang, o.enabled)
      const sent = Object.assign({}, extra, { text: p, lang: d.lang, source: d.source, conf: d.conf })
      if (d.mixed) sent.mixed = true
      sentences.push(sent)
    })
  }

  // Sentences the model should look at: unsure heuristics with some words, and
  // Greek sentences holding a run of Latin words. Computed before smoothing.
  const uncertain = sentences
    .filter((x) => (x.source === 'heuristic' || x.source === 'default') ? (x.conf < minConf && wordCount(x.text) >= 3) : Boolean(x.mixed))
    .map((x) => x.text.trim())
    .filter((t, i, a) => t && a.indexOf(t) === i)

  // Smoothing: a sentence with little evidence (under 4 words, or an unsure
  // score) takes its neighbour's language, so "OK." or "Yes!" between Greek
  // sentences stays Greek. A fragment that does not end a sentence (it
  // continues after a marked span) looks forward to the text it belongs to;
  // anything else looks back. Markers, manual picks, script and model
  // decisions are never smoothed.
  const unmarkedAt = (from, step) => {
    for (let j = from; j >= 0 && j < sentences.length; j += step) if (sentences[j].source !== 'marker') return sentences[j]
    return null
  }
  for (let i = 0; i < sentences.length; i += 1) {
    const s = sentences[i]
    if (s.source === 'marker' || s.source === 'manual' || s.source === 'script' || s.source === 'model') continue
    const strong = s.source === 'heuristic' && wordCount(s.text) >= 4 && s.conf >= 0.6
    if (strong || (s.source === 'default' && wordCount(s.text) >= 4)) continue
    const ends = /[.!?\u2026\u037E;]["'\u201d\u2019)\]]*\s*$/.test(s.text)
    const nextMarked = sentences[i + 1] && sentences[i + 1].source === 'marker'
    const pick = (!ends && nextMarked)
      ? (unmarkedAt(i + 1, 1) || unmarkedAt(i - 1, -1))
      : (unmarkedAt(i - 1, -1) || unmarkedAt(i + 1, 1))
    if (pick && pick.lang !== s.lang) { s.lang = pick.lang; s.source = 'smoothed' }
  }

  const segments = []
  for (const s of sentences) {
    const last = segments[segments.length - 1]
    const same = last && !s.pauseBeforeMs && last.lang === s.lang && (last.voice || '') === (s.voice || '')
      && (last.provider || '') === (s.provider || '') && (last.model || '') === (s.model || '')
      && (last.speed || 0) === (s.speed || 0)
    if (same) {
      last.text += s.text
      last.conf = Math.min(last.conf, s.conf)
      if (last.source !== s.source) last.source = last.source === 'marker' ? 'marker' : 'mixed'
    } else {
      const seg = { text: s.text, lang: s.lang, source: s.source, conf: s.conf }
      for (const k of ['voice', 'provider', 'model', 'speed', 'pauseBeforeMs']) if (s[k]) seg[k] = s[k]
      segments.push(seg)
    }
  }
  const cleaned = segments
    .map((x) => Object.assign(x, { text: x.text.trim() }))
    .filter((x) => x.text || x.pauseBeforeMs)
  return { segments: cleaned, codeBlocks, plain: runs.map((r) => r.text).join(''), uncertain }
}

/**
 * Split one sentence by model spans [{from, to, lang}] (offsets into the
 * trimmed sentence); text outside every span keeps `base`.
 */
export function splitBySpans(sentence, base, spans) {
  const lead = sentence.length - sentence.trimStart().length
  const core = sentence.trim()
  const ok = spans
    .map((x) => ({ from: Math.max(0, Number(x.from) | 0), to: Math.min(core.length, Number(x.to) | 0), lang: String(x.lang || base) }))
    .filter((x) => x.to > x.from)
    .sort((a, b) => a.from - b.from)
  const out = []
  let at = 0
  const push = (text, lang) => { if (!text) return; const last = out[out.length - 1]; if (last && last.lang === lang) last.text += text; else out.push({ text, lang }) }
  for (const sp of ok) {
    if (sp.from < at) continue
    push(core.slice(at, sp.from), base)
    push(core.slice(sp.from, sp.to), sp.lang)
    at = sp.to
  }
  push(core.slice(at), base)
  if (out.length) { out[0].text = sentence.slice(0, lead) + out[0].text; out[out.length - 1].text += sentence.slice(lead + core.length) }
  return out.length ? out : [{ text: sentence, lang: base }]
}

/** Two-letter routing key: "en-GB" -> "en". */
export const lang2 = (l) => String(l || 'en').toLowerCase().slice(0, 2)
