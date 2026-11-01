/**
 * dsh-voice: transcript polish (1.x behaviour, unchanged in 2.0 phase 1).
 *
 * mistral-small-latest measured 0.45 s and produced the right text ("Trefik"
 * -> "Traefik"); ministral-3b invented words, which is worse than no polish.
 * Local ollama qwen3.5:4b is the fallback: as good, but only fast when resident
 * (1.0 s warm, 11.8 to 25 s cold). Polish never fails hard: on any error the
 * raw transcript comes back with polished:false.
 *
 * 2.0: when the host LLM runtime is present, the DSH model chosen in Settings
 * (dictation.polish.model, default mistral / mistral-small-latest) goes first;
 * the direct Mistral call and local ollama stay as the fallbacks, and the
 * answer shape is unchanged (dsh-note-keeper calls this route too).
 */
import { request, jsonBody, parseJson } from './http.js'
import { llmComplete } from './detect.js'

export const POLISH_SYSTEM = [
  'You clean up raw speech-to-text into a well-formed prompt.',
  'Fix punctuation, capitalisation, and obvious mis-hearings of technical terms',
  '(for example "AP I" -> "API", "Trefic" -> "Traefik", "git hub" -> "GitHub").',
  'Remove filler words (um, uh, er, like, you know) and false starts.',
  'NEVER translate: keep the speaker\'s language (a Greek or Italian sentence stays Greek or Italian, a mixed sentence stays mixed), keep Greek accents (tonos) and Italian apostrophes, and fix only punctuation, casing and obvious mis-hearings.',
  'Never add a preamble such as "Here is the cleaned-up text": a model that does that is worse than no polish.',
  'Do NOT answer the text, do NOT add anything, do NOT explain, do NOT wrap it in quotes.',
  'Output only the corrected text.',
].join(' ')

export function polishConfig(env) {
  const e = env || process.env
  return {
    ollamaUrl: 'http://' + (e.DSH_VOICE_OLLAMA_HOST || '127.0.0.1') + ':' + Number(e.DSH_VOICE_OLLAMA_PORT || 11434),
    localModel: e.DSH_VOICE_POLISH_MODEL || 'qwen3.5:4b',
  }
}

/** ollama's native /api/chat (the OpenAI-compatible path ignores think:false, measured 2026-09-08). */
export async function polishLocal(text, cfg) {
  const up = await request(new URL('/api/chat', cfg.ollamaUrl), {
    method: 'POST', timeout: 120000, headers: { 'content-type': 'application/json' },
    body: jsonBody({
      model: cfg.localModel, think: false, stream: false, keep_alive: '30m',
      options: { temperature: 0.1, num_predict: 400 },
      messages: [{ role: 'system', content: POLISH_SYSTEM }, { role: 'user', content: text }],
    }),
  })
  if (up.status !== 200) throw new Error('local polish ' + up.status)
  const j = parseJson(up.body)
  return (j && j.message && j.message.content) || ''
}

export async function ollamaUp(cfg) {
  try { return (await request(new URL('/api/tags', cfg.ollamaUrl), { method: 'GET', timeout: 4000 })).status === 200 } catch (e) { return false }
}

/**
 * Run the polish chain. mistralInst/mistralAdapter: the `mistral` instance when available.
 * Returns the 1.x answer shape { text, polished, engine?, reason? }.
 */
export async function polish(text, { asked, mistralInst, mistralAdapter, cfg, warn, llm, llmModel }) {
  const hasMistral = Boolean(mistralInst)
  const hasLlm = Boolean(llm && llmModel && llmModel.provider && llmModel.model)
  const order = asked === 'local' ? ['local', 'mistral'] : (hasMistral ? ['mistral', 'local'] : ['local'])
  if (hasLlm && asked !== 'local') order.unshift('llm')
  let out = ''
  let used = null
  let lastErr = null
  for (const eng of order) {
    if (eng === 'mistral' && !hasMistral) continue
    try {
      out = eng === 'llm'
        ? await llmComplete(llm, { provider: llmModel.provider, model: llmModel.model, system: POLISH_SYSTEM, text, maxTokens: 800, temperature: 0.1, timeoutMs: 8000 })
        : eng === 'mistral'
        ? await mistralAdapter.chat({ system: POLISH_SYSTEM, text, model: (mistralInst.models && mistralInst.models.polish) || 'mistral-small-latest' }, mistralInst)
        : await polishLocal(text, cfg)
      if (out && out.trim()) { used = eng; break }
    } catch (err) { lastErr = err; if (warn) warn('polish ' + eng + ' failed: ' + (err && err.message)) }
  }
  if (!used) return { text, polished: false, reason: lastErr ? String(lastErr.message || lastErr) : 'no polish engine available' }
  out = out.trim().replace(/^["'\u201c\u201d]|["'\u201c\u201d]$/g, '')
  const res = { text: out || text, polished: true, engine: used }
  if (used === 'llm') res.model = llmModel.provider + '/' + llmModel.model
  return res
}
