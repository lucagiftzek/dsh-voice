// GET /api/voice/doctor: shape, gate, no secrets, probes only loopback or self-hosted engines.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mockServer, reply, voiceServer, closedPort, tmpDir } from './helpers.mjs'
import { runDoctor } from '../lib/server/doctor.js'
import { createRegistry } from '../lib/server/registry.js'
import { createSettingsStore } from '../lib/server/settings-store.js'
import { normalise } from '../lib/server/settings.js'
import { E } from '../lib/errors.js'

const KEY = 'fake-mistral-key-doctor-1111'
const VAULT_SECRET = 'fake-vault-secret-doctor-2222'

const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]))

test('doctor: shape, loose secret file, unreachable engine, no secret leaked, cloud never probed', async () => {
  const up = await mockServer((r, res) => reply(res, 404, { error: 'nf' }))
  const dead = await closedPort()
  const dataDir = tmpDir('dshvoice-doc-')
  fs.writeFileSync(path.join(dataDir, 'vault.json'), JSON.stringify({ cloud1: VAULT_SECRET }), { mode: 0o644 })
  fs.chmodSync(path.join(dataDir, 'vault.json'), 0o644)
  const config = {
    providers: [
      { id: 'cloud1', type: 'deepgram', baseUrl: 'https://api.example.com', credential: 'vault:cloud1', enabled: true },
      { id: 'piper-up', type: 'piper', baseUrl: up.origin, enabled: true },
      { id: 'piper-down', type: 'piper', baseUrl: 'http://127.0.0.1:' + dead, enabled: true },
    ],
  }
  const v = await voiceServer({ MISTRAL_API_KEY: KEY, DSH_VOICE_MISTRAL_BASE: up.origin, DSH_VOICE_OLLAMA_PORT: String(dead) }, { dataDir, config })
  try {
    const r = await v.call('GET', '/doctor')
    assert.equal(r.status, 200)
    const j = r.json
    assert.equal(j.plugin, 'dsh-voice')
    assert.ok(['ok', 'warn', 'fail'].includes(j.status))
    assert.equal(j.docs, 'docs/TROUBLESHOOTING.md')
    assert.ok(j.host && j.host.node)
    const c = byId(j)
    for (const id of ['plugin', 'settings', 'config', 'providers', 'routing', 'trusted-hosts', 'data-dir', 'files', 'engines', 'retirements', 'client']) assert.ok(c[id], 'check ' + id)
    for (const x of j.checks) if (x.code) { assert.ok(E.has(x.code), x.code); assert.ok(x.docs && x.hint) }

    assert.equal(c.settings.code, 'VOICE_SETTINGS_NOT_WIRED') // no settings service in this fake host
    assert.equal(c.files.code, 'VOICE_FILE_MODE')
    assert.equal(c.engines.code, 'VOICE_ENGINE_UNREACHABLE')
    assert.equal(c.engines.human, true)
    const probed = Object.fromEntries(c.engines.detail.map((p) => [p.id, p]))
    assert.equal(probed['piper-up'].reachable, true)
    assert.equal(probed['piper-down'].reachable, false)
    assert.equal(probed.cloud1, undefined, 'a cloud provider on a public host is never probed')
    assert.ok(up.reqs.every((q) => q.method === 'GET'), 'probes are plain GETs')
    assert.ok(up.reqs.every((q) => !q.headers.authorization), 'probes send no credential')

    const prov = Object.fromEntries(c.providers.detail.instances.map((p) => [p.id, p]))
    assert.equal(prov.mistral.credential, true)
    assert.equal(prov.cloud1.credential, true)
    assert.equal(typeof prov.mistral.credential, 'boolean')

    for (const secret of [KEY, VAULT_SECRET]) assert.ok(!r.text.includes(secret), 'secret leaked into the doctor report')
  } finally { await v.close(); await up.close() }
})

test('doctor: same gate as the other read routes', async () => {
  const v = await voiceServer({})
  try {
    const r = await v.call('GET', '/doctor', { headers: { host: 'evil.example' } })
    assert.equal(r.status, 403)
    assert.equal(r.json.code, 'VOICE_READ_REFUSED')
    const post = await v.call('POST', '/doctor', { body: {} })
    assert.notEqual(post.status, 200)
  } finally { await v.close() }
})

test('doctor: forms mode without Config fails the config check; routing flags an unavailable explicit provider', async () => {
  const dataDir = tmpDir('dshvoice-doc2-')
  const home = tmpDir('dshvoice-doc2h-')
  const ctx = { settings: { update() {}, describe() {} } }
  const store = createSettingsStore({ dataDir, config: { providers: [{ id: 'lfm3', enabled: false }], perLanguage: { en: { tts: { provider: 'mistral', fallback: [] } } } } })
  const settings = normalise(store.raw())
  const reg = createRegistry({ env: {}, home, settings, vault: (id) => store.vault(id) })
  const j = await runDoctor({ svc: { store, ctx, hasConfig: false }, settings, reg, req: { headers: { host: '127.0.0.1:3080' } } })
  const c = byId(j)
  assert.equal(j.host.settingsMode, 'forms')
  assert.equal(c.config.status, 'fail')
  assert.equal(c.config.code, 'VOICE_CONFIG_NOT_VISIBLE')
  assert.equal(c.routing.code, 'VOICE_ROUTE_UNRESOLVED')
  assert.equal(c.providers.code, 'VOICE_NO_PROVIDER')
  assert.equal(j.status, 'fail')
})

test('doctor: a throwing check becomes a fail row, never an exception', async () => {
  const store = { dataDir: tmpDir('dshvoice-doc3-'), describe() { throw new Error('boom') }, backend: 'file' }
  const settings = normalise({})
  const reg = createRegistry({ env: {}, home: tmpDir('dshvoice-doc3h-'), settings })
  const j = await runDoctor({ svc: { store, hasConfig: true }, settings, reg, req: null })
  assert.equal(byId(j).settings.status, 'fail')
})
