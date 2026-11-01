import test from 'node:test'
import assert from 'node:assert/strict'
import { wsConnect, wsExchange, encodeFrame, FrameParser } from '../lib/server/ws.js'
import { mockWsServer } from './ws-helper.mjs'

test('ws: frame codec round-trips text, binary and a 70 KB payload, masked and unmasked', () => {
  for (const mask of [true, false]) {
    for (const size of [0, 5, 125, 126, 300, 70000]) {
      const p = Buffer.alloc(size, 7)
      const parser = new FrameParser()
      const half = encodeFrame(2, p, mask)
      const out = [].concat(parser.push(half.slice(0, 3)), parser.push(half.slice(3)))
      assert.equal(out.length, 1)
      assert.equal(out[0].opcode, 2)
      assert.deepEqual(out[0].payload, p)
    }
  }
})

test('ws: handshake with custom headers, text + binary both ways, server close', async () => {
  const m = await mockWsServer((c) => {
    c.on('message', (d, bin) => {
      if (bin) c.sendBinary(Buffer.concat([Buffer.from('echo:'), d]))
      else { c.sendText('got ' + d); c.close() }
    })
  })
  try {
    const ws = await wsConnect(m.origin + '/v1/x?token=abc', { headers: { 'Ocp-Apim-Subscription-Key': 'fake-k' } })
    const got = []
    ws.on('message', (d, bin) => got.push([bin, bin ? d.toString() : d]))
    const closed = new Promise((r) => ws.on('close', r))
    ws.sendBinary(Buffer.from('b1'))
    ws.sendText('hello')
    await closed
    assert.deepEqual(got, [[true, 'echo:b1'], [false, 'got hello']])
    assert.equal(m.reqs[0].path, '/v1/x')
    assert.equal(m.reqs[0].query, '?token=abc')
    assert.equal(m.reqs[0].headers['ocp-apim-subscription-key'], 'fake-k')
  } finally { await m.close() }
})

test('ws: refused upgrade rejects with bad_key on 401', async () => {
  const m = await mockWsServer()
  m.refuse = 401
  try { await assert.rejects(wsConnect(m.origin + '/x'), (e) => e.code === 'bad_key') } finally { await m.close() }
})

test('ws: wsExchange resolves with the finishing value and rejects on early close', async () => {
  const m = await mockWsServer((c) => { c.on('message', (d) => { c.sendText('a'); c.sendText('done:' + d) }) })
  try {
    const v = await wsExchange(m.origin + '/', {}, (ws) => ws.sendText('go'), (d) => (String(d).startsWith('done:') ? String(d) : undefined))
    assert.equal(v, 'done:go')
  } finally { await m.close() }
  const m2 = await mockWsServer((c) => { c.on('message', () => c.close()) })
  try {
    await assert.rejects(wsExchange(m2.origin + '/', {}, (ws) => ws.sendText('go'), () => undefined), (e) => e.code === 'vendor')
  } finally { await m2.close() }
})
