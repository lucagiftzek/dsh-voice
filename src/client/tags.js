/**
 * dsh-voice client: Voxtral TTS 3 inline tags (emotion, pace, sounds) and the
 * language-marker helper of the reader tab. Pure; tested in node.
 *
 * Voxtral tags are a provider-specific syntax ([emotion=happy], [pace=slow],
 * [laugh]); they reach Mistral TTS 3 only and are removed for every other
 * engine, which would read them aloud. A tag lasts until the end of its
 * request, so the active emotion and pace are carried into later chunks.
 */

export const TAGS = [
  { group: 'Emotion', items: ['amused', 'angry', 'anxious', 'apologetic', 'appreciative', 'assertive', 'bored', 'calm', 'confident', 'confused', 'critical', 'curious', 'determined', 'disappointed', 'disgusted', 'excited', 'frustrated', 'grateful', 'happy', 'hopeful', 'playful', 'proud', 'reflective', 'resigned', 'sad', 'sarcastic', 'skeptical', 'somber', 'surprised', 'tense', 'tired', 'urgent', 'warm', 'wistful'].map((e) => '[emotion=' + e + ']') },
  { group: 'Pace', items: ['very-slow', 'slow', 'moderate', 'fast', 'very-fast'].map((p) => '[pace=' + p + ']') },
  { group: 'Sounds', items: ['um', 'uh', 'laugh', 'chuckle', 'laugh hard', 'breath', 'sigh', 'gasp', 'sniff', 'cough', 'throat clearing', 'yawn'].map((x) => '[' + x + ']') },
]
const SOUNDS = TAGS[2].items.map((t) => t.slice(1, -1))
const TAG_RE = new RegExp('\\[(?:(?:emotion|pace)=[a-z-]+|' + SOUNDS.map((s) => s.replace(/ /g, '\\s')).join('|') + ')\\]', 'g')

/** Is this engine/model the one that understands the tags? */
export const takesTags = (engine, model) => engine === 'mistral' && /tts-3/.test(String(model || ''))

/** Remove Voxtral tags (and the double space they leave). */
export function stripTags(text) {
  return String(text || '').replace(TAG_RE, '').replace(/[ \t]{2,}/g, ' ')
}

/** Carry the active emotion and pace into chunks that do not start with their own. */
export function carryTags(chunks) {
  let emotion = ''
  let pace = ''
  return chunks.map((c) => {
    const head = (/^\s*\[(?:emotion|pace)=/.test(c)) ? '' : (emotion + pace)
    let m
    const re = /\[(emotion|pace)=([a-z-]+)\]/g
    while ((m = re.exec(c))) { if (m[1] === 'emotion') emotion = m[0]; else pace = m[0] }
    return head + c
  })
}

/**
 * Insert a language marker at the cursor. With a selection, wrap it:
 * "[[it]]selection[[/]]"; without one, insert the sticky switch "[[it]]".
 * Returns { text, start, end } with the new cursor/selection.
 */
export function insertMarker(text, selStart, selEnd, lang) {
  const t = String(text || '')
  const a = Math.max(0, Math.min(t.length, Number(selStart) || 0))
  const b = Math.max(a, Math.min(t.length, Number(selEnd) || a))
  const open = lang === '/' ? '[[/]]' : '[[' + lang + ']]'
  if (b > a && lang !== '/') {
    const out = t.slice(0, a) + open + t.slice(a, b) + '[[/]]' + t.slice(b)
    return { text: out, start: a + open.length, end: b + open.length }
  }
  const out = t.slice(0, a) + open + t.slice(b)
  return { text: out, start: a + open.length, end: a + open.length }
}

/** Insert any snippet at the cursor (Voxtral tag menu). */
export function insertSnippet(text, selStart, selEnd, snippet) {
  const t = String(text || '')
  const a = Math.max(0, Math.min(t.length, Number(selStart) || 0))
  const b = Math.max(a, Math.min(t.length, Number(selEnd) || a))
  const pad = a > 0 && !/\s$/.test(t.slice(0, a)) ? ' ' : ''
  const out = t.slice(0, a) + pad + snippet + ' ' + t.slice(b)
  const at = a + pad.length + snippet.length + 1
  return { text: out, start: at, end: at }
}

/** Plain text of an opened file: .md and .txt as is, .html without its markup. */
export function fileText(name, content, parseHtml) {
  const n = String(name || '').toLowerCase()
  if (/\.(html?|xhtml)$/.test(n)) {
    if (typeof parseHtml === 'function') return parseHtml(content)
    return String(content || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').trim()
  }
  return String(content || '')
}
