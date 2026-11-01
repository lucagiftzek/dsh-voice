/**
 * dsh-voice client: dictation logic without the DOM (tested in node).
 *
 * The state machine behind the composer mic and the dictation shortcut:
 *
 *   idle --press--> rec           (recording starts)
 *   rec --release--> busy         push-to-talk: released after holding >= HOLD_MS,
 *                                 or any release in 'push-to-talk' mode
 *   rec --release (short, toggle mode)--> rec   (a click: keep recording)
 *   rec --press (toggle mode, after a click)--> busy   (second click stops)
 *   rec --cancel--> idle          (recording discarded, nothing sent)
 *   busy --done--> idle | busy --fail--> error --timeout--> idle
 *
 * insertAt() places dictated text at the composer caret with sensible spacing.
 */

export const HOLD_MS = 350

export function createDictation(opts) {
  const o = opts || {}
  const now = o.now || (() => Date.now())
  let state = 'idle'
  let pressedAt = 0
  let latched = false   // toggle mode: a short click latched recording on
  let mode = o.mode === 'push-to-talk' ? 'push-to-talk' : 'toggle'
  const fx = o.effects || {}
  const call = (name, ...a) => { if (typeof fx[name] === 'function') fx[name](...a) }
  return {
    get state() { return state },
    get mode() { return mode },
    setMode(m) { mode = m === 'push-to-talk' ? 'push-to-talk' : 'toggle' },
    press() {
      if (state === 'busy') return state
      if (state === 'rec') {
        if (latched) { latched = false; state = 'busy'; call('stop') }
        return state
      }
      if (state === 'error') state = 'idle'
      pressedAt = now()
      latched = false
      state = 'rec'
      call('start')
      return state
    },
    release() {
      if (state !== 'rec' || latched) return state
      const held = now() - pressedAt
      if (mode === 'push-to-talk' || held >= HOLD_MS) { state = 'busy'; call('stop') }
      else latched = true
      return state
    },
    cancel() {
      if (state !== 'rec') return state
      latched = false
      state = 'idle'
      call('discard')
      return state
    },
    done() { if (state === 'busy') state = 'idle'; return state },
    fail() { state = 'error'; latched = false; return state },
    reset() { state = 'idle'; latched = false; return state },
  }
}

/**
 * Insert dictated text into a draft.
 * where: 'caret' (at caret, when known), 'append' (1.x), 'replace'.
 * caret: an offset into draft, or null when unknown (then appended).
 */
export function insertAt(draft, text, where, caret) {
  const d = String(draft || '')
  const t = String(text || '').trim()
  if (!t) return { draft: d, caret: caret == null ? d.length : caret }
  if (where === 'replace') return { draft: t, caret: t.length }
  const at = where === 'caret' && Number.isInteger(caret) && caret >= 0 && caret <= d.length ? caret : d.length
  const before = d.slice(0, at)
  const after = d.slice(at)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : ''
  const out = before + lead + t + trail + after
  return { draft: out, caret: (before + lead + t).length }
}

/**
 * Map a caret given as "characters of rendered text before the caret" (what a
 * DOM Range from the editor start reports, which drops paragraph breaks) to an
 * offset in the draft, which keeps them as newlines.
 */
export function caretToDraftOffset(draft, renderedBefore) {
  const d = String(draft || '')
  const want = String(renderedBefore || '').replace(/\n/g, '').length
  let seen = 0
  for (let i = 0; i < d.length; i += 1) {
    if (seen >= want) return i
    if (d[i] !== '\n') seen += 1
  }
  return d.length
}

/** Cycle the dictation language chip: auto, then the enabled languages. */
export function nextDictationLang(cur, enabled) {
  const list = ['auto'].concat((enabled && enabled.length ? enabled : ['en', 'it', 'el']).filter((x) => x !== 'auto'))
  const i = list.indexOf(cur)
  return list[(i + 1) % list.length]
}

/** RMS level of an analyser frame (byte time-domain data centred on 128), 0..1. */
export function levelOf(bytes) {
  if (!bytes || !bytes.length) return 0
  let sum = 0
  for (let i = 0; i < bytes.length; i += 1) { const v = (bytes[i] - 128) / 128; sum += v * v }
  return Math.min(1, Math.sqrt(sum / bytes.length) * 3)
}
