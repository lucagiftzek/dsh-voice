// Speech annotations: one in-text syntax, adapted per model family, removed when a model cannot use it.
// Every rule quoted in the adaptation table was read from the vendor's own documentation on 2026-11-25.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TONES, PACES, PITCHES, VOLUMES, SOUNDS, PAUSE_MS, ADAPTATION,
  parseAnnotation, normalizePace, normalizePitch, normalizeVolume, emphasisSpans, parts, listAnnotations,
  adaptationFor, annotationInfo, tagMenu, nativeTag, applyAnnotations, buildInstructions, toSsml, stripAnnotations, mechanismFor,
} from '../lib/shared/annotations.js'

const DASH = /[\u2013\u2014]/
const fam = (family) => {
  const ids = {
    voxtral: 'mistralai/voxtral-mini-tts-3-0', elevenlabs: 'elevenlabs/eleven-v3', gemini: 'google/gemini-3.8-flash-tts',
    heygen: 'heygen/heygen-voice-1', fish: 'fish-audio/s2.1-pro', fish_s1: 'fish-audio/s1', orpheus: 'canopylabs/orpheus-3b-0.1-ft',
    openai: 'openai/gpt-4o-mini-tts', openai_legacy: 'tts-1', kokoro: 'hexgrad/kokoro-82m',
  }
  return adaptationFor('openrouter', ids[family], 'or')
}

test('syntax: one plain form parses into the canonical kinds', () => {
  assert.deepEqual(parseAnnotation('tone=happy'), { kind: 'tone', value: 'happy', strength: '' })
  assert.deepEqual(parseAnnotation('emotion=warm'), { kind: 'tone', value: 'warm', strength: '' })
  assert.deepEqual(parseAnnotation('slightly sad'), { kind: 'tone', value: 'sad', strength: 'slight' })
  assert.deepEqual(parseAnnotation('very excited'), { kind: 'tone', value: 'excited', strength: 'strong' })
  assert.deepEqual(parseAnnotation('pace=slow'), { kind: 'pace', value: 'slow', strength: '' })
  assert.deepEqual(parseAnnotation('rate=very fast'), { kind: 'pace', value: 'very-fast', strength: '' })
  assert.deepEqual(parseAnnotation('pitch=high'), { kind: 'pitch', value: 'high', strength: '' })
  assert.deepEqual(parseAnnotation('pitch=lower'), { kind: 'pitch', value: 'low', strength: '' }, 'lower is the low step')
  assert.deepEqual(parseAnnotation('volume=soft'), { kind: 'volume', value: 'soft', strength: '' }, 'soft is a documented volume value of its own')
  assert.deepEqual(parseAnnotation('shout'), { kind: 'volume', value: 'shout', strength: '' })
  assert.deepEqual(parseAnnotation('emphasis'), { kind: 'emphasis' })
  assert.deepEqual(parseAnnotation('laugh'), { kind: 'sound', value: 'laugh', strength: '' })
  assert.deepEqual(parseAnnotation('laughs'), { kind: 'sound', value: 'laugh', strength: '' }, 'a plural is the same sound')
  assert.deepEqual(parseAnnotation('throat clearing'), { kind: 'sound', value: 'throat clearing', strength: '' })
  assert.deepEqual(parseAnnotation('long pause'), { kind: 'sound', value: 'long pause', strength: '' })
  // everything else is text: link markers, citations, section labels keep their brackets and are spoken
  for (const t of ['1', '2', 'Section 4', 'wiki', 'el', '/', 'photo of a cat', '', 'x'.repeat(130)]) {
    assert.equal(parseAnnotation(t).kind, null, JSON.stringify(t) + ' is not an annotation')
  }
  assert.equal(parseAnnotation('emotion=').kind, null, 'a key with no value is not an annotation')
  assert.equal(parseAnnotation('pace=sideways').kind, null, 'an unknown pace value is not an annotation')
  assert.equal(normalizePace('Very Slow'), 'very-slow')
  assert.equal(normalizePitch('down'), 'down', 'a documented step is kept as is')
  assert.equal(normalizePitch('lower'), 'low')
  assert.equal(normalizeVolume('whispering'), 'quiet')
})

test('the vocabularies contain no dash characters and no duplicates', () => {
  for (const [name, list] of Object.entries({ TONES, PACES, PITCHES, VOLUMES, SOUNDS })) {
    assert.equal(new Set(list).size, list.length, name + ' has duplicates')
    for (const x of list) assert.ok(!DASH.test(x), name + ' entry has a dash: ' + x)
  }
  for (const [k, ms] of Object.entries(PAUSE_MS)) assert.ok(ms >= 100 && ms <= 2000, k)
})

test('emphasis is stress, not markup: **text** and __text__ mark a run', () => {
  assert.deepEqual(emphasisSpans('a **b c** d'), [{ from: 4, to: 7 }])
  assert.deepEqual(emphasisSpans('__x__ and **y**'), [{ from: 2, to: 3 }, { from: 12, to: 13 }])
  const ps = parts('one **two** three')
  const text = ps.filter((p) => p.kind === 'text').map((p) => p.text).join('')
  assert.equal(text, 'one **two** three', 'parts keep the original text so offsets hold')
  const run = parts('one **two** three').filter((p) => p.kind === 'text').find((p) => p.text.includes('two'))
  assert.equal(run.stress, true, 'the text that stands inside ** ** is marked as stressed')
  assert.deepEqual(listAnnotations('[laugh] a [1] b [[el]] c').map((x) => x.inner), ['laugh'])
})

test('every family resolves from the model id, through OpenRouter too', () => {
  assert.equal(fam('voxtral').family, 'voxtral')
  assert.equal(adaptationFor('mistral', 'voxtral-mini-tts-2603', 'mistral').family, 'mute', 'the older Voxtral takes no tags')
  assert.equal(fam('elevenlabs').family, 'elevenlabs')
  assert.equal(adaptationFor('elevenlabs', 'eleven_multilingual_v2', 'elevenlabs').family, 'mute', 'tag models only')
  assert.equal(fam('gemini').family, 'gemini')
  assert.equal(fam('heygen').family, 'heygen')
  assert.equal(fam('fish').family, 'fish')
  assert.equal(fam('fish_s1').family, 'fish_s1')
  assert.equal(fam('orpheus').family, 'orpheus')
  assert.equal(fam('openai').family, 'openai')
  assert.equal(fam('openai_legacy').family, 'openai_legacy')
  assert.equal(fam('kokoro').family, 'kokoro')
  assert.equal(adaptationFor('azure', '', 'az').family, 'ssml')
  assert.equal(adaptationFor('amazon', '', 'amazon').family, 'ssml')
  assert.equal(adaptationFor('google', '', 'google').family, 'mute', 'Google Cloud /v1 takes plain text')
  assert.equal(adaptationFor('openrouter', 'some/unknown-model', 'or').family, 'mute')
  assert.equal(mechanismFor('azure', '', 'az'), 'ssml')
  assert.equal(mechanismFor('openrouter', 'openai/gpt-4o-mini-tts', 'or'), 'instructions')
  assert.equal(mechanismFor('openrouter', 'mistralai/voxtral-mini-tts-3-0', 'or'), 'tags')
  assert.equal(mechanismFor('openrouter', 'hexgrad/kokoro-82m', 'or'), 'none')
})

test('the adaptation table is documented: a verification note per family, no dash characters', () => {
  for (const [k, a] of Object.entries(ADAPTATION)) {
    assert.ok(a.label && a.channels, k)
    assert.ok(a.verification && a.verification.length > 60, k + ' needs its source')
    assert.ok(!DASH.test(JSON.stringify(a)), k + ' has a dash character')
    for (const c of Object.keys(a.channels)) assert.ok(['tone', 'pace', 'pitch', 'volume', 'emphasis', 'sounds'].includes(c), k + ' channel ' + c)
  }
})

test('native tags follow each vendor syntax exactly', () => {
  const v = fam('voxtral')
  assert.deepEqual(nativeTag(v, { kind: 'tone', value: 'happy' }), '[emotion=happy]')
  assert.equal(nativeTag(v, { kind: 'tone', value: 'cheerful' }), '', 'not one of the 34 documented emotions')
  assert.equal(nativeTag(v, { kind: 'pace', value: 'very-fast' }), '[pace=very-fast]')
  assert.equal(nativeTag(v, { kind: 'sound', value: 'laugh' }), '[laugh]')
  assert.equal(nativeTag(v, { kind: 'pitch', value: 'high' }), '', 'Voxtral has no pitch tag')
  assert.equal(nativeTag(v, { kind: 'sound', value: 'pause' }), '', 'a pause is a silence, not a tag')

  const h = fam('heygen')
  assert.equal(nativeTag(h, { kind: 'tone', value: 'sad', strength: 'slight' }), '[slightly sad]', 'intensity is part of the tag')
  assert.equal(nativeTag(h, { kind: 'tone', value: 'sad', strength: 'strong' }), '[extremely sad]', 'only slightly and extremely are tags')
  assert.equal(nativeTag(h, { kind: 'sound', value: 'laugh' }), '[laughs]')
  assert.equal(nativeTag(h, { kind: 'pitch', value: 'high' }), '[high voice]')

  const g = fam('gemini')
  assert.equal(nativeTag(g, { kind: 'sound', value: 'laugh' }), '<laugh>', 'Gemini bursts are angle brackets')
  assert.equal(nativeTag(g, { kind: 'sound', value: 'pause' }), '', 'a silence is always a real pause, on any model')

  const e = fam('elevenlabs')
  assert.equal(nativeTag(e, { kind: 'sound', value: 'laugh' }), '[laughs]')
  assert.equal(nativeTag(e, { kind: 'volume', value: 'quiet' }), '[whispering]')
  assert.equal(nativeTag(e, { kind: 'pace', value: 'slow' }), '[slowly]')

  const f = fam('fish')
  assert.equal(nativeTag(f, { kind: 'tone', value: 'excited', strength: 'strong' }), '[very excited]', 'S2 takes free descriptions')
  assert.equal(nativeTag(f, { kind: 'emphasis', value: '' }), '[emphasis]')

  assert.equal(nativeTag(fam('fish_s1'), { kind: 'tone', value: 'happy' }), '(happy)', 'S1 uses parentheses')
  assert.equal(nativeTag(fam('fish_s1'), { kind: 'pace', value: 'slow' }), '', 'S1 has no pace tag')
  assert.equal(nativeTag(fam('orpheus'), { kind: 'sound', value: 'sigh' }), '<sigh>')
  assert.equal(nativeTag(fam('orpheus'), { kind: 'tone', value: 'happy' }), '', 'Orpheus documents sound tags only')
  assert.equal(nativeTag(fam('openai'), { kind: 'tone', value: 'whispering' }), '[whispering]', 'measured: gpt-4o-mini-tts performs it')
  assert.equal(nativeTag(fam('openai_legacy'), { kind: 'tone', value: 'happy' }), '', 'tts-1 takes nothing')
})

test('applyAnnotations: a model with tags gets them, the words alone are the spoken text', () => {
  const text = '[tone=happy] Hello there. This is **very** good. [1] and [[el]] Greek.'
  const r = applyAnnotations(text, { adaptation: fam('voxtral') })
  assert.equal(r.text, '[emotion=happy]Hello there. This is very good. [1] and [[el]] Greek.')
  assert.equal(r.spoken, 'Hello there. This is very good. [1] and [[el]] Greek.')
  assert.equal(r.instructions, '')
  assert.equal(r.had, 1)
  assert.equal(r.used, 1)
  assert.equal(r.dropped, 0)
  // offsets: what the person sees maps onto what is spoken, and back
  const at = text.indexOf('there')
  assert.deepEqual(r.map(at, at + 5).map(([a, b]) => r.spoken.slice(a, b)), ['there'])
  const sp = r.spoken.indexOf('there')
  assert.deepEqual(r.unmap(sp, sp + 5).map(([a, b]) => text.slice(a, b)), ['there'])
})

test('applyAnnotations: a model without tags gets the words only, and every annotation is dropped', () => {
  const text = '[tone=happy] Hello [laugh] there [pace=slow] now.'
  const r = applyAnnotations(text, { adaptation: fam('mute') })
  assert.equal(r.spoken, 'Hello there now.', 'removed tags leave no double space')
  assert.equal(r.dropped, 3)
  assert.equal(r.used, 0)
  assert.equal(r.text, r.spoken)
})

test('applyAnnotations: instructions are built from the annotations for the models that take them', () => {
  const r = applyAnnotations('[tone=warm] [pace=slow] [pitch=high] [volume=soft] Hello.', { adaptation: fam('gemini') })
  assert.equal(r.instructions, 'Speak in a warm tone, speaking slowly, with a higher pitch, at a soft volume.')
  assert.equal(buildInstructions('[laugh] no control', fam('gemini')), '')
  assert.equal(buildInstructions('[tone=happy] x', fam('voxtral')), '', 'Voxtral has no instructions channel')
})

test('applyAnnotations: pauses become a real silence where the model has no pause tag', () => {
  const r = applyAnnotations('One. [pause] Two.', { adaptation: fam('mute') })
  assert.equal(r.spoken, 'One. Two.')
  assert.deepEqual(r.pauses, [{ at: 6, ms: PAUSE_MS.pause }], 'the silence lands where the next word begins')
  const h = applyAnnotations('One. [pause] Two.', { adaptation: fam('heygen') })
  assert.equal(h.text, 'One. Two.', 'the removed annotation leaves one space, not two')
  assert.deepEqual(h.pauses, [{ at: 6, ms: PAUSE_MS.pause }], 'the silence is a real gap on HeyGen too')
  const st = applyAnnotations('Hold. [long pause] Go on.', { adaptation: fam('gemini') })
  assert.equal(st.spoken, 'Hold. Go on.')
  assert.deepEqual(st.pauses, [{ at: 7, ms: PAUSE_MS['long pause'] }], 'a pause is a real silence on every model, just after the space it left')
})

test('SSML: prosody rate, pitch and volume close and reopen around a change, breaks for pauses', () => {
  const a = adaptationFor('amazon', '', 'amazon')
  const r = applyAnnotations('Plain. [pace=fast] Fast. [pitch=high] [volume=loud] High and loud. [pause] Done.', { adaptation: a })
  assert.match(r.text, /^<speak>/)
  assert.match(r.text, /<prosody rate="\+15%">/)
  assert.match(r.text, /pitch="\+12st"/)
  assert.match(r.text, /volume="\+6dB"/)
  assert.match(r.text, /<break time="450ms"\/>/)
  assert.equal(r.spoken, 'Plain. Fast. High and loud. Done.')
  assert.ok(!/[<>]/.test(r.spoken), 'the spoken text carries no markup')
  const emph = toSsml('Keep **this** now', a)
  assert.match(emph, /<emphasis level="strong">this<\/emphasis>/)
  assert.ok(!/[\u2013\u2014]/.test(r.text))
})

test('a code read ignores annotations: no tag is ever sent as code', () => {
  const r = applyAnnotations('[tone=happy] x = 1;', { adaptation: fam('voxtral'), script: true })
  assert.equal(r.text, 'x = 1;')
  assert.equal(r.used, 0)
})

test('the menu offers only what the model can take, and the info line says what it is', () => {
  const menu = tagMenu(fam('voxtral'))
  const groups = menu.groups.map((g) => g.group)
  assert.deepEqual(groups, ['Tone', 'Pace', 'Sounds and pauses', 'Strength'])
  assert.ok(menu.groups[0].items.includes('[tone=happy]'))
  assert.ok(menu.groups[2].items.includes('[pause]'))
  const info = annotationInfo(fam('gemini'))
  assert.equal(info.family, 'gemini')
  assert.match(info.mechanism, /native tags/)
  assert.match(info.mechanism, /instructions/)
  assert.match(info.summary, /pitch/)
  const mute = annotationInfo(fam('mute'))
  assert.equal(mute.summary, 'none: annotations are removed')
  assert.equal(tagMenu(fam('mute')).groups.length, 0)
})

test('stripAnnotations is the plain-speech path for callers that do not highlight', () => {
  assert.equal(stripAnnotations('[tone=happy] Ciao [laugh] a tutti.', 'mistral', 'voxtral-mini-tts-2603', 'mistral'), ' Ciao a tutti.'.replace(/^ /, ''))
})