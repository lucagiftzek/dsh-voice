// Marker parser, sentence splitting and per-language segmentation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkers, stripMarkers, parseDirective, plainToSource, encodeMarkers, decodeMarkers, hideCommentMarkers, displayTokens } from '../lib/shared/lang/markers.js'
import { splitSentences, buildSegments, speakableProse, speakableCode } from '../lib/shared/lang/segment.js'
import { scriptLang, guessLangV1, setLatinScorer } from '../lib/shared/lang/detect.js'

test('directive grammar', () => {
  assert.deepEqual(parseDirective('/'), { kind: 'pop' })
  assert.deepEqual(parseDirective('el'), { kind: 'push', lang: 'el', opts: {} })
  assert.deepEqual(parseDirective('auto'), { kind: 'push', lang: null, opts: {} })
  assert.deepEqual(parseDirective('en-GB'), { kind: 'push', lang: 'en-GB', opts: {} })
  assert.deepEqual(parseDirective('el voice=el-GR-AthinaNeural provider=azure'), { kind: 'push', lang: 'el', opts: { voice: 'el-GR-AthinaNeural', provider: 'azure' } })
  assert.deepEqual(parseDirective('pause 600'), { kind: 'pause', ms: 600 })
  assert.equal(parseDirective('wiki links'), null)
  assert.equal(parseDirective('EL'), null)
  assert.equal(parseDirective('el color=red'), null)
  assert.equal(parseDirective('el speed=9'), null)
  assert.equal(parseDirective(''), null)
})

test('sticky switch, span with pop, auto', () => {
  const r = parseMarkers('One [[el]]Ένα [[it]]uno[[/]] δύο [[auto]]two')
  assert.equal(r.plain, 'One Ένα uno δύο two')
  assert.deepEqual(r.runs.map((x) => [x.text, x.lang]), [['One ', null], ['Ένα ', 'el'], ['uno', 'it'], [' δύο ', 'el'], ['two', null]])
  assert.equal(r.hadMarkers, true)
})

test('pop on an empty stack is harmless; unclosed marker is sticky', () => {
  assert.deepEqual(parseMarkers('a[[/]]b').runs.map((x) => [x.text, x.lang]), [['ab', null]])
  assert.deepEqual(parseMarkers('[[it]]ciao a tutti').runs.map((x) => x.lang), ['it'])
})

test('HTML comment form is invisible and equivalent', () => {
  const r = parseMarkers('Hi <!--lang:el-->Γεια<!--lang:/--> there')
  assert.equal(r.plain, 'Hi Γεια there')
  assert.deepEqual(r.runs.map((x) => x.lang), [null, 'el', null])
  assert.equal(hideCommentMarkers('a<!--lang:el-->b[[it]]c'), 'ab[[it]]c')
  assert.equal(parseMarkers('<!-- a normal comment -->').plain, '<!-- a normal comment -->')
})

test('escape, wiki links, code fences and inline code stay text', () => {
  assert.equal(stripMarkers('literal \\[[el]] here'), 'literal [[el]] here')
  assert.equal(stripMarkers('see [[wiki link]]'), 'see [[wiki link]]')
  assert.equal(stripMarkers('```\n[[el]]\n``` and `[[it]]`'), '```\n[[el]]\n``` and `[[it]]`')
  assert.equal(parseMarkers('```\n[[el]]x\n```').hadMarkers, false)
})

test('pause and per-span options', () => {
  const r = parseMarkers('a [[pause 500]]b [[en provider=mistral voice=gb_jane_x]]c[[/]]')
  const b = r.runs.find((x) => x.text.startsWith('b'))
  assert.equal(b.pauseBeforeMs, 500)
  const c = r.runs.find((x) => x.text === 'c')
  assert.equal(c.provider, 'mistral')
  assert.equal(c.voice, 'gb_jane_x')
})

test('offset map converts plain offsets back to the source', () => {
  const src = 'ab[[el]]cd[[/]]ef'
  const r = parseMarkers(src)
  assert.equal(r.plain, 'abcdef')
  assert.equal(src[plainToSource(r.map, 2)], 'c')
  assert.equal(src[plainToSource(r.map, 4)], 'e')
})

test('encode/decode survives a markdown transform', () => {
  const enc = encodeMarkers('**Bold** [[it]]*ciao*[[/]] end')
  const prose = speakableProse(enc.text)
  const runs = decodeMarkers(prose.text, enc.directives)
  assert.deepEqual(runs.map((x) => [x.text, x.lang]), [['Bold ', null], ['ciao', 'it'], [' end', null]])
})

test('display tokens show chips', () => {
  assert.deepEqual(displayTokens('a[[el]]b[[/]]').map((t) => t.type + ':' + (t.lang || t.text)), ['text:a', 'chip:el', 'text:b', 'chip:/'])
})

test('Greek question mark and ano teleia', () => {
  assert.deepEqual(splitSentences('Τι κάνεις; Καλά· ευχαριστώ. Εσύ\u037E Ναι'), ['Τι κάνεις; ', 'Καλά· ευχαριστώ. ', 'Εσύ\u037E ', 'Ναι'])
  // ';' after Latin text is a semicolon, not a stop
  assert.deepEqual(splitSentences('one; two. Three'), ['one; two. ', 'Three'])
})

test('abbreviations, decimals and lowercase continuations do not split', () => {
  assert.deepEqual(splitSentences('Dr. Smith paid 3.5 euros, e.g. today. Then left.'), ['Dr. Smith paid 3.5 euros, e.g. today. ', 'Then left.'])
  assert.deepEqual(splitSentences('Il dott. Rossi è qui. Bene!'), ['Il dott. Rossi è qui. ', 'Bene!'])
  assert.deepEqual(splitSentences('Ο κ. Παπαδόπουλος ήρθε. Ναι.'), ['Ο κ. Παπαδόπουλος ήρθε. ', 'Ναι.'])
  assert.equal(splitSentences('a b c\nd e').length, 2)
  assert.equal(splitSentences('x. y? z!').join(''), 'x. y? z!')
})

test('script detection', () => {
  assert.equal(scriptLang('Καλημέρα σας').lang, 'el')
  assert.equal(scriptLang('Hello there'), null)
  assert.equal(scriptLang('Привет').lang, 'ru')
  assert.equal(guessLangV1('Bonjour, vous êtes là'), 'fr')
  assert.equal(guessLangV1('plain english'), 'en')
  assert.equal(guessLangV1('mixed Γεια'), 'el')
})

test('segments: single-language English message is one segment (1.x parity)', () => {
  const md = '# Title\n\nThis is **one** answer. It has two sentences.'
  const { segments } = buildSegments(md)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].lang, 'en')
  assert.equal(segments[0].text, speakableProse(md).text)
})

test('segments: per-sentence split of English and Greek, short sentence smoothed', () => {
  const { segments } = buildSegments('This is an English sentence here. Αυτή είναι μια ελληνική πρόταση εδώ. OK. Back to English for a while.')
  assert.deepEqual(segments.map((s) => s.lang), ['en', 'el', 'en'])
  assert.match(segments[1].text, /OK\.$/)
})

test('segments: [[el]]...[[/]] routes the span to Greek, markers stripped before TTS', () => {
  const { segments } = buildSegments('Say [[el]]καλημέρα[[/]] to everyone in the room please.')
  assert.equal(segments.find((s) => s.lang === 'el').text, 'καλημέρα')
  assert.ok(segments.every((s) => !s.text.includes('[[')))
  assert.deepEqual(segments.map((s) => s.lang), ['en', 'el', 'en'])
  assert.equal(segments.find((s) => s.lang === 'el').source, 'marker')
})

test('segments: Italian marker span inside English, fragment before the marker stays English', () => {
  const { segments } = buildSegments('And then [[it]]una frase italiana[[/]] done now.')
  assert.deepEqual(segments.map((s) => [s.lang, s.text]), [['en', 'And then'], ['it', 'una frase italiana'], ['en', 'done now.']])
})

test('segments: detection off reproduces 1.x (one language per message)', () => {
  const { segments } = buildSegments('English sentence one here. Ελληνική πρόταση εδώ.', { detection: 'off' })
  assert.equal(segments.length, 1)
  assert.equal(segments[0].lang, 'el')
})

test('segments: manual language forces unmarked text, markers still win', () => {
  const { segments } = buildSegments('Ciao a tutti voi. [[el]]Γεια[[/]]', { defaultLang: 'it' })
  assert.deepEqual(segments.map((s) => s.lang), ['it', 'el'])
})

test('segments: code blocks skipped in prose, read by the code button, markers in code ignored', () => {
  const md = 'Look:\n```js\nconst a = "[[el]]"\n```\nDone here now.'
  const b = buildSegments(md)
  assert.equal(b.codeBlocks, 1)
  assert.ok(b.segments.map((s) => s.text).join(' ').includes('(code block skipped)'))
  assert.ok(b.segments.every((s) => s.lang === 'en'))
  assert.equal(speakableCode(md), 'Code block 1, js. const a = "[[el]]"')
  assert.equal(buildSegments(md, { code: true }).segments[0].text, 'Code block 1, js. const a = "[[el]]"')
})

test('segments: pause marker becomes pauseBeforeMs', () => {
  const { segments } = buildSegments('First part here now. [[pause 700]]Second part here now.')
  assert.equal(segments[1].pauseBeforeMs, 700)
})

test('segments: markers disabled leaves the text untouched', () => {
  const { segments } = buildSegments('Hello [[el]] there friend of mine', { markers: false })
  assert.equal(segments[0].text, 'Hello [[el]] there friend of mine')
})

test('phase 2 hook: a Latin scorer refines unmarked sentences', () => {
  setLatinScorer((s) => (/\b(che|una|della)\b/.test(s) ? { lang: 'it', conf: 0.9 } : null))
  try {
    const { segments } = buildSegments('This is an English sentence. Questa è una frase che parla italiano.')
    assert.deepEqual(segments.map((s) => s.lang), ['en', 'it'])
  } finally { setLatinScorer(null) }
})
