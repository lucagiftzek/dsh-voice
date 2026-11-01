/**
 * dsh-voice: the read-only self-check behind GET /api/voice/doctor.
 *
 * Read-only by construction: it reads settings and file modes, resolves routing
 * without touching a vendor, and probes ONLY loopback or self-hosted engines with
 * one plain GET and a 2 s timeout (any HTTP status counts as reachable). It never
 * synthesises, never transcribes, never calls a paid API, never writes, and never
 * puts a credential, a URL with credentials or a settings value in the output:
 * credentials are reported as booleans, trusted hosts as a count.
 */
import fs from 'node:fs'
import path from 'node:path'
import { E } from '../errors.js'
import { doctorReport, check, hostInfo } from '../plugin-errors.js'
import { request } from './http.js'
import { isLoopbackHostname } from './security.js'
import { entryFor, chooseTtsLegacy, chooseSttLegacy } from './routing.js'
import { retirementNotes } from '../shared/retirements.js'

export const PROBE_TIMEOUT_MS = 2000
const SECRET_FILES = ['vault.json', 'capability.secret', 'settings.json']
const PKG = new URL('../../package.json', import.meta.url)
const BUNDLE = new URL('../client.js', import.meta.url)

/** A non-ok check row carrying the catalog code, hint and docs anchor. */
function problem(code, status, detail, human) {
  const b = E.body(code)
  const row = { status, detail, code, hint: b.hint, docs: b.docs }
  if (human) row.human = true
  return row
}

function version() {
  try { return JSON.parse(fs.readFileSync(PKG, 'utf8')).version || 'unknown' } catch (e) { return 'unknown' }
}

const hostnameOf = (u) => { try { return new URL(String(u)).hostname } catch (e) { return '' } }

function secretPresent(inst) {
  try { return Boolean(inst.secret()) } catch (e) { return false }
}

/** Which languages and directions resolve to an unavailable explicit provider (no vendor call). */
function routingProblems(settings, reg) {
  const langs = settings.languages.enabled.concat(['*'])
  const bad = []
  const resolved = {}
  for (const l of langs) {
    const lang = l === '*' ? 'xx' : l
    resolved[l] = {}
    for (const dir of ['tts', 'stt']) {
      const e = entryFor(settings, lang, dir)
      if (!e.provider || e.provider === 'auto') {
        resolved[l][dir] = (dir === 'tts' ? chooseTtsLegacy(lang, reg) : chooseSttLegacy(lang, reg)) || 'none'
        continue
      }
      const chain = [e.provider].concat(e.fallback || [])
      const hit = chain.find((id) => id === 'browser' || (reg.get(id) && reg.available(reg.get(id), dir)))
      resolved[l][dir] = hit || 'auto-tail'
      if (e.provider !== 'browser' && hit !== e.provider) bad.push(l + ' ' + dir + ': ' + e.provider + ' is not available' + (hit ? ', uses ' + hit : ''))
    }
  }
  return { bad, resolved }
}

function modeOf(file) {
  try { return fs.statSync(file).mode & 0o777 } catch (e) { return null }
}

/** One cheap GET, 2 s timeout. Any HTTP answer = reachable. Never throws. */
async function probe(inst) {
  const t0 = Date.now()
  try {
    const r = await request(inst.baseUrl, { method: 'GET', timeout: PROBE_TIMEOUT_MS })
    return { id: inst.id, reachable: true, http: r.status, ms: Date.now() - t0 }
  } catch (e) {
    return { id: inst.id, reachable: false, error: String((e && e.code) || (e && e.message) || 'error').slice(0, 40), ms: Date.now() - t0 }
  }
}

/**
 * svc: the handler services ({ store, ctx?, hasConfig?, env, home }). settings and reg are the
 * effective settings and registry of this request; req is used to see how DSH was reached.
 */
export async function runDoctor({ svc, settings, reg, req }) {
  const host = await hostInfo(svc.ctx || null)
  const dataDir = svc.store.dataDir
  const checks = []

  checks.push(await check('plugin', 'Plugin loaded', () => ({ status: 'ok', detail: 'dsh-voice ' + version() })))

  checks.push(await check('settings', 'Settings store', () => {
    const d = svc.store.describe ? svc.store.describe() : {}
    const detail = 'mode ' + host.settingsMode + ', backend ' + svc.store.backend + (d.entryId ? ', entry ' + d.entryId : '') + (d.legacyImport ? ', legacy import ' + d.legacyImport : '')
    if (host.settingsMode === 'config') return problem('VOICE_SETTINGS_NOT_WIRED', 'warn', detail + ' (values only in the plugin settings file)', false)
    return { status: 'ok', detail }
  }))

  checks.push(await check('config', 'Config visible to the loader', () => {
    if (svc.hasConfig) return { status: 'ok', detail: 'Config exported' }
    if (host.settingsMode === 'forms') return problem('VOICE_CONFIG_NOT_VISIBLE', 'fail', 'no Config schema: DSH 0.2.x cannot render the settings form', false)
    return { status: 'info', detail: 'no Config schema (not needed on this settings mode)' }
  }))

  checks.push(await check('providers', 'Providers', () => {
    const rows = reg.list().map((i) => ({
      id: i.id, type: i.type, enabled: Boolean(i.enabled),
      configured: Boolean(reg.adapter(i).configured(i)), credential: secretPresent(i),
      tts: reg.available(i, 'tts'), stt: reg.available(i, 'stt'), residency: reg.residency(i),
    }))
    const real = rows.filter((r) => r.type !== 'browser')
    const tts = real.filter((r) => r.tts).length
    const stt = real.filter((r) => r.stt).length
    const detail = { speak: tts, transcribe: stt, instances: rows }
    if (!tts || !stt) return problem('VOICE_NO_PROVIDER', 'warn', detail, true)
    return { status: 'ok', detail }
  }))

  checks.push(await check('routing', 'Per-language routing', () => {
    const { bad, resolved } = routingProblems(settings, reg)
    if (bad.length) return problem('VOICE_ROUTE_UNRESOLVED', 'warn', { problems: bad.slice(0, 8), resolved }, false)
    return { status: 'ok', detail: resolved }
  }))

  checks.push(await check('trusted-hosts', 'Trusted hosts', () => {
    const n = settings.security.trustedHosts.length
    const h = req && req.headers ? req.headers : {}
    let proxied = Boolean(h['x-forwarded-host'])
    if (!proxied && h.host) proxied = !isLoopbackHostname(hostnameOf('http://' + h.host))
    if (n) return { status: 'ok', detail: n + ' trusted host(s)' }
    if (proxied) return problem('VOICE_TRUSTED_HOSTS_UNSET', 'warn', 'security.trustedHosts is empty and the request came through a proxy host name', true)
    return { status: 'info', detail: 'security.trustedHosts is empty (fine while DSH is opened on a loopback address only)' }
  }))

  checks.push(await check('data-dir', 'Data directory', () => {
    let probeDir = dataDir
    while (probeDir && !fs.existsSync(probeDir) && path.dirname(probeDir) !== probeDir) probeDir = path.dirname(probeDir)
    try { fs.accessSync(probeDir, fs.constants.W_OK) } catch (e) { return problem('VOICE_DATA_DIR_UNWRITABLE', 'fail', (fs.existsSync(dataDir) ? 'exists' : 'missing') + ' but not writable', false) }
    return { status: 'ok', detail: fs.existsSync(dataDir) ? 'exists and writable' : 'will be created on first write' }
  }))

  checks.push(await check('files', 'Secret file modes', () => {
    if (process.platform === 'win32') return { status: 'skip', detail: 'file modes are not checked on Windows' }
    const seen = SECRET_FILES.map((f) => ({ f, mode: modeOf(path.join(dataDir, f)) })).filter((x) => x.mode !== null)
    const loose = seen.filter((x) => (x.mode & 0o077) !== 0)
    const detail = seen.map((x) => x.f + ' ' + x.mode.toString(8)).join(', ') || 'no files yet'
    if (loose.length) return problem('VOICE_FILE_MODE', 'warn', detail + ' (expected 600)', false)
    return { status: 'ok', detail }
  }))

  checks.push(await check('engines', 'Self-hosted engines reachable', async () => {
    const cands = reg.list().filter((i) => {
      const a = reg.adapter(i)
      if (!a || i.type === 'browser' || !i.enabled || !i.baseUrl) return false
      const local = isLoopbackHostname(hostnameOf(i.baseUrl))
      if (!local && a.group !== 'self' && !a.selfHostable) return false
      return reg.available(i) || !i.discovered || i.overridden
    })
    if (!cands.length) return { status: 'skip', detail: 'no self-hosted or loopback engine is configured' }
    const out = await Promise.all(cands.map(probe))
    const down = out.filter((r) => !r.reachable)
    if (down.length) return problem('VOICE_ENGINE_UNREACHABLE', 'warn', out, true)
    return { status: 'ok', detail: out }
  }))

  checks.push(await check('retirements', 'Vendor model retirements', () => {
    const notes = []
    for (const i of reg.list()) for (const n of retirementNotes(i)) notes.push({ provider: i.id, model: n.model, on: n.on, past: Date.now() >= Date.parse(n.on) })
    if (!notes.length) return { status: 'ok', detail: 'none of the configured models is scheduled for retirement' }
    const past = notes.some((n) => n.past)
    return { status: past ? 'warn' : 'info', detail: notes, hint: 'Switch the model or the provider in Settings > Voice.', docs: 'docs/TROUBLESHOOTING.md#t-retirements' }
  }))

  checks.push(await check('client', 'Client bundle present', () => {
    let size = 0
    try { size = fs.statSync(BUNDLE).size } catch (e) { size = 0 }
    if (size > 0) return { status: 'ok', detail: 'lib/client.js ' + size + ' bytes' }
    return problem('VOICE_CLIENT_BUNDLE_MISSING', 'fail', 'lib/client.js is missing or empty', true)
  }))

  return doctorReport({ plugin: 'dsh-voice', version: version(), host, checks })
}
