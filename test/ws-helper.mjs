// A mock WebSocket vendor for tests, built on the same frame codec as lib/server/ws.js.
// const m = await mockWsServer((conn, req) => { conn.on('message', (data, isBinary) => ...); conn.sendText('x') })
// m.reqs records every upgrade request ({url, path, query, headers}). m.refuse = status makes the upgrade fail.
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { acceptKey, encodeFrame, FrameParser } from '../lib/server/ws.js'

export async function mockWsServer(onConn) {
  const m = { reqs: [], conns: [], refuse: 0, onConn }
  m.server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  m.server.on('upgrade', (req, socket) => {
    const u = new URL(req.url, 'http://x')
    const r = { url: req.url, path: u.pathname, query: u.search, headers: req.headers }
    m.reqs.push(r)
    if (m.refuse) { socket.end('HTTP/1.1 ' + m.refuse + ' Refused\r\nContent-Length: 0\r\n\r\n'); return }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey(req.headers['sec-websocket-key']) + '\r\n\r\n')
    const conn = new EventEmitter()
    const parser = new FrameParser()
    conn.sendText = (s) => socket.write(encodeFrame(1, Buffer.from(String(s), 'utf8'), false))
    conn.sendBinary = (b) => socket.write(encodeFrame(2, b, false))
    conn.close = () => { try { socket.write(encodeFrame(8, Buffer.from([3, 232]), false)); socket.end() } catch (e) { /* gone */ } }
    let frag = []
    let fragOp = 0
    socket.on('data', (chunk) => {
      for (const f of parser.push(chunk)) {
        if (f.opcode === 8) { try { socket.end() } catch (e) { /* gone */ } continue }
        if (f.opcode === 9) { socket.write(encodeFrame(10, f.payload, false)); continue }
        if (f.opcode === 1 || f.opcode === 2) { frag = [f.payload]; fragOp = f.opcode } else if (f.opcode === 0) frag.push(f.payload)
        if (f.fin && frag.length) { const d = Buffer.concat(frag); frag = []; conn.emit('message', fragOp === 1 ? d.toString('utf8') : d, fragOp === 2) }
      }
    })
    socket.on('error', () => {})
    m.conns.push(conn)
    if (m.onConn) m.onConn(conn, r)
  })
  await new Promise((resolve) => m.server.listen(0, '127.0.0.1', resolve))
  m.port = m.server.address().port
  m.origin = 'ws://127.0.0.1:' + m.port
  m.close = () => new Promise((resolve) => { m.server.closeAllConnections && m.server.closeAllConnections(); m.server.close(() => resolve()) })
  return m
}
