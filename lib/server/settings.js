/**
 * dsh-voice: settings shape, defaults, schema, redaction and normalisation.
 *
 * COMPATIBILITY RULE: with no stored settings at all, every install routes
 * exactly as 1.x did. `perLanguage.<lang>.tts.provider: 'auto'` means "the
 * built-in 1.x chain" (routing.js chooseTtsLegacy / chooseSttLegacy), and the
 * shipped defaults are 'auto' for every language. The spec's generic table
 * (section 4.4) ships as RECOMMENDED, applied per language with one click in
 * Settings. So no install needs a pin to keep its behaviour, and a pin cannot
 * be lost when a DSH upgrade drops plugin sections from settings.yaml.
 */
import { isPointer } from './credentials.js'
import { liveObject } from '../dual-settings.js'

export const SECRET_MARK = '__set__'

const chain = (provider, extra) => Object.assign({ provider: provider || 'auto', model: '', voice: '', speed: 1, fallback: [] }, extra || {})
const sttChain = (provider, extra) => Object.assign({ provider: provider || 'auto', model: '', fallback: [] }, extra || {})

/** Spec 4.4 "Generic default" column, offered as "Apply recommended". */
export const RECOMMENDED = {
  en: { tts: chain('mistral', { model: 'voxtral-mini-tts-3-0', voice: 'gb_oliver_neutral', fallback: ['mimo', 'elevenlabs', 'browser'] }), stt: sttChain('mistral', { model: 'voxtral-mini-transcribe-3', fallback: ['mimo', 'local'] }) },
  it: { tts: chain('mistral', { model: 'voxtral-mini-tts-3-0', voice: 'voice_482', fallback: ['elevenlabs', 'lfm3', 'local', 'browser'] }), stt: sttChain('local', { model: 'small', fallback: ['mistral'] }) },
  el: { tts: chain('elevenlabs', { model: 'eleven_multilingual_v2', fallback: ['lfm3', 'local', 'browser'] }), stt: sttChain('local', { model: 'small', fallback: ['elevenlabs'] }) },
  '*': { tts: chain('auto'), stt: sttChain('auto') },
}

export const DEFAULTS = {
  providers: [],
  languages: { enabled: ['en', 'it', 'el'], primary: 'en' },
  perLanguage: {
    en: { tts: chain('auto'), stt: sttChain('auto') },
    it: { tts: chain('auto'), stt: sttChain('auto') },
    el: { tts: chain('auto'), stt: sttChain('auto') },
    '*': { tts: chain('auto'), stt: sttChain('auto') },
  },
  detection: {
    mode: 'heuristic+model',
    model: { provider: 'mistral', model: 'mistral-small-latest' },
    fallbackModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
    minConfidence: 0.75, timeoutMs: 2500, maxChars: 4000,
  },
  markers: { enabled: true, askAssistantToTag: false },
  reading: {
    autoRead: 'off', highlight: 'word', rate: 1, nativeSpeed: false, queue: 'replace',
    readCode: false, links: 'domain', fallbackToBrowser: true,
    chunk: { first: 110, rest: 260, localFirst: 400, localRest: 900 },
  },
  dictation: {
    mode: 'toggle', lang: 'auto', insert: 'caret',
    polish: { enabled: true, model: { provider: 'mistral', model: 'mistral-small-latest' } },
    markLanguages: false, liveInterim: false,
  },
  shortcuts: {
    readLast: 'Alt+Shift+R', playPause: 'Alt+Shift+P', stop: 'Alt+Shift+S',
    nextSentence: 'Alt+Shift+.', prevSentence: 'Alt+Shift+,', faster: 'Alt+Shift+=', slower: 'Alt+Shift+-',
    dictate: 'Alt+Shift+M', dictationLang: 'Alt+Shift+L',
  },
  privacy: { storeAudio: false, audioCacheMinutes: 0, logTranscripts: false },
  security: { trustedHosts: [], requireHarnessCookie: true, rateLimit: { ttsPerMin: 60, sttPerMin: 30, detectPerMin: 60, polishPerMin: 30 } },
  reader: { enabled: true, rememberText: true },
  legacy: { engines: false },
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x)

/** Deep merge for plain objects; arrays and scalars from `over` replace. */
export function deepMerge(base, over) {
  if (!isObj(base)) return over === undefined ? base : over
  const out = Object.assign({}, base)
  if (!isObj(over)) return out
  for (const k of Object.keys(over)) {
    if (k === '__proto__' || k === 'constructor') continue
    out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k]
  }
  return out
}

function cleanChain(c, stt) {
  const d = stt ? sttChain('auto') : chain('auto')
  const x = deepMerge(d, isObj(c) ? c : {})
  x.provider = String(x.provider || 'auto')
  x.model = String(x.model || '')
  x.fallback = Array.isArray(x.fallback) ? x.fallback.map(String).filter(Boolean).slice(0, 8) : []
  if (!stt) {
    x.voice = String(x.voice || '')
    const sp = Number(x.speed)
    x.speed = sp >= 0.25 && sp <= 4 ? sp : 1
  } else { delete x.voice; delete x.speed }
  return x
}

/** Resolved settings: defaults, then the stored layers, then sanity. */
export function normalise(raw) {
  // Clone first: deepMerge copies one level, and a caller mutating the result must never reach DEFAULTS.
  const s = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), isObj(raw) ? JSON.parse(JSON.stringify(raw)) : {})
  s.providers = Array.isArray(s.providers) ? s.providers.filter((p) => isObj(p) && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(String(p.id || ''))) : []
  const per = {}
  const langs = new Set(Object.keys(DEFAULTS.perLanguage).concat(Object.keys(isObj(s.perLanguage) ? s.perLanguage : {})))
  for (const l of langs) {
    if (!/^(\*|[a-z]{2,3})$/.test(l)) continue
    const src = (isObj(s.perLanguage) && s.perLanguage[l]) || {}
    per[l] = { tts: cleanChain(src.tts, false), stt: cleanChain(src.stt, true) }
  }
  s.perLanguage = per
  if (!Array.isArray(s.languages.enabled) || !s.languages.enabled.length) s.languages.enabled = DEFAULTS.languages.enabled.slice()
  s.languages.enabled = s.languages.enabled.map((x) => String(x).toLowerCase()).filter((x) => /^[a-z]{2,3}$/.test(x))
  for (const l of s.languages.enabled) if (!per[l]) per[l] = { tts: cleanChain(null, false), stt: cleanChain(null, true) }
  if (!Array.isArray(s.security.trustedHosts)) s.security.trustedHosts = []
  return s
}

/** Is a stored credential a secret (literal or vault entry) rather than a visible pointer? */
export function isSecretCredential(c) {
  const s = String(c || '').trim()
  return Boolean(s) && !isPointer(s)
}

/**
 * Settings for the wire: every literal credential becomes '__set__' (or '').
 * Pointers (env:NAME, file:/path#NAME, dsh-ref:NAME) are names, shown in clear.
 * Same contract as dsh-phone's redact().
 */
export function redact(settings) {
  const s = JSON.parse(JSON.stringify(settings || {}))
  for (const p of Array.isArray(s.providers) ? s.providers : []) {
    if ('credential' in p) p.credential = isSecretCredential(p.credential) ? SECRET_MARK : (p.credential || '')
  }
  return s
}

/**
 * Apply a patch from the UI. '__set__' keeps the stored secret of the same
 * provider id; any other value replaces it. Unknown top-level keys are dropped.
 */
export function sanitisePatch(patch, current) {
  const out = isObj(patch) ? JSON.parse(JSON.stringify(patch)) : {}
  delete out.__proto__
  for (const k of Object.keys(out)) if (!(k in DEFAULTS)) delete out[k]
  if (Array.isArray(out.providers)) {
    const cur = new Map(((current && current.providers) || []).map((p) => [p.id, p]))
    out.providers = out.providers.filter(isObj).map((p) => {
      const q = Object.assign({}, p)
      if (q.credential === SECRET_MARK) q.credential = (cur.get(q.id) && cur.get(q.id).credential) || ''
      for (const bad of ['secret', 'state', 'key']) delete q[bad]
      return q
    })
  }
  return out
}

/**
 * The plugin's settings schema, built with the RUNNING harness's schemastery:
 * registered as the `dsh-voice` namespace on DSH 0.1.5 and exported as the
 * `Config` of the cordis row on 0.2.x. Every top-level key is declared (the 0.2
 * Loader validates the row against it) and live (`.volatile()` where the host
 * supports it), so edits apply without a remount. Permissive on purpose: a
 * stored section that fails the schema rejects the registration.
 */
export function settingsSchema(z) {
  if (!z) return null
  const any = () => (typeof z.any === 'function' ? z.any() : z.dict(z.string()))
  const D = DEFAULTS
  // providers[] stays free-form: a partial override entry (only {id, enabled})
  // is normal, and literal credentials never land here anyway (they go to the
  // plugin's own 0600 vault file, the setting holds a vault: pointer).
  return liveObject(z, {
    providers: z.array(any()).default([]).description('Speech provider instances. Env-discovered ones (Mistral, MiMo, local TTS server, remote Kokoro, LFM3, ElevenLabs) exist without an entry; an entry with the same id overrides them.'),
    languages: z.object({ enabled: z.array(z.string()).default(D.languages.enabled), primary: z.string().default('en') }),
    perLanguage: z.dict(any()).default(D.perLanguage).description('Per-language TTS and STT: provider ("auto" = the built-in chain), model, voice, speed, fallback list.'),
    detection: any().default(D.detection),
    markers: z.object({ enabled: z.boolean().default(true), askAssistantToTag: z.boolean().default(false) }),
    reading: any().default(D.reading),
    dictation: any().default(D.dictation),
    shortcuts: z.dict(z.string()).default(D.shortcuts),
    privacy: any().default(D.privacy),
    security: z.object({ trustedHosts: z.array(z.string()).default([]), requireHarnessCookie: z.boolean().default(true), rateLimit: z.dict(z.number()).default(D.security.rateLimit) }),
    reader: any().default(D.reader),
    legacy: z.object({ engines: z.boolean().default(false).description('Re-enable the retired Groq, ElevenLabs-in-auto and Alibaba routing (same as DSH_VOICE_LEGACY_ENGINES=1).') }),
  })
}
