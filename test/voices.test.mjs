// Voice facets and presets: a voice id read into language, accent and tone; the picker's groups; the starred
// presets. Every rule is data, so these tests pin the ids real providers publish (measured on /config).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  facetsOf, facetOptions, filterVoices, groupVoices, HIDDEN_PROVIDERS,
  presetKey, isPresetOf, togglePreset, presetsFor, presetLabel,
} from '../src/client/voices.js'

const DASH = /[\u2013\u2014]/

test('the ids real providers publish read into the facets a person needs', () => {
  const f = (id, extra) => facetsOf(id, Object.assign({ langs: ['en'] }, extra || {}))
  const g = (id) => facetsOf(id, { langs: [] })
  // Voxtral: language_accent, a name, and the tone sold with that voice
  assert.deepEqual([f('gb_oliver_sad').language, f('gb_oliver_sad').accent, f('gb_oliver_sad').name, f('gb_oliver_sad').tone], ['English', 'British', 'Oliver', 'Sad'])
  assert.deepEqual([f('en_paul_neutral').language, f('en_paul_neutral').accent, f('en_paul_neutral').tone], ['English', '', 'Neutral'], 'the language own accent carries no label')
  assert.deepEqual([f('fr_marie_happy').language, f('fr_marie_happy').tone], ['French', 'Happy'])
  // Kokoro: language letter, gender letter, name; the British voices say so
  assert.deepEqual([g('bm_george').name, g('bm_george').accent, g('bm_george').gender], ['George', 'British', 'Male'])
  assert.deepEqual([g('af_heart').name, g('af_heart').accent], ['Heart', 'American'])
  assert.deepEqual([g('if_sara').language, g('if_sara').name], ['Italian', 'Sara'])
  // Azure, MAI, Deepgram and the plain names
  assert.deepEqual([f('en-US-JennyNeural').language, f('en-US-JennyNeural').accent, f('en-US-JennyNeural').name], ['English', 'American', 'Jenny'])
  assert.deepEqual([f('it-IT-Luca:MAI-Voice-2.1', { model: 'microsoft/mai-voice-2.1' }).language, f('it-IT-Luca:MAI-Voice-2.1').name], ['Italian', 'Luca'])
  assert.deepEqual([f('aura-2-cesare-it', { model: 'deepgram/aura-2' }).language, f('aura-2-cesare-it', { model: 'deepgram/aura-2' }).name], ['Italian', 'Cesare'])
  assert.equal(f('marin', { provider: 'openai' }).name, 'Marin')
  assert.equal(f('voice_482').name, 'Voice 482')
  assert.equal(f('voice_482', { langs: [] }).language, 'Any language', 'a number says nothing about itself when nothing is published')
  assert.equal(f('voice_482', { label: 'Oliver' }).name, 'Oliver', 'with the model default voice it takes its name')
  for (const id of ['gb_oliver_sad', 'bm_george', 'marin', 'voice_482']) assert.ok(!DASH.test(f(id).name), id)
})

test('the facet choices are what the voices actually carry (only then does a picker appear)', () => {
  // the published languages are carried on the voice entries (the host sends them from the model)
  const voices = [
    { id: 'gb_oliver_neutral', langs: ['en'] }, { id: 'gb_jane_sarcasm', langs: ['en'] },
    { id: 'en_paul_sad', langs: ['en'] }, { id: 'fr_marie_happy', langs: ['fr'] }, { id: 'voice_482', langs: [] },
  ]
  const f = facetOptions(voices)
  assert.deepEqual(f.languages.map((x) => x.label), ['English', 'French'], 'one English, however its accents are tagged')
  assert.deepEqual(f.accents.map((x) => x.label), ['British'])
  assert.deepEqual(f.tones.map((x) => x.label), ['Neutral', 'Sarcasm', 'Sad', 'Happy'])
  // a list with no accents or tones offers neither
  const plain = facetOptions([{ id: 'marin', langs: ['en'] }, { id: 'cedar', langs: ['en'] }])
  assert.deepEqual(plain.languages, [{ value: 'English', label: 'English' }])
  assert.deepEqual(plain.accents, [])
  assert.deepEqual(plain.tones, [])
})

test('a pick filters on every facet, and an empty facet matches everything', () => {
  const voices = [{ id: 'gb_oliver_sad' }, { id: 'en_paul_sad' }, { id: 'fr_marie_happy' }]
  assert.deepEqual(filterVoices(voices, {}).map((v) => v.id), ['gb_oliver_sad', 'en_paul_sad', 'fr_marie_happy'])
  assert.deepEqual(filterVoices(voices, { language: 'English' }).map((v) => v.id), ['gb_oliver_sad', 'en_paul_sad'])
  assert.deepEqual(filterVoices(voices, { language: 'English', accent: 'gb' }).map((v) => v.id), ['gb_oliver_sad'])
  assert.deepEqual(filterVoices(voices, { tone: 'Sad' }).map((v) => v.id), ['gb_oliver_sad', 'en_paul_sad'])
  assert.deepEqual(filterVoices(voices, { language: 'Italian' }), [])
})

test('a grouped menu lists provider order: language, then accent inside it', () => {
  const g = groupVoices([{ id: 'voice_482', langs: [] }, { id: 'fr_marie_happy', langs: ['fr'] }, { id: 'gb_oliver_sad', langs: ['en'] }, { id: 'en_paul_neutral', langs: ['en'] }])
  assert.deepEqual(g.groups.map((x) => x.language + '/' + x.accent), ['English/', 'English/British', 'French/', 'Any language/'],
    'languages first, the default accent before the tagged ones, voices that say nothing last')
  assert.deepEqual(g.groups[1].items.map((i) => i.label), ['Oliver [Sad]'])
})

test('presets: one starred voice, restored as one entry; unstarring removes it', () => {
  const entry = { provider: 'mistral', providerLabel: 'Mistral', model: 'voxtral-mini-tts-3-0', modelLabel: 'Voxtral TTS 3', voice: 'gb_oliver_sad', voiceLabel: 'Oliver', language: 'English', accent: 'British', tone: 'Sad' }
  let list = togglePreset([], entry, true)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, presetKey(entry))
  assert.equal(presetLabel(list[0]), 'Oliver \u00b7 English, British, Sad')
  assert.ok(isPresetOf(list[0], { provider: 'mistral', model: 'voxtral-mini-tts-3-0', voice: 'gb_oliver_sad', language: 'English', accent: 'British', tone: 'Sad' }))
  assert.ok(!isPresetOf(list[0], { provider: 'mistral', model: 'voxtral-mini-tts-3-0', voice: 'en_paul_sad' }))
  assert.equal(presetsFor(list, 'mistral').length, 1)
  assert.equal(presetsFor(list, 'openai').length, 0)
  assert.equal(presetsFor(list, 'mistral', 'voxtral-mini-tts-2603').length, 0, 'a preset belongs to its model')
  // starring the same pick twice keeps one entry, the newest first
  list = togglePreset(list, entry, true)
  assert.equal(list.length, 1)
  list = togglePreset(list, entry, false)
  assert.equal(list.length, 0)
})

test('the providers Luca removed are named in one place (the Tzekos engine and Liquid; Kokoro stays)', () => {
  assert.deepEqual(HIDDEN_PROVIDERS, ['local', 'lfm3'], 'the Tzekos engine and Liquid')
})
