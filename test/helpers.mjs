// Shared test helpers: recording mock HTTP vendor, a service builder and a tiny HTTP client.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandler } from '../lib/server/routes.js'
import { createSettingsStore } from '../lib/server/settings-store.js'
import { createRegistry } from '../lib/server/registry.js'
import { normalise } from '../lib/server/settings.js'

/**
 * A mock vendor on 127.0.0.1:<port 0>. Every request is recorded in `reqs`
 * ({method, url, path, query, headers, body}). `m.handler = (r, res) => ...`
 * answers; the default answer is 404. Helpers: m.json(res, status, obj).
 */
export async function mockServer(handler) {
  const m = { reqs: [], handler: handler || null }
  m.server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const u = new URL(req.url, 'http://x')
      const r = { method: req.method, url: req.url, path: u.pathname, query: u.search, headers: req.headers, body: Buffer.concat(chunks) }
      r.json = () => { try { return JSON.parse(r.body.toString('utf8')) } catch (e) { return null } }
      m.reqs.push(r)
      if (m.handler) return m.handler(r, res)
      reply(res, 404, { error: 'not found' })
    })
  })
  await new Promise((resolve) => m.server.listen(0, '127.0.0.1', resolve))
  m.port = m.server.address().port
  m.origin = 'http://127.0.0.1:' + m.port
  m.close = () => new Promise((resolve) => { m.server.closeAllConnections && m.server.closeAllConnections(); m.server.close(() => resolve()) })
  return m
}

export function reply(res, status, obj, headers) {
  const body = Buffer.isBuffer(obj) ? obj : Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))
  res.writeHead(status, Object.assign({ 'content-type': Buffer.isBuffer(obj) ? 'audio/mpeg' : (typeof obj === 'string' ? 'text/plain' : 'application/json'), 'content-length': body.length }, headers || {}))
  res.end(body)
}

/** A port nothing listens on. */
export async function closedPort() {
  const s = http.createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}

export function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dshvoice-'))
}

/** Adapter instance for direct adapter tests. */
export function inst(over) {
  const o = Object.assign({ id: 'x', baseUrl: '', models: {}, options: {}, defaultVoice: '', key: 'fake-key-0000', state: {} }, over || {})
  const key = o.key
  o.secret = () => key
  return o
}

/** A tiny valid 16 kHz mono 16 bit WAV so ffmpeg is never needed. */
export function wavBuffer(samples) {
  const n = samples || 1600
  const data = Buffer.alloc(n * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1')
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/** Browser-style multipart upload body with one file part. */
export function multipartUpload(audio, name) {
  const b = '----testboundary' + Math.random().toString(36).slice(2)
  const body = Buffer.concat([
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="file"; filename="' + (name || 'clip.wav') + '"\r\nContent-Type: audio/wav\r\n\r\n'),
    audio,
    Buffer.from('\r\n--' + b + '--\r\n'),
  ])
  return { body, contentType: 'multipart/form-data; boundary=' + b }
}

/**
 * Build a voice server: createHandler over a fresh settings store, served on a
 * loopback port. env is used AS GIVEN (never process.env).
 */
export async function voiceServer(env, opts) {
  const o = opts || {}
  const dataDir = o.dataDir || tmpDir('dshvoice-data-')
  const home = o.home || tmpDir('dshvoice-home-')
  const store = createSettingsStore({ dataDir, config: o.config })
  const secret = 'test-secret-' + 'x'.repeat(40)
  // lookup: no DNS in tests unless a test passes a fake resolver.
  const handler = createHandler({ store, env, home, secret: () => secret, warn: () => {}, llm: () => null, lookup: o.lookup || null })
  const server = http.createServer((req, res) => { handler(req, res) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const v = {
    port, dataDir, home, store, secret, origin: 'http://127.0.0.1:' + port,
    close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()) }),
  }
  v.call = (method, route, callOpts) => call(port, method, '/api/voice' + route, callOpts)
  return v
}

/** Raw HTTP call to 127.0.0.1:port. opts: {headers, body (Buffer|string|object)}. Resolves {status, headers, body, text, json}. */
export function call(port, method, urlPath, opts) {
  const o = opts || {}
  let body = o.body
  const headers = Object.assign({}, o.headers || {})
  if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') { body = JSON.stringify(body); headers['content-type'] = headers['content-type'] || 'application/json' }
  if (body !== undefined) headers['content-length'] = Buffer.byteLength(body)
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const text = buf.toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text, json })
      })
    })
    r.on('error', reject)
    if (body !== undefined) r.write(body)
    r.end()
  })
}

/** Registry over an env + settings object, for routing tests. */
export function makeRegistry(env, settingsRaw, home) {
  const settings = normalise(settingsRaw || {})
  const state = new Map()
  const reg = createRegistry({ env, home: home || tmpDir('dshvoice-home-'), settings, state })
  return { reg, settings, state }
}
