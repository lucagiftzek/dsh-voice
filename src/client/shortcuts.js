/**
 * dsh-voice client: keyboard shortcuts.
 *
 * Defaults (settings `shortcuts.*`, empty string disables one):
 *   Alt+Shift+R  read the last reply       Alt+Shift+P  play / pause
 *   Alt+Shift+S  stop                      Alt+Shift+.  next sentence
 *   Alt+Shift+,  previous sentence         Alt+Shift+=  faster   Alt+Shift+-  slower
 *   Alt+Shift+M  dictation (tap toggles, hold for push-to-talk)
 *   Alt+Shift+L  cycle the dictation language
 *
 * Checked against the DSH 0.1.5 client: its composer (Lexical) binds
 * Alt/Shift+ArrowUp/Down, Enter combinations and Ctrl+O; nothing binds
 * Alt+Shift with a letter or punctuation, and bare Escape is left to DSH.
 * Matching uses event.code (the physical key), so a Greek or Italian layout,
 * or macOS turning Option+Shift+R into a symbol, does not change the binding.
 */

const CODE = {
  '.': 'Period', ',': 'Comma', '=': 'Equal', '-': 'Minus', '/': 'Slash', ';': 'Semicolon',
  '[': 'BracketLeft', ']': 'BracketRight', "'": 'Quote', '`': 'Backquote', '\\': 'Backslash',
  Space: 'Space', Enter: 'Enter', Escape: 'Escape',
}

export const DEFAULT_SHORTCUTS = {
  readLast: 'Alt+Shift+R', playPause: 'Alt+Shift+P', stop: 'Alt+Shift+S',
  nextSentence: 'Alt+Shift+.', prevSentence: 'Alt+Shift+,', faster: 'Alt+Shift+=', slower: 'Alt+Shift+-',
  dictate: 'Alt+Shift+M', dictationLang: 'Alt+Shift+L',
}

/** "Alt+Shift+R" -> { alt, shift, ctrl, meta, code: 'KeyR' } or null. */
export function parseCombo(s) {
  const str = String(s || '').trim()
  if (!str) return null
  const parts = str.split('+')
  // "Alt+Shift++" style: a trailing empty part means the key is '+'
  let key = parts.pop()
  if (key === '' && parts.length && parts[parts.length - 1] === '') { parts.pop(); key = '+' }
  const mods = parts.map((p) => p.toLowerCase())
  const c = { alt: mods.includes('alt') || mods.includes('option'), shift: mods.includes('shift'), ctrl: mods.includes('ctrl') || mods.includes('control'), meta: mods.includes('meta') || mods.includes('cmd') }
  if (/^[A-Za-z]$/.test(key)) c.code = 'Key' + key.toUpperCase()
  else if (/^[0-9]$/.test(key)) c.code = 'Digit' + key
  else if (CODE[key]) c.code = CODE[key]
  else if (/^F\d{1,2}$/.test(key) || /^Arrow(Up|Down|Left|Right)$/.test(key)) c.code = key
  else if (key === '+') c.code = 'Equal'
  else return null
  if (!c.alt && !c.ctrl && !c.meta) return null   // a bare key would fight typing
  return c
}

export function matches(combo, ev) {
  if (!combo || !ev) return false
  return ev.code === combo.code && Boolean(ev.altKey) === combo.alt && Boolean(ev.shiftKey) === combo.shift
    && Boolean(ev.ctrlKey) === combo.ctrl && Boolean(ev.metaKey) === combo.meta
}

/** Which action a key event triggers under a shortcut map (null when none). */
export function actionFor(map, ev) {
  const m = Object.assign({}, DEFAULT_SHORTCUTS, map || {})
  for (const [action, combo] of Object.entries(m)) if (matches(parseCombo(combo), ev)) return action
  return null
}

/** Duplicate bindings inside one map: [[comboText, [actions]]]. */
export function conflicts(map) {
  const m = Object.assign({}, DEFAULT_SHORTCUTS, map || {})
  const by = new Map()
  for (const [action, combo] of Object.entries(m)) {
    const c = parseCombo(combo)
    if (!c) continue
    const k = JSON.stringify(c)
    if (!by.has(k)) by.set(k, [combo, []])
    by.get(k)[1].push(action)
  }
  return Array.from(by.values()).filter((x) => x[1].length > 1)
}

/**
 * Install the page listener. getMap() returns the current shortcut map;
 * handlers: { [action]: { down(ev), up?(ev) } }. Returns an uninstaller.
 */
export function installShortcuts(target, getMap, handlers) {
  if (!target || typeof target.addEventListener !== 'function') return () => {}
  const held = new Set()
  const down = (ev) => {
    if (ev.repeat) { if (held.size) ev.preventDefault(); return }
    const action = actionFor(getMap(), ev)
    if (!action || !handlers[action]) return
    ev.preventDefault()
    held.add(action + '|' + ev.code)
    try { handlers[action].down(ev) } catch (e) { /* a shortcut must never break the page */ }
  }
  const up = (ev) => {
    for (const k of Array.from(held)) {
      const [action, code] = k.split('|')
      if (code === ev.code || ev.key === 'Alt' || ev.key === 'Shift') {
        held.delete(k)
        try { if (handlers[action] && handlers[action].up) handlers[action].up(ev) } catch (e) { /* contained */ }
      }
    }
  }
  target.addEventListener('keydown', down, true)
  target.addEventListener('keyup', up, true)
  return () => { target.removeEventListener('keydown', down, true); target.removeEventListener('keyup', up, true) }
}
