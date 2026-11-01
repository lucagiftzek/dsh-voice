/**
 * dsh-voice client: export a whole text as one audio file.
 *
 * Every chunk is synthesised at normal speed (speed is a playback setting),
 * then joined in the browser:
 *   mp3   all chunks MP3: frames concatenate as they are (a [[pause]] cannot
 *         be represented and is skipped)
 *   wav   all chunks WAV with one format: PCM payloads merged (1.x reader path)
 *   wav   anything mixed (MiMo WAV next to Mistral MP3): decoded with Web
 *         Audio, mixed down to mono, silence inserted for [[pause]] markers,
 *         encoded as 16-bit PCM WAV
 * The browser voice is synthesised by the OS and cannot be captured.
 */

const tag4 = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3])

export function isWavBytes(u8) { return u8 && u8.length > 12 && tag4(u8, 0) === 'RIFF' && tag4(u8, 8) === 'WAVE' }
export function isMp3Bytes(u8) { return u8 && u8.length > 3 && (tag4(u8, 0).slice(0, 3) === 'ID3' || (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0)) }

/** fmt and data of a WAV (streamed WAVs may carry 0 or 0xFFFFFFFF as the data size). */
export function parseWav(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let o = 12
  let fmt = null
  while (o + 8 <= u8.byteLength) {
    const id = tag4(u8, o)
    let size = dv.getUint32(o + 4, true)
    if (id === 'fmt ') fmt = u8.subarray(o + 8, o + 8 + size)
    if (id === 'data') {
      if (size === 0 || size === 0xffffffff || o + 8 + size > u8.byteLength) size = u8.byteLength - (o + 8)
      return { fmt, data: u8.subarray(o + 8, o + 8 + size) }
    }
    o += 8 + size + (size % 2)
  }
  return null
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

/** Merge WAVs that share one fmt chunk; null when they do not. */
export function mergeWav(list) {
  const parsed = list.map(parseWav)
  if (parsed.some((p) => !p || !p.fmt)) return null
  const fmt = parsed[0].fmt
  if (parsed.some((p) => !sameBytes(p.fmt, fmt))) return null
  const total = parsed.reduce((n, p) => n + p.data.length, 0)
  const out = new Uint8Array(12 + 8 + fmt.length + 8 + total)
  const dv = new DataView(out.buffer)
  const tag = (o, t) => { for (let i = 0; i < 4; i += 1) out[o + i] = t.charCodeAt(i) }
  tag(0, 'RIFF'); dv.setUint32(4, out.length - 8, true); tag(8, 'WAVE')
  tag(12, 'fmt '); dv.setUint32(16, fmt.length, true); out.set(fmt, 20)
  const d = 20 + fmt.length
  tag(d, 'data'); dv.setUint32(d + 4, total, true)
  let p = d + 8
  for (const x of parsed) { out.set(x.data, p); p += x.data.length }
  return out
}

export function concatBytes(list) {
  const n = list.reduce((a, b) => a + b.length, 0)
  const out = new Uint8Array(n)
  let p = 0
  for (const b of list) { out.set(b, p); p += b.length }
  return out
}

/** Mono float samples -> 16-bit PCM WAV bytes. */
export function encodeWav(samples, sampleRate) {
  const n = samples.length
  const out = new Uint8Array(44 + n * 2)
  const dv = new DataView(out.buffer)
  const tag = (o, t) => { for (let i = 0; i < 4; i += 1) out[o + i] = t.charCodeAt(i) }
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE')
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  tag(36, 'data'); dv.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return out
}

/** Which join applies: 'mp3-concat' | 'wav-merge' | 'decode'. */
export function strategyFor(parts, format) {
  const allMp3 = parts.every((p) => isMp3Bytes(p.bytes))
  const allWav = parts.every((p) => isWavBytes(p.bytes))
  const pauses = parts.some((p) => p.pauseBeforeMs)
  if (format === 'mp3') return allMp3 ? 'mp3-concat' : 'decode'
  if (allWav && !pauses) return 'wav-merge'
  return 'decode'
}

/**
 * Join synthesised parts [{ bytes: Uint8Array, pauseBeforeMs }] into one file.
 * decode(bytes) -> Promise<{ sampleRate, channels: Float32Array[] }> (Web Audio in the browser,
 * injectable in tests). Returns { bytes, mime, ext, strategy }.
 */
export async function joinParts(parts, format, decode) {
  if (!parts.length) throw new Error('nothing to export')
  let strategy = strategyFor(parts, format)
  if (strategy === 'mp3-concat') return { bytes: concatBytes(parts.map((p) => p.bytes)), mime: 'audio/mpeg', ext: 'mp3', strategy }
  if (strategy === 'wav-merge') {
    const w = mergeWav(parts.map((p) => p.bytes))
    if (w) return { bytes: w, mime: 'audio/wav', ext: 'wav', strategy }
    strategy = 'decode'
  }
  if (typeof decode !== 'function') throw new Error('this browser cannot decode audio for a mixed export')
  const decoded = []
  for (const p of parts) decoded.push({ pauseBeforeMs: p.pauseBeforeMs || 0, audio: await decode(p.bytes) })
  const rate = decoded[0].audio.sampleRate
  let total = 0
  const mono = decoded.map((d) => {
    const ch = d.audio.channels
    const len = ch[0].length
    const m = new Float32Array(len)
    for (let c = 0; c < ch.length; c += 1) for (let i = 0; i < len; i += 1) m[i] += ch[c][i] / ch.length
    // decodeAudioData resamples to the context rate; a differing rate here is resampled linearly.
    const r = d.audio.sampleRate
    const out = r === rate ? m : resample(m, r, rate)
    const pad = Math.round((d.pauseBeforeMs / 1000) * rate)
    total += pad + out.length
    return { pad, out }
  })
  const all = new Float32Array(total)
  let at = 0
  for (const x of mono) { at += x.pad; all.set(x.out, at); at += x.out.length }
  return { bytes: encodeWav(all, rate), mime: 'audio/wav', ext: 'wav', strategy }
}

export function resample(src, from, to) {
  if (from === to) return src
  const n = Math.max(1, Math.round(src.length * to / from))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 1) {
    const x = i * from / to
    const i0 = Math.floor(x)
    const f = x - i0
    out[i] = (src[i0] || 0) * (1 - f) + (src[Math.min(src.length - 1, i0 + 1)] || 0) * f
  }
  return out
}

/** Web Audio decoder for joinParts (browser only). */
export function webAudioDecoder() {
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)
  if (!AC) return null
  let ac = null
  return async (bytes) => {
    if (!ac) ac = new AC()
    const buf = await ac.decodeAudioData(bytes.slice().buffer)
    const channels = []
    for (let c = 0; c < buf.numberOfChannels; c += 1) channels.push(buf.getChannelData(c))
    return { sampleRate: buf.sampleRate, channels }
  }
}

/** Download bytes as a file. */
export function saveBytes(bytes, mime, ext, prefix) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const name = (prefix || 'dsh-voice') + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.' + ext
  const url = URL.createObjectURL(new window.Blob([bytes], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => { try { URL.revokeObjectURL(url) } catch (e) { /* gone */ } }, 30000)
  return name
}
