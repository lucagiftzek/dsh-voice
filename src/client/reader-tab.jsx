/**
 * dsh-voice client: the sidebar reader tab (dsh-better-sidebar), merged from
 * the retired dsh-tts-reader package. Same tab id and title, so a saved
 * sidebar layout keeps the tab.
 *
 * Sources: paste or type, the current reply (the last reply whose speaker is
 * on screen), the text selected in the chat, or a .txt / .md / .html file
 * opened from this computer (read in the browser, nothing is uploaded).
 * Reading uses the same reader as the chat button (segments, detection,
 * badges, highlight); the reading view shows the text as segments with a
 * language chip each. Export writes the whole text as one MP3 or WAV.
 */
import * as React from 'react'
import { buildSegments } from '../../lib/shared/lang/segment.js'
import { useConfig, usePref, writePref, readPref, RATE_KEY, RATES, PREF_KEY, cleanEngine } from './store.js'
import { read, stop, togglePause, skipSentence, useNowPlaying, exportItem, lastMessage } from './reader.js'
import { currentAudio } from './player.js'
import { autoRead } from './autoread.js'
import { saveBytes } from './export.js'
import { readerModelToRoute } from '../../lib/shared/prefs.js'
import { TAGS, takesTags, stripTags, insertMarker, insertSnippet, fileText } from './tags.js'
import { Icon, ensureStyles } from './ui.jsx'

export const TAB_ID = 'dsh-tts-reader:main'
export const TAB_TITLE = 'TTS Reader'
const READER_ID = 'reader-tab'
const TEXT_KEY = 'dsh-tts-reader.text'
const PROVIDER_KEY = 'dsh-voice.v2.reader.provider'
const MODEL_PICK_KEY = 'dsh-voice.v2.reader.model'
const VOICE_KEY_PREFIX = 'dsh-tts-reader.voice.'
const OLD_MODEL_KEY = 'dsh-tts-reader.model'
const MARKERS = [['en', 'EN'], ['it', 'IT'], ['el', 'EL'], ['/', 'end']]
// The source segments: Paste focuses the text box (and pastes the clipboard when the browser allows it).
const SOURCES = [['paste', 'Paste', 'Paste text from the clipboard'], ['reply', 'Current reply', 'Take the current reply'], ['selection', 'Selection', 'Take the text selected in the chat'], ['file', 'File', 'Open file: a .txt, .md or .html file from this computer']]

/** Selection made in the chat, remembered when focus moves to the tab. */
let lastSelection = ''
let selectionHooked = false
function hookSelection(rootRef) {
  if (selectionHooked || typeof document === 'undefined') return
  selectionHooked = true
  document.addEventListener('selectionchange', () => {
    try {
      const sel = document.getSelection()
      const t = sel ? String(sel.toString() || '').trim() : ''
      if (!t) return
      const node = sel.anchorNode
      const root = rootRef.current
      if (root && node && root.contains(node)) return
      lastSelection = t
    } catch (e) { /* no selection API */ }
  })
}

/** Providers the tab offers: auto, every enabled TTS instance, the browser voice. */
export function readerProviders(cfg) {
  const out = [{ id: 'auto', label: 'Auto (per language)' }]
  for (const p of (cfg && cfg.providers) || []) {
    if (!p.enabled || p.type === 'browser' || !p.tts) continue
    out.push({ id: p.id, label: p.label || p.id })
  }
  out.push({ id: 'browser', label: 'Browser voice (no export)' })
  return out
}

/** Models and voices one provider publishes in /config. */
export function readerChoices(cfg, provider) {
  const e = (cfg && cfg.engines && cfg.engines[provider]) || {}
  let models = []
  if (provider === 'mistral' && e.models && Array.isArray(e.models.tts)) models = e.models.tts.map((m) => ({ id: m.id, label: m.name || m.id }))
  else if (provider === 'local' && e.models && Array.isArray(e.models.tts)) models = e.models.tts.map((m) => ({ id: m, label: m }))
  let voices = []
  if (Array.isArray(e.voices)) voices = e.voices.filter((v) => v && v.id && v.id !== 'auto').map((v) => ({ id: v.id, label: v.name || v.id }))
  else if (e.models && Array.isArray(e.models.tts) && provider === 'grey') voices = e.models.tts.map((v) => ({ id: v, label: v }))
  return { models, voices }
}

export function ReaderTab(props) {
  const cfg = useConfig()
  const rootRef = React.useRef(null)
  const areaRef = React.useRef(null)
  const viewRef = React.useRef(null)
  const fileRef = React.useRef(null)
  const remember = !(cfg && cfg.reader && cfg.reader.rememberText === false)
  const [text, setText] = React.useState(() => readPref(TEXT_KEY, ''))
  // First use: start from the retired tab's pick ("mistral:<model>", "local:maya", "grey").
  const oldPick = readPref(OLD_MODEL_KEY, '')
  const oldRoute = readerModelToRoute(oldPick)
  const provider = usePref(PROVIDER_KEY, oldRoute.provider || 'auto')
  const model = usePref(MODEL_PICK_KEY, oldRoute.model || '')
  const voice = usePref(VOICE_KEY_PREFIX + provider, oldPick ? readPref(VOICE_KEY_PREFIX + oldPick, '') : '')
  const rate = usePref(RATE_KEY, '1')
  const np = useNowPlaying(READER_ID)
  const [status, setStatus] = React.useState('')
  const [format, setFormat] = React.useState('mp3')
  const [exporting, setExporting] = React.useState(false)
  const [source, setSource] = React.useState('paste')
  React.useEffect(() => { ensureStyles(); hookSelection(rootRef) }, [])

  const update = (t) => { setText(t); if (remember) writePref(TEXT_KEY, t) }
  const segments = React.useMemo(() => buildSegments(text, { markers: true, detection: 'heuristic', enabled: cfg && cfg.languages && cfg.languages.enabled }).segments, [text, cfg])
  const choices = readerChoices(cfg, provider)
  const live = np.state === 'speaking' || np.state === 'paused' || np.state === 'working' || np.state === 'fallback'
  const composer = cleanEngine(readPref(PREF_KEY, 'auto'), cfg)

  const item = () => {
    const eng = provider || 'auto'
    const md = takesTags(eng, model) ? text : stripTags(text)
    return {
      messageId: READER_ID, md, cfg, engine: eng, model: model || '', voice: voice || '', prefs: {}, auto: false,
      getContainer: () => viewRef.current,
    }
  }

  const play = () => {
    if (live) { stop(); return }
    if (!text.trim()) { setStatus('Nothing to read yet: paste text, open a file or take the current reply.'); return }
    setStatus('')
    read(item(), { replace: true })
  }

  const insertAtCursor = (fn) => {
    const el = areaRef.current
    const a = el ? el.selectionStart : text.length
    const b = el ? el.selectionEnd : text.length
    const r = fn(text, a, b)
    update(r.text)
    window.setTimeout(() => { try { if (el) { el.focus(); el.setSelectionRange(r.start, r.end) } } catch (e) { /* detached */ } }, 0)
  }

  const takeReply = () => {
    const m = lastMessage(autoRead.lastIds())
    if (!m || !m.md) { setStatus('No reply on screen to take.'); return }
    update(m.md)
    setSource('reply')
    setStatus('Took the last reply.')
  }
  const takePaste = () => {
    setSource('paste')
    const el = areaRef.current
    const focus = () => { try { if (el) el.focus() } catch (e) { /* detached */ } }
    const clip = typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function' ? navigator.clipboard : null
    if (!clip) { focus(); setStatus('Paste into the text box (Ctrl+V).'); return }
    clip.readText().then((t) => {
      if (t && t.trim()) { update(t); setStatus('Pasted from the clipboard.') } else setStatus('The clipboard has no text; type or paste into the box.')
      focus()
    }).catch(() => { focus(); setStatus('Paste into the text box (Ctrl+V).') })
  }
  const takeSelection = () => {
    let t = ''
    try { t = String(document.getSelection().toString() || '').trim() } catch (e) { t = '' }
    if (!t || (rootRef.current && rootRef.current.contains(document.getSelection().anchorNode))) t = lastSelection
    if (!t) { setStatus('Select some text in the chat first.'); return }
    update(t)
    setSource('selection')
    setStatus('Took the selection.')
  }
  const openFile = (ev) => {
    const f = ev.target.files && ev.target.files[0]
    ev.target.value = ''
    if (!f) return
    if (f.size > 2 * 1024 * 1024) { setStatus('That file is over 2 MB; open a smaller one.'); return }
    const fr = new window.FileReader()
    fr.onload = () => {
      const parse = (html) => { try { return new window.DOMParser().parseFromString(html, 'text/html').body.textContent || '' } catch (e) { return '' } }
      update(fileText(f.name, String(fr.result || ''), parse))
      setSource('file')
      setStatus('Opened ' + f.name + '.')
    }
    fr.onerror = () => setStatus('Could not read that file.')
    fr.readAsText(f)
  }
  const doExport = async () => {
    if (!text.trim()) return
    setExporting(true)
    try {
      const out = await exportItem(item(), format, (i, n) => setStatus('Preparing audio: part ' + Math.min(i + 1, n) + ' of ' + n + '\u2026'))
      const name = saveBytes(out.bytes, out.mime, out.ext, 'tts-reader')
      setStatus('Saved ' + name + (parseFloat(rate) !== 1 ? ' (at normal speed)' : '') + (format === 'mp3' && out.ext === 'wav' ? '; the voices differ in format, so it is a WAV' : '') + '.')
    } catch (e) { setStatus('Export failed: ' + String(e && e.message || e)) }
    setExporting(false)
  }

  const stateLine = np.state === 'idle' ? status
    : np.state === 'working' ? 'Preparing speech\u2026'
    : np.state === 'error' ? 'Speech failed: ' + np.why
    : (np.state === 'paused' ? 'Paused' : 'Reading') + (np.lang ? ' in ' + String(np.lang).toUpperCase() : '') + (np.state === 'fallback' ? ' with the browser voice: ' + np.why : '')

  if (props.visible === false) return <div ref={rootRef} />

  const paused = np.state === 'paused'
  const speaking = np.state === 'speaking' || paused
  const failed = np.state === 'error'
  const chars = text.trim().length
  const meta = live ? (paused ? 'paused' : np.state === 'working' ? 'preparing' : 'reading') + (np.lang ? ' \u00b7 ' + String(np.lang).slice(0, 2).toUpperCase() : '')
    : chars ? chars.toLocaleString('en-US') + ' characters' : 'no text yet'
  const setRate = (v) => { writePref(RATE_KEY, v); const c = currentAudio(); if (c && c.tagName === 'AUDIO') c.playbackRate = parseFloat(v) }
  const pick = (id) => {
    if (id === 'paste') takePaste()
    else if (id === 'reply') takeReply()
    else if (id === 'selection') takeSelection()
    else if (fileRef.current) fileRef.current.click()
  }

  return (
    <div ref={rootRef} className="dv" role="region" aria-label="TTS Reader">
      <div className="dv-bar">
        <span className={'dv-dot' + (live ? ' on' : failed ? ' bad' : '')} aria-hidden="true" />
        <span className="dv-title">TTS Reader</span>
        <span className="dv-meta" title={meta}>{meta}</span>
      </div>
      <div className="dv-body">
        <div className="dv-sec">
          <div className="dv-lab">Source</div>
          <div className="dv-seg" role="group" aria-label="Text source">
            {SOURCES.map(([id, label, tip]) => (
              <button key={id} type="button" aria-pressed={source === id} title={tip} aria-label={tip} onClick={() => pick(id)}><span>{label}</span></button>
            ))}
          </div>
          <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.html,.htm,text/plain,text/markdown,text/html" style={{ display: 'none' }} onChange={openFile} aria-label="Open a text file" tabIndex={-1} />
        </div>

        <div className="dv-sec">
          <div className="dv-lab">
            <span>Text</span>
            <span className="dv-aside">
              <button type="button" className="dv-btn g sm" onClick={() => { update(''); setStatus('') }} disabled={!text} aria-label="Clear the text" title="Clear the text"><Icon name="close" size={12} />Clear</button>
            </span>
          </div>
          <textarea ref={areaRef} className="dv-ta" value={text} aria-label="Text to read" spellCheck={false}
            placeholder="Paste or type the text to read aloud. [[el]] switches to Greek, [[it]]...[[/]] marks an Italian span."
            onChange={(ev) => update(ev.target.value)}
            onKeyDown={(ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); play() } }} />
          <div className="dv-chips" role="toolbar" aria-label="Language markers">
            {MARKERS.map(([l, label]) => (
              <button key={l} type="button" className="dv-chip" title={l === '/' ? 'End a marked span: [[/]]' : 'Mark the selection (or switch from here) as ' + label}
                aria-label={l === '/' ? 'Insert end marker' : 'Insert ' + label + ' marker'}
                onClick={() => insertAtCursor((t, a, b) => insertMarker(t, a, b, l))}>{l === '/' ? '[[/]]' : '[[' + l + ']]'}</button>
            ))}
            {takesTags(provider, model) ? (
              <select aria-label="Insert a Voxtral tag" value="" className="dv-sel" onChange={(ev) => { const v = ev.target.value; if (v) insertAtCursor((t, a, b) => insertSnippet(t, a, b, v)) }}>
                <option value="">{'Insert a tag\u2026'}</option>
                {TAGS.map((g) => <optgroup key={g.group} label={g.group}>{g.items.map((x) => <option key={x} value={x}>{x}</option>)}</optgroup>)}
              </select>
            ) : null}
          </div>
        </div>

        <div className="dv-sec" role="group" aria-label="Voice for this read">
          <div className="dv-lab">Voice</div>
          <div className="dv-grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 84px' }}>
            <label className="dv-field"><span>Provider</span>
              <select aria-label="Provider" value={provider} className="dv-sel" onChange={(ev) => { writePref(PROVIDER_KEY, ev.target.value); writePref(MODEL_PICK_KEY, '') }}>
                {readerProviders(cfg).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label className="dv-field"><span>Speed</span>
              <select aria-label="Speed" value={rate} className="dv-sel" onChange={(ev) => setRate(ev.target.value)}>
                {RATES.map((r) => <option key={r} value={r}>{r + '\u00d7'}</option>)}
              </select>
            </label>
          </div>
          {choices.models.length || choices.voices.length ? (
            <div className="dv-grid">
              {choices.models.length ? (
                <label className="dv-field"><span>Model</span>
                  <select aria-label="Model" value={model} className="dv-sel" onChange={(ev) => writePref(MODEL_PICK_KEY, ev.target.value)}>
                    <option value="">default model</option>
                    {choices.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </label>
              ) : null}
              {choices.voices.length ? (
                <label className="dv-field"><span>Voice</span>
                  <select aria-label="Voice" value={voice} className="dv-sel" onChange={(ev) => writePref(VOICE_KEY_PREFIX + provider, ev.target.value)}>
                    <option value="">default voice</option>
                    {choices.voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}
          {provider === 'auto' && composer !== 'auto' ? <div className="dv-hint">{'The composer pick (' + composer + ') is not used here; Auto follows the per-language table.'}</div> : null}
        </div>

        <div className="dv-sec">
          <div className="dv-transport" role="toolbar" aria-label="Playback">
            <button type="button" className={'dv-btn p' + (live ? ' stop' : '')} onClick={play} disabled={!live && !text.trim()}
              aria-label={live ? 'Stop reading' : 'Read the text'} title={live ? 'Stop reading' : 'Read the text aloud (Ctrl+Enter)'}>
              <Icon name={np.state === 'working' ? 'spinner' : live ? 'stop' : 'play'} size={14} />{live ? 'Stop' : 'Read'}
            </button>
            <span className="dv-sp" />
            <button type="button" className="dv-btn i" onClick={() => skipSentence(-1)} disabled={!live} aria-label="Previous sentence" title="Previous sentence"><Icon name="prev" /></button>
            <button type="button" className="dv-btn i" onClick={() => togglePause()} disabled={!speaking} aria-pressed={paused}
              aria-label={paused ? 'Resume' : 'Pause'} title={paused ? 'Resume' : 'Pause'}><Icon name={paused ? 'play' : 'pause'} /></button>
            <button type="button" className="dv-btn i" onClick={() => skipSentence(1)} disabled={!live} aria-label="Next sentence" title="Next sentence"><Icon name="next" /></button>
          </div>
          <div role="status" aria-live="polite" className={failed ? 'dv-note' : 'dv-status' + (live ? ' live' : '')}>{stateLine}</div>
        </div>

        <div className="dv-sec">
          <div className="dv-lab">Reading view</div>
          <div ref={viewRef} className={'dv-view' + (segments.length ? '' : ' empty')} aria-label="Reading view">
            {segments.length ? segments.map((g, i) => (
              <span key={i} lang={g.lang}>
                <span data-dsh-voice-ui="1" className="dv-lang" data-l={String(g.lang).slice(0, 2).toLowerCase()} title={'language ' + g.lang + ' (' + g.source + ')'} aria-label={'language ' + g.lang}>{String(g.lang).slice(0, 2).toUpperCase()}</span>
                {g.text + ' '}
              </span>
            )) : 'The text appears here as you read, with its language per part.'}
          </div>
        </div>

        <div className="dv-sec">
          <div className="dv-lab">Export</div>
          <div className="dv-row">
            <div className="dv-seg sm" role="group" aria-label="Export format">
              <button type="button" aria-pressed={format === 'mp3'} onClick={() => setFormat('mp3')} title="One MP3 file">MP3</button>
              <button type="button" aria-pressed={format === 'wav'} onClick={() => setFormat('wav')} title="One WAV file">WAV</button>
            </div>
            <span style={{ flex: 1 }} />
            <button type="button" className="dv-btn" onClick={doExport} disabled={!text.trim() || exporting || provider === 'browser'}
              aria-label="Download the whole text as audio" title={provider === 'browser' ? 'The browser voice cannot be saved; pick a provider' : 'Download the whole text as one audio file'}>
              <Icon name={exporting ? 'spinner' : 'download'} size={14} />{exporting ? 'Preparing\u2026' : 'Download audio'}
            </button>
          </div>
          {provider === 'browser' ? <div className="dv-hint">The browser voice plays in this tab only; pick a provider to download audio.</div> : null}
        </div>
      </div>
    </div>
  )
}


/** The tab descriptor for ctx.betterSidebar.registerTab. */
export function readerTabDescriptor() {
  const icon = (size) => (
    <svg width={size || 16} height={size || 16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M2.5 6v4h2.6L8.6 13V3L5.1 6z" />
      <path d="M11 5.6a3.4 3.4 0 0 1 0 4.8M12.8 3.9a5.8 5.8 0 0 1 0 8.2" strokeLinecap="round" />
    </svg>
  )
  return { id: TAB_ID, title: TAB_TITLE, order: 94, single: true, icon, component: (props) => <ReaderTab visible={props.visible} /> }
}
