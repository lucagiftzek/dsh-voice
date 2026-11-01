/**
 * dsh-voice client: the composer mic as a target for shortcuts, and where the
 * composer's editor is. One composer is visible at a time; the last mounted
 * mic wins.
 */
export const DICT_LANG_KEY = 'dsh-voice.v2.dictation.lang'

let mic = null
export function registerMic(ctrl) {
  mic = ctrl
  return () => { if (mic === ctrl) mic = null }
}
export function getMic() { return mic }

/** The composer's contenteditable (Lexical) near the mic button. */
export function findComposerEditor(fromEl) {
  let el = fromEl
  for (let i = 0; el && i < 10; i += 1, el = el.parentElement) {
    const ed = el.querySelector ? el.querySelector('[contenteditable="true"]') : null
    if (ed) return ed
  }
  return null
}
