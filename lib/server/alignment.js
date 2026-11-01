/**
 * dsh-voice: alignment normalisation. Every adapter returns timings in the
 * SEGMENT's own character offsets (c0, c1 into the text that was sent, after
 * marker stripping). Phase 2 maps them back to display offsets.
 */

/**
 * ElevenLabs character alignment -> word items [{ c0, c1, t0, t1 }].
 * `characters` normally equals the input char by char; when it does not
 * (normalised text), each character is matched forward in the input so the
 * offsets still point into the text that was sent.
 */
export function charsToWords(text, al) {
  const chars = (al && al.characters) || []
  const t0s = (al && al.character_start_times_seconds) || []
  const t1s = (al && al.character_end_times_seconds) || []
  if (!chars.length) return null
  const src = String(text || '')
  const pos = []
  let at = 0
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]
    let j = src.indexOf(c, at)
    if (j === -1 || j - at > 8) j = at < src.length ? at : src.length - 1
    pos.push(j)
    at = j + 1
  }
  const words = []
  let cur = null
  for (let i = 0; i < chars.length; i += 1) {
    const ws = /\s/.test(chars[i])
    if (ws) { if (cur) { words.push(cur); cur = null } continue }
    if (!cur) cur = { c0: pos[i], c1: pos[i] + 1, t0: Number(t0s[i]) || 0, t1: Number(t1s[i]) || 0 }
    else { cur.c1 = pos[i] + 1; cur.t1 = Number(t1s[i]) || cur.t1 }
  }
  if (cur) words.push(cur)
  return words
}

/**
 * Timed tokens from a vendor -> word items in the sent text's character offsets.
 * tokens: [{ text, t0, t1 }] in reading order (seconds). Each token is searched
 * forward in `text` (case-insensitive, whitespace skipped) so a vendor that
 * normalises punctuation or case still maps; a token that cannot be found is
 * placed right after the previous one. Returns [{ c0, c1, t0, t1 }] or null.
 */
export function tokensToWords(text, tokens) {
  const src = String(text || '')
  const list = Array.isArray(tokens) ? tokens.filter((t) => t && String(t.text || '').trim()) : []
  if (!src || !list.length) return null
  const low = src.toLowerCase()
  const out = []
  let at = 0
  for (const t of list) {
    const w = String(t.text).trim()
    const wl = w.toLowerCase()
    let j = low.indexOf(wl, at)
    if (j === -1 || j - at > 40) {
      // vendor dropped or changed the word: keep order, anchor after the previous end
      j = at
      while (j < src.length && /\s/.test(src[j])) j += 1
      out.push({ c0: Math.min(j, src.length), c1: Math.min(j + w.length, src.length), t0: Number(t.t0) || 0, t1: Number(t.t1) || 0 })
      at = Math.min(j + w.length, src.length)
      continue
    }
    out.push({ c0: j, c1: j + w.length, t0: Number(t.t0) || 0, t1: Number(t.t1) || 0 })
    at = j + w.length
  }
  return out
}

/**
 * Word starts only (marks, offsets in ms, speech marks): turn [{ c0, c1, t0 }]
 * into items whose t1 is the next word's start (the last one ends at durationS).
 */
export function startsToWords(items, durationS) {
  const a = (items || []).slice().sort((x, y) => x.t0 - y.t0)
  if (!a.length) return null
  return a.map((w, k) => ({ c0: w.c0, c1: w.c1, t0: w.t0, t1: k + 1 < a.length ? a[k + 1].t0 : Math.max(w.t0, Number(durationS) || w.t0) }))
}
