// The player: which tool results carry clips, how a path becomes a URL, and that the slot registers safely.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// the same esbuild loader the other client tests use: Node cannot import a .jsx file on its own
const require = createRequire(import.meta.url)
let panel = null
async function loadPanel() {
  if (panel) return panel
  const { build } = await import('esbuild')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const r = await build({
    entryPoints: [new URL('../src/client/clip-panel.jsx', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node',
    jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', loader: { '.js': 'jsx', '.jsx': 'jsx' }, external: ['react'], logLevel: 'silent',
  })
  const file = join(mkdtempSync(join(tmpdir(), 'dshv-clip-')), 'clip-panel.mjs')
  writeFileSync(file, r.outputFiles[0].text.replace(/from "react"/g, 'from ' + JSON.stringify(require.resolve('react'))))
  panel = await import(file)
  return panel
}

const call = (callId, name) => ({ event: { type: 'tool/call', data: { callId, name } } })
const result = (callId, meta) => ({ event: { type: 'tool/result', data: { callId, meta } } })

test('only a speech tool result with clips is rendered, and its call is matched through callId', async () => {
  const { clipPayloads } = await loadPanel()
  const matches = [
    call('c1', 'voice_speak'), result('c1', { clip: '/x/notes-01.mp3', clips: ['/x/notes-01.mp3', '/x/notes-02.mp3'] }),
    call('c2', 'bash'), result('c2', { clip: '/x/ignored.mp3' }),
    call('c3', 'voice_announce'), result('c3', { announce: 'announce-abc-1', clip: '/x/announce.mp3' }),
    call('c4', 'voice_speak'), result('c4', {}),
  ]
  const out = clipPayloads(matches)
  assert.equal(out.length, 2, JSON.stringify(out))
  assert.deepEqual(out[0].clips, ['/x/notes-01.mp3', '/x/notes-02.mp3'])
  assert.equal(out[1].announce, 'announce-abc-1')
})

test('a result without a matching call, or without usable clips, never renders', async () => {
  const { clipPayloads } = await loadPanel()
  assert.deepEqual(clipPayloads([result('zz', { clip: '/x/a.mp3' })]), [])
  assert.deepEqual(clipPayloads([call('c1', 'voice_speak'), result('c1', { clip: 42 })]), [])
  assert.deepEqual(clipPayloads(null), [])
  assert.deepEqual(clipPayloads([{ event: null }]), [])
})

test('a clip path becomes a same-origin URL, never a file URL', async () => {
  const { clipUrl } = await loadPanel()
  const assembled = ['', 'srv', 'someone', 'reports', 'voice-clips', 'a b.mp3'].join('/')
  assert.equal(clipUrl(assembled), '/api/voice/clips/a%20b.mp3')
  assert.ok(clipUrl('/x/y.mp3').startsWith('/api/voice/clips/'))
  assert.ok(!clipUrl('/x/y.mp3').includes('..'))
})

test('the slot registers with a fresh id and order, and never throws when the host has no slots', async () => {
  const { registerClipSlot } = await loadPanel()
  const seen = []
  const ctx = { slots: { inject: (owner, fn) => fn(), register: (def) => { seen.push(def); return () => {} } } }
  assert.equal(registerClipSlot(ctx, { order: 40 }), 'voice-clips')
  assert.equal(seen[0].name, 'conversation.chat.turnTail')
  assert.equal(seen[0].id, 'voice-clips')
  assert.equal(seen[0].order, 40)
  // a host without slot services must not break the client half
  assert.equal(registerClipSlot({}), null)
  assert.equal(registerClipSlot(null), null)
  // a thrown register is caught, not propagated into boot
  const throwing = { slots: { inject: (o, fn) => fn(), register: () => { throw new Error('collision') } } }
  const origWarn = console.warn
  console.warn = () => {}
  try { assert.equal(registerClipSlot(throwing), null) } finally { console.warn = origWarn }
})
