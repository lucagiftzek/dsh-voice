/**
 * dsh-voice: model-facing tools (voice_annotations, voice_speak, voice_announce, voice_announce_stop).
 *
 * Written to the DSH tool rules: the canonical value that `execute()` returns is validated against
 * `output.schema`, `output.render` turns it into model-facing text, and `output.presentationMeta` projects
 * the replayable payload a UI may narrow (the clip path and the announce id), never the model.
 *
 * The tools call the plugin's own HTTP surface on loopback, so they use exactly the provider, voice,
 * annotation and routing code the readers use. No engine is special-cased here.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLIP_MIME = 'audio/mpeg'
const MAX_TEXT = 20000

/** The shape every tool result carries: a short sentence for the model, optional clip metadata for the UI. */
const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
    clip: { type: 'string' },
    clips: { type: 'array', items: { type: 'string' } },
    id: { type: 'string' },
    provider: { type: 'string' },
    voice: { type: 'string' },
    annotations: { type: 'array', items: { type: 'string' } },
    dropped: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
  },
}

const text = (s) => [{ type: 'text', text: s }]

/** A plain file name: no directories, no traversal, so a clip can never be written outside the output folder. */
export function safeName(name, fallback) {
  const base = String(name || '').replace(/[\\/]+/g, '-').replace(/^[.-]+/, '').replace(/[^A-Za-z0-9._-]/g, '-')
  const stem = base.replace(/\.(mp3|wav)$/i, '') || fallback
  return stem.slice(0, 80)
}

/** Join the configured output directory and a safe file name. */
export function clipPath(dir, name, fallback) {
  const home = homedir()
  const root = dir && dir.trim() ? dir.replace(/^~(?=\/|$)/, home) : join(home, 'reports', 'voice-clips')
  return join(root, safeName(name, fallback) + '.mp3')
}

/** One announce replaces the previous one: the id lets the stop tool and the player agree on which. */
export function newAnnounceId(now = Date.now(), rand = Math.random) {
  return 'announce-' + now.toString(36) + '-' + Math.floor(rand() * 1e6).toString(36)
}

/**
 * Split on sentence boundaries for engines that synthesise a whole utterance per call (Kokoro). Each piece is
 * returned with its own mp3, so a long passage plays without waiting for the end and without a time limit.
 */
export function sentenceChunks(text, limit = 400) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const parts = clean.match(/[^.!?]+[.!?]+["')\]»”]?|[^.!?]+$/g) || [clean]
  const out = []
  let cur = ''
  for (const raw of parts) {
    const piece = raw.trim()
    if (!piece) continue
    if (piece.length > limit) {
      if (cur) { out.push(cur); cur = '' }
      for (let i = 0; i < piece.length; i += limit) out.push(piece.slice(i, i + limit))
      continue
    }
    if ((cur + ' ' + piece).trim().length > limit) { out.push(cur); cur = piece } else cur = (cur ? cur + ' ' : '') + piece
  }
  if (cur) out.push(cur)
  return out.filter((s) => s.trim().length > 0)
}

/**
 * Build the four tools.
 * @param defineTool the host's tool DSL
 * @param deps { call(route, body), clipDir(), announce, config() }
 *   `call` posts to the plugin's own loopback route; `announce` tracks the running clip;
 *   `config` reads the live settings (provider, voice, language) at the moment of use.
 */
export function speechTools(defineTool, deps) {
  const { call, clipDir } = deps
  const chunks = typeof deps.chunks === 'function' ? deps.chunks : (t) => sentenceChunks(t)
  const tools = []

  tools.push(defineTool({
    name: 'voice_annotations',
    description: 'Show how a text will be spoken by the selected speech model, and optionally return it marked up for tone, pace and expressions. Use it before voice_speak when the delivery matters.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to inspect, up to 20000 characters.' },
      provider: { type: 'string', description: 'Provider id (defaults to the recalled provider).' },
      model: { type: 'string', description: 'Model id of that provider.' },
      wrap: { type: 'boolean', description: 'Return the text wrapped in the annotations this model accepts, instead of only reporting them.' },
      tone: { type: 'string', description: 'With wrap: one tone for the whole passage, e.g. warm, calm, excited.' },
    },
    output: {
      schema: resultSchema,
      render: (_a, v) => text(v.message + (v.annotations && v.annotations.length ? '\nannotations: ' + v.annotations.join(', ') : '') + (v.dropped && v.dropped.length ? '\ndropped by this model: ' + v.dropped.join(', ') : '')),
      presentationMeta: (_a, v) => ({ ok: v.ok, annotations: v.annotations || [], dropped: v.dropped || [] }),
    },
    async execute(args) {
      const r = await call('/annotations', { text: String(args.text || '').slice(0, MAX_TEXT), provider: args.provider, model: args.model })
      if (!r.ok) return { ok: false, message: 'annotations failed: ' + r.error, error: r.error }
      const items = Array.isArray(r.data.items) ? r.data.items : []
      const useful = items.filter((i) => i.useful !== false).map((i) => i.raw || i.text || String(i.verb || ''))
      const dropped = items.filter((i) => i.useful === false).map((i) => i.raw || i.text || String(i.verb || ''))
      const family = (r.data.annotation && r.data.annotation.family) || 'mute'
      let message = 'family ' + family + ': ' + items.length + ' annotation(s), ' + useful.length + ' usable'
      if (args.wrap) {
        const body = args.tone ? '[' + 'tone=' + String(args.tone).trim().slice(0, 40) + ']' + args.text : args.text
        const w = await call('/annotations', { text: body, provider: args.provider, model: args.model })
        message += w.ok ? '\nready to speak:\n' + (w.data.text || '') : '\nwrapping failed: ' + w.error
      }
      return { ok: true, message, annotations: useful, dropped, provider: args.provider, voice: args.model }
    },
  }))

  tools.push(defineTool({
    name: 'voice_speak',
    description: 'Turn text into an mp3 with the selected speech provider and return its path plus an inline player. The text runs through the annotation layer, so tone and pace markers are honoured where the model supports them.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to speak, up to 20000 characters.' },
      provider: { type: 'string', description: 'Provider id (defaults to the recalled provider).' },
      voice: { type: 'string', description: 'Voice id of that provider (defaults to the recalled voice).' },
      model: { type: 'string', description: 'Model id, when the provider has several.' },
      language: { type: 'string', description: 'Language tag, e.g. en, it, el.' },
      filename: { type: 'string', description: 'Base name of the mp3 (defaults to the voice id).' },
      speed: { type: 'number', description: 'Rate multiplier, 0.5 to 2.', minimum: 0.5, maximum: 2 },
    },
    output: {
      schema: resultSchema,
      render: (_a, v) => text(v.ok ? v.message : 'voice_speak failed: ' + v.error),
      presentationMeta: (_a, v) => (v.ok ? { clip: v.clip, clips: v.clips || [v.clip], provider: v.provider, voice: v.voice } : { ok: false }),
    },
    async execute(args) {
      const cfg = deps.config()
      const provider = String(args.provider || cfg.provider || 'auto')
      const voice = String(args.voice || cfg.voice || '')
      const whole = String(args.text || '').slice(0, MAX_TEXT)
      // an engine that synthesises a whole utterance per call gets sentence-sized pieces (see sentenceChunks)
      const pieces = chunks(whole)
      const stem = safeName(args.filename, voice || 'voice')
      const base = clipPath(clipDir(), stem, voice || 'voice')
      const clips = []
      for (let i = 0; i < pieces.length; i += 1) {
        const path = pieces.length === 1 ? base : base.replace(/\.mp3$/i, '-' + String(i + 1).padStart(2, '0') + '.mp3')
        const r = await call('/tts', { text: pieces[i], provider, voice, model: args.model || cfg.model, language: args.language || cfg.language, speed: args.speed, saveTo: path })
        if (!r.ok) return { ok: false, message: 'voice_speak failed on piece ' + (i + 1) + ' of ' + pieces.length, error: r.error, clip: clips[0] }
        clips.push(path)
      }
      const message = clips.length === 1
        ? 'Saved ' + clips[0] + ' (' + provider + (voice ? ', ' + voice : '') + ')'
        : 'Saved ' + clips.length + ' clips, ' + clips[0] + ' to ' + clips[clips.length - 1] + ' (' + provider + (voice ? ', ' + voice : '') + ')'
      return { ok: true, message, clip: clips[0], clips, provider, voice }
    },
  }))

  tools.push(defineTool({
    name: 'voice_announce',
    description: 'Speak a short message out loud immediately through the selected provider, without leaving a file to open. Use it for alerts and spoken answers; voice_announce_stop ends it.',
    parameters: {
      message: { type: 'string', required: true, description: 'What to say, up to 2000 characters.' },
      provider: { type: 'string', description: 'Provider id (defaults to the recalled provider).' },
      voice: { type: 'string', description: 'Voice id (defaults to the recalled voice).' },
      language: { type: 'string', description: 'Language tag.' },
    },
    output: {
      schema: resultSchema,
      render: (_a, v) => text(v.ok ? v.message : 'voice_announce failed: ' + v.error),
      presentationMeta: (_a, v) => (v.ok ? { announce: v.id, clip: v.clip, provider: v.provider, voice: v.voice } : { ok: false }),
    },
    async execute(args) {
      const cfg = deps.config()
      const provider = String(args.provider || cfg.provider || 'auto')
      const voice = String(args.voice || cfg.voice || '')
      const path = clipPath(clipDir(), 'announce-' + newAnnounceId(), voice || 'announce')
      const r = await call('/tts', { text: String(args.message || '').slice(0, 2000), provider, voice, language: args.language || cfg.language, saveTo: path })
      if (!r.ok) return { ok: false, message: 'voice_announce failed', error: r.error }
      const id = newAnnounceId()
      deps.announce.set({ id, clip: path, startedAt: Date.now() })
      return { ok: true, message: 'Speaking now (' + provider + (voice ? ', ' + voice : '') + ')', id, clip: path, provider, voice }
    },
  }))

  tools.push(defineTool({
    name: 'voice_announce_stop',
    description: 'Stop the current voice announcement. Safe to call when nothing is playing.',
    parameters: { id: { type: 'string', description: 'The announce id to stop; omit to stop whatever is playing.' } },
    output: {
      schema: resultSchema,
      render: (_a, v) => text(v.message),
      presentationMeta: (_a, v) => ({ stopped: v.ok, id: v.id || '' }),
    },
    async execute(args) {
      const cur = deps.announce.get()
      if (!cur || (args.id && cur.id !== String(args.id))) {
        return { ok: true, message: 'Nothing was playing' + (args.id ? ' as ' + args.id : '') + '.', id: args.id || '' }
      }
      await deps.announce.stop(cur)
      return { ok: true, message: 'Stopped the announcement.', id: cur.id }
    },
  }))

  return tools
}

/** An announce slot: one id and clip at a time, with a stop hook the client half triggers over the route. */
export function announceSlot() {
  let current = null
  return {
    get: () => current,
    set: (v) => { current = v },
    clear: () => { current = null },
    async stop(v) {
      current = null
      if (v && typeof v.stop === 'function') await v.stop()
    },
  }
}

export { CLIP_MIME }