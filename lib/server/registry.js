/**
 * dsh-voice: provider registry.
 *
 * A provider TYPE is one adapter module (providers/<type>.js). An INSTANCE binds
 * a type to a base URL, credential and options. Instances come from:
 *   1. env auto-discovery (discover()): the 1.x engine ids, built from the same
 *      env names and credential files 1.x read, so no install needs a config edit
 *   2. settings.providers[]: an entry with a discovered id overrides it field by
 *      field (an empty value keeps the discovered one); a new id adds an instance
 * Several instances of one type are normal (a local TTS server, a Kokoro server on
 * another box, a relayed Kokoro).
 */
import path from 'node:path'
import os from 'node:os'
import mistral from './providers/mistral.js'
import elevenlabs from './providers/elevenlabs.js'
import elevenlabsCompatible from './providers/elevenlabs-compatible.js'
import tzekosNative from './providers/tzekos-native.js'
import mimo from './providers/mimo.js'
import lfm3 from './providers/lfm3.js'
import openaiCompatible from './providers/openai-compatible.js'
import dashscope from './providers/dashscope.js'
import browser from './providers/browser.js'
import speechmatics from './providers/speechmatics.js'
import gladia from './providers/gladia.js'
import acapela from './providers/acapela.js'
import readspeaker from './providers/readspeaker.js'
import azure from './providers/azure.js'
import google from './providers/google.js'
import amazon from './providers/amazon.js'
import openai from './providers/openai.js'
import piper from './providers/piper.js'
import xtts from './providers/xtts.js'
import fish from './providers/fish.js'
import cartesia from './providers/cartesia.js'
import deepgram from './providers/deepgram.js'
import assemblyai from './providers/assemblyai.js'
import { resolveCredential, dotenvValue } from './credentials.js'
import fs from 'node:fs'

/**
 * Catalogue order = menu order. The Settings UI groups by each adapter's
 * `group` ('eu' first, then 'other', then 'self'); inside a group this order holds.
 */
export const TYPES = {
  mistral, speechmatics, gladia, acapela, readspeaker,
  elevenlabs, azure, google, amazon, openai, 'openai-compatible': openaiCompatible,
  fish, cartesia, deepgram, assemblyai, mimo, dashscope,
  'elevenlabs-compatible': elevenlabsCompatible, 'tzekos-native': tzekosNative, lfm3, piper, xtts, browser,
}
export const GROUP_ORDER = ['eu', 'other', 'self']
export const RESIDENCY_LABELS = {
  eu: 'EU', 'eu-region': 'EU region available', 'non-eu': 'Outside the EU', self: 'Self-hosted', device: 'On device', varies: 'Depends on the endpoint',
}

/** Static, JSON-safe description of an adapter type for the Settings UI and docs. */
export function typeMeta(a) {
  return {
    type: a.type, label: a.label, hq: a.hq || '', euNote: a.euNote || '', group: a.group || 'other', residency: a.residency || 'varies',
    desc: a.desc || '', docs: a.docs || '', status: a.status || 'unverified', verification: a.verification || '',
    presets: a.presets || [], regions: a.regions || [], optionFields: a.optionFields || [], configFields: a.configFields || [],
    planned: a.status === 'planned',
  }
}
export const TYPE_ORDER = Object.keys(TYPES)

/** The 1.x engine ids, in the 1.x menu order. They are a compatibility surface. */
export const LEGACY_IDS = ['mistral', 'mimo', 'alibaba', 'groq', 'elevenlabs', 'local', 'grey', 'lfm3', 'browser']
/** Retired from automatic routing on 2026-10-12 (ElevenLabs stays selectable). */
export const RETIRED_FROM_AUTO = ['elevenlabs', 'groq', 'alibaba']

const HEALTH_TTL_MS = 60000

function fileValue(file, name) {
  try { return dotenvValue(fs.readFileSync(file, 'utf8'), name) } catch (e) { return '' }
}

/**
 * Instances implied by the environment (spec 6.3). Pure: env and home injectable.
 * `legacy` = settings legacy.engines or DSH_VOICE_LEGACY_ENGINES=1.
 */
export function discover(env, opts) {
  const e = env || process.env
  const o = opts || {}
  const home = o.home || os.homedir()
  const legacy = Boolean(o.legacy) || e.DSH_VOICE_LEGACY_ENGINES === '1'
  const mimoCreds = e.DSH_VOICE_MIMO_CREDS || path.join(home, '.config', 'xiaomi-mimo', 'credentials')
  const mimoBase = e.MIMO_TOKEN_PLAN_BASE_URL || fileValue(mimoCreds, 'MIMO_TOKEN_PLAN_BASE_URL') || mimo.defaultBaseUrl
  const ttsHost = e.DSH_VOICE_TTS_HOST || '127.0.0.1'
  const ttsPort = Number(e.DSH_VOICE_TTS_PORT || 8771)
  const lfmHost = e.DSH_VOICE_LFM3_HOST || '127.0.0.1'
  const lfmPort = Number(e.DSH_VOICE_LFM3_PORT || 11435)
  const aliPayg = Boolean(e.ALIBABA_PAYG_API_KEY)
  const aliHost = e.ALIBABA_PAYG_HOST || e.ALIBABA_BAILIAN_HOST || ''
  return [
    {
      id: 'mistral', type: 'mistral', label: 'Mistral (Voxtral)', enabled: true, inAuto: true,
      baseUrl: e.DSH_VOICE_MISTRAL_BASE || mistral.defaultBaseUrl, credential: 'env:MISTRAL_API_KEY',
      models: { tts: e.DSH_VOICE_MISTRAL_TTS || 'voxtral-mini-tts-latest', stt: e.DSH_VOICE_MISTRAL_STT || 'voxtral-mini-latest', polish: e.DSH_VOICE_MISTRAL_POLISH || 'mistral-small-latest' },
      defaultVoice: e.DSH_VOICE_MISTRAL_VOICE || 'gb_oliver_neutral', options: {},
    },
    {
      id: 'mimo', type: 'mimo', label: 'Xiaomi MiMo', enabled: true, inAuto: true,
      baseUrl: mimoBase, credential: 'env:MIMO_TOKEN_PLAN_API_KEY|file:' + mimoCreds + '#MIMO_TOKEN_PLAN_API_KEY',
      models: {}, defaultVoice: '',
      options: Object.assign({}, e.DSH_VOICE_MIMO_DESIGN ? { designPrompt: e.DSH_VOICE_MIMO_DESIGN } : {}, e.DSH_VOICE_MIMO_CLONE ? { cloneSample: e.DSH_VOICE_MIMO_CLONE } : {}),
    },
    {
      id: 'elevenlabs', type: 'elevenlabs', label: 'ElevenLabs', enabled: true, inAuto: legacy,
      baseUrl: e.DSH_VOICE_ELEVEN_BASE || elevenlabs.defaultBaseUrl, credential: 'env:ELEVENLABS_API_KEY',
      models: { tts: e.DSH_VOICE_ELEVEN_TTS || 'eleven_flash_v2_5', stt: e.DSH_VOICE_ELEVEN_STT || 'scribe_v2' },
      defaultVoice: e.DSH_VOICE_ELEVEN_VOICE || 'onwK4e9ZLuTAKqWW03F9', options: {},
    },
    {
      id: 'local', type: 'elevenlabs-compatible', label: 'Local TTS server (this box)', preset: 'tzekos', enabled: true, inAuto: true,
      baseUrl: 'http://' + ttsHost + ':' + ttsPort, credential: 'env:TTS_API_KEY',
      models: {}, defaultVoice: '', options: { native: true, sttPath: e.DSH_VOICE_STT_PATH || '/v1/speech-to-text-fast' },
    },
    {
      id: 'grey', type: 'tzekos-native', label: e.DSH_VOICE_GREY_LABEL || 'Kokoro (remote)', enabled: true, inAuto: true,
      baseUrl: e.GREY_TTS_URL || '', credential: 'env:GREY_TTS_API_KEY', models: {}, defaultVoice: 'bm_george', options: {},
    },
    {
      id: 'lfm3', type: 'lfm3', label: 'Liquid LFM3 Audio (this box)', enabled: true, inAuto: true,
      baseUrl: 'http://' + lfmHost + ':' + lfmPort, credential: '',
      models: { tts: e.DSH_VOICE_LFM3_TTS_MODEL || 'lfm3-audio-2b' }, defaultVoice: 'female', options: {},
    },
    {
      id: 'groq', type: 'openai-compatible', label: 'Groq (whisper)', enabled: legacy, inAuto: legacy,
      baseUrl: 'https://api.groq.com/openai/v1', credential: 'env:GROQ_API_KEY',
      models: { stt: e.DSH_VOICE_GROQ_STT || 'whisper-large-v3' }, defaultVoice: '', options: { stt: true, tts: false },
    },
    {
      id: 'alibaba', type: 'dashscope', label: 'Alibaba Qwen3 TTS', enabled: legacy && e.DSH_VOICE_ALI_AUDIO === '1', inAuto: legacy,
      baseUrl: aliHost ? 'https://' + aliHost : '', credential: 'env:ALIBABA_PAYG_API_KEY|env:ALIBABA_BAILIAN_API_KEY',
      models: { tts: e.DSH_VOICE_ALI_TTS || (aliPayg ? 'qwen3-tts-flash' : 'qwen-audio-3.0-tts-plus'), stt: e.DSH_VOICE_ALI_STT || 'qwen-audio-3.0-realtime-plus' },
      defaultVoice: 'Cherry', options: { payg: aliPayg },
    },
    { id: 'browser', type: 'browser', label: 'Browser voice', enabled: true, inAuto: true, baseUrl: '', credential: '', models: {}, defaultVoice: '', options: {} },
  ].map((x) => Object.assign({ discovered: true }, x))
}

const filled = (v) => v !== undefined && v !== null && v !== '' && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)

/** Merge discovered instances with settings.providers[] (by id). */
export function mergeInstances(discovered, configured) {
  const out = discovered.map((d) => Object.assign({}, d))
  const byId = new Map(out.map((x) => [x.id, x]))
  for (const p of Array.isArray(configured) ? configured : []) {
    if (!p || !p.id) continue
    const cur = byId.get(p.id)
    if (cur) {
      for (const k of Object.keys(p)) {
        if (k === 'id' || k === 'discovered') continue
        if (k === 'models' || k === 'options') { if (p[k] && typeof p[k] === 'object') cur[k] = Object.assign({}, cur[k] || {}, p[k]) }
        else if (filled(p[k]) || typeof p[k] === 'boolean') cur[k] = p[k]
      }
      cur.overridden = true
    } else {
      if (!TYPES[p.type]) continue
      const t = TYPES[p.type]
      const n = Object.assign({ enabled: true, inAuto: true, label: p.id, baseUrl: t.defaultBaseUrl || '', credential: '', models: {}, defaultVoice: '', options: {} }, p)
      n.models = Object.assign({}, n.models || {})
      n.options = Object.assign({}, n.options || {})
      out.push(n)
      byId.set(n.id, n)
    }
  }
  return out
}

/**
 * Build a registry over effective settings. `state` is a Map kept by the caller
 * across requests (caches: voice lists, ElevenLabs balance, health).
 * opts: { env, home, settings (normalised), state, vault(id) }
 */
export function createRegistry(opts) {
  const o = opts || {}
  const env = o.env || process.env
  const settings = o.settings || {}
  const state = o.state || new Map()
  const legacy = Boolean(settings.legacy && settings.legacy.engines)
  const list = mergeInstances(discover(env, { home: o.home, legacy }), settings.providers)
    .filter((x) => TYPES[x.type])
    .map((x) => {
      const key = x.id + '|' + x.type + '|' + (x.baseUrl || '')
      if (!state.has(key)) state.set(key, {})
      const inst = Object.assign({}, x)
      inst.state = state.get(key)
      inst.secret = () => {
        const c = String(x.credential || '')
        if (c.startsWith('vault:')) return o.vault ? o.vault(c.slice(6)) : ''
        return resolveCredential(c, { env, home: o.home })
      }
      return inst
    })
  const byId = new Map(list.map((x) => [x.id, x]))

  const reg = {
    list() {
      return list.slice().sort((a, b) => {
        const la = LEGACY_IDS.indexOf(a.id)
        const lb = LEGACY_IDS.indexOf(b.id)
        if (la >= 0 && lb >= 0) return la - lb
        return TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || (la >= 0 ? -1 : lb >= 0 ? 1 : 0)
      })
    },
    get(id) { return byId.get(String(id || '')) || null },
    adapter(inst) { return inst ? TYPES[inst.type] : null },
    /** Effective group and residency of an instance (instance field, adapter hook, adapter default). */
    group(inst) { return (inst && inst.group) || (inst && TYPES[inst.type] && TYPES[inst.type].group) || 'other' },
    residency(inst) {
      if (!inst) return 'varies'
      const a = TYPES[inst.type]
      if (inst.residency) return inst.residency
      if (a && typeof a.residencyOf === 'function') { try { const r = a.residencyOf(inst); if (r) return r } catch (e) { /* adapter default */ } }
      return (a && a.residency) || 'varies'
    },
    caps(inst) { return inst ? TYPES[inst.type].capabilities(inst) : {} },

    /** Usable for a direction right now (enabled, configured, not known down where health gates routing). */
    available(inst, dir) {
      if (!inst || !inst.enabled) return false
      const a = TYPES[inst.type]
      const c = a.capabilities(inst)
      if (dir && !c[dir]) return false
      if (!a.configured(inst)) return false
      if (c.healthGatesRouting && inst.state.health && inst.state.health.status === 'down') return false
      return true
    },

    /** May automatic routing use it? (available + inAuto; the retired engines need legacy.engines). */
    autoOk(inst, dir) { return reg.available(inst, dir) && inst.inAuto !== false },

    /** Does the instance cover a language for automatic routing? */
    covers(inst, dir, lang) {
      const c = reg.caps(inst)
      const langs = dir === 'tts' ? c.ttsLangs : c.sttLangs
      if (langs === '*') return true
      return Array.isArray(langs) && langs.indexOf(String(lang || 'en').slice(0, 2)) >= 0
    },

    /** Cached health (60 s). Types flagged noProbe never touch the network here. */
    async health(inst, force) {
      if (!inst) return { ok: false, status: 'down', detail: 'unknown provider' }
      const st = inst.state
      const now = Date.now()
      if (!force && st.health && now - (st.healthAt || 0) < HEALTH_TTL_MS) return st.health
      let h
      try { h = await TYPES[inst.type].health(inst) } catch (e) { h = { ok: false, status: 'down', detail: String(e && e.message || e).slice(0, 160) } }
      st.health = h
      st.healthAt = now
      return h
    },

    /** The 1.x providers() map: { mistral, mimo, alibaba, groq, elevenlabs, local, grey, lfm3 }. */
    legacyAvail() {
      const out = {}
      for (const id of LEGACY_IDS) {
        if (id === 'browser') continue
        const inst = byId.get(id)
        out[id] = Boolean(inst && reg.available(inst) && (RETIRED_FROM_AUTO.indexOf(id) < 0 || inst.inAuto !== false || id === 'elevenlabs'))
      }
      return out
    },
  }
  return reg
}
