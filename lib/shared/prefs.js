/**
 * dsh-voice: browser preference migration (pure; the client passes localStorage).
 *
 * 1.x keys stay in place and stay authoritative in 2.0 (rollback safety, and
 * the 1.x client and the separate dsh-tts-reader on other installs read them).
 * migratePrefs() reads them ONCE into a dsh-voice.v2.prefs snapshot and sets
 * dsh-voice.v2.migrated; it never deletes or rewrites an old key.
 */

export const V1_KEYS = {
  engine: 'dsh-voice.engine', voice: 'dsh-voice.voice', alivoice: 'dsh-voice.alivoice',
  localmodel: 'dsh-voice.localmodel', mimovoice: 'dsh-voice.mimovoice', lfm3voice: 'dsh-voice.lfm3voice',
  rate: 'dsh-voice.rate', fallback: 'dsh-voice.fallback',
}
export const READER_KEYS = { text: 'dsh-tts-reader.text', model: 'dsh-tts-reader.model', rate: 'dsh-tts-reader.rate', voicePrefix: 'dsh-tts-reader.voice.' }
export const V2_PREFS = 'dsh-voice.v2.prefs'
export const V2_FLAG = 'dsh-voice.v2.migrated'

const get = (st, k) => { try { const v = st.getItem(k); return v === null || v === undefined ? null : String(v) } catch (e) { return null } }

/** A reader model id ("mistral:<model>", "local:maya", "grey", "auto") -> { provider, model }. */
export function readerModelToRoute(id) {
  const s = String(id || '').trim()
  if (!s || s === 'auto') return { provider: 'auto', model: '' }
  const i = s.indexOf(':')
  if (i < 0) return { provider: s, model: '' }
  return { provider: s.slice(0, i), model: s.slice(i + 1) }
}

/** Build the v2 snapshot from the 1.x keys (no writes). */
export function readV1(st) {
  const engine = get(st, V1_KEYS.engine) || 'auto'
  const rate = parseFloat(get(st, V1_KEYS.rate) || '1')
  const voices = {}
  const map = { elevenlabs: V1_KEYS.voice, alibaba: V1_KEYS.alivoice, mimo: V1_KEYS.mimovoice, lfm3: V1_KEYS.lfm3voice }
  for (const [eng, key] of Object.entries(map)) {
    const v = get(st, key)
    if (v && v !== 'auto') voices[eng] = v
  }
  const localModel = get(st, V1_KEYS.localmodel)
  const reader = {}
  const rm = get(st, READER_KEYS.model)
  if (rm) reader.route = readerModelToRoute(rm)
  const rr = parseFloat(get(st, READER_KEYS.rate) || '')
  if (isFinite(rr)) reader.rate = rr
  reader.voices = {}
  try {
    for (let i = 0; i < (st.length || 0); i += 1) {
      const k = st.key(i)
      if (k && k.indexOf(READER_KEYS.voicePrefix) === 0) reader.voices[k.slice(READER_KEYS.voicePrefix.length)] = get(st, k)
    }
  } catch (e) { /* storage without key() */ }
  return {
    manual: { provider: engine, model: localModel && localModel !== 'auto' ? localModel : '' },
    voices,
    rate: isFinite(rate) && rate >= 0.25 && rate <= 4 ? rate : 1,
    fallbackToBrowser: get(st, V1_KEYS.fallback) !== '0',
    reader,
  }
}

/** Run once per browser. Returns the snapshot (fresh or stored). */
export function migratePrefs(st) {
  if (!st) return null
  if (get(st, V2_FLAG) === '1') {
    try { return JSON.parse(get(st, V2_PREFS) || 'null') } catch (e) { return null }
  }
  const snap = readV1(st)
  try { st.setItem(V2_PREFS, JSON.stringify(snap)); st.setItem(V2_FLAG, '1') } catch (e) { /* private mode */ }
  return snap
}
