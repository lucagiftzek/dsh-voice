/**
 * dsh-voice: transport helpers. node:http / node:https only (see lib/index.js
 * for why the host half has no dependencies).
 */
import http from 'node:http'
import https from 'node:https'
import { spawn } from 'node:child_process'

export const MAX_BODY = 25 * 1024 * 1024

/** A vendor failure with a machine-readable code, so the UI can explain it. */
export function voiceErr(message, code, status) {
  const e = new Error(message)
  e.code = code
  if (status) e.status = status
  return e
}

/** Trim an upstream body for an error message and scrub anything key-shaped. */
export function scrub(text, n) {
  return String(text || '').slice(0, n || 200)
    .replace(/(sk|xi|key|tok|Bearer)[-_ ]?[A-Za-z0-9_-]{16,}/g, '$1***')
    .replace(/[A-Za-z0-9_-]{32,}/g, '***')
}

export function readBody(req, max) {
  const cap = max || MAX_BODY
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > cap) { reject(voiceErr('body too large', 'too_large', 413)); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * One upstream call. `url` is a full URL string or URL; http or https by its
 * protocol, so an instance may point at a loopback relay (a relayed MiMo
 * endpoint is plain http with a port). Non-2xx resolves; only transport errors reject.
 * opts: { method, headers, body, timeout, agent, signal }
 */
export function request(url, opts) {
  const o = opts || {}
  const u = url instanceof URL ? url : new URL(String(url))
  const mod = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const reqOpts = {
      protocol: u.protocol,
      host: u.hostname,
      port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: o.method || 'GET',
      headers: Object.assign({}, o.headers || {}),
      timeout: o.timeout || 60000,
    }
    if (o.agent !== undefined) reqOpts.agent = o.agent
    if (o.body) reqOpts.headers['content-length'] = o.body.length
    const r = mod.request(reqOpts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 502, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    r.on('error', (e) => reject(e && e.code === 'ABORT_ERR' ? voiceErr('request aborted', 'timeout', 504) : e))
    r.on('timeout', () => { r.destroy(voiceErr('upstream timeout', 'timeout', 504)) })
    if (o.signal) {
      if (o.signal.aborted) { r.destroy(voiceErr('request aborted', 'timeout', 504)) }
      else o.signal.addEventListener('abort', () => r.destroy(voiceErr('request aborted', 'timeout', 504)), { once: true })
    }
    if (o.body) r.write(o.body)
    r.end()
  })
}

/** Join an instance base URL and a path: ("https://h/v1", "/audio/speech") -> https://h/v1/audio/speech */
export function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '')
  return new URL(b + (String(path).startsWith('/') ? path : '/' + path))
}

export function jsonBody(obj) { return Buffer.from(JSON.stringify(obj)) }

export function parseJson(buf) {
  try { return JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)) } catch (e) { return null }
}

export function sendJson(res, status, obj) {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length, 'cache-control': 'no-store' })
  res.end(b)
}

export function sendAudio(res, buf, type) {
  res.writeHead(200, { 'content-type': type || 'audio/mpeg', 'content-length': buf.length, 'cache-control': 'no-store' })
  res.end(buf)
}

/** Sniff an audio container from its first bytes (RIFF -> wav, ID3 -> mp3). */
export function audioType(buf, fallback) {
  if (buf && buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF') return 'audio/wav'
  if (buf && buf.length > 3 && buf.slice(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg'
  if (buf && buf.length > 4 && buf.slice(0, 4).toString('latin1') === 'OggS') return 'audio/ogg'
  return fallback || 'audio/mpeg'
}

export const isWav = (buf) => Boolean(buf && buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF')

/** Rebuild a multipart body around one audio part (vendors differ in field names). */
export function multipart(fields, file) {
  const b = '----dshvoice' + Math.abs(Date.now() % 1e9).toString(36) + 'x'
  const parts = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  parts.push(Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\n` +
    `Content-Type: ${file.type}\r\n\r\n`))
  parts.push(file.data)
  parts.push(Buffer.from(`\r\n--${b}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` }
}

/** Pull the single file part out of the browser's multipart body. */
export function extractFilePart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '')
  if (!m) return null
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim())
  let start = buf.indexOf(boundary)
  while (start !== -1) {
    const headEnd = buf.indexOf('\r\n\r\n', start)
    if (headEnd === -1) break
    const head = buf.slice(start, headEnd).toString('latin1')
    const next = buf.indexOf(boundary, headEnd)
    const end = next === -1 ? buf.length : next - 2
    if (/filename=/i.test(head)) {
      const fn = /filename="([^"]*)"/i.exec(head)
      const ct = /Content-Type:\s*([^\r\n]+)/i.exec(head)
      return { data: buf.slice(headEnd + 4, end), name: (fn && fn[1]) || 'dictation.webm', type: (ct && ct[1].trim()) || 'audio/webm' }
    }
    start = next
  }
  return null
}

/** Browser clips are webm/opus or mp4; some engines take only wav (16 kHz mono). */
export function toWav(buf) {
  if (isWav(buf)) return Promise.resolve(buf)
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'])
    const out = []
    let err = ''
    ff.stdout.on('data', (c) => out.push(c))
    ff.stderr.on('data', (c) => { err += c })
    ff.on('error', (e) => reject(new Error('ffmpeg unavailable: ' + e.message)))
    ff.on('close', (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg failed: ' + err.slice(0, 160)))))
    ff.stdin.on('error', () => {})
    ff.stdin.end(buf)
  })
}

/** Two-letter language tag, defaulting to English. "en-GB" -> "en". */
export const lang2 = (l) => String(l || 'en').toLowerCase().slice(0, 2)
