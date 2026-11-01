/**
 * dsh-voice: map spoken text to rendered text (pure; the DOM wrapper lives in
 * src/client/highlight.js).
 *
 * The spoken text is markdown with its syntax removed, the rendered message
 * is HTML: whitespace, markup and punctuation differ, letters do not. So both
 * sides are reduced to a KEY of letters and digits (NFC, lowercase, final
 * sigma folded) and a spoken range is found in the rendered key. Every key
 * character remembers which text node and offset it came from, so a match
 * becomes a DOM Range without ever mutating the chat DOM.
 */

const KEEP = /[\p{L}\p{N}]/u

function keyChar(c) {
  if (!KEEP.test(c)) return ''
  let k = c.normalize('NFC').toLowerCase()
  if (k === '\u03c2') k = '\u03c3'
  return k.length === 1 ? k : c
}

/** Key of a plain string and, per key char, its offset in the string. */
export function keyOf(text) {
  const s = String(text || '')
  let key = ''
  const at = []
  for (let i = 0; i < s.length; i += 1) {
    const k = keyChar(s[i])
    if (!k) continue
    key += k
    at.push(i)
  }
  return { key, at }
}

/**
 * Index over text node strings: { key, map } where map[j] = [nodeIndex, offset]
 * for key char j.
 */
export function buildKeyIndex(texts) {
  let key = ''
  const map = []
  texts.forEach((t, n) => {
    const s = String(t || '')
    for (let i = 0; i < s.length; i += 1) {
      const k = keyChar(s[i])
      if (!k) continue
      key += k
      map.push([n, i])
    }
  })
  return { key, map }
}

/**
 * Find a spoken text in the index, searching forward from key offset `from`
 * (then from the start). Returns { k0, k1 } (key offsets, k1 exclusive) or null.
 */
export function findKey(index, text, from) {
  const { key } = keyOf(text)
  if (!key) return null
  let k0 = index.key.indexOf(key, Math.max(0, from || 0))
  if (k0 < 0) k0 = index.key.indexOf(key)
  if (k0 < 0 && key.length > 24) {
    // Rendered text may differ in the middle (a link label, a list number):
    // anchor on the first and last 12 key chars.
    const a = index.key.indexOf(key.slice(0, 12), Math.max(0, from || 0))
    const b = a >= 0 ? index.key.indexOf(key.slice(-12), a) : -1
    if (a >= 0 && b >= 0 && b - a < key.length * 2) return { k0: a, k1: b + 12 }
    return null
  }
  if (k0 < 0) return null
  return { k0, k1: k0 + key.length }
}

/**
 * Key range of a sub-span [c0, c1) of a chunk whose key starts at chunkK0.
 * Returns { k0, k1 } or null when the span holds no letters.
 */
export function subKeyRange(chunkText, chunkK0, c0, c1) {
  const { at } = keyOf(chunkText)
  let a = -1
  let b = -1
  for (let j = 0; j < at.length; j += 1) {
    if (at[j] >= c0 && a < 0) a = j
    if (at[j] < c1) b = j
  }
  if (a < 0 || b < a) return null
  return { k0: chunkK0 + a, k1: chunkK0 + b + 1 }
}

/** Key range -> [[startNode, startOffset], [endNode, endOffsetExclusive]] through the index map. */
export function keyRangeToNodes(index, k0, k1) {
  if (k0 < 0 || k1 > index.map.length || k1 <= k0) return null
  const s = index.map[k0]
  const e = index.map[k1 - 1]
  return [[s[0], s[1]], [e[0], e[1] + 1]]
}
