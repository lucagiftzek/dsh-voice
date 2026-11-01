/**
 * dsh-voice: SSML helpers for the cloud TTS adapters that take SSML.
 */

export const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))

/**
 * Plain text -> escaped text with a <mark name="wN"/> before every word, plus
 * the table to map a returned mark back to character offsets in `text`.
 * Returns { body, marks: [{ name, c0, c1 }] }. `body` is the inside of <speak>.
 */
export function markWords(text) {
  const src = String(text || '')
  const marks = []
  let body = ''
  let last = 0
  const re = /\S+/g
  let m
  while ((m = re.exec(src))) {
    const name = 'w' + marks.length
    marks.push({ name, c0: m.index, c1: m.index + m[0].length })
    body += escapeXml(src.slice(last, m.index)) + '<mark name="' + name + '"/>' + escapeXml(m[0])
    last = m.index + m[0].length
  }
  body += escapeXml(src.slice(last))
  return { body, marks }
}

/** Convert a speed multiplier to an SSML prosody rate percentage string ("+20%", "-10%"). */
export function prosodyRate(speed) {
  const s = Number(speed)
  if (!s || s === 1) return ''
  const pct = Math.round((s - 1) * 100)
  return (pct >= 0 ? '+' : '') + pct + '%'
}
