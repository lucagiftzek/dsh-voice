import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir, makeRegistry } from './helpers.mjs'
import { normalise, redact, sanitisePatch, SECRET_MARK, DEFAULTS } from '../lib/server/settings.js'
import { resolveCredential, isPointer } from '../lib/server/credentials.js'
import { discover, mergeInstances, createRegistry } from '../lib/server/registry.js'
import { resolveTts, resolveStt, routesFor } from '../lib/server/routing.js'

const LUCA = {
  MISTRAL_API_KEY: 'fake-mistral', MIMO_TOKEN_PLAN_API_KEY: 'fake-mimo', TTS_API_KEY: 'fake-tts',
  GREY_TTS_URL: 'http://127.0.0.1:9', GREY_TTS_API_KEY: 'fake-grey', ELEVENLABS_API_KEY: 'fake-eleven',
  GROQ_API_KEY: 'fake-groq',
}

test('normalise fills defaults for en, it, el and *', () => {
  const s = normalise({})
  for (const l of ['en', 'it', 'el', '*']) {
    assert.equal(s.perLanguage[l].tts.provider, 'auto', l)
    assert.equal(s.perLanguage[l].stt.provider, 'auto', l)
    assert.deepEqual(s.perLanguage[l].tts.fallback, [])
    assert.equal(s.perLanguage[l].tts.speed, 1)
    assert.equal('voice' in s.perLanguage[l].stt, false)
  }
  assert.deepEqual(s.languages.enabled, ['en', 'it', 'el'])
  assert.equal(s.legacy.engines, false)
  assert.deepEqual(s.providers, [])
})

test('normalise cleans junk', () => {
  const s = normalise({
    providers: [{ id: 'ok-1' }, { id: 'Bad Id!' }, null, 'x'],
    perLanguage: { fr: { tts: { provider: 'mistral', speed: 99, fallback: ['a', '', 'b'] } }, 'toolong!': { tts: {} } },
    languages: { enabled: ['FR', 'x', 'en'] },
  })
  assert.deepEqual(s.providers.map((p) => p.id), ['ok-1'])
  assert.equal(s.perLanguage.fr.tts.provider, 'mistral')
  assert.equal(s.perLanguage.fr.tts.speed, 1)
  assert.deepEqual(s.perLanguage.fr.tts.fallback, ['a', 'b'])
  assert.equal('toolong!' in s.perLanguage, false)
  assert.deepEqual(s.languages.enabled, ['fr', 'en'])
  // normalise never mutates the shipped defaults
  assert.equal(DEFAULTS.perLanguage.fr, undefined)
})

test('redact hides literals, keeps pointers; sanitisePatch keeps secrets on the marker', () => {
  const s = normalise({ providers: [
    { id: 'a', type: 'mistral', credential: 'sk-secret-literal' },
    { id: 'b', type: 'mistral', credential: 'env:MISTRAL_API_KEY' },
    { id: 'c', type: 'mistral', credential: 'vault:c' },
    { id: 'd', type: 'mistral', credential: '' },
    { id: 'e', type: 'mistral' },
  ] })
  const r = redact(s)
  const by = Object.fromEntries(r.providers.map((p) => [p.id, p]))
  assert.equal(by.a.credential, SECRET_MARK)
  assert.equal(by.b.credential, 'env:MISTRAL_API_KEY')
  assert.equal(by.c.credential, SECRET_MARK)
  assert.equal(by.d.credential, '')
  assert.equal('credential' in by.e, false)
  assert.ok(!JSON.stringify(r).includes('sk-secret-literal'))
  assert.equal(s.providers[0].credential, 'sk-secret-literal', 'redact must not mutate its input')

  const cur = { providers: [{ id: 'a', credential: 'vault:a' }] }
  const p = sanitisePatch({
    providers: [{ id: 'a', credential: SECRET_MARK, secret: 'x', state: {}, key: 'y' }, { id: 'n', credential: SECRET_MARK }],
    evil: 1, perLanguage: { en: {} },
  }, cur)
  assert.equal(p.providers[0].credential, 'vault:a')
  assert.equal(p.providers[1].credential, '')
  for (const bad of ['secret', 'state', 'key']) assert.equal(bad in p.providers[0], false)
  assert.equal('evil' in p, false)
  assert.ok('perLanguage' in p)
})

test('credentials: isPointer', () => {
  assert.equal(isPointer('env:A'), true)
  assert.equal(isPointer('file:/x#A'), true)
  assert.equal(isPointer('dsh-ref:A'), true)
  assert.equal(isPointer('env:A|file:/x'), true)
  assert.equal(isPointer('env:A|literal'), false)
  assert.equal(isPointer('sk-abc'), false)
  assert.equal(isPointer(''), false)
})

test('credentials: env, file with NAME, whole file, dsh-ref, chains, literals', () => {
  const dir = tmpDir('dshvoice-cred-')
  const dotenv = path.join(dir, 'creds')
  fs.writeFileSync(dotenv, '# comment\nexport ALPHA="quoted-value"\nBETA=\'single\'\nGAMMA=plain\nEMPTY=\n')
  const whole = path.join(dir, 'whole.txt')
  fs.writeFileSync(whole, '  whole-file-secret \n')
  const yaml = path.join(dir, 'credentials.yaml')
  fs.writeFileSync(yaml, 'version: 1\nrefs:\n  MY_REF: "ref-value"\n  OTHER: plain-ref\nother:\n  MY_REF: not-this\n')
  const env = { SET: 'from-env', DSH_VOICE_DSH_CREDENTIALS: yaml }
  const o = { env, home: dir }
  assert.equal(resolveCredential('env:SET', o), 'from-env')
  assert.equal(resolveCredential('env:MISSING', o), '')
  assert.equal(resolveCredential('file:' + dotenv + '#ALPHA', o), 'quoted-value')
  assert.equal(resolveCredential('file:' + dotenv + '#BETA', o), 'single')
  assert.equal(resolveCredential('file:' + dotenv + '#GAMMA', o), 'plain')
  assert.equal(resolveCredential('file:' + dotenv + '#EMPTY', o), '')
  assert.equal(resolveCredential('file:' + dotenv + '#NOPE', o), '')
  assert.equal(resolveCredential('file:' + whole, o), 'whole-file-secret')
  assert.equal(resolveCredential('file:~/whole.txt', o), 'whole-file-secret')
  assert.equal(resolveCredential('file:' + path.join(dir, 'missing'), o), '')
  assert.equal(resolveCredential('dsh-ref:MY_REF', o), 'ref-value')
  assert.equal(resolveCredential('dsh-ref:OTHER', o), 'plain-ref')
  assert.equal(resolveCredential('dsh-ref:ABSENT', o), '')
  assert.equal(resolveCredential('env:MISSING|env:SET', o), 'from-env')
  assert.equal(resolveCredential('env:MISSING|file:' + dotenv + '#GAMMA|env:SET', o), 'plain')
  assert.equal(resolveCredential('env:SET|env:MISSING', o), 'from-env')
  assert.equal(resolveCredential('a-literal-key', o), 'a-literal-key')
  assert.equal(resolveCredential('', o), '')
})

test('registry discover: Luca-like env', () => {
  const list = discover(LUCA, { home: tmpDir() })
  const by = Object.fromEntries(list.map((i) => [i.id, i]))
  assert.deepEqual(Object.keys(by).sort(), ['alibaba', 'browser', 'elevenlabs', 'grey', 'groq', 'lfm3', 'local', 'mimo', 'mistral'])
  assert.equal(by.elevenlabs.inAuto, false)
  assert.equal(by.elevenlabs.enabled, true)
  assert.equal(by.groq.enabled, false)
  assert.equal(by.alibaba.enabled, false)
  assert.equal(by.local.type, 'elevenlabs-compatible')
  assert.equal(by.local.options.native, true)
  assert.equal(by.grey.type, 'tzekos-native')
  assert.equal(by.grey.baseUrl, 'http://127.0.0.1:9')
  assert.equal(by.mistral.inAuto, true)
  const legacy = Object.fromEntries(discover(LUCA, { home: tmpDir(), legacy: true }).map((i) => [i.id, i]))
  assert.equal(legacy.groq.enabled, true)
  assert.equal(legacy.elevenlabs.inAuto, true)
  assert.equal(legacy.alibaba.enabled, false, 'alibaba also needs DSH_VOICE_ALI_AUDIO=1')
  const viaEnv = Object.fromEntries(discover(Object.assign({ DSH_VOICE_LEGACY_ENGINES: '1', DSH_VOICE_ALI_AUDIO: '1' }, LUCA), { home: tmpDir() }).map((i) => [i.id, i]))
  assert.equal(viaEnv.groq.enabled, true)
  assert.equal(viaEnv.alibaba.enabled, true)
})

test('mergeInstances: override a discovered instance, add a new one', () => {
  const disc = discover(LUCA, { home: tmpDir() })
  const merged = mergeInstances(disc, [
    { id: 'local', enabled: false },
    { id: 'kokoro-lan', type: 'tzekos-native', baseUrl: 'http://192.0.2.10:8790', credential: 'env:GREY_TTS_API_KEY' },
    { id: 'junk', type: 'no-such-type' },
  ])
  const by = Object.fromEntries(merged.map((i) => [i.id, i]))
  assert.equal(by.local.enabled, false)
  assert.equal(by.local.overridden, true)
  assert.equal(by.local.baseUrl, disc.find((i) => i.id === 'local').baseUrl, 'empty fields keep the discovered value')
  assert.equal(by.local.options.native, true)
  assert.ok(by['kokoro-lan'])
  assert.equal(by['kokoro-lan'].type, 'tzekos-native')
  assert.equal(by['kokoro-lan'].enabled, true)
  assert.equal(by.junk, undefined)
  assert.equal(disc.find((i) => i.id === 'local').enabled, true, 'inputs are not mutated')

  const { reg } = makeRegistry(LUCA, { providers: [{ id: 'kokoro-lan', type: 'tzekos-native', baseUrl: 'http://192.0.2.10:8790', credential: 'env:GREY_TTS_API_KEY' }] })
  const k = reg.get('kokoro-lan')
  assert.ok(k)
  assert.equal(reg.available(k, 'tts'), true)
  assert.equal(reg.available(k, 'stt'), false)
  assert.equal(k.secret(), 'fake-grey')
})

test('settings disabling local sends Greek auto-routing to mistral (the 1.x chain)', async () => {
  const env = Object.assign({}, LUCA)
  delete env.GREY_TTS_URL
  const base = makeRegistry(env, {})
  assert.equal((await resolveTts({ lang: 'el', settings: base.settings, reg: base.reg })).id, 'local')
  const { reg, settings } = makeRegistry(env, { providers: [{ id: 'local', enabled: false }] })
  assert.equal(reg.available(reg.get('local')), false)
  const el = await resolveTts({ lang: 'el', settings, reg })
  assert.equal(el.id, 'mistral')
  const it = await resolveTts({ lang: 'it', settings, reg })
  assert.equal(it.id, 'mistral')
  const sttEl = await resolveStt({ lang: 'el', settings, reg })
  assert.equal(sttEl.id, 'mistral')
  // English is unaffected
  assert.equal((await resolveTts({ lang: 'en', settings, reg })).id, 'mimo')
})

test('perLanguage.el.tts elevenlabs with lfm3 fallback', async () => {
  const per = { el: { tts: { provider: 'elevenlabs', fallback: ['lfm3'] } } }
  // elevenlabs available: Greek goes to it, even though auto would not
  let r = makeRegistry(LUCA, { perLanguage: per })
  let t = await resolveTts({ lang: 'el', settings: r.settings, reg: r.reg })
  assert.equal(t.id, 'elevenlabs')
  assert.equal(t.source, 'lang')
  // other languages are untouched
  assert.equal((await resolveTts({ lang: 'it', settings: r.settings, reg: r.reg })).id, 'local')
  // elevenlabs unavailable (no key): lfm3 takes it
  const noEleven = Object.assign({}, LUCA)
  delete noEleven.ELEVENLABS_API_KEY
  r = makeRegistry(noEleven, { perLanguage: per })
  t = await resolveTts({ lang: 'el', settings: r.settings, reg: r.reg })
  assert.equal(t.id, 'lfm3')
  // quota dry elevenlabs is skipped (state.acct.quota.remaining 0, quota refresh fails fast)
  r = makeRegistry(Object.assign({}, LUCA, { DSH_VOICE_ELEVEN_BASE: 'http://127.0.0.1:1' }), { perLanguage: per })
  r.reg.get('elevenlabs').state.acct = { at: Date.now(), voices: [], quota: { remaining: 0, limit: 10000, used: 10000, tier: 'free' }, error: null }
  t = await resolveTts({ lang: 'el', settings: r.settings, reg: r.reg })
  assert.equal(t.id, 'lfm3')
  // a manual pick is honoured regardless
  assert.equal((await resolveTts({ lang: 'el', provider: 'elevenlabs', settings: r.settings, reg: r.reg })).id, 'elevenlabs')
})

test('routesFor lists a route for every language', async () => {
  const { reg, settings } = makeRegistry(LUCA, {})
  const routes = await routesFor(['en', 'it', 'el', '*'], settings, reg)
  assert.equal(routes.en.tts, 'mimo')
  assert.equal(routes.el.tts, 'local')
  assert.equal(routes['*'].tts, 'local')
  assert.equal(routes.en.ttsSource, 'legacy')
})

test('registry state is shared across registries built from one Map', () => {
  const state = new Map()
  const settings = normalise({})
  const a = createRegistry({ env: LUCA, home: tmpDir(), settings, state })
  a.get('mistral').state.marker = 1
  const b = createRegistry({ env: LUCA, home: tmpDir(), settings, state })
  assert.equal(b.get('mistral').state.marker, 1)
})
