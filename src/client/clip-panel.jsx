/**
 * dsh-voice client: the clips the speech tools produced, played at the end of a turn.
 *
 * The tools (voice_speak, voice_announce) attach a `meta` payload to their `tool/result` event. That payload is
 * opaque to the core and survives replay, so this entry reads it from the session event stream and draws one
 * player per clip beside the file cards. It never touches the DOM directly, never bundles React and styles with
 * the theme tokens only, as the UI-plugin rules require.
 */
import * as React from 'react'

const TOOL_NAMES = new Set(['voice_speak', 'voice_announce'])

/** Read a tool name from a tool/result event through its callId, using the calls seen in the same turn. */
export function clipPayloads(matches) {
  const calls = new Map()
  const out = []
  // the entry runs inside the chat: anything unexpected must yield no players, never throw
  if (!Array.isArray(matches)) return out
  for (const match of matches) {
    const event = match.event || match
    if (!event || !event.data) continue
    if (event.type === 'tool/call') {
      calls.set(String(event.data.callId), String(event.data.name || ''))
      continue
    }
    if (event.type !== 'tool/result') continue
    const name = calls.get(String(event.data.callId || ''))
    if (!name || !TOOL_NAMES.has(name)) continue
    const meta = event.data.meta
    if (!meta || typeof meta !== 'object') continue
    const clips = Array.isArray(meta.clips) ? meta.clips.filter((c) => typeof c === 'string') : (typeof meta.clip === 'string' ? [meta.clip] : [])
    if (!clips.length) continue
    out.push({ name, clips, announce: typeof meta.announce === 'string' ? meta.announce : '', provider: meta.provider || '', voice: meta.voice || '' })
  }
  return out
}

/** A local file path as a URL the page may fetch (the plugin serves clips under /api/voice). */
export function clipUrl(path) {
  const p = String(path || '')
  const name = p.split(/[\\/]/).pop() || ''
  return '/api/voice/clips/' + encodeURIComponent(name)
}

/**
 * One player row. `audio` carries the browser element; nothing here writes to the document, so a remount
 * simply re-creates it.
 */
export function ClipPanel(props) {
  const items = props.items || []
  const [stopped, setStopped] = React.useState(false)
  if (!items.length) return null
  const rows = []
  for (const item of items) {
    for (const clip of item.clips) {
      rows.push(React.createElement('div', { key: item.name + ':' + clip, style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' } },
        React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary)', minWidth: '64px' } },
          item.announce ? 'Announce' : 'Voice'),
        React.createElement('audio', {
          controls: true,
          preload: 'none',
          src: clipUrl(clip),
          style: { height: '30px', maxWidth: '320px' },
          'data-voice-clip': clip,
          // an announce plays at once; a plain clip waits for the reader's click (browser autoplay policy)
          autoPlay: Boolean(item.announce) && !stopped,
        }),
        item.announce ? React.createElement('button', {
          type: 'button', disabled: stopped,
          onClick: () => setStopped(true),
          style: { padding: '2px 8px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border)', background: 'var(--dsw-alias-surface)', color: 'var(--dsw-alias-text)' },
          title: stopped ? 'Stopped' : 'Stop this announcement',
        }, stopped ? 'Stopped' : 'Stop') : null))
    }
  }
  return React.createElement('div', { style: { paddingTop: '6px' } },
    React.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary)' } }, 'Spoken'),
    rows)
}

/**
 * Register the entry. The host hands the turn tail entry its events through `inject`, and the contract is a
 * plain component or a factory; both shapes are accepted, so the entry works on either host line.
 */
export function registerClipSlot(ctx, opts = {}) {
  if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') return null
  const id = opts.id || 'voice-clips'
  try {
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
      { name: 'conversation.chat.turnTail', id, order: Number(opts.order || 40), label: 'Spoken' },
      (props) => {
        // the entry may receive matches, a turn, or nothing at all: narrow defensively, never throw
        const matches = Array.isArray(props && props.matches) ? props.matches : (Array.isArray(props && props.events) ? props.events : [])
        return React.createElement(ClipPanel, { items: clipPayloads(matches) })
      },
    ))
    return id
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[dsh-voice] clip player not registered: ' + String(e && e.message || e))
    return null
  }
}