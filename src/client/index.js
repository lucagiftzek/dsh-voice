/**
 * dsh-voice: browser half (built into lib/client.js by scripts/build.mjs).
 *
 *   conversation.chat.assistant-actions  id voice-speak    order 20   speaker on every finished reply
 *   conversation.input.right             id voice-mic      order 100  microphone + engine picker
 *   settings.section                     id voice-settings order 60   Settings > Voice
 *   betterSidebar tab                    id dsh-tts-reader:main, "TTS Reader" (OPTIONAL)
 *
 * Exported contract identical to 1.x: name 'dsh-voice', inject ['slots'],
 * loader id 'dsh-voice'. `slots` is a core service on every DSH line. The
 * sidebar is NOT injected: a required inject that the host refuses keeps the
 * whole client from booting (seen on the 0.2.1 dry run), so the reader tab is
 * registered through ctx.inject(['betterSidebar'], ...) only when that
 * service exists, and a host without dsh-better-sidebar loads everything else.
 *
 * window.__DSH_VOICE_V2__ tells the dsh-tts-reader deprecation stub (and any
 * older copy that checks it) that the reader tab now comes from this package.
 */
import { SpeakAction, MicAction } from './actions.jsx'
import { VoiceSettings } from './settings.jsx'
import { readerTabDescriptor } from './reader-tab.jsx'
import { migratePrefs } from '../../lib/shared/prefs.js'
import { installShortcuts } from './shortcuts.js'
import { stop, togglePause, skipSentence, lastMessage, getNow } from './reader.js'
import { autoRead } from './autoread.js'
import { getMic } from './mic-registry.js'
import { currentConfig, readPref, writePref, RATE_KEY, RATES } from './store.js'
import { currentAudio } from './player.js'
import { ensureStyles } from './ui.jsx'

export const name = 'dsh-voice'
export const inject = ['slots']

function setRate(dir) {
  const cur = readPref(RATE_KEY, '1')
  const i = Math.max(0, RATES.indexOf(cur))
  const next = RATES[Math.max(0, Math.min(RATES.length - 1, i + dir))]
  writePref(RATE_KEY, next)
  const a = currentAudio()
  if (a && a.tagName === 'AUDIO') a.playbackRate = parseFloat(next)
}

/** Shortcut actions (see shortcuts.js for the defaults and the conflict check). */
export const SHORTCUT_HANDLERS = {
  readLast: { down() { const m = lastMessage(autoRead.lastIds()); if (m && m.read) m.read() } },
  playPause: { down() { const s = getNow().state; if (s === 'idle' || s === 'error') { const m = lastMessage(autoRead.lastIds()); if (m && m.read) m.read() } else togglePause() } },
  stop: { down() { stop() } },
  nextSentence: { down() { skipSentence(1) } },
  prevSentence: { down() { skipSentence(-1) } },
  faster: { down() { setRate(1) } },
  slower: { down() { setRate(-1) } },
  dictate: { down() { const m = getMic(); if (m) m.press() }, up() { const m = getMic(); if (m) m.release() } },
  dictationLang: { down() { const m = getMic(); if (m) m.cycleLang() } },
}

export function apply(ctx) {
  try { if (typeof window !== 'undefined') { window.__DSH_VOICE_V2__ = { version: 2 }; migratePrefs(window.localStorage) } } catch (e) { /* storage blocked */ }
  try { ensureStyles() } catch (e) { /* no document: server render or tests */ }
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
    { name: 'conversation.chat.assistant-actions', id: 'voice-speak', order: 20, label: 'Read aloud' },
    SpeakAction,
  ))
  // label as a FUNCTION and an inject() declaration: the shape the settings shell expects.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'voice-settings', order: 60, label: () => 'Voice', inject: () => ({}),
  }, VoiceSettings))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
    { name: 'conversation.input.right', id: 'voice-mic', order: 100, label: 'Dictate' },
    MicAction,
  ))

  // The reader tab, only when the sidebar service exists. A duplicate tab id
  // (an old dsh-tts-reader still installed) throws in registerTab: caught, so
  // there is never a second tab and never a broken client.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['betterSidebar'], (c) => {
        const sb = c.betterSidebar
        if (!sb || typeof sb.registerTab !== 'function') return
        const enabled = !(currentConfig() && currentConfig().reader && currentConfig().reader.enabled === false)
        if (!enabled) return
        let dispose = null
        try { dispose = sb.registerTab(readerTabDescriptor()) } catch (e) { console.warn('[dsh-voice] reader tab not registered: ' + String(e && e.message || e)) }
        if (dispose && typeof c.on === 'function') c.on('dispose', () => { try { dispose() } catch (e) { /* gone */ } })
      })
    } catch (e) { console.warn('[dsh-voice] sidebar unavailable: ' + String(e && e.message || e)) }
  }

  if (typeof document !== 'undefined') {
    const off = installShortcuts(document, () => (currentConfig() && currentConfig().shortcuts) || {}, SHORTCUT_HANDLERS)
    if (typeof ctx.on === 'function') { try { ctx.on('dispose', off) } catch (e) { /* older host */ } }
  }
}
