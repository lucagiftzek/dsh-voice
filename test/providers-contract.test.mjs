// Contract every adapter type must satisfy (metadata, truthful capabilities, planned types inert),
// and what the Settings API exposes for the grouped UI. No network, no real credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TYPES, GROUP_ORDER, RESIDENCY_LABELS, typeMeta, createRegistry } from '../lib/server/registry.js'
import { normalise } from '../lib/server/settings.js'
import { voiceServer, inst, tmpDir } from './helpers.mjs'

const STATUSES = ['verified', 'partial', 'unverified', 'planned']
const DASH = /[\u2013\u2014]/
const fake = (type, over) => inst(Object.assign({ id: type, type, region: '', options: {}, models: {} }, over || {}))

test('every type has complete, honest metadata', () => {
  for (const a of Object.values(TYPES)) {
    const t = a.type
    assert.ok(GROUP_ORDER.includes(a.group), t + ' group')
    assert.ok(a.residency in RESIDENCY_LABELS, t + ' residency')
    assert.ok(typeof a.desc === 'string' && a.desc.length > 10 && a.desc.length <= 140, t + ' desc length ' + (a.desc || '').length)
    assert.ok(STATUSES.includes(a.status), t + ' status')
    assert.ok(a.label && a.euNote && a.hq, t + ' label, euNote, hq')
    if (a.status !== 'planned' && a.status !== 'partial') assert.match(a.docs, /^https:\/\//, t + ' docs')
    assert.ok(Array.isArray(a.presets), t + ' presets')
    for (const p of a.presets) assert.ok(p.id && p.label, t + ' preset id and label')
    for (const f of a.optionFields || []) assert.ok(f.key && f.label && ['bool', 'text', 'number', 'select'].includes(f.type), t + ' optionField ' + f.key)
    for (const f of ['desc', 'euNote', 'label', 'verification']) assert.ok(!DASH.test(String(a[f] || '')), t + ' ' + f + ' has a dash character')
    assert.ok(typeof a.status !== 'string' || a.status === 'planned' || a.verification, t + ' needs a verification note')
    assert.equal(typeof a.configured, 'function', t + ' configured')
    assert.equal(typeof a.health, 'function', t + ' health')
    assert.equal(typeof a.listVoices, 'function', t + ' listVoices')
  }
})

test('capabilities are truthful in shape: languages are 2-letter lists or *, alignment is a known value', () => {
  for (const a of Object.values(TYPES)) {
    const c = a.capabilities(fake(a.type))
    for (const k of ['ttsLangs', 'sttLangs']) {
      assert.ok(c[k] === '*' || Array.isArray(c[k]), a.type + ' ' + k)
      if (Array.isArray(c[k])) for (const l of c[k]) assert.match(l, /^[a-z]{2,3}$/, a.type + ' ' + k + ' ' + l)
    }
    assert.ok(['none', 'sentence', 'word', 'char', 'duration'].includes(c.alignment), a.type + ' alignment')
    if (!c.tts) assert.ok(Array.isArray(c.ttsLangs) ? true : c.ttsLangs === '*', a.type)
    assert.equal(typeof c.tts, 'boolean')
    assert.equal(typeof c.stt, 'boolean')
  }
})

test('providers known to lack Greek never declare it for TTS', () => {
  const NO_GREEK_TTS = ['amazon', 'deepgram', 'xtts', 'dashscope', 'tzekos-native']
  for (const t of NO_GREEK_TTS) {
    const c = TYPES[t].capabilities(fake(t))
    if (c.ttsLangs !== '*') assert.ok(!c.ttsLangs.includes('el'), t + ' must not list el for TTS')
    else assert.fail(t + ' declares every language for TTS')
  }
})

test('planned types are inert: never configured, never available, never routed', () => {
  const settings = normalise({ providers: Object.values(TYPES).filter((a) => a.status === 'planned').map((a) => ({ id: 'p-' + a.type, type: a.type, credential: 'fake-key-0000', baseUrl: 'http://127.0.0.1:9', inAuto: true })) })
  const reg = createRegistry({ env: {}, home: tmpDir('dshvoice-home-'), settings, state: new Map() })
  for (const a of Object.values(TYPES).filter((x) => x.status === 'planned')) {
    const i = reg.get('p-' + a.type)
    assert.ok(i, a.type)
    assert.equal(reg.available(i), false, a.type + ' must not be available')
    assert.equal(reg.autoOk(i, 'tts'), false)
    assert.equal(reg.autoOk(i, 'stt'), false)
  }
})

test('GET /settings exposes grouped type metadata and instance badges for the UI', async () => {
  const v = await voiceServer({})
  try {
    const r = await v.call('GET', '/settings')
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.groups, ['eu', 'other', 'self'])
    assert.ok(r.json.residencyLabels.eu)
    const types = r.json.types
    assert.equal(types.length, Object.keys(TYPES).length)
    for (const t of types) {
      assert.ok(['eu', 'other', 'self'].includes(t.group), t.type)
      assert.ok(t.desc, t.type + ' desc')
      assert.ok(t.docs || t.planned || t.status === 'partial', t.type + ' docs')
    }
    // EU group is listed first
    const order = types.map((t) => t.group)
    assert.ok(order.indexOf('eu') < order.indexOf('other'))
    for (const i of r.json.instances) {
      assert.ok(['eu', 'other', 'self'].includes(i.group), i.id)
      assert.ok(i.residency in RESIDENCY_LABELS, i.id)
      assert.equal(typeof i.caps.alignment, 'string')
    }
    const mistral = r.json.instances.find((i) => i.id === 'mistral')
    assert.equal(mistral.group, 'eu')
    assert.equal(mistral.residency, 'eu')
    assert.equal(typeMeta(TYPES.mistral).group, 'eu')
  } finally { await v.close() }
})
