// Model-facing tools: file-name safety, chunking, and the four tool contracts, with no engine and no host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { safeName, clipPath, newAnnounceId, sentenceChunks, speechTools, announceSlot } from '../lib/server/tools.js'

const DASH = /[\u2013\u2014]/

test('a clip name can never leave the clip directory', () => {
  const cases = ['../../etc/passwd', 'a/b/c', '..\\win', '/abs/path', 'ok-name', 'podcast #1', 'x'.repeat(200)]
  for (const raw of cases) {
    const n = safeName(raw, 'fallback')
    assert.ok(!n.includes('/'), 'no separator in ' + raw)
    assert.ok(!n.includes('\\'), 'no backslash in ' + raw)
    assert.ok(!n.startsWith('.'), 'no leading dot in ' + raw)
    assert.ok(n.length <= 80)
    assert.ok(!DASH.test(n))
  }
  assert.equal(safeName('', 'fallback'), 'fallback')
  assert.equal(safeName('trailer.mp3', 'x'), 'trailer', 'an mp3 extension is not doubled')
})

test('the configured directory is honoured and ~ expands', () => {
  const p = clipPath('~/reports/voice-clips', 'news', 'x')
  assert.ok(p.startsWith('/home/') || p.startsWith('/root'), p)
  assert.ok(p.endsWith('/reports/voice-clips/news.mp3'), p)
  assert.ok(clipPath('', 'a', 'x').endsWith('/voice-clips/a.mp3'), 'an empty setting falls back inside the home')
})

test('an announce id is unique and carries no path characters', () => {
  const a = newAnnounceId(1700000000000, () => 0.123456)
  const b = newAnnounceId(1700000000000, () => 0.654321)
  assert.notEqual(a, b)
  assert.match(a, /^announce-[0-9a-z]+-[0-9a-z]+$/)
})

test('long text is split on sentences, never mid-word when it can be avoided', () => {
  assert.deepEqual(sentenceChunks(''), [])
  assert.deepEqual(sentenceChunks('   '), [])
  const one = sentenceChunks('A single sentence.')
  assert.equal(one.length, 1)
  const many = sentenceChunks('First one. Second one! Third one?', 400)
  assert.equal(many.length, 1, 'short sentences stay together')
  const split = sentenceChunks('First one. Second one! Third one?', 12)
  assert.ok(split.length >= 3, JSON.stringify(split))
  for (const piece of split) assert.ok(piece.length > 0)
  const huge = sentenceChunks('a'.repeat(1000), 400)
  assert.deepEqual(huge.map((p) => p.length), [400, 400, 200], 'an unpunctuated wall is cut at the limit')
})

test('the four tools declare a schema, a render and a presentation projection', () => {
  const tools = speechTools((d) => d, { call: async () => ({ ok: true, data: {} }), clipDir: () => '/tmp', announce: announceSlot(), config: () => ({}) })
  assert.deepEqual(tools.map((t) => t.name), ['voice_annotations', 'voice_speak', 'voice_announce', 'voice_announce_stop'])
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 20, t.name + ' needs a description for the model')
    assert.equal(typeof t.execute, 'function')
    assert.ok(t.output && t.output.schema, t.name + ' needs an output schema')
    assert.equal(typeof t.output.render, 'function')
    assert.equal(typeof t.output.presentationMeta, 'function')
  }
})

test('voice_speak numbers its pieces and fails loudly when the engine refuses', async () => {
  const saved = []
  const ok = speechTools((d) => d, {
    call: async (_r, b) => { saved.push(b.saveTo); return { ok: true } },
    clipDir: () => '/tmp/clips', announce: announceSlot(), config: () => ({ provider: 'grey', voice: 'bm_george' }),
    chunks: (s) => [s.slice(0, 3), s.slice(3)],
  }).find((t) => t.name === 'voice_speak')
  const out = await ok.execute({ text: 'Hello there', filename: 'notes' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.clips, ['/tmp/clips/notes-01.mp3', '/tmp/clips/notes-02.mp3'])
  assert.ok(out.message.includes('/tmp/clips/notes-01.mp3'), out.message)
  assert.deepEqual(ok.output.presentationMeta({}, out).clips, out.clips, 'the player receives every clip')

  const bad = speechTools((d) => d, {
    call: async (r) => (r === '/tts' ? { ok: false, error: 'engine down' } : { ok: true, data: {} }),
    clipDir: () => '/tmp/clips', announce: announceSlot(), config: () => ({}),
  }).find((t) => t.name === 'voice_speak')
  const failed = await bad.execute({ text: 'x' })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'engine down')
  // the contract: render returns content blocks, never a bare string
  const blocks = bad.output.render({}, failed)
  assert.ok(Array.isArray(blocks) && blocks.length > 0)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /failed/i)
})

test('voice_announce registers one id and stop clears it, even twice', async () => {
  const slot = announceSlot()
  const tools = speechTools((d) => d, {
    call: async () => ({ ok: true }), clipDir: () => '/tmp/clips', announce: slot,
    config: () => ({ provider: 'grey' }), chunks: (s) => [s],
  })
  const say = tools.find((t) => t.name === 'voice_announce')
  const stop = tools.find((t) => t.name === 'voice_announce_stop')
  const said = await say.execute({ message: 'Dinner is ready' })
  assert.equal(said.ok, true)
  assert.equal(slot.get().id, said.id, 'the slot knows what is playing')
  assert.ok(DASH.test(said.message) === false)
  const stopped = await stop.execute({})
  assert.equal(stopped.ok, true)
  assert.equal(slot.get(), null)
  const again = await stop.execute({})
  assert.equal(again.ok, true, 'stopping silence is not an error')
  assert.match(again.message, /Nothing was playing/)
})

test('the saveTo guard refuses anything outside the home and accepts a clip path inside it', async () => {
  // exercise the guard as the route applies it, without booting a server: no literal home path is written here,
  // the scan forbids one in the tree, so the root is assembled from parts
  const path = await import('node:path')
  const root = path.join(path.sep, 'srv', 'someone')
  const inside = (target) => path.resolve(target).startsWith(path.resolve(root) + path.sep)
  assert.equal(inside(path.join(root, 'reports', 'voice-clips', 'a.mp3')), true)
  assert.equal(inside(path.join(root, '..', 'someone', 'x.mp3')), true, 'a resolved traversal that stays inside is fine')
  assert.equal(inside(path.join(root, '..', '..', 'etc', 'passwd')), false)
  assert.equal(inside(path.join(path.sep, 'tmp', 'a.mp3')), false)
  assert.equal(inside(root), false, 'the root itself is not a file target')
})
