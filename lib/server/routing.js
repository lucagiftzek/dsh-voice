/**
 * dsh-voice: which instance speaks or transcribes a request.
 *
 * Order for one segment (spec 4.3): marker override > manual pick (the request's
 * `provider` when not 'auto') > perLanguage[lang] > perLanguage['*'] > tail.
 *
 * A perLanguage entry whose provider is 'auto' runs the 1.x chain below, which
 * is what every install gets with no settings: en -> mimo, then mistral; el, it
 * and the rest -> local (Maya1 / whisper); ElevenLabs, Groq and Alibaba stay
 * out unless legacy.engines is on. An explicit entry is tried as written
 * (provider, then its fallback list, an explicit entry is honoured even for a
 * language it is not listed for), then any inAuto instance that covers the
 * language (catalogue order), then the browser voice.
 *
 * Routing picks by availability, it never retries on failure: a provider switch
 * inside a segment after a failure is not allowed (1.x pipeline semantics).
 */
import { lang2 } from './http.js'

const MIMO_LANGS = ['en', 'zh']
const MISTRAL_TTS_LANGS = ['en']
const MISTRAL_STT_LANGS = ['en', 'fr']
const ALI_TTS_LANGS = ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it']

/** 1.x chooseTts, over registry instances. */
export function chooseTtsLegacy(lang, reg) {
  const l = lang2(lang)
  const ok = (id) => { const i = reg.get(id); return Boolean(i && reg.autoOk(i, 'tts')) }
  const dry = (id) => { const i = reg.get(id); const a = reg.adapter(i); return Boolean(a && a.isDry && a.isDry(i)) }
  if (ok('mimo') && MIMO_LANGS.includes(l)) return 'mimo'
  if (ok('mistral') && MISTRAL_TTS_LANGS.includes(l)) return 'mistral'
  if (ok('alibaba') && ALI_TTS_LANGS.includes(l)) return 'alibaba'
  if (ok('elevenlabs') && !dry('elevenlabs')) return 'elevenlabs'
  if (ok('local')) return 'local'
  if (ok('elevenlabs')) return 'elevenlabs'
  if (ok('mistral')) return 'mistral'
  return 'browser'
}

/** 1.x chooseStt, over registry instances. null when nothing can transcribe. */
export function chooseSttLegacy(lang, reg) {
  const l = lang2(lang)
  const ok = (id) => { const i = reg.get(id); return Boolean(i && reg.autoOk(i, 'stt')) }
  if (ok('mimo') && MIMO_LANGS.includes(l)) return 'mimo'
  if (ok('mistral') && MISTRAL_STT_LANGS.includes(l)) return 'mistral'
  if (ok('local') && !MISTRAL_STT_LANGS.includes(l)) return 'local'
  if (ok('groq')) return 'groq'
  if (ok('alibaba')) return 'alibaba'
  if (ok('mistral')) return 'mistral'
  if (ok('local')) return 'local'
  return null
}

/** The perLanguage entry for a language ('*' when the language has none). */
export function entryFor(settings, lang, dir) {
  const per = (settings && settings.perLanguage) || {}
  const l = lang2(lang)
  const e = (per[l] && per[l][dir]) || (per['*'] && per['*'][dir]) || null
  return e || { provider: 'auto', fallback: [] }
}

async function notDry(reg, inst) {
  const a = reg.adapter(inst)
  if (!a || !a.isDry) return true
  if (a.quota) { try { await a.quota(inst) } catch (e) { /* unknown counts as not dry */ } }
  return !a.isDry(inst)
}

/**
 * Resolve TTS. Returns { id, inst, model, voice, speed, source } where source is
 * 'manual' | 'marker' | 'lang' | 'legacy' | 'tail' | 'browser'. For a manual pick
 * the instance is returned even when unavailable (the route answers 503 with
 * the 1.x message).
 */
export async function resolveTts({ lang, provider, settings, reg }) {
  const asked = String(provider || 'auto')
  if (asked !== 'auto') return { id: asked, inst: reg.get(asked), source: 'manual' }
  const e = entryFor(settings, lang, 'tts')
  if (!e.provider || e.provider === 'auto') {
    const id = chooseTtsLegacy(lang, reg)
    // 1.x refreshed the ElevenLabs balance before an auto read in a language
    // Mistral cannot voice; the legacy chain only reaches it with legacy.engines.
    if (id === 'elevenlabs') {
      const inst = reg.get(id)
      if (!(await notDry(reg, inst))) { const again = chooseTtsLegacy(lang, reg); return { id: again, inst: reg.get(again), source: 'legacy' } }
    }
    return { id, inst: reg.get(id), source: 'legacy' }
  }
  const chain = [e.provider].concat(e.fallback || [])
  for (let k = 0; k < chain.length; k += 1) {
    const id = chain[k]
    if (id === 'browser') return { id: 'browser', inst: reg.get('browser'), source: 'browser' }
    const inst = reg.get(id)
    if (!inst || !reg.available(inst, 'tts')) continue
    if (!(await notDry(reg, inst))) continue
    const own = k === 0
    return { id, inst, source: 'lang', model: own ? e.model || '' : '', voice: own ? e.voice || '' : '', speed: own ? e.speed || 1 : 1 }
  }
  for (const inst of reg.list()) {
    if (inst.type === 'browser') continue
    if (!reg.autoOk(inst, 'tts') || !reg.covers(inst, 'tts', lang)) continue
    if (!(await notDry(reg, inst))) continue
    return { id: inst.id, inst, source: 'tail' }
  }
  return { id: 'browser', inst: reg.get('browser'), source: 'browser' }
}

/** Resolve STT. Same shape; id null when nothing can transcribe. */
export async function resolveStt({ lang, provider, settings, reg }) {
  const asked = String(provider || 'auto')
  if (asked !== 'auto') return { id: asked, inst: reg.get(asked), source: 'manual' }
  const e = entryFor(settings, lang, 'stt')
  if (!e.provider || e.provider === 'auto') {
    const id = chooseSttLegacy(lang, reg)
    return { id, inst: id ? reg.get(id) : null, source: 'legacy' }
  }
  const chain = [e.provider].concat(e.fallback || [])
  for (let k = 0; k < chain.length; k += 1) {
    const inst = reg.get(chain[k])
    if (!inst || !reg.available(inst, 'stt')) continue
    return { id: inst.id, inst, source: 'lang', model: k === 0 ? e.model || '' : '' }
  }
  for (const inst of reg.list()) {
    if (!reg.autoOk(inst, 'stt') || !reg.covers(inst, 'stt', lang)) continue
    return { id: inst.id, inst, source: 'tail' }
  }
  return { id: null, inst: null, source: 'none' }
}

/** What automatic routing resolves to per language, for /config and the Settings table. */
export async function routesFor(langs, settings, reg) {
  const out = {}
  for (const l of langs) {
    const t = await resolveTts({ lang: l === '*' ? 'xx' : l, settings, reg })
    const s = await resolveStt({ lang: l === '*' ? 'xx' : l, settings, reg })
    out[l] = { tts: t.id, ttsSource: t.source, stt: s.id, sttSource: s.source }
  }
  return out
}
