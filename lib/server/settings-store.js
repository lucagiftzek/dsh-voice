/**
 * dsh-voice: the ONE place that reads and writes settings.
 *
 * Built on lib/dual-settings.js (vendored from dsh-migrate-0.2/shared, the
 * shared helper of the 0.2 migration), which picks the backend by capability:
 *
 *   'register'  DSH 0.1.5: namespace `dsh-voice` registered with
 *               ctx.settings.register (values in settings.yaml)
 *   'forms'     DSH 0.2.x: values in this plugin's cordis row of the profile
 *               patch, written with ctx.settings.update(entryId, patch); the
 *               exported `Config` declares every top-level key as volatile, so
 *               edits apply live; a 0.1.5 `dsh-voice:` section of settings.yaml
 *               is imported once
 *   'config'    no settings service (headless runs, tests, a host that did not
 *               inject it): read-only over the apply() config, with the plugin
 *               file <dataDir>/settings.json as a writable fallback
 *
 * Secrets never enter any of these layers: a literal key typed in Settings
 * goes to <dataDir>/vault.json (0600) and the setting holds `vault:<id>`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deepMerge, sanitisePatch, DEFAULTS } from './settings.js'
import { isPointer } from './credentials.js'
import { createDualSettings, plain } from '../dual-settings.js'

export function defaultDataDir(env) {
  const e = env || process.env
  return e.DSH_VOICE_DATA_DIR || path.join(os.homedir(), '.config', 'dsh-voice')
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch (e) { /* best effort */ }
}

/** Move literal credentials of a patch into the vault; the patch keeps `vault:<id>`. */
function vaultSecrets(patch, vaultFile) {
  if (!patch || !Array.isArray(patch.providers)) return patch
  const vault = readJson(vaultFile) || {}
  let changed = false
  for (const p of patch.providers) {
    const c = String((p && p.credential) || '').trim()
    if (c && !isPointer(c) && !c.startsWith('vault:')) {
      vault[p.id] = c
      p.credential = 'vault:' + p.id
      changed = true
    }
  }
  if (changed) writeJson(vaultFile, vault)
  return patch
}

/**
 * opts: { ctx?, config?, schema?, dataDir?, env?, warn?, log?, metaUrl? }
 * Without ctx (tests, tools) the store is file-backed over `config`.
 */
export function createSettingsStore(opts) {
  const o = opts || {}
  const dir = o.dataDir || defaultDataDir(o.env)
  const settingsFile = path.join(dir, 'settings.json')
  const vaultFile = path.join(dir, 'vault.json')
  const config = (o.config && typeof o.config === 'object') ? o.config : {}
  const listeners = new Set()
  const notify = () => listeners.forEach((fn) => { try { fn() } catch (e) { /* contained */ } })
  const warn = o.warn || (() => {})
  const log = o.log || (() => {})

  const dual = o.ctx
    ? createDualSettings(o.ctx, config, {
      ns: 'dsh-voice', packageName: 'dsh-voice', schema: o.schema || null, base: DEFAULTS,
      autoForm: false, log, warn, metaUrl: o.metaUrl,
      legacy: { transform: (patch) => vaultSecrets(JSON.parse(JSON.stringify(patch)), vaultFile) },
    })
    : null
  const mode = () => (dual ? dual.mode : 'config')
  const fileLayer = () => readJson(settingsFile) || {}

  const store = {
    dataDir: dir,
    /** 'dsh-settings' (0.1.5 register), 'profile' (0.2 forms) or 'file'. */
    get backend() { return mode() === 'register' ? 'dsh-settings' : mode() === 'forms' ? 'profile' : 'file' },
    get mode() { return mode() },
    ready: dual ? dual.ready : Promise.resolve(),
    describe() { return dual ? dual.describeStore() : { mode: 'config', entryId: null, legacyImport: 'not-needed' } },

    /** Raw stored settings (not yet normalised). Read at the moment of use. */
    raw() {
      if (dual && mode() !== 'config') {
        try { return plain(dual.get()) } catch (e) { /* fall through */ }
      }
      return deepMerge(plain(config), fileLayer())
    },

    /** Apply a UI patch (already gated). '__set__' keeps secrets; literals go to the vault. */
    async update(patch) {
      const clean = vaultSecrets(sanitisePatch(patch, store.raw()), vaultFile)
      if (dual && dual.writable()) {
        await dual.update(clean)
      } else {
        writeJson(settingsFile, deepMerge(fileLayer(), clean))
      }
      notify()
      return clean
    },

    /** Resolve a vault:<id> pointer (host side only). */
    vault(id) {
      const v = readJson(vaultFile) || {}
      return typeof v[id] === 'string' ? v[id] : ''
    },

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
  return store
}
