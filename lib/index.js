/**
 * dsh-voice 2: host half. Multi-provider speech for the DSH web UI.
 *
 * WHY A SERVER HALF AT ALL: every engine needs a credential, and a credential in
 * the browser is a published credential. The browser talks only to this
 * same-origin /api/voice route and never sees a key.
 *
 * LAYOUT
 *   lib/server/registry.js      provider types + instances (env discovery merged with Settings)
 *   lib/server/providers/*.js   one adapter per type (mistral, elevenlabs, elevenlabs-compatible,
 *                               tzekos-native, lfm3, mimo, openai-compatible, dashscope, browser)
 *   lib/server/routing.js       per-language routing; 'auto' = the 1.x chain
 *   lib/server/routes.js        /api/voice/* (1.x contracts unchanged + new gated routes)
 *   lib/server/doctor.js        GET /api/voice/doctor, the read-only self-check
 *   lib/errors.js               the VOICE_* error catalog (docs/ERRORS.md)
 *   lib/server/settings*.js     defaults, schema, redaction, the settings store
 *   lib/shared/lang/*.js        markers, sentences, segments (bundled into the client too)
 *
 * SERVICES: `webServer` and `settings` are required (both DSH lines provide
 * them; settings are read through lib/server/settings-store.js, which works on
 * 0.1.5 register, 0.2 forms, or neither). `llm` is optional, picked up with
 * ctx.inject(['llm'], ...) when the host provides it.
 *
 * DEPENDENCIES ARE node:-ONLY on purpose: an ESM import error at load once
 * crash-looped dsh-web 794 times. Schemastery is resolved from the host install
 * at runtime inside try/catch.
 *
 * KILL SWITCH: add to the web profile's cordis.patch.yml
 *     - id: voice
 *       disabled: true
 * and restart dsh-web.
 */
import os from 'node:os'
import path from 'node:path'
import { createHandler } from './server/routes.js'
import { createSettingsStore } from './server/settings-store.js'
import { settingsSchema } from './server/settings.js'
import { loadOrCreateSecret } from './server/security.js'
import { loadHostSchemastery } from './dual-settings.js'
import { registerPluginSkills } from './plugin-skills.js'

export const name = 'dsh-voice'
// 'settings' is injected so ctx.settings may be read at all (on DSH 0.2 reading
// a service that is not injected throws). Both lines provide it; the store
// (lib/dual-settings.js) picks register (0.1.5) or forms (0.2) by capability.
export const inject = ['webServer', 'settings']

/**
 * The settings schema as the row Config (DSH 0.2 validates the cordis row
 * against it and renders forms from it), built with the running harness's
 * schemastery. undefined when no schemastery is found (tests, other hosts).
 */
export const Config = settingsSchema(loadHostSchemastery(import.meta.url)) || undefined

export function apply(ctx, config) {
  const log = ctx.logger ? ctx.logger('dsh-voice') : console
  const warn = (m) => { try { (log.warn || log.error || console.warn).call(log, String(m)) } catch (x) { /* never throw from a log */ } }
  const info = (m) => { try { (log.info || log.log || console.log).call(log, String(m)) } catch (x) { /* never throw from a log */ } }

  const store = createSettingsStore({ ctx, config: config || {}, schema: Config || null, warn, log: info, metaUrl: import.meta.url })
  info('settings store: ' + store.mode)
  let llm = null
  let secret = null
  loadOrCreateSecret(path.join(store.dataDir, 'capability.secret')).then((s) => { secret = s }).catch((e) => warn('capability secret: ' + e.message))

  // The host LLM runtime is optional (detection and polish degrade without it).
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['llm'], (c) => {
        llm = c.llm || null
        c.on('dispose', () => { llm = null })
      })
    } catch (e) { warn('llm service unavailable: ' + e.message) }
  }

  const handler = createHandler({
    store, warn, env: process.env, home: os.homedir(),
    ctx, hasConfig: Boolean(Config),
    secret: () => secret,
    llm: () => llm,
  })

  // The packaged voice-doctor skill (skills/voice-doctor), discoverable by agents.
  registerPluginSkills(ctx, { plugin: 'dsh-voice', dir: new URL('../skills/', import.meta.url), log: info })

  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/api/voice', handler })
  ctx.on('dispose', () => { try { dispose() } catch (e) { /* already gone */ } })
}
