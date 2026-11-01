/**
 * dsh-voice client: reactive stores shared by every button on the page
 * (per-browser prefs, /api/voice/config, the ElevenLabs balance).
 * Ported from the 1.x client unchanged in behaviour.
 */
import * as React from 'react'

export const PREF_KEY = 'dsh-voice.engine'
export const VOICE_KEY = 'dsh-voice.voice'          // which ElevenLabs voice reads
export const ALIVOICE_KEY = 'dsh-voice.alivoice'    // which Qwen3-TTS voice reads
export const MODEL_KEY = 'dsh-voice.localmodel'
export const MIMOVOICE_KEY = 'dsh-voice.mimovoice'  // which MiMo voice reads
export const LFM3VOICE_KEY = 'dsh-voice.lfm3voice'  // which LFM3-Audio timbre reads
export const RATE_KEY = 'dsh-voice.rate'
/** '1' (default): when the chosen engine fails, the browser voice reads and the row SAYS so. '0': show the error. */
export const FALLBACK_KEY = 'dsh-voice.fallback'
export const RATES = ['0.75', '1', '1.25', '1.5', '1.75', '2', '3']

/**
 * Engines on the menu. MUST list every static engine the menu offers: an id
 * missing here is rewritten to 'auto' and the select snaps back (that is how
 * lfm3 behaved on 2026-10-29). Instances added in Settings are accepted when
 * /config lists them. ElevenLabs is selectable again in 2.0 (never in auto).
 */
export const MENU_ENGINES = ['auto', 'mimo', 'mistral', 'elevenlabs', 'lfm3', 'local', 'grey', 'browser']
export function cleanEngine(e, cfg) {
  if (MENU_ENGINES.indexOf(e) >= 0) return e
  if (cfg && Array.isArray(cfg.providers) && cfg.providers.some((p) => p.id === e && p.enabled)) return e
  return 'auto'
}

export function readPref(key, dflt) {
  try { return window.localStorage.getItem(key) || dflt } catch (e) { return dflt }
}
const prefListeners = new Set()
/** The only writer: a change in the composer must reach the buttons already on screen. */
export function writePref(key, v) {
  try { window.localStorage.setItem(key, v) } catch (e) { /* private mode */ }
  prefListeners.forEach((fn) => { try { fn(key, v) } catch (e) { /* contained */ } })
}
export function usePref(key, dflt) {
  const [v, setV] = React.useState(() => readPref(key, dflt))
  React.useEffect(() => {
    const fn = (k) => { if (k === key) setV(readPref(key, dflt)) }
    prefListeners.add(fn)
    return () => { prefListeners.delete(fn) }
  }, [key])
  return v
}

/** Speed is client side (playbackRate, pitch preserved): one knob, same meaning for every engine. */
export function readRate() {
  const v = parseFloat(readPref(RATE_KEY, '1'))
  return isFinite(v) && v >= 0.25 && v <= 4 ? v : 1
}

/** A one-way engine picked for the other leg degrades to 'auto' instead of a 503. */
export function directionEngine(engine, cfg, dir) {
  if (!engine || engine === 'auto') return engine
  const e = cfg && cfg.engines && cfg.engines[engine]
  if (e && e[dir] === false) return 'auto'
  return engine
}

// ---- /api/voice/config, one fetch shared by every button, re-read on menu focus (20 s TTL)
let configPromise = null
let configValue = null
let configAt = 0
const CONFIG_TTL_MS = 20000
const configListeners = new Set()
export function loadConfig() {
  if (!configPromise) {
    configPromise = fetch('/api/voice/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (c) { configValue = c; configAt = Date.now() } return c })
      .catch(() => null)
  }
  return configPromise
}
/** The last fetched /config (null before the first answer). */
export function currentConfig() { return configValue }
export function refreshConfig(force) {
  if (!force && configAt && Date.now() - configAt < CONFIG_TTL_MS) return Promise.resolve(configValue)
  configPromise = null
  return loadConfig().then((c) => {
    configListeners.forEach((fn) => { try { fn(c) } catch (e) { /* contained */ } })
    return c
  })
}
export function useConfig() {
  const [cfg, setCfg] = React.useState(configValue)
  React.useEffect(() => {
    let alive = true
    const onCfg = (c) => { if (alive) setCfg(c) }
    configListeners.add(onCfg)
    loadConfig().then(onCfg)
    return () => { alive = false; configListeners.delete(onCfg) }
  }, [])
  return cfg
}

// ---- the ElevenLabs balance, refreshed after each read (the server rate-limits it)
let quotaValue = null
let quotaPromise = null
const quotaListeners = new Set()
function publishQuota(q) {
  if (q) quotaValue = q
  quotaListeners.forEach((fn) => { try { fn(quotaValue) } catch (e) { /* contained */ } })
}
export function loadQuota() {
  if (quotaPromise) return quotaPromise
  const p = fetch('/api/voice/quota')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && j.quota) publishQuota(j.quota); return j })
    .catch(() => null)
    .then((j) => { if (quotaPromise === p) quotaPromise = null; return j })
  quotaPromise = p
  return p
}
export function useQuota() {
  const [q, setQ] = React.useState(quotaValue)
  React.useEffect(() => {
    let alive = true
    const fn = (v) => { if (alive) setQ(v) }
    quotaListeners.add(fn)
    loadQuota()
    return () => { alive = false; quotaListeners.delete(fn) }
  }, [])
  return q
}

// ---- ElevenLabs helpers (names and balance phrasing; the server owns the numbers)
export function voiceLabel(v) {
  if (!v) return ''
  const l = v.labels || {}
  const bits = [l.accent, l.gender].filter(Boolean).join(', ')
  return bits ? v.name + ' (' + bits + ')' : v.name
}
export function voiceShort(v) { return v ? String(v.name || '').split(' - ')[0] : '' }
export function elevenOf(cfg) { return ((cfg || {}).engines || {}).elevenlabs || {} }
export function findVoice(cfg, id) {
  const list = elevenOf(cfg).voices || []
  for (let i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i]
  return null
}
export function quotaText(q) {
  if (!q) return ''
  const when = q.resetsAt ? new Date(q.resetsAt).toISOString().slice(0, 10) : ''
  if (q.remaining <= 0) return 'No ElevenLabs credits left (' + q.used + ' of ' + q.limit + ' used on the ' + q.tier + ' plan' + (when ? '; resets ' + when : '') + ')'
  return q.remaining + ' of ' + q.limit + ' ElevenLabs credits left' + (when ? '; resets ' + when : '')
}
export function clampWhy(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  const cut = t.slice(0, n)
  const sp = cut.lastIndexOf(' ')
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut) + '\u2026'
}
export function charsLeftIn(cfg, q) {
  if (!q) return null
  const per = elevenOf(cfg).creditsPerChar || 0.5
  return Math.floor((q.remaining || 0) / per)
}
export const fmtChars = (n) => Number(n).toLocaleString('en-US')
export function elevenVoiceName(cfg, picked) {
  const el = elevenOf(cfg)
  return voiceShort(findVoice(cfg, picked) || findVoice(cfg, el.defaultVoice))
}

/** The local box names its own models (its /health); this only prettifies. */
export const LM_LABELS = {
  maya: 'Maya1 3B \u00b7 expressive', kokoro: 'Kokoro 82M \u00b7 fast', qwen: 'Qwen3 1.7B \u00b7 inert here',
  base: 'whisper base \u00b7 snappy', 'base.en': 'whisper base.en \u00b7 English-only',
  small: 'whisper small', medium: 'whisper medium \u00b7 best, slowest',
}

/** The local model pick, only when valid for THIS direction (lists come from the local server via /config). */
export function localPick(cfg, engine, sel, dir) {
  if (engine !== 'local' || !sel || sel === 'auto') return ''
  const mo = (((cfg || {}).engines || {}).local || {}).models
  if (!mo) return ''
  const list = dir === 'tts' ? (mo.tts || []) : (mo.stt || [])
  return list.indexOf(sel) >= 0 ? sel : ''
}

/** What `auto` resolves to for a language, from the server's published routes. */
export function autoFor(cfg, lang) {
  if (!cfg) return null
  const l = String(lang || 'en').toLowerCase().slice(0, 2)
  const r = cfg.routes && (cfg.routes[l] || cfg.routes['*'])
  if (r && r.tts) return r.tts
  if (!cfg.defaults) return null
  return (l === 'en' || l === 'fr') ? cfg.defaults.tts : (cfg.defaults.ttsNonEnglish || cfg.defaults.tts)
}
