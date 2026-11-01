/**
 * dsh-voice: in-text language markers (shared by the host and the browser bundle).
 *
 * Grammar (spec 4.2):
 *   [[el]]                 switch to Greek from here (sticky) until the next marker
 *   [[it]] ... [[/]]       Italian for the span, then back to the previous language
 *   [[auto]]               back to automatic detection
 *   [[el voice=x provider=y model=z speed=1.1]]   optional per-span overrides
 *   [[pause 600]]          a pause in milliseconds
 *   <!--lang:el--> <!--lang:/--> <!--lang:auto-->  the same, invisible in rendered markdown
 *   \[[el]]                literal text, not a marker
 *
 * A tag is a BCP-47 subset: [a-z]{2,3}(-[A-Za-z]{2,4})?. Anything else, for
 * example [[wiki links]], stays text. Markers inside code fences and inline
 * code are ignored. Voxtral emotion tags ([happy], single brackets) are a
 * different syntax and are never touched here.
 *
 * `[[/]]` pops the most recent marker, so `[[el]] a [[it]] b [[/]] c` reads c
 * in Greek again. An unclosed marker is simply sticky.
 *
 * No dependencies: this file is bundled into the client as is.
 */

export const TAG_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/
const KEYS = new Set(['voice', 'provider', 'model', 'speed'])
const VALUE_RE = /^[A-Za-z0-9_.:@+-]{1,80}$/

/** Sentinels used to carry markers through text transforms (Unicode private use area). */
export const SENTINEL_OPEN = '\uE000'
export const SENTINEL_CLOSE = '\uE001'
const SENTINEL_RE = /\uE000(\d+)\uE001/g

/**
 * Parse the inside of one marker. Returns a directive or null (not a marker).
 *   { kind: 'pop' } | { kind: 'push', lang: string|null, opts } | { kind: 'pause', ms }
 */
export function parseDirective(body) {
  const s = String(body || '').trim()
  if (!s) return null
  if (s === '/') return { kind: 'pop' }
  const pause = /^pause\s+(\d{1,5})$/.exec(s)
  if (pause) return { kind: 'pause', ms: Math.min(10000, Number(pause[1])) }
  const parts = s.split(/\s+/)
  const head = parts[0]
  let lang
  if (head === 'auto') lang = null
  else if (TAG_RE.test(head)) lang = head
  else return null
  const opts = {}
  for (let i = 1; i < parts.length; i += 1) {
    const kv = /^([a-z]+)=(.+)$/.exec(parts[i])
    if (!kv || !KEYS.has(kv[1]) || !VALUE_RE.test(kv[2])) return null
    opts[kv[1]] = kv[1] === 'speed' ? Number(kv[2]) : kv[2]
    if (kv[1] === 'speed' && !(opts.speed >= 0.25 && opts.speed <= 4)) return null
  }
  return { kind: 'push', lang, opts }
}

/**
 * Scan source text. Calls onText(text, srcStart) for literal text and
 * onDirective(directive, srcStart, srcEnd, form) for every marker.
 * form is 'bracket' or 'comment'.
 */
function scan(src, onText, onDirective) {
  const s = String(src || '')
  let i = 0
  let textStart = 0
  const flush = (end) => { if (end > textStart) onText(s.slice(textStart, end), textStart) }
  while (i < s.length) {
    const ch = s[i]
    // Code fences: copy through untouched.
    if (ch === '`' && s.startsWith('```', i)) {
      const close = s.indexOf('```', i + 3)
      i = close === -1 ? s.length : close + 3
      continue
    }
    // Inline code.
    if (ch === '`') {
      const close = s.indexOf('`', i + 1)
      const nl = s.indexOf('\n', i + 1)
      if (close !== -1 && (nl === -1 || close < nl)) { i = close + 1; continue }
      i += 1
      continue
    }
    // Escape: \[[el]] is literal "[[el]]" when what follows is a valid marker.
    if (ch === '\\' && s.startsWith('[[', i + 1)) {
      const end = s.indexOf(']]', i + 3)
      if (end !== -1 && parseDirective(s.slice(i + 3, end))) {
        flush(i)
        onText(s.slice(i + 1, end + 2), i + 1)
        i = end + 2
        textStart = i
        continue
      }
      i += 1
      continue
    }
    if (ch === '[' && s.startsWith('[[', i)) {
      const end = s.indexOf(']]', i + 2)
      const nl = s.indexOf('\n', i + 2)
      if (end !== -1 && (nl === -1 || end < nl) && end - i < 140) {
        const d = parseDirective(s.slice(i + 2, end))
        if (d) {
          flush(i)
          onDirective(d, i, end + 2, 'bracket')
          i = end + 2
          textStart = i
          continue
        }
      }
      i += 1
      continue
    }
    if (ch === '<' && s.startsWith('<!--', i)) {
      const m = /^<!--\s*lang:\s*([^>]*?)\s*-->/.exec(s.slice(i, i + 160))
      if (m) {
        const d = parseDirective(m[1])
        if (d && d.kind !== 'pause') {
          flush(i)
          onDirective(d, i, i + m[0].length, 'comment')
          i += m[0].length
          textStart = i
          continue
        }
      }
      i += 1
      continue
    }
    i += 1
  }
  flush(s.length)
}

/** Resolve a directive against the current stack; returns the new top (or a pause). */
function applyDirective(stack, d) {
  if (d.kind === 'pop') { if (stack.length) stack.pop() }
  else if (d.kind === 'push') stack.push({ lang: d.lang, opts: d.opts || {} })
  return stack.length ? stack[stack.length - 1] : null
}

function runOf(top, text, start, pauseBeforeMs) {
  const r = { text, start, lang: top ? top.lang : null, marked: Boolean(top && top.lang) }
  if (top && top.opts) {
    if (top.opts.voice) r.voice = top.opts.voice
    if (top.opts.provider) r.provider = top.opts.provider
    if (top.opts.model) r.model = top.opts.model
    if (top.opts.speed) r.speed = top.opts.speed
  }
  if (pauseBeforeMs) r.pauseBeforeMs = pauseBeforeMs
  return r
}

/**
 * Parse markers out of a text.
 * Returns { plain, runs, map, hadMarkers }:
 *   plain  the text with every marker removed (what TTS receives and what alignment offsets refer to)
 *   runs   [{ text, start, lang|null, marked, voice?, provider?, model?, speed?, pauseBeforeMs? }] covering plain
 *   map    [[plainStart, srcStart, length], ...] to convert plain offsets back to source offsets
 */
export function parseMarkers(src) {
  const stack = []
  let top = null
  let plain = ''
  const runs = []
  const map = []
  let pause = 0
  let hadMarkers = false
  scan(src, (text, srcStart) => {
    map.push([plain.length, srcStart, text.length])
    const last = runs[runs.length - 1]
    if (last && !pause && last.lang === (top ? top.lang : null) && sameOpts(last, top)) last.text += text
    else runs.push(runOf(top, text, plain.length, pause))
    pause = 0
    plain += text
  }, (d) => {
    hadMarkers = true
    if (d.kind === 'pause') { pause += d.ms; return }
    top = applyDirective(stack, d)
  })
  if (pause && runs.length) runs.push(runOf(top, '', plain.length, pause))
  return { plain, runs, map, hadMarkers }
}

function sameOpts(run, top) {
  const o = (top && top.opts) || {}
  return (run.voice || '') === (o.voice || '') && (run.provider || '') === (o.provider || '')
    && (run.model || '') === (o.model || '') && (run.speed || 0) === (o.speed || 0)
}

/** Convert an offset into `plain` back to an offset into the source text. */
export function plainToSource(map, offset) {
  for (let i = map.length - 1; i >= 0; i -= 1) {
    const [p, s, len] = map[i]
    if (offset >= p) return s + Math.min(offset - p, len)
  }
  return offset
}

/** Remove every marker (TTS input). */
export function stripMarkers(src) {
  return parseMarkers(src).plain
}

/** Remove only the invisible HTML comment form, for places that render text (the bracket form is the author's). */
export function hideCommentMarkers(src) {
  let out = ''
  scan(src, (t) => { out += t }, (d, s, e, form) => { if (form === 'bracket') out += String(src).slice(s, e) })
  return out
}

/**
 * Replace markers with sentinels so the text can pass through markdown
 * clean-up (speakableProse) and be split back into runs afterwards.
 * Returns { text, directives }.
 */
export function encodeMarkers(src) {
  const directives = []
  let text = ''
  scan(src, (t) => { text += t.replace(/[\uE000\uE001]/g, '') }, (d) => {
    directives.push(d)
    text += SENTINEL_OPEN + (directives.length - 1) + SENTINEL_CLOSE
  })
  return { text, directives }
}

/** Inverse of encodeMarkers after a transform: split the text into runs. */
export function decodeMarkers(text, directives) {
  const stack = []
  let top = null
  const runs = []
  let pause = 0
  let last = 0
  let plainLen = 0
  const push = (t) => {
    if (!t) return
    const prev = runs[runs.length - 1]
    if (prev && !pause && prev.lang === (top ? top.lang : null) && sameOpts(prev, top)) prev.text += t
    else runs.push(runOf(top, t, plainLen, pause))
    pause = 0
    plainLen += t.length
  }
  String(text || '').replace(SENTINEL_RE, (m, n, at) => {
    push(text.slice(last, at))
    last = at + m.length
    const d = directives[Number(n)]
    if (!d) return m
    if (d.kind === 'pause') pause += d.ms
    else top = applyDirective(stack, d)
    return m
  })
  push(text.slice(last))
  if (pause && runs.length) runs.push(runOf(top, '', plainLen, pause))
  return runs
}

/** Tokens for a reading view that shows markers as language chips (reader tab, phase 3). */
export function displayTokens(src) {
  const out = []
  scan(src, (t) => out.push({ type: 'text', text: t }), (d) => {
    if (d.kind === 'push') out.push({ type: 'chip', lang: d.lang || 'auto' })
    else if (d.kind === 'pop') out.push({ type: 'chip', lang: '/' })
    else out.push({ type: 'pause', ms: d.ms })
  })
  return out
}
