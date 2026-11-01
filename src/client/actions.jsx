/**
 * dsh-voice client: the speaker on assistant messages and the composer mic.
 * Behaviour ported from 1.x (each rule there was a measured bug fix); new in
 * 2.0: per-language segments with in-text markers, ElevenLabs selectable again,
 * provider instances added in Settings appear in the menu.
 */
import * as React from 'react'
import { buildSegments } from '../../lib/shared/lang/segment.js'
import {
  PREF_KEY, VOICE_KEY, ALIVOICE_KEY, MODEL_KEY, MIMOVOICE_KEY, LFM3VOICE_KEY, RATE_KEY, FALLBACK_KEY, RATES, MENU_ENGINES,
  cleanEngine, readPref, writePref, usePref, directionEngine, useConfig, refreshConfig, useQuota, loadQuota,
  elevenOf, quotaText, clampWhy, charsLeftIn, fmtChars, elevenVoiceName, voiceLabel, LM_LABELS, localPick, autoFor,
} from './store.js'
import { currentAudio } from './player.js'
import { read, stop, stopAuto, togglePause, skipSentence, useNowPlaying, registerMessage } from './reader.js'
import { findMessageContainer } from './highlight.js'
import { autoRead } from './autoread.js'
import { createDictation, insertAt, caretToDraftOffset, nextDictationLang, levelOf } from './dictation.js'
import { registerMic, findComposerEditor, DICT_LANG_KEY } from './mic-registry.js'
import { Icon } from './ui.jsx'

export const BTN = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  padding: '2px 4px', lineHeight: 1, fontSize: '13px', opacity: 0.72,
  display: 'inline-flex', alignItems: 'center', gap: '3px', borderRadius: '4px',
}
const SEL = { background: 'transparent', border: 'none', color: 'inherit', font: 'inherit', fontSize: '11px', opacity: 0.55, cursor: 'pointer', padding: 0 }

/** The assistant message's text from ChatSnapshot.legacy.nodes (text blocks only: no tools, no reasoning). */
export function messageText(chatSnapshot, messageId) {
  try {
    const nodes = (chatSnapshot && chatSnapshot.legacy && chatSnapshot.legacy.nodes) || []
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i]
      if (n && n.kind === 'assistant' && n.messageId === messageId) {
        return (n.blocks || []).filter((b) => b && b.kind === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n')
      }
    }
  } catch (e) { /* snapshot shape changed: read nothing rather than crash */ }
  return ''
}

const LANG_LABEL = { marker: 'marked in the text', model: 'detected by the model', heuristic: 'detected from the words', script: 'detected from the script', smoothed: 'follows the neighbouring sentence', default: 'message default', manual: 'chosen by hand', mixed: 'detected' }

/** Speaker on a finished assistant message. */
export function SpeakAction(props) {
  const chat = props.useChat ? props.useChat((s) => s) : null
  const cfg = useConfig()
  if (chat) autoRead.observe(chat)
  // Every hook runs on every render, including the ones that render nothing.
  const engine = cleanEngine(usePref(PREF_KEY, 'auto'), cfg)
  const prefs = {
    el: usePref(VOICE_KEY, 'auto'), ali: usePref(ALIVOICE_KEY, 'auto'),
    mimo: usePref(MIMOVOICE_KEY, 'auto'), lfm3: usePref(LFM3VOICE_KEY, 'female'),
  }
  const quota = useQuota()
  const np = useNowPlaying(props.messageId)
  const rowRef = React.useRef(null)
  const md = React.useMemo(() => messageText(chat, props.messageId), [chat, props.messageId])
  const markersOn = !(cfg && cfg.markers && cfg.markers.enabled === false)
  const detection = (cfg && cfg.detection && cfg.detection.mode) || 'heuristic+model'
  const enabled = cfg && cfg.languages && cfg.languages.enabled
  const built = React.useMemo(() => buildSegments(md, { markers: markersOn, detection: detection === 'off' ? 'off' : 'heuristic', enabled }), [md, markersOn, detection])
  const prefsRef = React.useRef(prefs)
  prefsRef.current = prefs

  const item = (code, auto) => ({
    messageId: props.messageId, md, code: Boolean(code), cfg, engine, prefs: prefsRef.current, auto: Boolean(auto),
    getContainer: (probe) => findMessageContainer(rowRef.current, probe),
  })

  // Shortcuts and the reader tab reach this message through the registry.
  React.useEffect(() => (md ? registerMessage(props.messageId, { md, getContainer: (probe) => findMessageContainer(rowRef.current, probe), read: () => read(item(false, false)) }) : undefined), [md, props.messageId, engine, cfg])

  // Auto-read: a reply that finished while this chat was in view. Waits until
  // the text has been stable for a moment.
  const autoMode = (cfg && cfg.reading && cfg.reading.autoRead) || 'off'
  React.useEffect(() => {
    if (!md || autoMode === 'off') return undefined
    const t = window.setTimeout(() => {
      if (autoRead.take(props.messageId, autoMode)) read(item(false, true), { replace: false })
    }, 1200)
    return () => window.clearTimeout(t)
  }, [md, autoMode, props.messageId])

  if (!md) return null

  const state = np.state
  const why = np.why
  const langs = Array.from(new Set(built.segments.map((x) => String(x.lang || 'en').slice(0, 2))))
  const engineName = engine === 'auto' ? (langs.map((l) => autoFor(cfg, l)).filter(Boolean).filter((x, i, arr) => arr.indexOf(x) === i).join(' + ') || 'auto') : engine
  const voiceName = engine === 'elevenlabs' ? elevenVoiceName(cfg, prefs.el) : ''
  const charsNow = engine === 'elevenlabs' ? charsLeftIn(cfg, quota || elevenOf(cfg).quota) : null
  const live = state === 'speaking' || state === 'fallback' || state === 'working' || state === 'paused'

  const play = (code) => {
    if (live) { stop(); return }
    read(item(code, false))
  }

  const title = state === 'speaking' || state === 'paused' ? 'Stop'
    : state === 'working' ? 'Generating speech\u2026'
    : state === 'fallback' ? ('Speaking with the BROWSER voice: ' + engineName + ' failed: ' + why + ' (click to stop)')
    : state === 'error' ? ('Speech failed: ' + why)
    : 'Read aloud (' + engineName + (voiceName ? '/' + voiceName : '')
      + (engineName === 'local' ? ' \u00b7 this box, slow but unlimited' : '')
      + (langs.length > 1 ? ' \u00b7 ' + langs.map((l) => l.toUpperCase()).join('/') : '') + ')'
      + (charsNow !== null ? ': ' + fmtChars(charsNow) + ' chars left; this one about ' + fmtChars(built.plain.length) : '')

  const glyph = live ? 'stop' : state === 'error' ? 'warn' : 'speaker'
  const badge = live && np.lang ? String(np.lang).slice(0, 2).toUpperCase() : ''
  return (
    <span ref={rowRef} data-dsh-voice-ui="1" className="dv-inline" style={{ display: 'inline-flex', alignItems: 'center' }}>
      <button type="button" onClick={() => play(false)} title={title} aria-label={title} style={BTN}><Icon name={state === 'working' ? 'spinner' : glyph} /></button>
      {badge ? (
        <span role="status" aria-live="polite" aria-label={'Reading in ' + badge} title={'Language ' + np.lang + ': ' + (LANG_LABEL[np.langSource] || 'detected') + (np.queued ? '; ' + np.queued + ' queued' : '')}
          className="dv-lang">{badge}</span>
      ) : null}
      {state === 'speaking' || state === 'paused' ? (
        <button type="button" onClick={() => togglePause()} aria-pressed={state === 'paused'} aria-label={state === 'paused' ? 'Resume' : 'Pause'} title={state === 'paused' ? 'Resume' : 'Pause'} style={BTN}>
          <Icon name={state === 'paused' ? 'play' : 'pause'} size={13} />
        </button>
      ) : null}
      {state === 'speaking' || state === 'paused' ? (
        <button type="button" onClick={() => skipSentence(1)} aria-label="Next sentence" title="Next sentence" style={BTN}><Icon name="next" size={13} /></button>
      ) : null}
      {(state === 'fallback' || state === 'error') ? (
        <span title={why} role="status" aria-live="polite" style={{ fontSize: '11px', opacity: 0.75, marginLeft: '4px', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', verticalAlign: 'middle' }}>
          {(state === 'fallback' ? 'browser voice: ' : '') + clampWhy(why, 64)}
        </span>
      ) : null}
      {built.codeBlocks > 0 && !live ? (
        <button type="button" onClick={() => play(true)} aria-label="Read code aloud"
          title={'Also read the ' + built.codeBlocks + ' code block' + (built.codeBlocks === 1 ? '' : 's')}
          style={Object.assign({}, BTN, { opacity: 0.5, fontSize: '11px' })}><Icon name="speakerCode" size={15} /></button>
      ) : null}
    </span>
  )
}

/** Microphone + engine picker in the composer. */
export function MicAction(props) {
  const cfg = useConfig()
  const [state, setState] = React.useState('idle')   // idle | rec | busy | error
  const engine = cleanEngine(usePref(PREF_KEY, 'auto'), cfg)
  const localModel = usePref(MODEL_KEY, 'auto')
  const mimoVoiceSel = usePref(MIMOVOICE_KEY, 'auto')
  const lfm3VoiceSel = usePref(LFM3VOICE_KEY, 'female')
  const elVoice = usePref(VOICE_KEY, 'auto')
  const aliVoice = usePref(ALIVOICE_KEY, 'auto')
  const rateSel = usePref(RATE_KEY, '1')
  const quota = useQuota()
  const [why, setWhy] = React.useState('')
  const rec = React.useRef(null)
  const chunks = React.useRef([])
  const stream = React.useRef(null)

  // The draft MUST be read at render time and carried into async callbacks
  // through a ref: props.useInput is a hook, and calling it after an await threw
  // "Invalid hook call" and turned every good transcript into an error (1.x).
  const draftAtRender = props.useInput ? props.useInput((s) => (s && s.draft) || '') : ''
  const draftRef = React.useRef('')
  draftRef.current = draftAtRender
  const ownDraft = React.useRef(null)
  const chat = props.useChat ? props.useChat((x) => x) : null
  if (chat) autoRead.observe(chat)
  // The person typing stops what auto-read started (and its queue). Our own
  // setDraft after a dictation is not typing.
  const prevDraft = React.useRef(draftAtRender)
  React.useEffect(() => {
    const prev = prevDraft.current
    prevDraft.current = draftAtRender
    if (ownDraft.current !== null && draftAtRender === ownDraft.current) { ownDraft.current = null; return }
    if (draftAtRender && draftAtRender !== prev) stopAuto()
  }, [draftAtRender])

  // ---- dictation: toggle or push-to-talk, a language chip, a level meter, cancel
  const dict = (cfg && cfg.dictation) || {}
  const dictLang = usePref(DICT_LANG_KEY, dict.lang || 'auto')
  const [heard, setHeard] = React.useState('')
  const [level, setLevel] = React.useState(0)
  const discard = React.useRef(false)
  const meter = React.useRef(null)
  const caret = React.useRef(null)   // { offset, draft } at the last selection inside the composer
  const wrapRef = React.useRef(null)

  const stopMeter = () => {
    const m = meter.current
    meter.current = null
    if (!m) return
    try { if (m.raf) window.cancelAnimationFrame(m.raf) } catch (e) { /* gone */ }
    try { m.ac.close() } catch (e) { /* gone */ }
    setLevel(0)
  }
  const startMeter = (s) => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return
      const ac = new AC()
      const an = ac.createAnalyser()
      an.fftSize = 512
      ac.createMediaStreamSource(s).connect(an)
      const buf = new Uint8Array(an.fftSize)
      const m = { ac, raf: 0 }
      let last = 0
      const tick = (t) => {
        if (meter.current !== m) return
        an.getByteTimeDomainData(buf)
        if (!t || t - last > 66) { last = t || 0; setLevel(levelOf(buf)) }
        m.raf = window.requestAnimationFrame(tick)
      }
      meter.current = m
      m.raf = window.requestAnimationFrame(tick)
    } catch (e) { /* the meter is a nicety */ }
  }
  const cleanup = () => {
    stopMeter()
    try { if (stream.current) stream.current.getTracks().forEach((t) => t.stop()) } catch (e) { /* gone */ }
    stream.current = null; rec.current = null; chunks.current = []
  }
  React.useEffect(() => cleanup, [])

  // Remember where the caret is in the composer (Lexical contenteditable), so
  // dictated text lands there even though clicking the mic takes the focus.
  React.useEffect(() => {
    const onSel = () => {
      try {
        const ed = findComposerEditor(wrapRef.current)
        const sel = document.getSelection()
        if (!ed || !sel || !sel.rangeCount || !ed.contains(sel.anchorNode)) return
        const r = document.createRange()
        r.selectNodeContents(ed)
        r.setEnd(sel.anchorNode, sel.anchorOffset)
        caret.current = { offset: caretToDraftOffset(draftRef.current, r.toString()), draft: draftRef.current }
      } catch (e) { /* no selection API */ }
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  const fail = (msg) => { setWhy(msg); machine.current.fail(); setState('error'); window.setTimeout(() => { machine.current.reset(); setState('idle') }, 3000) }

  const finish = async (blob) => {
    try {
      const fd = new FormData()
      // Safari records fMP4, Chrome webm/opus: the suffix must match the blob.
      const mime = String(blob.type || 'audio/webm')
      const ext = /mp4|m4a|aac/i.test(mime) ? 'm4a' : /ogg/i.test(mime) ? 'ogg' : /wav/i.test(mime) ? 'wav' : 'webm'
      fd.append('file', blob, 'dictation.' + ext)
      const lp = localPick(cfg, engine, localModel, 'stt')
      const qs = '?provider=' + encodeURIComponent(directionEngine(engine, cfg, 'stt')) + (lp ? '&model=' + encodeURIComponent(lp) : '')
        + (dictLang && dictLang !== 'auto' ? '&lang=' + encodeURIComponent(dictLang) : '')
      const sr = await fetch('/api/voice/stt' + qs, { method: 'POST', body: fd })
      if (!sr.ok) {
        let m = 'stt ' + sr.status
        try { m = ((await sr.json()) || {}).error || m } catch (e) { /* not json */ }
        throw new Error(m)
      }
      const sj = (await sr.json()) || {}
      const raw = sj.text || ''
      if (sj.language) setHeard(String(sj.language).slice(0, 2).toLowerCase())
      if (!raw.trim()) { fail('no speech detected in that clip'); return }
      let text = raw
      if (!(dict.polish && dict.polish.enabled === false)) {
        try {
          const pr = await fetch('/api/voice/polish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: raw }) })
          if (pr.ok) text = ((await pr.json()) || {}).text || raw
        } catch (e) { /* polish is best effort */ }
      }
      const actions = props.inputActions
      if (!actions || typeof actions.setDraft !== 'function') throw new Error('composer actions unavailable')
      const existing = draftRef.current || ''
      const c = caret.current && caret.current.draft === existing ? caret.current.offset : null
      const next = insertAt(existing, text, dict.insert || 'caret', c)
      ownDraft.current = next.draft
      caret.current = { offset: next.caret, draft: next.draft }
      autoRead.markDictated()
      actions.setDraft(next.draft)
      machine.current.done()
      setState('idle')
    } catch (e) {
      fail(String(e && e.message || e))
    } finally { cleanup() }
  }

  const startRecording = async () => {
    try {
      discard.current = false
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (machine.current.state !== 'rec') { s.getTracks().forEach((t) => t.stop()); return }
      stream.current = s
      const mr = new window.MediaRecorder(s)
      rec.current = mr; chunks.current = []
      mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.current.push(ev.data) }
      mr.onstop = () => {
        if (discard.current) { cleanup(); return }
        finish(new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' }))
      }
      mr.start()
      startMeter(s)
      setState('rec')
    } catch (e) {
      fail('microphone unavailable: ' + String(e && e.message || e))
    }
  }
  const stopRecording = () => {
    // Released before the microphone was even open: nothing was recorded.
    if (!rec.current) { cleanup(); machine.current.reset(); setState('idle'); return }
    setState('busy')
    try { rec.current.stop() } catch (e) { cleanup(); machine.current.reset(); setState('idle') }
  }
  const discardRecording = () => { discard.current = true; try { if (rec.current) rec.current.stop() } catch (e) { /* stopped */ } cleanup(); setState('idle') }

  const machine = React.useRef(null)
  if (!machine.current) machine.current = createDictation({ mode: dict.mode, effects: {} })
  machine.current.setMode(dict.mode)
  // Effects are rebound every render so they see this render's closures.
    const fx = { start: startRecording, stop: stopRecording, discard: discardRecording }
  const press = () => { if (engine === 'browser') return; const before = machine.current.state; machine.current.press(); after(before) }
  const release = () => { const before = machine.current.state; machine.current.release(); after(before) }
  const cancel = () => { const before = machine.current.state; machine.current.cancel(); after(before) }
  function after(before) {
    const now = machine.current.state
    if (before !== 'rec' && now === 'rec') { setState('rec'); fx.start() }
    else if (before === 'rec' && now === 'busy') fx.stop()
    else if (before === 'rec' && now === 'idle') fx.discard()
  }
  React.useEffect(() => registerMic({ press, release, cancel, cycleLang: () => writePref(DICT_LANG_KEY, nextDictationLang(dictLang, cfg && cfg.languages && cfg.languages.enabled)) }))

  const e = (cfg && cfg.engines) || {}
  const opts = []
  const push = (v, label, ok, note) => opts.push(<option key={v} value={v} disabled={!ok} title={note || label}>{label + (ok ? '' : ' (unavailable)')}</option>)
  push('auto', 'Voice: auto' + (cfg && cfg.defaults ? ' (' + cfg.defaults.tts + ')' : ''), true)
  push('mimo', 'Xiaomi MiMo (TTS + ASR)', Boolean(e.mimo && e.mimo.available), e.mimo && e.mimo.note)
  push('mistral', 'Mistral (Voxtral)', !e.mistral || e.mistral.available !== false, e.mistral && e.mistral.note)
  push('elevenlabs', 'ElevenLabs', Boolean(e.elevenlabs && e.elevenlabs.available), e.elevenlabs && e.elevenlabs.note)
  push('lfm3', 'Liquid LFM3 Audio (this box)', Boolean(e.lfm3 && e.lfm3.available), e.lfm3 && e.lfm3.note)
  push('local', 'Local (this box)', Boolean(e.local && e.local.available), e.local && e.local.note)
  push('grey', (e.grey && e.grey.v2 && e.grey.v2.label) || 'Kokoro (remote)', Boolean(e.grey && e.grey.available), e.grey && e.grey.note)
  ;((cfg && cfg.providers) || []).forEach((p) => {
    if (MENU_ENGINES.indexOf(p.id) >= 0 || p.type === 'browser' || !p.enabled) return
    if (['groq', 'alibaba'].indexOf(p.id) >= 0) return
    push(p.id, p.label || p.id, Boolean(p.tts || p.stt), (e[p.id] && e[p.id].note) || '')
  })
  push('browser', 'Browser voice (no mic)', true, 'The browser\'s own speech synthesis; no dictation.')

  const ptt = dict.mode === 'push-to-talk'
  const title = state === 'rec' ? (ptt ? 'Recording: release to transcribe' : 'Recording: click to transcribe (or hold and release)')
    : state === 'busy' ? 'Transcribing\u2026' : state === 'error' ? why
    : ptt ? 'Hold to dictate a prompt' : 'Dictate a prompt (click to start and stop, or hold to talk)'
  const langChip = dictLang === 'auto' ? (heard ? 'Auto: ' + heard.toUpperCase() : 'Auto') : String(dictLang).toUpperCase()
  const cur = currentAudio()
  const voices = (id) => (((cfg || {}).engines || {})[id] || {}).voices
  const el = elevenOf(cfg)
  const q = quota || el.quota

  return (
    <span ref={wrapRef} data-dsh-voice-ui="1" className="dv-inline" style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
      <button type="button" title={title} aria-label={title} aria-pressed={state === 'rec'} disabled={engine === 'browser'}
        onPointerDown={(ev) => { if (ev.button !== undefined && ev.button !== 0) return; ev.preventDefault(); press() }}
        onPointerUp={() => release()}
        onPointerLeave={() => { if (machine.current.state === 'rec' && ptt) release() }}
        onKeyDown={(ev) => { if ((ev.key === ' ' || ev.key === 'Enter') && !ev.repeat) { ev.preventDefault(); press() } }}
        onKeyUp={(ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); release() } }}
        style={Object.assign({}, BTN, { opacity: engine === 'browser' ? 0.3 : state === 'idle' ? 0.72 : 1, color: state === 'rec' || state === 'error' ? 'var(--dv-bad)' : 'inherit', touchAction: 'none' })}>
        <Icon name={state === 'rec' ? 'rec' : state === 'busy' ? 'spinner' : state === 'error' ? 'warn' : 'mic'} />
      </button>
      {state === 'rec' ? (
        <span role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}
          style={{ display: 'inline-block', width: '36px', height: '6px', borderRadius: '3px', background: 'var(--dv-line)', overflow: 'hidden', verticalAlign: 'middle' }}>
          <span style={{ display: 'block', height: '100%', width: Math.round(level * 100) + '%', background: 'var(--dv-bad)' }} />
        </span>
      ) : null}
      {state === 'rec' ? (
        <button type="button" onClick={() => cancel()} aria-label="Cancel dictation" title="Cancel: discard this recording" style={Object.assign({}, BTN, { fontSize: '11px' })}><Icon name="close" size={12} /></button>
      ) : null}
      <button type="button" aria-label={'Dictation language: ' + langChip + '. Click to change.'} title="Dictation language (Auto uses the per-language table; the chip shows what was heard)"
        onClick={() => writePref(DICT_LANG_KEY, nextDictationLang(dictLang, cfg && cfg.languages && cfg.languages.enabled))}
        style={Object.assign({}, BTN, { fontSize: '10px', fontWeight: 600, opacity: 0.6, padding: '1px 4px', border: '1px solid currentColor' })}>{langChip}</button>
      <select value={engine} title="Which speech engine to use" aria-label="Speech engine"
        onFocus={() => refreshConfig()} onPointerDown={() => refreshConfig()}
        onChange={(ev) => writePref(PREF_KEY, ev.target.value)} style={Object.assign({}, SEL, { maxWidth: '128px' })}>{opts}</select>
      <select value={rateSel} title="Read-aloud speed (pitch preserved; dictation unaffected)" aria-label="Read-aloud speed"
        onChange={(ev) => { writePref(RATE_KEY, ev.target.value); const c = currentAudio(); if (c && c.tagName === 'AUDIO') c.playbackRate = parseFloat(ev.target.value) }}
        style={SEL}>{RATES.map((v) => <option key={v} value={v}>{v + '\u00d7'}</option>)}</select>
      {engine === 'mimo' && voices('mimo') && voices('mimo').length ? (
        <select value={mimoVoiceSel} aria-label="MiMo voice" onChange={(ev) => writePref(MIMOVOICE_KEY, ev.target.value)} style={Object.assign({}, SEL, { maxWidth: '150px' })}
          title={'Which MiMo-V2.5-TTS voice reads aloud. Built-in voices use mimo-v2.5-tts; "designed" uses the voicedesign model; "cloned" the voiceclone model. Dictation always uses mimo-v2.5-asr.'}>
          {voices('mimo').map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      ) : null}
      {engine === 'lfm3' && voices('lfm3') && voices('lfm3').length ? (
        <select value={lfm3VoiceSel} aria-label="LFM3 voice" onChange={(ev) => writePref(LFM3VOICE_KEY, ev.target.value)} style={Object.assign({}, SEL, { maxWidth: '130px' })}
          title="Which LFM3-Audio voice reads aloud. Free and unlimited, but it borrows the GPU, and the first read after something else used the card pays a model load.">
          {voices('lfm3').map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      ) : null}
      {engine === 'elevenlabs' && el.available && q ? (
        <span aria-label="ElevenLabs characters remaining" style={{ fontSize: '11px', whiteSpace: 'nowrap', cursor: 'help', opacity: charsLeftIn(cfg, q) <= 0 ? 0.95 : 0.55, padding: '0 2px' }}
          title={(charsLeftIn(cfg, q) <= 0 ? 'No ElevenLabs characters left in this period. ' : 'About ' + fmtChars(charsLeftIn(cfg, q)) + ' characters of ElevenLabs speech left. ') + quotaText(q) + '. About half a credit per character on flash v2.5.'}>
          {charsLeftIn(cfg, q) <= 0 ? '0 chars' : fmtChars(charsLeftIn(cfg, q)) + ' chars'}
        </span>
      ) : null}
      {engine === 'local' && e.local && e.local.models ? (
        <select value={localModel} aria-label="Local model" onChange={(ev) => writePref(MODEL_KEY, ev.target.value)} style={Object.assign({}, SEL, { maxWidth: '150px' })}
          title="Which model THIS box uses. Reading aloud and dictation use different groups; model: auto keeps each side's default (Maya1 for voices, fast whisper for dictation). Switching pays a one-off model load.">
          <option key="auto" value="auto">model: auto</option>
          {(e.local.models.tts || []).length ? <optgroup key="t" label="read aloud">{e.local.models.tts.map((id) => <option key={'t' + id} value={id}>{LM_LABELS[id] || id}</option>)}</optgroup> : null}
          {(e.local.models.stt || []).length ? <optgroup key="s" label="dictation">{e.local.models.stt.map((id) => <option key={'s' + id} value={id}>{LM_LABELS[id] || id}</option>)}</optgroup> : null}
        </select>
      ) : null}
      {engine === 'elevenlabs' && el.voices && el.voices.length ? (
        <select value={elVoice} aria-label="ElevenLabs voice" onChange={(ev) => writePref(VOICE_KEY, ev.target.value)} style={Object.assign({}, SEL, { maxWidth: '150px' })}
          title={'Which ElevenLabs voice reads aloud: ' + el.voices.length + ' on this account. ' + (quotaText(q) ? quotaText(q) + '. ' : '') + 'Billed per character.'}>
          <option key="auto" value="auto">voice: account default</option>
          {el.voices.map((v) => <option key={v.id} value={v.id} title={voiceLabel(v) + (v.category ? ' \u00b7 ' + v.category : '')}>{voiceLabel(v)}</option>)}
        </select>
      ) : null}
      {engine === 'alibaba' && voices('alibaba') && voices('alibaba').length ? (
        <select value={aliVoice} aria-label="Alibaba voice" onChange={(ev) => writePref(ALIVOICE_KEY, ev.target.value)} style={Object.assign({}, SEL, { maxWidth: '130px' })} title="Which Qwen3-TTS voice reads aloud.">
          <option key="auto" value="auto">voice: Cherry</option>
          {voices('alibaba').map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      ) : null}
      <button type="button" aria-label="Rewind 15 seconds" title="Rewind 15 seconds (server audio only, not the browser voice)"
        disabled={!cur || cur.tagName !== 'AUDIO'}
        onClick={() => { const c = currentAudio(); if (c && c.tagName === 'AUDIO') c.currentTime = Math.max(0, c.currentTime - 15) }}
        style={Object.assign({}, BTN, { opacity: !cur || cur.tagName !== 'AUDIO' ? 0.6 : 1, fontSize: '11px', padding: '2px 6px' })}>
        <Icon name="rewind" size={12} />15s
      </button>
    </span>
  )
}
