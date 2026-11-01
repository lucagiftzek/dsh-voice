/**
 * dsh-voice: the /api/voice/* handler.
 *
 * 1.x routes, contracts unchanged (callers: this plugin's client, dsh-tts-reader,
 * dsh-note-keeper, older copies on other installs):
 *   GET  /config   engines{<id>}, defaults{tts,stt,ttsNonEnglish}, polish, ttsHealth  (+ v2 superset)
 *   GET  /quota    ElevenLabs balance, vendor call at most every 3 s
 *   POST /tts      {text, provider, lang, model, voice} -> audio (x-voice-engine, -voice, -note, -error-code)
 *   POST /stt      multipart `file`, ?provider&lang&model -> {text, language, engine, fellBackFrom?}
 *   POST /polish   {text} -> {text, polished, engine?, reason?}, never fails hard
 * New in 2.0 (gated, see security.js):
 *   GET  /session            capability token for the mutating routes
 *   GET  /settings           redacted settings, effective instances, types, recommended
 *   PATCH|POST /settings     sanitised patch ('__set__' keeps a stored secret)
 *   POST /test               {provider, lang?} speak "Hello. Ciao. Γεια σας." and transcribe it back
 *   GET  /voices?provider&lang
 *   GET  /models             DSH model list (ctx.llm) for the detection and polish pickers
 *   GET  /doctor             read-only self-check (docs/TROUBLESHOOTING.md), same gate as /settings
 *   POST /detect             {text, mode?} -> segments (markers, heuristics, then one batched model call via ctx.llm)
 *   POST /tts?alignment=1    JSON {audio_base64, mime, alignment, engine, voice}
 */
import { readBody, sendJson, sendAudio, parseJson, extractFilePart, lang2 } from './http.js'
import { normalise, redact, RECOMMENDED, SECRET_MARK } from './settings.js'
import { createRegistry, TYPES, typeMeta, GROUP_ORDER, RESIDENCY_LABELS } from './registry.js'
import { resolveTts, resolveStt, routesFor } from './routing.js'
import { polish, polishConfig, ollamaUp } from './polish.js'
import { describeCredential } from './credentials.js'
import { checkReadRequest, checkMutateRequest, isLoopbackPeer, mintToken, createRateLimiter, checkProviderEntry } from './security.js'
import dns from 'node:dns'
import { charsLeft, CREDITS_PER_CHAR } from './providers/elevenlabs.js'
import { detectSegments, createDetectCache } from './detect.js'
import { retirementNotes } from '../shared/retirements.js'
import { E, codeFor, sendFailure } from '../errors.js'
import { runDoctor } from './doctor.js'

const TEST_PHRASE = 'Hello. Ciao. \u0393\u03b5\u03b9\u03b1 \u03c3\u03b1\u03c2.'

/** The 1.x 503 sentences, per engine id, when an engine is asked for but not usable. */
function unavailableMessage(id, inst, dir, reg) {
  if (!inst) return 'unknown voice provider "' + id + '"'
  const caps = reg.caps(inst)
  if (dir === 'tts' && !caps.tts) return id + ' is speech-to-text only'
  if (dir === 'stt' && !caps.stt) return id + ' is text-to-speech only'
  const host = (() => { try { return new URL(inst.baseUrl).host } catch (e) { return inst.baseUrl } })()
  const m = {
    alibaba: 'alibaba not configured',
    elevenlabs: dir === 'tts' ? 'ELEVENLABS_API_KEY not set for dsh-web' : 'ELEVENLABS_API_KEY not set',
    groq: 'GROQ_API_KEY not set for dsh-web',
    mistral: dir === 'tts' ? 'MISTRAL_API_KEY not set for dsh-web' : 'MISTRAL_API_KEY not set',
    mimo: dir === 'tts' ? 'MiMo token-plan key not found (~/.config/xiaomi-mimo/credentials)' : 'MiMo token-plan key not found',
    local: dir === 'tts' ? 'TTS_API_KEY not set for dsh-web' : 'TTS_API_KEY not set',
    lfm3: dir === 'tts' ? 'the LFM3 audio model is not answering on ' + host : 'the LFM3 audio model is not answering',
    grey: 'GREY_TTS_URL / GREY_TTS_API_KEY not set for dsh-web',
  }
  if (!inst.enabled && (inst.overridden || !m[id])) return inst.label + ' is disabled in Settings'
  return m[id] || (inst.label + ' is not configured')
}

export function createHandler(svc) {
  const warn = svc.warn || (() => {})
  const state = svc.state || new Map()
  const limiter = createRateLimiter()
  const detectCache = svc.detectCache || createDetectCache()
  const polishCfg = polishConfig(svc.env)

  const current = () => {
    const settings = normalise(svc.store.raw())
    const reg = createRegistry({ env: svc.env, home: svc.home, settings, state, vault: (id) => svc.store.vault(id) })
    return { settings, reg }
  }

  const gateRead = (req, res, s) => {
    const g = checkReadRequest(req, { trustedHosts: s.security.trustedHosts })
    if (!g.ok) E.send(res, 'VOICE_READ_REFUSED', { message: g.reason, status: g.status })
    return g.ok
  }
  const gateMutate = (req, res, s) => {
    const g = checkMutateRequest(req, { trustedHosts: s.security.trustedHosts, secret: svc.secret(), requireHarnessCookie: s.security.requireHarnessCookie })
    if (!g.ok) E.send(res, 'VOICE_WRITE_REFUSED', { message: g.reason, status: g.status, layer: g.layer })
    return g.ok
  }
  /**
   * /detect is called by the read-aloud button like /tts and /polish, so it is
   * gated the same light way (no trustedHosts pin needed behind the proxy):
   * loopback peer, never cross-site, and an Origin, when sent, equal to Host.
   * The rate limit bounds what it can spend on the model.
   */
  const gatePost = (req, res) => {
    const host = String(req.headers.host || '')
    const origin = req.headers.origin
    let sameOrigin = true
    if (origin) { try { sameOrigin = new URL(origin).host === host } catch (e) { sameOrigin = false } }
    const ok = isLoopbackPeer(req.socket && req.socket.remoteAddress) && req.headers['sec-fetch-site'] !== 'cross-site' && sameOrigin
    if (!ok) E.send(res, 'VOICE_UNTRUSTED_REQUEST', { message: 'untrusted request' })
    return ok
  }

  /** Refuse a browser request from another site: Sec-Fetch-Site cross-site, or an Origin whose host differs from Host. */
  const crossSiteOk = (req) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = req.headers.origin
    if (!origin || origin === 'null') return origin !== 'null'
    try { return new URL(origin).host === String(req.headers.host || '') } catch (e) { return false }
  }

  const abortOnClose = (res) => {
    const ac = new AbortController()
    res.on('close', () => { if (!res.writableFinished) ac.abort() })
    return ac.signal
  }

  async function engineBlock(inst, reg) {
    const a = reg.adapter(inst)
    const caps = a.capabilities(inst)
    const avail = reg.available(inst)
    const extra = a.legacyConfig ? await a.legacyConfig(inst, avail).catch((e) => ({ note: 'config failed: ' + String(e && e.message || e).slice(0, 120) })) : {}
    return Object.assign({
      available: avail,
      tts: Boolean(caps.tts) && avail,
      stt: Boolean(caps.stt) && avail,
    }, extra, {
      v2: { type: inst.type, label: inst.label, group: reg.group(inst), residency: reg.residency(inst), inAuto: inst.inAuto !== false, alignment: caps.alignment, chunkPlan: a.chunkPlan ? a.chunkPlan(inst) : null, clientOnly: Boolean(caps.clientOnly) },
    })
  }

  async function config() {
    const { settings, reg } = current()
    // Probes 1.x ran on every /config: the local TTS server /health (inside its
    // legacyConfig), ollama, and the LFM3 router. Relay-safe types never probe.
    const lfm = reg.get('lfm3')
    if (lfm) await reg.health(lfm)
    const ollama = await ollamaUp(polishCfg)
    const engines = {}
    for (const inst of reg.list()) engines[inst.id] = await engineBlock(inst, reg)
    // browser keeps the 1.x shape exactly
    engines.browser = Object.assign({}, engines.browser, { available: true, tts: true, stt: false })
    const en = await resolveTts({ lang: 'en', settings, reg })
    const el = await resolveTts({ lang: 'el', settings, reg })
    const sttEn = await resolveStt({ lang: 'en', settings, reg })
    const local = reg.get('local')
    const mistralOk = Boolean(reg.get('mistral') && reg.available(reg.get('mistral')))
    const langs = settings.languages.enabled.concat(['*'])
    return {
      ok: true,
      engines,
      defaults: { tts: en.id, stt: sttEn.id, ttsNonEnglish: el.id },
      polish: { primary: mistralOk ? ((reg.get('mistral').models || {}).polish || 'mistral-small-latest') : polishCfg.localModel, fallback: polishCfg.localModel, localAvailable: ollama },
      ttsHealth: local && local.state.health ? 200 : 0,
      v: 2,
      providers: reg.list().map((i) => ({ id: i.id, type: i.type, label: i.label, group: reg.group(i), residency: reg.residency(i), enabled: Boolean(i.enabled), inAuto: i.inAuto !== false, tts: reg.available(i, 'tts'), stt: reg.available(i, 'stt') })),
      languages: settings.languages,
      perLanguage: settings.perLanguage,
      routes: await routesFor(langs, settings, reg),
      markers: settings.markers,
      detection: { mode: settings.detection.mode, minConfidence: settings.detection.minConfidence, timeoutMs: settings.detection.timeoutMs, model: settings.detection.model, llm: Boolean(svc.llm && svc.llm()) },
      reading: settings.reading,
      dictation: { mode: settings.dictation.mode, lang: settings.dictation.lang, insert: settings.dictation.insert, liveInterim: settings.dictation.liveInterim, polish: { enabled: settings.dictation.polish.enabled !== false, model: settings.dictation.polish.model } },
      shortcuts: settings.shortcuts,
      reader: settings.reader,
      settingsBackend: svc.store.backend,
    }
  }

  async function settingsView() {
    const { settings, reg } = current()
    const instances = []
    for (const i of reg.list()) {
      const a = reg.adapter(i)
      const caps = a.capabilities(i)
      const cred = String(i.credential || '').startsWith('vault:') ? { kind: 'literal', shown: 'set', resolved: Boolean(i.secret()) } : describeCredential(i.credential, { env: svc.env, home: svc.home })
      instances.push({
        id: i.id, type: i.type, label: i.label, enabled: Boolean(i.enabled), inAuto: i.inAuto !== false,
        discovered: Boolean(i.discovered), overridden: Boolean(i.overridden), baseUrl: i.baseUrl || '', region: i.region || '',
        credential: cred, models: i.models || {}, defaultVoice: i.defaultVoice || '', options: i.options || {},
        available: { tts: reg.available(i, 'tts'), stt: reg.available(i, 'stt') },
        health: i.state.health ? { status: i.state.health.status, detail: i.state.health.detail } : { status: caps.noProbe ? 'unknown' : 'untested' },
        caps: { tts: caps.tts, stt: caps.stt, ttsLangs: caps.ttsLangs, sttLangs: caps.sttLangs, alignment: caps.alignment, quota: caps.quota, clientOnly: Boolean(caps.clientOnly) },
        hq: a.hq, euNote: a.euNote,
        group: reg.group(i), residency: reg.residency(i), desc: a.desc || '', docs: a.docs || '', status: a.status || 'unverified',
        regions: a.regions || [], optionFields: a.optionFields || [], configFields: a.configFields || [],
        planned: a.status === 'planned',
        notices: retirementNotes(i).map((n) => n.text),
      })
    }
    const types = Object.values(TYPES).map(typeMeta)
    return {
      ok: true, backend: svc.store.backend, store: svc.store.describe ? svc.store.describe() : null, secretMarker: SECRET_MARK, llm: Boolean(svc.llm && svc.llm()),
      settings: redact(settings), instances, types, groups: GROUP_ORDER, residencyLabels: RESIDENCY_LABELS, recommended: RECOMMENDED,
      routes: await routesFor(settings.languages.enabled.concat(['*']), settings, reg),
    }
  }

  async function ttsRoute(req, res, q) {
    const { settings, reg } = current()
    if (!limiter('tts', settings.security.rateLimit.ttsPerMin)) return E.send(res, 'VOICE_RATE_LIMITED', { message: 'too many speech requests, slow down', legacyCode: 'rate_limited' })
    const want = parseJson(await readBody(req, 256 * 1024))
    if (!want) return E.send(res, 'VOICE_BAD_REQUEST', { message: 'bad json' })
    const text = String(want.text || '').slice(0, 6000)
    if (!text.trim()) return E.send(res, 'VOICE_BAD_REQUEST', { message: 'empty text' })
    const asked = String(want.provider || q.get('provider') || 'auto')
    const r = await resolveTts({ lang: want.lang, provider: asked, settings, reg })
    const engine = r.id
    if (engine === 'browser') return E.send(res, 'VOICE_BROWSER_ONLY', { message: 'the browser voice is synthesised in the page, not here', legacyCode: 'browser_only', engine })
    const inst = r.inst
    if (!inst || !reg.available(inst, 'tts')) return E.send(res, 'VOICE_PROVIDER_UNAVAILABLE', { message: unavailableMessage(engine, inst, 'tts', reg), engine })
    const adapter = reg.adapter(inst)
    const wantAlignment = q.get('alignment') === '1'
    try {
      const out = await adapter.tts({
        text, lang: want.lang, voice: String(want.voice || '').trim() || r.voice || '',
        model: String(want.model || '') || r.model || '', speed: r.speed || 1, wantAlignment,
      }, inst, abortOnClose(res))
      res.setHeader('x-voice-engine', engine)
      if (out.voice) res.setHeader('x-voice-voice', String(out.voice).replace(/[^\x20-\x7e]/g, '?'))
      if (out.note) res.setHeader('x-voice-note', out.note)
      if (wantAlignment) {
        return sendJson(res, 200, { ok: true, engine, voice: out.voice || null, model: out.model || null, mime: out.mime, audio_base64: out.audio.toString('base64'), alignment: out.alignment || null, durationS: out.durationS || null })
      }
      return sendAudio(res, out.audio, out.mime)
    } catch (e) {
      warn(E.logLine(codeFor(e), 'tts ' + engine + ' failed: ' + String(e && e.message || e)))
      const code = (e && e.code) || ''
      if (code) res.setHeader('x-voice-error-code', code)
      return sendFailure(res, e, 502, { engine })
    }
  }

  async function sttRoute(req, res, q) {
    const { settings, reg } = current()
    if (!limiter('stt', settings.security.rateLimit.sttPerMin)) return E.send(res, 'VOICE_RATE_LIMITED', { message: 'too many transcription requests, slow down', legacyCode: 'rate_limited' })
    const raw = await readBody(req)
    if (!raw.length) return E.send(res, 'VOICE_BAD_REQUEST', { message: 'empty body' })
    const ct = req.headers['content-type'] || ''
    const asked = String(q.get('provider') || 'auto')
    const r = await resolveStt({ lang: q.get('lang') || 'en', provider: asked, settings, reg })
    const engine = r.id
    if (!engine) return E.send(res, 'VOICE_PROVIDER_UNAVAILABLE', { message: 'no speech-to-text engine is configured' })
    const inst = r.inst
    if (!inst || !reg.available(inst, 'stt')) return E.send(res, 'VOICE_PROVIDER_UNAVAILABLE', { message: unavailableMessage(engine, inst, 'stt', reg), engine })
    const isNative = Boolean(inst.options && inst.options.native)
    const part = extractFilePart(raw, ct)
    if (!part && !isNative) return E.send(res, 'VOICE_BAD_REQUEST', { message: 'could not find the audio part in the upload' })
    const signal = abortOnClose(res)
    try {
      const out = await reg.adapter(inst).stt({
        audio: part ? part.data : raw, name: part ? part.name : 'dictation.webm', mime: part ? part.type : 'audio/webm',
        raw, rawType: ct, lang: q.get('lang'), model: q.get('model') || r.model || '',
      }, inst, signal)
      const body = { text: out.text, language: out.language, engine }
      if (out.words) body.words = out.words
      return sendJson(res, 200, body)
    } catch (e) {
      // A cloud engine can fail for reasons the person cannot fix; the local
      // whisper keeps the button working. The fallback drops the model choice:
      // the env default (fast whisper) is the one measured to answer in ~1 s.
      warn(E.logLine(codeFor(e), 'stt ' + engine + ' failed: ' + String(e && e.message || e)))
      const local = reg.get('local')
      if (engine !== 'local' && local && reg.available(local, 'stt')) {
        try {
          const out = await reg.adapter(local).stt({ audio: part ? part.data : raw, name: part ? part.name : 'dictation.webm', mime: part ? part.type : 'audio/webm', raw, rawType: ct, lang: q.get('lang'), model: '' }, local, signal)
          return sendJson(res, 200, { text: out.text, language: out.language, engine: 'local', fellBackFrom: engine })
        } catch (e2) { warn(E.logLine(codeFor(e2), 'local stt fallback failed: ' + String(e2 && e2.message || e2))) }
      }
      return sendFailure(res, { code: e && e.code, message: String(e && e.message || e), status: 502 }, 502, { engine })
    }
  }

  async function polishRoute(req, res, q) {
    const { reg, settings } = current()
    const want = parseJson(await readBody(req, 256 * 1024))
    if (!want) return E.send(res, 'VOICE_BAD_REQUEST', { message: 'bad json' })
    const text = String(want.text || '').slice(0, 8000)
    if (!text.trim()) return sendJson(res, 200, { text: '' })
    const asked = String(want.provider || q.get('provider') || 'auto')
    const m = reg.get('mistral')
    const pol = (settings.dictation && settings.dictation.polish) || {}
    const out = await polish(text, {
      asked, mistralInst: m && reg.available(m) ? m : null, mistralAdapter: TYPES.mistral, cfg: polishCfg, warn,
      llm: svc.llm ? svc.llm() : null, llmModel: pol.model,
    })
    return sendJson(res, 200, out)
  }

  async function testRoute(req, res) {
    const { reg } = current()
    const want = parseJson(await readBody(req, 64 * 1024)) || {}
    const inst = reg.get(want.provider)
    if (!inst) return E.send(res, 'VOICE_PROVIDER_UNKNOWN', { message: 'unknown provider' })
    const a = reg.adapter(inst)
    const caps = a.capabilities(inst)
    const out = { ok: true, provider: inst.id, health: await reg.health(inst, true), tts: null, stt: null }
    if (caps.clientOnly) { out.tts = { ok: true, clientOnly: true, text: TEST_PHRASE }; return sendJson(res, 200, out) }
    let audio = null
    let mime = ''
    if (caps.tts && reg.available(inst, 'tts')) {
      const t0 = Date.now()
      try {
        const r = await a.tts({ text: String(want.text || TEST_PHRASE).slice(0, 300), lang: want.lang || 'en', voice: want.voice || '', model: want.model || '' }, inst)
        audio = r.audio
        mime = r.mime
        out.tts = { ok: true, ms: Date.now() - t0, mime, bytes: r.audio.length, voice: r.voice || null, audio_base64: r.audio.toString('base64') }
      } catch (e) { out.ok = false; out.tts = { ok: false, ms: Date.now() - t0, error: String(e && e.message || e), code: e && e.code } }
    } else if (caps.tts) out.tts = { ok: false, error: unavailableMessage(inst.id, inst, 'tts', reg) }
    // A speech-to-text-only provider has nothing to transcribe: borrow a spoken
    // sample from the first other usable TTS instance (English phrase), so the
    // Test button still proves the key and the endpoint end to end.
    if (!audio && caps.stt && !caps.tts && reg.available(inst, 'stt')) {
      for (const other of reg.list()) {
        if (other.id === inst.id || other.type === 'browser' || !reg.available(other, 'tts')) continue
        try {
          const r = await reg.adapter(other).tts({ text: 'Hello. This is a short test.', lang: 'en', voice: '', model: '' }, other)
          audio = r.audio
          mime = r.mime
          out.sample = { from: other.id }
          break
        } catch (e) { /* try the next one */ }
      }
    }
    if (caps.stt && reg.available(inst, 'stt') && audio) {
      const t0 = Date.now()
      try {
        const r = await a.stt({ audio, name: /wav/.test(mime) ? 'test.wav' : 'test.mp3', mime: mime || 'audio/mpeg', lang: '' }, inst)
        out.stt = { ok: true, ms: Date.now() - t0, text: r.text, language: r.language || null }
      } catch (e) { out.ok = false; out.stt = { ok: false, ms: Date.now() - t0, error: String(e && e.message || e) } }
    }
    return sendJson(res, 200, out)
  }

  async function modelsRoute(res) {
    const llm = svc.llm && svc.llm()
    if (!llm) return sendJson(res, 200, { ok: true, available: false, providers: [] })
    const providers = []
    let list = []
    try { list = (typeof llm.listProviders === 'function' ? llm.listProviders() : []) || [] } catch (e) { list = [] }
    for (const p of list.slice(0, 40)) {
      const id = String((p && (p.id || p.name || p.provider)) || '')
      if (!id) continue
      let models = []
      try { models = (await llm.listModels(id)) || [] } catch (e) { models = [] }
      providers.push({ id, label: String((p && (p.label || p.displayName)) || id), models: models.slice(0, 200).map((m) => ({ id: String(m.id || m.model || m.name || ''), label: String(m.label || m.displayName || m.name || m.id || '') })).filter((m) => m.id) })
    }
    return sendJson(res, 200, { ok: true, available: true, providers })
  }

  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const route = url.pathname.replace(/^\/api\/voice/, '').replace(/\/+$/, '') || '/'
    const q = url.searchParams
    try {
      if (route === '/config') return sendJson(res, 200, await config())

      if (route === '/quota') {
        const { reg } = current()
        const el = reg.get('elevenlabs')
        if (!el || !reg.available(el)) return sendJson(res, 200, { ok: true, available: false, quota: null })
        const qv = await TYPES.elevenlabs.quota(el)
        return sendJson(res, 200, { ok: true, available: true, creditsPerChar: CREDITS_PER_CHAR, quota: qv ? Object.assign({}, qv, { charsRemaining: charsLeft(qv) }) : null })
      }

      const s = normalise(svc.store.raw())

      if (route === '/session') {
        if (!gateRead(req, res, s)) return
        const sec = svc.secret()
        if (!sec) return E.send(res, 'VOICE_SESSION_NOT_READY', { message: 'secret not ready' })
        return sendJson(res, 200, { ok: true, token: mintToken(sec) })
      }
      if (route === '/doctor' && req.method === 'GET') {
        if (!gateRead(req, res, s)) return
        const { settings, reg } = current()
        return sendJson(res, 200, await runDoctor({ svc, settings, reg, req }))
      }
      if (route === '/settings' && req.method === 'GET') {
        if (!gateRead(req, res, s)) return
        return sendJson(res, 200, await settingsView())
      }
      if (route === '/settings' && (req.method === 'PATCH' || req.method === 'POST')) {
        if (!gateMutate(req, res, s)) return
        const patch = parseJson(await readBody(req, 512 * 1024))
        if (!patch || typeof patch !== 'object') return E.send(res, 'VOICE_BAD_REQUEST', { message: 'bad json' })
        const before = current().reg
        for (const p of Array.isArray(patch.providers) ? patch.providers : []) {
          if (!p || typeof p !== 'object') continue
          if (p.type && !TYPES[p.type]) return E.send(res, 'VOICE_PROVIDER_ENTRY_REJECTED', { message: 'unknown provider type ' + p.type })
          const cur = before.get(p.id)
          const type = p.type || (cur && cur.type)
          const why = await checkProviderEntry(p, { adapter: TYPES[type] || null, current: cur, lookup: svc.lookup === undefined ? dns.promises.lookup : svc.lookup })
          if (why) return E.send(res, 'VOICE_PROVIDER_ENTRY_REJECTED', { message: 'provider ' + String(p.id) + ': ' + why })
        }
        await svc.store.update(patch)
        return sendJson(res, 200, await settingsView())
      }
      if (route === '/voices' && req.method === 'GET') {
        if (!gateRead(req, res, s)) return
        const { reg } = current()
        const inst = reg.get(q.get('provider'))
        if (!inst) return E.send(res, 'VOICE_PROVIDER_UNKNOWN', { message: 'unknown provider' })
        const voices = reg.available(inst) ? await reg.adapter(inst).listVoices(inst, { lang: q.get('lang') || '' }) : []
        const l = q.get('lang') ? lang2(q.get('lang')) : ''
        return sendJson(res, 200, { ok: true, provider: inst.id, voices: l ? voices.filter((v) => !Array.isArray(v.langs) || !v.langs.length || v.langs.indexOf(l) >= 0) : voices })
      }
      if (route === '/models' && req.method === 'GET') {
        if (!gateRead(req, res, s)) return
        return modelsRoute(res)
      }
      if (route === '/detect' && req.method === 'POST') {
        if (!gatePost(req, res)) return
        if (!limiter('detect', s.security.rateLimit.detectPerMin)) return E.send(res, 'VOICE_RATE_LIMITED', { message: 'rate limited' })
        const want = parseJson(await readBody(req, 256 * 1024)) || {}
        const text = String(want.text || '').slice(0, 20000)
        const settings = want.mode && ['off', 'heuristic', 'heuristic+model'].includes(want.mode)
          ? Object.assign({}, s, { detection: Object.assign({}, s.detection, { mode: want.mode }) }) : s
        const out = await detectSegments(text, { settings, llm: svc.llm ? svc.llm() : null, cache: detectCache })
        return sendJson(res, 200, { ok: true, segments: out.segments, mode: out.mode, uncertain: out.uncertain, model: out.model, llm: Boolean(svc.llm && svc.llm()) })
      }

      if (req.method !== 'POST') return E.send(res, 'VOICE_METHOD_NOT_ALLOWED', { message: 'POST only' })
      if (route === '/tts' || route === '/stt' || route === '/polish') {
        // 1.x routes stay ungated for same-origin callers (dsh-note-keeper, old
        // clients, server-side scripts send no Fetch metadata), but a browser
        // POST from ANOTHER site (a simple text/plain or multipart form needs no
        // CORS preflight) must not spend credits or model tokens.
        if (!crossSiteOk(req)) return E.send(res, 'VOICE_CROSS_SITE', { message: 'cross-site request refused', legacyCode: 'cross_site' })
      }
      if (route === '/tts') return await ttsRoute(req, res, q)
      if (route === '/stt') return await sttRoute(req, res, q)
      if (route === '/polish') {
        if (!limiter('polish', s.security.rateLimit.polishPerMin)) return E.send(res, 'VOICE_RATE_LIMITED', { message: 'too many polish requests, slow down', legacyCode: 'rate_limited' })
        return await polishRoute(req, res, q)
      }
      if (route === '/test') {
        if (!gateMutate(req, res, s)) return
        return await testRoute(req, res)
      }
      return E.send(res, 'VOICE_ROUTE_NOT_FOUND', { message: 'no such voice route' })
    } catch (e) {
      warn(E.logLine(codeFor(e, 'VOICE_INTERNAL'), 'voice route failed: ' + String(e && e.message || e)))
      if (!res.headersSent) return sendFailure(res, e, 500, undefined, 'VOICE_INTERNAL')
      try { res.end() } catch (x) { /* already closed */ }
    }
  }
}
