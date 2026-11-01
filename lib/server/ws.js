/**
 * dsh-voice: a minimal RFC 6455 WebSocket client on node:http / node:https
 * (no dependency, custom request headers allowed, which the global WebSocket
 * of Node does not offer portably). Used by the adapters whose word timings
 * or streaming only exist on a socket (Azure WordBoundary, Cartesia word
 * timestamps, Amazon Transcribe streaming, Speechmatics realtime).
 *
 *   const ws = await wsConnect('wss://host/path', { headers, signal, timeout })
 *   ws.on('message', (data, isBinary) => ...)   // data: string (text) or Buffer (binary)
 *   ws.on('close', (code, reason) => ...)
 *   ws.on('error', (err) => ...)
 *   ws.sendText(str); ws.sendBinary(buf); ws.close()
 *
 * No extensions are negotiated (no permessage-deflate). Fragmented messages are
 * reassembled, pings are answered, and a message above MAX_MESSAGE is refused.
 *
 * encodeFrame / FrameParser are exported so the test suite's mock server uses
 * the very same codec (server frames are unmasked, client frames masked).
 */
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { voiceErr } from './http.js'

export const MAX_MESSAGE = 32 * 1024 * 1024
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const acceptKey = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64')

/** One frame. opcode 1 text, 2 binary, 8 close, 9 ping, 10 pong. */
export function encodeFrame(opcode, payload, mask) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8')
  const len = data.length
  const head = []
  head.push(0x80 | opcode)
  const m = mask ? 0x80 : 0
  if (len < 126) head.push(m | len)
  else if (len < 65536) head.push(m | 126, (len >> 8) & 255, len & 255)
  else {
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(len))
    head.push(m | 127, ...b)
  }
  if (!mask) return Buffer.concat([Buffer.from(head), data])
  const key = crypto.randomBytes(4)
  const out = Buffer.alloc(len)
  for (let i = 0; i < len; i += 1) out[i] = data[i] ^ key[i % 4]
  return Buffer.concat([Buffer.from(head), key, out])
}

/** Incremental frame parser: push(chunk) returns [{opcode, fin, payload}]. */
export class FrameParser {
  constructor() { this.buf = Buffer.alloc(0) }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out = []
    for (;;) {
      const b = this.buf
      if (b.length < 2) break
      const fin = Boolean(b[0] & 0x80)
      const opcode = b[0] & 0x0f
      const masked = Boolean(b[1] & 0x80)
      let len = b[1] & 0x7f
      let off = 2
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10 }
      if (len > MAX_MESSAGE) throw voiceErr('websocket frame too large', 'vendor', 502)
      const need = off + (masked ? 4 : 0) + len
      if (b.length < need) break
      let payload = b.slice(off + (masked ? 4 : 0), need)
      if (masked) {
        const key = b.slice(off, off + 4)
        const p = Buffer.alloc(len)
        for (let i = 0; i < len; i += 1) p[i] = payload[i] ^ key[i % 4]
        payload = p
      }
      out.push({ opcode, fin, payload })
      this.buf = b.slice(need)
    }
    return out
  }
}

/**
 * Open a WebSocket. Resolves when the handshake is done; rejects on a refused
 * upgrade (the status is kept: 401 -> bad_key) or a timeout/abort.
 * opts: { headers, timeout (ms for the handshake), signal, protocols }
 */
export function wsConnect(url, opts) {
  const o = opts || {}
  const u = url instanceof URL ? url : new URL(String(url))
  const secure = u.protocol === 'wss:' || u.protocol === 'https:'
  const mod = secure ? https : http
  const key = crypto.randomBytes(16).toString('base64')
  return new Promise((resolve, reject) => {
    const headers = Object.assign({
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
    }, o.headers || {})
    if (o.protocols) headers['Sec-WebSocket-Protocol'] = [].concat(o.protocols).join(', ')
    const req = mod.request({
      protocol: secure ? 'https:' : 'http:', host: u.hostname, port: u.port ? Number(u.port) : (secure ? 443 : 80),
      path: u.pathname + u.search, method: 'GET', headers, agent: false, timeout: o.timeout || 15000,
    })
    let done = false
    const fail = (e) => { if (!done) { done = true; reject(e) } }
    req.on('timeout', () => { req.destroy(voiceErr('websocket handshake timeout', 'timeout', 504)) })
    req.on('error', (e) => fail(e))
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const st = res.statusCode || 502
        const err = voiceErr('websocket upgrade refused (' + st + ')', st === 401 || st === 403 ? 'bad_key' : 'vendor', 502)
        err.upstreamStatus = st
        err.upstreamBody = Buffer.concat(chunks).toString('utf8').slice(0, 300)
        fail(err)
      })
    })
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) { socket.destroy(); return fail(voiceErr('websocket handshake failed', 'vendor', 502)) }
      done = true
      socket.setTimeout(0)
      const ee = new EventEmitter()
      const parser = new FrameParser()
      let frag = []
      let fragOp = 0
      let fragSize = 0
      let closed = false
      const finish = (code, reason) => { if (closed) return; closed = true; try { socket.destroy() } catch (e) { /* gone */ } ee.emit('close', code, reason) }
      const handle = (chunk) => {
        let frames
        try { frames = parser.push(chunk) } catch (e) { ee.emit('error', e); return finish(1009, 'too large') }
        for (const f of frames) {
          if (f.opcode === 9) { socket.write(encodeFrame(10, f.payload, true)); continue }
          if (f.opcode === 10) continue
          if (f.opcode === 8) {
            const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005
            const reason = f.payload.length > 2 ? f.payload.slice(2).toString('utf8') : ''
            if (!closed) { try { socket.write(encodeFrame(8, f.payload.slice(0, 2), true)) } catch (e) { /* gone */ } }
            return finish(code, reason)
          }
          if (f.opcode === 1 || f.opcode === 2) { frag = [f.payload]; fragOp = f.opcode; fragSize = f.payload.length }
          else if (f.opcode === 0) { frag.push(f.payload); fragSize += f.payload.length }
          if (fragSize > MAX_MESSAGE) { ee.emit('error', voiceErr('websocket message too large', 'vendor', 502)); return finish(1009, 'too large') }
          if (f.fin && frag.length) {
            const data = Buffer.concat(frag)
            frag = []
            ee.emit('message', fragOp === 1 ? data.toString('utf8') : data, fragOp === 2)
          }
        }
      }
      socket.on('data', handle)
      socket.on('error', (e) => { ee.emit('error', e); finish(1006, 'socket error') })
      socket.on('close', () => finish(1006, 'closed'))
      ee.sendText = (s) => { if (!closed) socket.write(encodeFrame(1, Buffer.from(String(s), 'utf8'), true)) }
      ee.sendBinary = (b) => { if (!closed) socket.write(encodeFrame(2, b, true)) }
      ee.close = (code) => {
        if (closed) return
        const p = Buffer.alloc(2)
        p.writeUInt16BE(code || 1000)
        try { socket.write(encodeFrame(8, p, true)) } catch (e) { /* gone */ }
        setTimeout(() => finish(code || 1000, 'closed'), 200).unref()
      }
      ee.terminate = () => finish(1006, 'terminated')
      ee.protocol = res.headers['sec-websocket-protocol'] || ''
      if (o.signal) {
        if (o.signal.aborted) ee.terminate()
        else o.signal.addEventListener('abort', () => ee.terminate(), { once: true })
      }
      resolve(ee)
      if (head && head.length) handle(head)
    })
    if (o.signal) {
      if (o.signal.aborted) { req.destroy(voiceErr('request aborted', 'timeout', 504)); return }
      o.signal.addEventListener('abort', () => req.destroy(voiceErr('request aborted', 'timeout', 504)), { once: true })
    }
    req.end()
  })
}

/**
 * Run a request/response style exchange: connect, call `onOpen(ws)` to send,
 * collect messages through `onMessage(data, isBinary, ws)` which returns a
 * value to finish with (anything other than undefined ends the exchange and
 * closes the socket). Rejects on error, on close before a result, or after
 * `timeout` ms. Returns the finishing value.
 */
export async function wsExchange(url, opts, onOpen, onMessage) {
  const o = opts || {}
  const ws = await wsConnect(url, o)
  return new Promise((resolve, reject) => {
    let over = false
    const end = (fn, v) => { if (over) return; over = true; clearTimeout(timer); try { ws.close() } catch (e) { /* gone */ } fn(v) }
    const timer = setTimeout(() => end(reject, voiceErr('websocket exchange timeout', 'timeout', 504)), o.exchangeTimeout || 60000)
    ws.on('message', (data, isBin) => {
      try {
        const r = onMessage(data, isBin, ws)
        if (r !== undefined) end(resolve, r)
      } catch (e) { end(reject, e) }
    })
    ws.on('error', (e) => end(reject, e))
    ws.on('close', () => end(reject, voiceErr('websocket closed before the result', 'vendor', 502)))
    try { onOpen(ws) } catch (e) { end(reject, e) }
  })
}
