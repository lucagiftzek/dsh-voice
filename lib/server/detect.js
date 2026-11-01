/**
 * dsh-voice: language detection with the model pass (spec 4.1 steps 6 and 7).
 *
 * 1. Markers and the heuristics run first (lib/shared/lang). Explicit beats
 *    detected: a marked span never reaches the model.
 * 2. Sentences still under detection.minConfidence, and Greek sentences holding
 *    a run of Latin words, go to the chosen DSH model in ONE batched call
 *    through the host LLM runtime (ctx.llm.stream), with a timeout.
 * 3. Answers are cached by sha256(normalised sentence) in an in-memory LRU
 *    (5000 entries, 7 days). The text itself is never stored, only the hash.
 * 4. No model service, mode != 'heuristic+model', a timeout or a bad answer:
 *    the heuristic result stands. Detection never fails a read.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { buildSegments } from '../shared/lang/segment.js'
import { normaliseSentence } from '../shared/lang/heuristics.js'

export const DETECT_SYSTEM = [
  'You identify the language of short text items for a text-to-speech router.',
  'Input: a JSON array of {"i": number, "text": string}.',
  'Output ONLY a JSON array, no prose, no code fence: [{"i": number, "lang": string, "spans": [{"from": number, "to": number, "lang": string}]}].',
  'lang is a lowercase ISO 639-1 code. Use one of the allowed codes listed below, or "other:<code>" for anything else.',
  '"spans" is optional: give it only when part of the item is clearly in a different language than the rest (a whole phrase, not one borrowed technical word);',
  'from/to are character offsets into that item\'s text, to exclusive.',
  'An English technical term inside an Italian or Greek sentence does not change the sentence language.',
].join(' ')

const hashOf = (s) => createHash('sha256').update(normaliseSentence(s)).digest('hex')

/** In-memory LRU keyed by sentence hash. */
export function createDetectCache(opts) {
  const o = opts || {}
  const max = o.max || 5000
  const ttl = o.ttlMs || 7 * 24 * 3600 * 1000
  const now = o.now || (() => Date.now())
  const map = new Map()
  return {
    get(text) {
      const k = hashOf(text)
      const e = map.get(k)
      if (!e) return null
      if (now() - e.at > ttl) { map.delete(k); return null }
      map.delete(k); map.set(k, e)
      return e.value
    },
    set(text, value) {
      const k = hashOf(text)
      map.delete(k)
      map.set(k, { at: now(), value })
      while (map.size > max) map.delete(map.keys().next().value)
    },
    get size() { return map.size },
    keys() { return Array.from(map.keys()) },
  }
}

let createUserMessage = null
function userMessage(text) {
  if (createUserMessage === null) {
    // Resolved at runtime from the host install (builtins-only rule); the
    // hand-built message below has the same shape when it is not found.
    createUserMessage = false
    for (const base of [import.meta.url, process.argv[1]].filter(Boolean)) {
      try {
        const mod = createRequire(base)('@deepseek-ai/dsh-llm')
        if (mod && typeof mod.createUserMessage === 'function') { createUserMessage = mod.createUserMessage; break }
      } catch (e) { /* next base */ }
    }
  }
  const input = { content: [{ type: 'text', text }], source: { kind: 'plugin:dsh-voice' } }
  if (createUserMessage) { try { return createUserMessage(input) } catch (e) { /* hand-built below */ } }
  return Object.assign({ id: randomUUID(), role: 'user' }, input)
}

/**
 * One short completion through the host LLM runtime (ctx.llm.stream), text
 * deltas joined. Throws on a missing runtime, an error finish or the timeout.
 * Shared by detection and the dictation polish.
 */
export async function llmComplete(llm, { provider, model, system, text, maxTokens, temperature, timeoutMs }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('no LLM runtime on this host')
  if (!provider || !model) throw new Error('no model chosen')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs || 2500)
  let out = ''
  try {
    const iter = llm.stream({ provider, model, system, maxTokens: maxTokens || 400, temperature: temperature === undefined ? 0 : temperature, messages: [userMessage(text)], signal: ac.signal })
    for await (const ch of iter) {
      if (ac.signal.aborted) throw new Error('model timeout')
      if (ch && ch.type === 'text-delta' && typeof ch.text === 'string') out += ch.text
      if (ch && ch.type === 'finish' && ch.finish && (ch.finish.kind === 'error' || ch.finish.kind === 'aborted')) throw new Error('model ' + ch.finish.kind)
    }
    if (ac.signal.aborted) throw new Error('model timeout')
  } finally { clearTimeout(timer) }
  return out
}

/** Pull the first JSON array out of a model answer. */
export function parseAnswer(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return null
  try {
    const v = JSON.parse(s.slice(a, b + 1))
    return Array.isArray(v) ? v : null
  } catch (e) { return null }
}

function cleanLang(l, enabled) {
  const s = String(l || '').toLowerCase().trim()
  if (/^[a-z]{2,3}$/.test(s)) return s
  const m = /^other:([a-z]{2,3})/.exec(s)
  if (m) return m[1]
  return enabled[0] || 'en'
}

/**
 * One batched model call. items: [{ i, text }]. Returns Map(i -> { lang, spans? }).
 * llm: the host LlmRuntime (stream(options) async iterable of chunks).
 */
export async function askModel(llm, items, { model, enabled, timeoutMs, maxTokens }) {
  const out = new Map()
  if (!llm || typeof llm.stream !== 'function' || !items.length || !model || !model.provider || !model.model) return out
  const system = DETECT_SYSTEM + ' Allowed codes: ' + enabled.join(', ') + '.'
  let text = ''
  try {
    text = await llmComplete(llm, { provider: model.provider, model: model.model, system, text: JSON.stringify(items), maxTokens: maxTokens || 400, timeoutMs })
  } catch (e) {
    return out
  }
  const arr = parseAnswer(text)
  if (!arr) return out
  for (const r of arr) {
    if (!r || typeof r.i !== 'number') continue
    const item = items.find((x) => x.i === r.i)
    if (!item) continue
    const v = { lang: cleanLang(r.lang, enabled) }
    if (Array.isArray(r.spans) && r.spans.length) {
      v.spans = r.spans.slice(0, 8).map((x) => ({ from: Number(x.from) | 0, to: Number(x.to) | 0, lang: cleanLang(x.lang, enabled) }))
        .filter((x) => x.to > x.from && x.to <= item.text.length)
      if (!v.spans.length) delete v.spans
    }
    out.set(r.i, v)
  }
  return out
}

/**
 * Detect segments for a message.
 * opts: { settings (normalised), llm (or null), cache, models? (fallback order) }
 * Returns { segments, model: { used, provider, model, asked, cached, ms } | null, mode }.
 */
export async function detectSegments(text, opts) {
  const o = opts || {}
  const s = o.settings
  const det = s.detection
  const base = { markers: s.markers.enabled, detection: det.mode === 'off' ? 'off' : 'heuristic', enabled: s.languages.enabled, minConfidence: det.minConfidence }
  const first = buildSegments(text, base)
  const result = { segments: first.segments, mode: det.mode, model: null, uncertain: first.uncertain.length }
  if (det.mode !== 'heuristic+model' || !first.uncertain.length) return result
  const cache = o.cache
  const resolve = (sentence) => (cache ? cache.get(sentence.trim()) : null)
  const todo = first.uncertain.filter((t) => !resolve(t))
  const info = { used: false, asked: 0, cached: first.uncertain.length - todo.length, ms: 0, provider: null, model: null }
  result.model = info
  if (todo.length && o.llm) {
    const t0 = Date.now()
    let budget = Number(det.maxChars) || 4000
    const items = []
    for (const t of todo) {
      if (budget - t.length < 0) break
      budget -= t.length
      items.push({ i: items.length, text: t })
    }
    const routes = [det.model, det.fallbackModel].filter((m) => m && m.provider && m.model)
    for (const m of routes) {
      const ans = await askModel(o.llm, items, { model: m, enabled: s.languages.enabled, timeoutMs: det.timeoutMs })
      if (ans.size) {
        for (const [i, v] of ans) if (cache) cache.set(items[i].text, v)
        info.used = true
        info.provider = m.provider
        info.model = m.model
        info.asked = items.length
        break
      }
      if (Date.now() - t0 > (det.timeoutMs || 2500)) break
    }
    info.ms = Date.now() - t0
  }
  if (info.used || info.cached) {
    result.segments = buildSegments(text, Object.assign({}, base, { resolve })).segments
  }
  return result
}
