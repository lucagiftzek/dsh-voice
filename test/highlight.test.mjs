// Phase 2 highlighting (pure parts): the alignment estimator, timelines, the DOM key mapping, auto-read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateWordTimings, activeIndex, positionAt, sentenceSpans, sentenceSeek, wordAtChar, wordsOf, PAUSE } from '../lib/shared/highlight/timeline.js'
import { buildKeyIndex, findKey, subKeyRange, keyRangeToNodes, keyOf } from '../lib/shared/highlight/domkey.js'
import { createAutoRead } from '../src/client/autoread.js'
import { charsToWords } from '../lib/server/alignment.js'

test('estimator: covers the duration, monotonic, one item per word', () => {
  const text = 'Hello there, my friend. This is a test.'
  const w = estimateWordTimings(text, 4)
  assert.equal(w.length, wordsOf(text).length)
  assert.equal(w[0].t0, 0)
  assert.ok(Math.abs(w[w.length - 1].t1 - 4) < 0.01)
  for (let i = 1; i < w.length; i += 1) assert.ok(w[i].t0 >= w[i - 1].t1 - 1e-9)
  assert.equal(text.slice(w[1].c0, w[1].c1), 'there,')
})

test('estimator: punctuation adds a pause, long words take longer', () => {
  const w = estimateWordTimings('aaaa, bbbb cccc. dddd', 10)
  const gap = (i) => w[i + 1].t0 - w[i].t1
  assert.ok(gap(0) > 0, 'comma pause')
  assert.equal(gap(1), 0)
  assert.ok(gap(2) > gap(0), 'a full stop pauses longer than a comma')
  assert.ok(Math.abs(gap(2) / gap(0) - PAUSE.stop / PAUSE.comma) < 0.01)
  const v = estimateWordTimings('a extraordinarily', 2)
  assert.ok((v[1].t1 - v[1].t0) > (v[0].t1 - v[0].t0) * 5)
  assert.deepEqual(estimateWordTimings('', 3), [])
  assert.deepEqual(estimateWordTimings('word', 0), [])
})

test('estimator: Greek and Italian letters count like Latin ones', () => {
  const w = estimateWordTimings('Γεια σας. Ciao a tutti.', 3)
  assert.equal(w.length, 5)
  assert.ok(w[0].t1 - w[0].t0 > w[3].t1 - w[3].t0)
})

test('activeIndex and positionAt follow the media clock (pause, seek back, speed)', () => {
  const text = 'One two three. Four five six.'
  const chunk = { text, words: estimateWordTimings(text, 3) }
  const seen = []
  // 1x, then a pause (same t three times), a seek back, then 2x speed (bigger steps).
  for (const t of [0, 0.4, 0.8, 0.8, 0.8, 0.2, 2.0, 2.5, 3.0]) {
    const p = positionAt(chunk, t)
    seen.push(text.slice(p.word.c0, p.word.c1).replace(/\W/g, '') + '|' + text.slice(p.sentence.c0, p.sentence.c1).split(' ')[0])
  }
  assert.equal(seen[2], seen[3])
  assert.equal(seen[3], seen[4])
  assert.ok(seen[5] < seen[4] || seen[5].startsWith('One'))
  assert.match(seen[6], /\|Four$/)
  assert.match(seen[8], /^six\|Four$/)
  assert.equal(activeIndex(chunk.words, -1), -1)
  assert.equal(positionAt(chunk, -1).sentence.c0, 0, 'before the first word the first sentence is lit')
})

test('sentenceSeek jumps to the next and previous sentence inside a chunk', () => {
  const text = 'One two three. Four five six. Seven eight.'
  const chunk = { text, words: estimateWordTimings(text, 6) }
  const s = sentenceSpans(text)
  assert.equal(s.length, 3)
  const t2 = sentenceSeek(chunk, 0.1, 1)
  assert.equal(text.slice(chunk.words[activeIndex(chunk.words, t2)].c0).startsWith('Four'), true)
  assert.equal(sentenceSeek(chunk, 5.9, 1), null, 'past the last sentence: the caller moves to the next chunk')
  const back = sentenceSeek(chunk, t2 + 0.2, -1)
  assert.equal(back, 0)
})

test('Web Speech boundaries map to words', () => {
  const text = 'Hello there friend'
  assert.deepEqual(wordAtChar(text, 6), { c0: 6, c1: 11 })
  assert.deepEqual(wordAtChar(text, 8), { c0: 6, c1: 11 })
  assert.deepEqual(wordAtChar(text, 0), { c0: 0, c1: 5 })
})

test('ElevenLabs character alignment becomes word items in the sent text', () => {
  const text = 'Hi you all'
  const chars = text.split('')
  const al = { characters: chars, character_start_times_seconds: chars.map((c, i) => i * 0.1), character_end_times_seconds: chars.map((c, i) => i * 0.1 + 0.1) }
  const w = charsToWords(text, al)
  assert.deepEqual(w.map((x) => text.slice(x.c0, x.c1)), ['Hi', 'you', 'all'])
  const chunk = { text, words: w }
  assert.equal(text.slice(positionAt(chunk, 0.45).word.c0, positionAt(chunk, 0.45).word.c1), 'you')
})

test('DOM key mapping: spoken markdown-free text finds rendered nodes', () => {
  // Rendered: "Hello " <b>"wörld"</b> ". Ναι, " <code>"ok"</code> " τέλος"
  const nodes = ['Hello ', 'wörld', '. Ναι, ', 'ok', ' τέλος']
  const idx = buildKeyIndex(nodes)
  const hit = findKey(idx, 'Hello wörld. Ναι, ok τέλος', 0)
  assert.deepEqual(hit, { k0: 0, k1: keyOf('Hello wörld. Ναι, ok τέλος').key.length })
  const word = subKeyRange('Hello wörld. Ναι, ok τέλος', hit.k0, 6, 11)
  assert.deepEqual(keyRangeToNodes(idx, word.k0, word.k1), [[1, 0], [1, 5]])
  const greek = subKeyRange('Hello wörld. Ναι, ok τέλος', hit.k0, 13, 16)
  assert.deepEqual(keyRangeToNodes(idx, greek.k0, greek.k1), [[2, 2], [2, 5]])
  // Final sigma and case fold
  assert.ok(findKey(buildKeyIndex(['ΤΕΛΟΣ']), 'τέλος', 0) === null, 'accents are kept, so a different word does not match')
  assert.ok(findKey(buildKeyIndex(['ΤΈΛΟΣ']), 'τέλος', 0))
  // Search continues forward from the cursor
  const twice = buildKeyIndex(['Yes. ', 'Yes.'])
  assert.equal(findKey(twice, 'Yes.', 3).k0, 3)
  assert.equal(subKeyRange('...', 0, 0, 3), null)
})

test('auto-read: history never reads, a new finished reply does, chat switch resets', () => {
  const ar = createAutoRead()
  const snap = (ids) => ({ legacy: { nodes: ids.map((id) => ({ kind: 'assistant', messageId: id })) } })
  ar.observe(snap(['a', 'b']))
  assert.equal(ar.take('b', 'new-replies'), false, 'already there when the chat opened')
  ar.observe(snap(['a', 'b', 'c']))
  assert.equal(ar.take('c', 'off'), false)
  assert.equal(ar.take('c', 'new-replies'), true)
  assert.equal(ar.take('c', 'new-replies'), false, 'once only')
  ar.observe(snap(['x']))
  assert.equal(ar.take('x', 'new-replies'), false, 'another chat: its history is the baseline')
  ar.observe(snap([]))
  ar.observe(snap(['n1']))
  assert.equal(ar.take('n1', 'new-replies'), true, 'first reply of a new chat')
})

test('auto-read: dictated mode needs a recent dictation and consumes it', () => {
  let t = 0
  const ar = createAutoRead({ now: () => t })
  const snap = (ids) => ({ legacy: { nodes: ids.map((id) => ({ kind: 'assistant', messageId: id })) } })
  ar.observe(snap(['a']))
  ar.observe(snap(['a', 'b']))
  assert.equal(ar.take('b', 'new-replies-when-dictated'), false)
  ar.markDictated()
  ar.observe(snap(['a', 'b', 'c']))
  assert.equal(ar.take('c', 'new-replies-when-dictated'), true)
  ar.observe(snap(['a', 'b', 'c', 'd']))
  assert.equal(ar.take('d', 'new-replies-when-dictated'), false, 'one reply per dictated prompt')
  ar.markDictated()
  t = 11 * 60 * 1000
  ar.observe(snap(['a', 'b', 'c', 'd', 'e']))
  assert.equal(ar.take('e', 'new-replies-when-dictated'), false, 'too long ago')
})
