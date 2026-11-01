/**
 * dsh-voice: vendor model retirements shown as a note in Settings > Voice.
 *
 * Source: OpenAI deprecations page (developers.openai.com/api/docs/deprecations),
 * read 2026-10-31: notice of 2026-10-01 (speech models) and of 2026-08-26
 * (transcription models and /v1/audio/translations); the 2025-03-20 snapshot of
 * gpt-4o-mini-transcribe goes earlier (notice of 2026-07-20).
 */
export const RETIREMENTS = [
  { model: /^tts-1(-hd)?$/, on: '2027-01-06', instead: 'no /v1/audio/speech successor (the Realtime API replaces it)' },
  { model: /^gpt-4o-mini-tts(-\d{4}-\d{2}-\d{2})?$/, on: '2027-01-06', instead: 'no /v1/audio/speech successor (the Realtime API replaces it)' },
  { model: /^gpt-4o-mini-transcribe-2025-03-20$/, on: '2027-01-20', instead: 'gpt-transcribe' },
  { model: /^(whisper-1|gpt-4o-transcribe(-diarize)?|gpt-4o-mini-transcribe(-\d{4}-\d{2}-\d{2})?)$/, on: '2027-02-26', instead: 'gpt-transcribe' },
]

const isOpenAiInstance = (inst) => {
  if (!inst) return false
  if (inst.type === 'openai') return true
  if (inst.type !== 'openai-compatible') return false
  try { return /(^|\.)openai\.com$/.test(new URL(String(inst.baseUrl || '')).hostname) } catch (e) { return false }
}

/** Notes for an instance whose configured models retire: [{dir, model, on, instead, text}]. */
export function retirementNotes(inst) {
  if (!isOpenAiInstance(inst)) return []
  const out = []
  const models = (inst && inst.models) || {}
  for (const dir of ['tts', 'stt']) {
    const m = String(models[dir] || '')
    if (!m) continue
    const r = RETIREMENTS.find((x) => x.model.test(m))
    if (r) out.push({ dir, model: m, on: r.on, instead: r.instead, text: 'OpenAI retires ' + m + ' on ' + r.on + ' (' + r.instead + ').' })
  }
  return out
}
