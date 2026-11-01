/**
 * dsh-voice client: Settings > Voice (slot settings.section, id voice-settings).
 *
 * Blocks: this browser (fallback switch, speed: per-browser as in 1.x),
 * Providers (status, credential source, Test, Enable, Edit, Add), Languages
 * (per-language TTS provider/model/voice/speed/fallback and STT, Preview,
 * Apply recommended), Detection (mode, DSH model), Reading (auto-read, markers).
 *
 * Reads GET /api/voice/settings (redacted: a literal key arrives as '__set__');
 * writes PATCH /api/voice/settings with a capability token from /session. The
 * same route works on every DSH version (the server decides where it stores).
 */
import * as React from 'react'
import { FALLBACK_KEY, RATE_KEY, RATES, PREF_KEY, usePref, writePref, useConfig, useQuota, refreshConfig, cleanEngine, elevenOf, charsLeftIn, fmtChars } from './store.js'
import { currentAudio, speakBrowser } from './player.js'
import { DEFAULT_SHORTCUTS, parseCombo, conflicts } from './shortcuts.js'

const SAMPLE = { en: 'Hello, this is a short English test.', it: 'Ciao, questa è una breve prova in italiano.', el: 'Γεια σας, αυτή είναι μια σύντομη δοκιμή στα ελληνικά.' }
const LANG_NAMES = { en: 'English', it: 'Italian', el: 'Greek', '*': 'Any other' }

// Layout only: colours, borders, focus and hover come from the .dv-set rules in ui.jsx (host tokens).
const S = {
  row: { display: 'flex', alignItems: 'center', gap: '10px', margin: '10px 0', flexWrap: 'wrap' },
  label: { minWidth: '150px', fontSize: '13px', color: 'var(--dv-ink2)' },
  hint: { fontSize: '12px', color: 'var(--dv-ink3)', lineHeight: 1.45 },
  h: { fontFamily: 'var(--dv-mono)', fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--dv-ink3)', margin: '26px 0 8px', paddingBottom: '6px', borderBottom: '1px solid var(--dv-line1)' },
  sub: { fontSize: '12px', fontWeight: 600, color: 'var(--dv-ink2)', margin: '14px 0 2px' },
  card: {},
  input: { minWidth: '90px' },
  btn: {},
  field: { display: 'flex', flexDirection: 'column', fontSize: '11px', gap: '3px', color: 'var(--dv-ink3)' },
  check: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' },
  table: { borderCollapse: 'collapse', fontSize: '12px', width: '100%' },
  td: { padding: '6px 6px', borderBottom: '1px solid var(--dv-line1)', verticalAlign: 'middle' },
  bad: { color: 'var(--dv-bad)' },
  warn: { color: 'var(--dv-warn)' },
}

let tokenCache = { at: 0, token: '' }
async function token() {
  if (tokenCache.token && Date.now() - tokenCache.at < 10 * 60 * 1000) return tokenCache.token
  const r = await fetch('/api/voice/session', { credentials: 'same-origin' })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.token) throw new Error(j.error || ('session ' + r.status))
  tokenCache = { at: Date.now(), token: j.token }
  return j.token
}
async function mutate(path, method, body) {
  const t = await token()
  const r = await fetch('/api/voice' + path, {
    method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-dsh-voice-token': t },
    body: JSON.stringify(body || {}),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || (path + ' ' + r.status))
  return j
}
function playBase64(b64, mime) {
  const a = new window.Audio('data:' + (mime || 'audio/mpeg') + ';base64,' + b64)
  a.play().catch(() => {})
  return a
}
async function previewTts(provider, lang, model, voice) {
  const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: SAMPLE[lang] || SAMPLE.en, provider: provider || 'auto', lang, model: model || undefined, voice: voice || undefined }) })
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || ('tts ' + r.status)) }
  const a = new window.Audio(URL.createObjectURL(await r.blob()))
  await a.play()
  return r.headers.get('x-voice-engine') || provider
}

function Dot(props) {
  const c = props.status === 'up' ? 'var(--dv-ok)' : props.status === 'down' ? 'var(--dv-bad)' : 'var(--dv-ink3)'
  return <span aria-label={'status ' + (props.status || 'unknown')} title={props.title || props.status} style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: 'var(--dv-pill)', background: c, flex: '0 0 auto' }} />
}

const RES_BADGE = {
  eu: ['EU', 'ok'], 'eu-region': ['EU region available', 'info'], 'non-eu': ['outside the EU', 'warn'],
  self: ['self-hosted', 'self'], device: ['on device', 'self'], varies: ['residency depends on endpoint', ''],
}
const ALIGN_BADGE = {
  word: 'word timings', char: 'word timings', sentence: 'sentence timings', duration: 'estimated timings', none: 'estimated timings',
}
const STATUS_NOTE = { planned: 'planned, no public API yet', unverified: 'unverified against vendor docs', partial: 'partly verified' }
export const GROUPS = [['eu', 'EU first'], ['other', 'Others'], ['self', 'Self-hosted']]

function Badge(props) {
  return <span className="dv-badge" data-tone={props.tone || undefined}>{props.children}</span>
}
function ResidencyBadge(props) {
  const b = RES_BADGE[props.residency] || RES_BADGE.varies
  return <Badge tone={b[1]}>{b[0]}</Badge>
}
function AlignBadge(props) {
  if (!props.caps || !props.caps.tts) return null
  return <Badge>{ALIGN_BADGE[props.caps.alignment] || ALIGN_BADGE.none}</Badge>
}

/** Option fields declared by an adapter (bool, text, number, select). */
function OptionFields(props) {
  const fields = props.fields || []
  if (!fields.length) return null
  return fields.map((f) => {
    const v = (props.value || {})[f.key]
    const set = (x) => props.onChange(Object.assign({}, props.value || {}, { [f.key]: x }))
    if (f.type === 'bool') {
      return <label key={f.key} title={f.help || ''} style={S.check}>
        <input type="checkbox" checked={v === undefined ? Boolean(f.default) : Boolean(v)} onChange={() => set(!(v === undefined ? Boolean(f.default) : Boolean(v)))} />{f.label}</label>
    }
    if (f.type === 'select') {
      return <label key={f.key} title={f.help || ''} style={S.field}>{f.label}
        <select aria-label={f.label} value={v === undefined ? (f.default || '') : v} style={S.input} onChange={(ev) => set(ev.target.value)}>
          {(f.choices || []).map((c) => <option key={String(c.id || c)} value={c.id || c}>{c.label || c.id || c}</option>)}
        </select></label>
    }
    return <label key={f.key} title={f.help || ''} style={S.field}>{f.label}
      <input type={f.type === 'number' ? 'number' : 'text'} aria-label={f.label} value={v === undefined ? (f.default === undefined ? '' : f.default) : v} style={S.input} autoComplete="off"
        onChange={(ev) => set(f.type === 'number' ? Number(ev.target.value) : ev.target.value)} /></label>
  })
}

/** Region select for a type that declares regions (EU regions first, flagged). */
function RegionField(props) {
  const regions = props.regions || []
  if (!regions.length) return null
  return (
    <label style={S.field}>Region
      <select aria-label="Region" value={props.value || ''} style={S.input} onChange={(ev) => props.onChange(ev.target.value)}>
        <option value="">default</option>
        {regions.map((r) => <option key={r.id} value={r.id}>{(r.eu ? '[EU] ' : '') + (r.label || r.id)}</option>)}
      </select>
    </label>
  )
}

/** One provider row: status, source, Test, Enable, Edit. */
function ProviderRow(props) {
  const p = props.inst
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState('')
  const [edit, setEdit] = React.useState(false)
  const [form, setForm] = React.useState(null)
  const test = async () => {
    setBusy(true); setResult('')
    try {
      if (p.caps.clientOnly) {
        // On-device voices only (online browser voices send the text to Google).
        const ok = speakBrowser('Hello. Ciao. Γεια σας.', '')
        setResult(ok ? 'spoken by the browser (on-device voice)' : 'no on-device browser voice on this device (online voices are not used)')
      } else {
        const j = await mutate('/test', 'POST', { provider: p.id })
        const bits = []
        if (j.tts) bits.push(j.tts.ok ? 'TTS ok in ' + j.tts.ms + ' ms' : 'TTS failed: ' + j.tts.error)
        if (j.stt) bits.push(j.stt.ok ? 'heard back: "' + j.stt.text + '"' : 'STT failed: ' + j.stt.error)
        if (!j.tts && !j.stt) bits.push('health: ' + ((j.health && j.health.detail) || (j.health && j.health.status) || 'unknown'))
        if (j.tts && j.tts.ok && j.tts.audio_base64) playBase64(j.tts.audio_base64, j.tts.mime)
        setResult(bits.join('; '))
      }
    } catch (e) { setResult('test failed: ' + String(e && e.message || e)) }
    setBusy(false)
    props.onChanged(false)
  }
  const startEdit = () => {
    setForm({ label: p.label || '', baseUrl: p.baseUrl || '', credential: p.credential.kind === 'literal' ? '__set__' : (p.credential.shown || ''), tts: (p.models || {}).tts || '', stt: (p.models || {}).stt || '', defaultVoice: p.defaultVoice || '', inAuto: p.inAuto, region: p.region || '', options: Object.assign({}, p.options || {}) })
    setEdit(true)
  }
  const save = async () => {
    const entry = { id: p.id, type: p.type, label: form.label, baseUrl: form.baseUrl, credential: form.credential, defaultVoice: form.defaultVoice, inAuto: Boolean(form.inAuto), models: {}, region: form.region || '' }
    if (Array.isArray(p.optionFields) && p.optionFields.length) entry.options = form.options
    if (form.tts) entry.models.tts = form.tts
    if (form.stt) entry.models.stt = form.stt
    await props.saveProvider(entry)
    setEdit(false)
  }
  const field = (k, label, type) => (
    <label key={k} style={S.field}>{label}
      <input type={type || 'text'} value={form[k]} aria-label={label} style={S.input} autoComplete="off"
        placeholder={k === 'credential' ? 'env:NAME, file:/path#NAME, dsh-ref:NAME or a key' : ''}
        onChange={(ev) => setForm(Object.assign({}, form, { [k]: ev.target.value }))} />
    </label>
  )
  const status = p.health && p.health.status
  return (
    <div className="dv-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <Dot status={status === 'untested' ? 'unknown' : status} title={(p.health && p.health.detail) || status} />
        <strong style={{ fontSize: '13px' }}>{p.label}</strong>
        <span style={S.hint}>{p.id + ' \u00b7 ' + p.type + (p.hq ? ' \u00b7 ' + p.hq : '')}</span>
        <span style={S.hint}>{[p.caps.tts ? 'TTS' : '', p.caps.stt ? 'STT' : ''].filter(Boolean).join(' + ')}</span>
        <ResidencyBadge residency={p.residency} />
        <AlignBadge caps={p.caps} />
        {STATUS_NOTE[p.status] ? <Badge tone="warn">{STATUS_NOTE[p.status]}</Badge> : null}
        {p.inAuto ? null : <span style={S.hint}>(not in auto)</span>}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
        <button type="button" style={S.btn} disabled={busy || !p.enabled} onClick={test} aria-label={'Test ' + p.label}>{busy ? 'Testing\u2026' : 'Test'}</button>
        <button type="button" style={S.btn} onClick={edit ? () => setEdit(false) : startEdit} aria-pressed={edit} aria-label={'Edit ' + p.label}>{edit ? 'Close' : 'Edit'}</button>
        <label style={S.check}>
          <input type="checkbox" checked={p.enabled} aria-label={'Enable ' + p.label} onChange={() => props.saveProvider({ id: p.id, type: p.type, enabled: !p.enabled })} />enabled
        </label></span>
      </div>
      <div style={Object.assign({}, S.hint, { marginTop: '3px' })}>
        {'credential: ' + (p.credential.kind === 'none' ? 'none needed' : p.credential.shown) + (p.credential.kind !== 'none' ? (p.credential.resolved ? ' (found)' : ' (not found)') : '')}
        {p.baseUrl ? ' \u00b7 ' + p.baseUrl : ''}
        {p.region ? ' \u00b7 region ' + p.region : ''}
        {p.euNote ? ' \u00b7 ' + p.euNote : ''}
        {p.docs ? <span>{' \u00b7 '}<a href={p.docs} target="_blank" rel="noreferrer noopener">docs</a></span> : null}
      </div>
      {Array.isArray(p.notices) && p.notices.length ? (
        <div data-voice-notice="retirement" style={Object.assign({}, S.hint, S.warn, { marginTop: '4px' })}>{p.notices.join(' ')}</div>
      ) : null}
      {result ? <div role="status" aria-live="polite" style={Object.assign({}, S.hint, { marginTop: '4px', color: 'var(--dv-ink2)' })}>{result}</div> : null}
      {edit && form ? (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '6px', alignItems: 'flex-end' }}>
          {field('label', 'Label')}
          {p.type !== 'browser' ? field('baseUrl', 'Base URL') : null}
          {(p.regions || []).length ? <RegionField regions={p.regions} value={form.region} onChange={(v) => setForm(Object.assign({}, form, { region: v }))} /> : null}
          <OptionFields fields={p.optionFields} value={form.options} onChange={(o) => setForm(Object.assign({}, form, { options: o }))} />
          {p.type !== 'browser' && p.type !== 'lfm3' ? field('credential', 'Credential', 'password') : null}
          {p.caps.tts ? field('tts', 'TTS model') : null}
          {p.caps.stt ? field('stt', 'STT model') : null}
          {p.caps.tts ? field('defaultVoice', 'Default voice') : null}
          <label style={S.check}>
            <input type="checkbox" checked={Boolean(form.inAuto)} onChange={() => setForm(Object.assign({}, form, { inAuto: !form.inAuto }))} />use in automatic routing
          </label>
          <button type="button" className="p" onClick={save}>Save</button>
          <span style={S.hint}>A stored key shows as __set__ and is kept unless you type a new one.</span>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Add provider dialog: every type, grouped EU first / Others / Self-hosted,
 * each with its one-line description, residency badge and a docs link. Picking
 * a type opens a small form (preset, id, region, credential).
 */
function AddProvider(props) {
  const [open, setOpen] = React.useState(false)
  const [type, setType] = React.useState('')
  const [preset, setPreset] = React.useState('')
  const [id, setId] = React.useState('')
  const [cred, setCred] = React.useState('')
  const [region, setRegion] = React.useState('')
  const [err, setErr] = React.useState('')
  const taken = props.existing || []
  const t = props.types.find((x) => x.type === type)
  const pr = t && t.presets.find((x) => x.id === preset)
  const freshId = (base) => { let n = base; let k = 2; while (taken.indexOf(n) >= 0) { n = base + '-' + k; k += 1 } return n }
  const pick = (x) => { setType(x.type); setPreset(''); setRegion(''); setErr(''); setId(freshId(x.type)) }
  const add = async () => {
    if (!t || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) { setErr('The id needs lower-case letters, digits, - or _'); return }
    if (taken.indexOf(id) >= 0) { setErr('That id is already used'); return }
    const entry = { id, type, label: (pr && pr.label) || t.label, enabled: true, inAuto: false, baseUrl: (pr && pr.baseUrl) || '', credential: cred, options: (pr && pr.options) || {}, models: (pr && pr.models) || {} }
    if (region || (pr && pr.region)) entry.region = region || pr.region
    if (pr && pr.defaultVoice) entry.defaultVoice = pr.defaultVoice
    if (pr && pr.group) entry.group = pr.group
    if (pr && pr.residency) entry.residency = pr.residency
    await props.saveProvider(entry)
    setType(''); setPreset(''); setId(''); setCred(''); setRegion(''); setOpen(false)
  }
  if (!open) {
    return <div style={S.row}><button type="button" style={S.btn} aria-expanded="false" onClick={() => setOpen(true)}>Add provider</button><span style={S.hint}>{props.types.filter((x) => x.type !== 'browser' && !x.planned).length + ' provider types available'}</span></div>
  }
  return (
    <div role="dialog" aria-label="Add provider" className="dv-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <strong style={{ fontSize: '13px' }}>Add provider</strong><span style={{ flex: 1 }} />
        <button type="button" style={S.btn} onClick={() => setOpen(false)}>Close</button>
      </div>
      {GROUPS.map((g) => {
        const list = props.types.filter((x) => x.type !== 'browser' && (x.group || 'other') === g[0])
        if (!list.length) return null
        return (
          <div key={g[0]}>
            <div style={S.h}>{g[1]}</div>
            {list.map((x) => (
              <label key={x.type} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', margin: '4px 0', opacity: x.planned ? 0.6 : 1, cursor: x.planned ? 'not-allowed' : 'pointer' }}>
                <input type="radio" name="dsh-voice-ptype" checked={type === x.type} disabled={Boolean(x.planned)} aria-label={x.label} onChange={() => pick(x)} />
                <span style={{ fontSize: '12px' }}>
                  <strong>{x.label}</strong>{' '}<ResidencyBadge residency={x.residency} />{x.planned ? <span>{' '}<Badge tone="warn">planned</Badge></span> : null}
                  <span style={{ display: 'block', color: 'var(--dv-ink3)', marginTop: '2px' }}>{x.desc}{x.docs ? ' ' : ''}{x.docs ? <a href={x.docs} target="_blank" rel="noreferrer noopener">docs</a> : null}</span>
                </span>
              </label>
            ))}
          </div>
        )
      })}
      {t ? (
        <div style={Object.assign({}, S.row, { marginTop: '12px', alignItems: 'flex-end' })}>
          <label style={S.field}>Preset
            <select aria-label="Preset" value={preset} style={S.input} onChange={(ev) => { setPreset(ev.target.value); const q = t.presets.find((z) => z.id === ev.target.value); if (q) setId(freshId(q.id)) }}>
              <option value="">none</option>
              {t.presets.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
          <label style={S.field}>Id
            <input aria-label="New provider id" placeholder="id, e.g. mistral-eu" value={id} style={S.input} onChange={(ev) => setId(ev.target.value.toLowerCase())} />
          </label>
          <RegionField regions={t.regions} value={region} onChange={setRegion} />
          {t.type !== 'lfm3' ? (
            <label style={S.field}>Credential
              <input aria-label="Credential" type="password" autoComplete="off" placeholder="env:NAME, file:/path#NAME or a key" value={cred} style={S.input} onChange={(ev) => setCred(ev.target.value)} />
            </label>
          ) : null}
          <button type="button" className="p" onClick={add}>Add</button>
          {err ? <span role="alert" style={Object.assign({}, S.hint, S.bad)}>{err}</span> : null}
          <div style={Object.assign({}, S.hint, { flexBasis: '100%' })}>{t.euNote}{t.verification ? ' Verification: ' + t.verification : ''}</div>
        </div>
      ) : null}
    </div>
  )
}

/** Per-language defaults table. */
function Languages(props) {
  const { view } = props
  const s = view.settings
  const [draft, setDraft] = React.useState(() => JSON.parse(JSON.stringify(s.perLanguage)))
  const [enabled, setEnabled] = React.useState(() => s.languages.enabled.slice())
  const [newLang, setNewLang] = React.useState('')
  const [msg, setMsg] = React.useState('')
  const [voices, setVoices] = React.useState({})
  React.useEffect(() => { setDraft(JSON.parse(JSON.stringify(s.perLanguage))); setEnabled(s.languages.enabled.slice()) }, [view])
  const ttsIds = ['auto'].concat(view.instances.filter((i) => i.caps.tts && i.enabled).map((i) => i.id))
  const sttIds = ['auto'].concat(view.instances.filter((i) => i.caps.stt && i.enabled).map((i) => i.id))
  const rows = enabled.concat(['*'])
  const set = (l, dir, k, v) => {
    const d = JSON.parse(JSON.stringify(draft))
    d[l] = d[l] || { tts: { provider: 'auto', model: '', voice: '', speed: 1, fallback: [] }, stt: { provider: 'auto', model: '', fallback: [] } }
    d[l][dir][k] = v
    setDraft(d)
  }
  const loadVoices = async (l, provider) => {
    if (!provider || provider === 'auto' || provider === 'browser') return
    try {
      const r = await fetch('/api/voice/voices?provider=' + encodeURIComponent(provider) + '&lang=' + encodeURIComponent(l === '*' ? '' : l), { credentials: 'same-origin' })
      const j = await r.json()
      if (j && j.voices) setVoices(Object.assign({}, voices, { [l + '|' + provider]: j.voices }))
    } catch (e) { /* free text stays possible */ }
  }
  const save = async () => {
    setMsg('saving\u2026')
    try { await props.patch({ perLanguage: draft, languages: { enabled } }); setMsg('saved') } catch (e) { setMsg('save failed: ' + String(e && e.message || e)) }
  }
  const recommend = (l) => {
    const r = view.recommended[l]
    if (!r) return
    const d = JSON.parse(JSON.stringify(draft))
    d[l] = JSON.parse(JSON.stringify(r))
    setDraft(d)
    setMsg('recommended values for ' + (LANG_NAMES[l] || l) + ' filled in: review, then Save')
  }
  const route = (l) => view.routes[l] || {}
  return (
    <div>
      {rows.map((l) => {
        const e = draft[l] || { tts: { provider: 'auto', fallback: [] }, stt: { provider: 'auto', fallback: [] } }
        const vl = voices[l + '|' + e.tts.provider]
        return (
          <div key={l} className="dv-card" role="group" aria-label={'Language ' + (l === '*' ? 'any other' : l.toUpperCase())}>
            <div className="dv-ltitle">
              <strong style={{ fontFamily: 'var(--dv-mono)', fontSize: '12px', letterSpacing: '0.04em' }}>{l === '*' ? '*' : l.toUpperCase()}</strong>
              <span style={{ fontSize: '12.5px', color: 'var(--dv-ink2)' }}>{LANG_NAMES[l] || ''}</span>
              <span style={S.hint} title="What this language uses right now">{'now: TTS ' + (route(l).tts || '?') + ' \u00b7 STT ' + (route(l).stt || 'none')}</span>
              <span style={{ flex: 1 }} />
              {l !== '*' ? <button type="button" onClick={() => previewTts(e.tts.provider, l, e.tts.model, e.tts.voice).then((eng) => setMsg('preview ' + l + ' spoken by ' + eng)).catch((err) => setMsg('preview failed: ' + err.message))}>Preview</button> : null}
              {view.recommended[l] && l !== '*' ? <button type="button" onClick={() => recommend(l)}>Apply recommended</button> : null}
              {l !== '*' && ['en', 'it', 'el'].indexOf(l) < 0 ? <button type="button" onClick={() => setEnabled(enabled.filter((x) => x !== l))}>Remove</button> : null}
            </div>
            <div className="dv-lsub">Read aloud</div>
            <div className="dv-lgrid">
              <label style={S.field}>Provider
                <select aria-label={'TTS provider ' + l} value={e.tts.provider} onChange={(ev) => { set(l, 'tts', 'provider', ev.target.value); loadVoices(l, ev.target.value) }}>
                  {ttsIds.map((id) => <option key={id} value={id}>{id === 'auto' ? 'auto (built-in chain)' : id}</option>)}
                </select>
              </label>
              <label style={S.field}>Model
                <input aria-label={'TTS model ' + l} placeholder="provider default" value={e.tts.model || ''} onChange={(ev) => set(l, 'tts', 'model', ev.target.value)} />
              </label>
              <label style={S.field}>Voice
                {vl && vl.length ? (
                  <select aria-label={'Voice ' + l} value={e.tts.voice || ''} onChange={(ev) => set(l, 'tts', 'voice', ev.target.value)}>
                    <option value="">default voice</option>
                    {vl.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
                  </select>
                ) : <input aria-label={'Voice ' + l} placeholder="default voice" value={e.tts.voice || ''} onFocus={() => loadVoices(l, e.tts.provider)} onChange={(ev) => set(l, 'tts', 'voice', ev.target.value)} />}
              </label>
              <label style={S.field}>Speed
                <input aria-label={'Speed ' + l} type="number" min="0.5" max="2" step="0.05" value={e.tts.speed || 1} onChange={(ev) => set(l, 'tts', 'speed', Number(ev.target.value))} />
              </label>
              <label style={Object.assign({}, S.field, { gridColumn: 'span 2' })}>Fallback
                <input aria-label={'Fallback ' + l} placeholder="provider ids, comma separated" value={(e.tts.fallback || []).join(', ')} onChange={(ev) => set(l, 'tts', 'fallback', ev.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />
              </label>
            </div>
            <div className="dv-lsub">Dictation</div>
            <div className="dv-lgrid">
              <label style={S.field}>Provider
                <select aria-label={'STT provider ' + l} value={e.stt.provider} onChange={(ev) => set(l, 'stt', 'provider', ev.target.value)}>
                  {sttIds.map((id) => <option key={id} value={id}>{id === 'auto' ? 'auto (built-in chain)' : id}</option>)}
                </select>
              </label>
              <label style={S.field}>Model
                <input aria-label={'STT model ' + l} placeholder="provider default" value={e.stt.model || ''} onChange={(ev) => set(l, 'stt', 'model', ev.target.value)} />
              </label>
            </div>
          </div>
        )
      })}
      <div style={S.row}>
        <input aria-label="Add a language (two or three letter code)" placeholder="add language, e.g. fr" value={newLang} style={S.input} onChange={(ev) => setNewLang(ev.target.value.toLowerCase().trim())} />
        <button type="button" style={S.btn} onClick={() => { if (/^[a-z]{2,3}$/.test(newLang) && enabled.indexOf(newLang) < 0) { setEnabled(enabled.concat([newLang])); setNewLang('') } }}>Add language</button>
        <button type="button" className="p" onClick={save}>Save languages</button>
        <span role="status" aria-live="polite" style={S.hint}>{msg}</span>
      </div>
      <div style={S.hint}>"auto" keeps the built-in 1.x routing (English: MiMo then Mistral; Greek, Italian and the rest: the local TTS server). Markers in a text (<code>[[el]]</code>, <code>[[it]]...[[/]]</code>, <code>{'<!--lang:el-->'}</code>) override these settings for their span.</div>
    </div>
  )
}

function Detection(props) {
  const { view } = props
  const det = view.settings.detection
  const [mode, setMode] = React.useState(det.mode)
  const [model, setModel] = React.useState(det.model || {})
  const [models, setModels] = React.useState(null)
  const [markers, setMarkers] = React.useState(view.settings.markers.enabled)
  const [autoRead, setAutoRead] = React.useState(view.settings.reading.autoRead)
  const [highlight, setHighlight] = React.useState(view.settings.reading.highlight || 'word')
  const [queueMode, setQueueMode] = React.useState(view.settings.reading.queue || 'replace')
  const [tryText, setTryText] = React.useState('This is English. Questa frase è in italiano. Αυτή η πρόταση είναι ελληνική. [[it]]ciao[[/]]')
  const [tryOut, setTryOut] = React.useState(null)
  const [msg, setMsg] = React.useState('')
  const tryIt = async () => {
    setTryOut({ busy: true })
    try {
      const r = await fetch('/api/voice/detect', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: tryText, mode }) })
      const j = await r.json()
      setTryOut(r.ok ? j : { error: j.error || ('detect ' + r.status) })
    } catch (e) { setTryOut({ error: String(e && e.message || e) }) }
  }
  React.useEffect(() => {
    fetch('/api/voice/models', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => setModels(j && j.available ? j.providers : [])).catch(() => setModels([]))
  }, [])
  const prov = (models || []).find((p) => p.id === model.provider)
  const save = async () => {
    setMsg('saving\u2026')
    try { await props.patch({ detection: { mode, model }, markers: { enabled: markers }, reading: { autoRead, highlight, queue: queueMode } }); setMsg('saved') } catch (e) { setMsg('save failed: ' + String(e && e.message || e)) }
  }
  return (
    <div>
      <div style={S.row}>
        <span style={S.label}>Language detection</span>
        <select aria-label="Detection mode" value={mode} style={S.input} onChange={(ev) => setMode(ev.target.value)}>
          <option value="heuristic+model">heuristics, then a model for unsure sentences</option>
          <option value="heuristic">heuristics only</option>
          <option value="off">off (one language per message, as in 1.x)</option>
        </select>
      </div>
      <div style={S.row}>
        <span style={S.label}>Detection model</span>
        {models && models.length ? (
          <span style={{ display: 'flex', gap: '4px' }}>
            <select aria-label="Detection model provider" value={model.provider || ''} style={S.input} onChange={(ev) => setModel({ provider: ev.target.value, model: '' })}>
              {models.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <select aria-label="Detection model" value={model.model || ''} style={S.input} onChange={(ev) => setModel(Object.assign({}, model, { model: ev.target.value }))}>
              <option value="">choose a model</option>
              {(prov ? prov.models : []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </span>
        ) : <span style={S.hint}>{models === null ? 'loading the DSH model list\u2026' : (model.provider + ' / ' + model.model + ' (the model list is not available here)')}</span>}
        <span style={S.hint}>{view.llm === false ? 'No DSH model service on this host: heuristics only.' : 'Asked once per message, only for sentences the heuristics are unsure of; answers are cached.'}</span>
      </div>
      <div style={S.row}>
        <label style={Object.assign({}, S.label, { display: 'flex', gap: '8px', alignItems: 'center' })}>
          <input type="checkbox" checked={markers} onChange={() => setMarkers(!markers)} aria-label="Language markers" />Language markers
        </label>
        <span style={S.hint}>[[el]] switches to Greek, [[it]]...[[/]] marks an Italian span, \[[el]] is literal text.</span>
      </div>
      <div style={S.row}>
        <span style={S.label}>Auto-read new replies</span>
        <select aria-label="Auto-read" value={autoRead} style={S.input} onChange={(ev) => setAutoRead(ev.target.value)}>
          <option value="off">off</option>
          <option value="new-replies">every new reply</option>
          <option value="new-replies-when-dictated">only after a dictated prompt</option>
        </select>
        <span style={S.hint}>Queued behind a read in progress; typing in the composer stops it.</span>
      </div>
      <div style={S.row}>
        <span style={S.label}>Highlight while reading</span>
        <select aria-label="Highlight" value={highlight} style={S.input} onChange={(ev) => setHighlight(ev.target.value)}>
          <option value="word">sentence and word</option>
          <option value="sentence">sentence only</option>
          <option value="off">off</option>
        </select>
        <span style={S.hint}>Word timings come from the provider when it has them (ElevenLabs, the browser voice), otherwise they are estimated.</span>
      </div>
      <div style={S.row}>
        <span style={S.label}>A second read</span>
        <select aria-label="Queue mode" value={queueMode} style={S.input} onChange={(ev) => setQueueMode(ev.target.value)}>
          <option value="replace">replaces the current one</option>
          <option value="append">waits in a queue</option>
        </select>
      </div>
      <div style={Object.assign({}, S.row, { alignItems: 'flex-start' })}>
        <span style={S.label}>Try detection</span>
        <textarea aria-label="Text to detect" value={tryText} rows={3} style={Object.assign({}, S.input, { minWidth: '220px', flex: 1 })} onChange={(ev) => setTryText(ev.target.value)} />
        <button type="button" style={S.btn} onClick={tryIt}>Try it</button>
      </div>
      {tryOut ? (
        <div role="status" aria-live="polite" style={Object.assign({}, S.hint, { color: 'var(--dv-ink2)' })}>
          {tryOut.busy ? 'detecting\u2026' : tryOut.error ? 'detect failed: ' + tryOut.error
            : (tryOut.segments || []).map((g, i) => <div key={i}><strong>{String(g.lang).toUpperCase()}</strong>{' (' + g.source + ', ' + Math.round((g.conf || 0) * 100) + '%) ' + g.text}</div>)}
          {tryOut.model ? <div>{tryOut.model.used ? 'model ' + tryOut.model.provider + '/' + tryOut.model.model + ' in ' + tryOut.model.ms + ' ms' : (tryOut.model.cached ? 'answered from the cache' : 'model not used')}</div> : null}
        </div>
      ) : null}
      <div style={S.row}><button type="button" className="p" onClick={save}>Save</button><span role="status" aria-live="polite" style={S.hint}>{msg}</span></div>
    </div>
  )
}

const SHORTCUT_LABELS = {
  readLast: 'Read the last reply', playPause: 'Play / pause', stop: 'Stop', nextSentence: 'Next sentence', prevSentence: 'Previous sentence',
  faster: 'Faster', slower: 'Slower', dictate: 'Dictation (tap toggles, hold to talk)', dictationLang: 'Cycle the dictation language',
}

function Dictation(props) {
  const { view } = props
  const d = view.settings.dictation
  const [mode, setMode] = React.useState(d.mode || 'toggle')
  const [lang, setLang] = React.useState(d.lang || 'auto')
  const [insert, setInsert] = React.useState(d.insert || 'caret')
  const [polishOn, setPolishOn] = React.useState(!(d.polish && d.polish.enabled === false))
  const [pmodel, setPmodel] = React.useState((d.polish && d.polish.model) || {})
  const [models, setModels] = React.useState(null)
  const [keys, setKeys] = React.useState(() => Object.assign({}, DEFAULT_SHORTCUTS, view.settings.shortcuts || {}))
  const [msg, setMsg] = React.useState('')
  React.useEffect(() => {
    fetch('/api/voice/models', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => setModels(j && j.available ? j.providers : [])).catch(() => setModels([]))
  }, [])
  const prov = (models || []).find((p) => p.id === pmodel.provider)
  const dup = conflicts(keys)
  const bad = Object.entries(keys).filter(([, v]) => v && !parseCombo(v)).map(([k]) => k)
  const save = async () => {
    if (bad.length) { setMsg('fix the shortcuts marked invalid first'); return }
    setMsg('saving\u2026')
    try { await props.patch({ dictation: { mode, lang, insert, polish: { enabled: polishOn, model: pmodel } }, shortcuts: keys }); setMsg('saved') } catch (e) { setMsg('save failed: ' + String(e && e.message || e)) }
  }
  const langs = ['auto'].concat(view.settings.languages.enabled)
  return (
    <div>
      <div style={S.row}>
        <span style={S.label}>Microphone</span>
        <select aria-label="Dictation mode" value={mode} style={S.input} onChange={(ev) => setMode(ev.target.value)}>
          <option value="toggle">click to start and stop (hold also works)</option>
          <option value="push-to-talk">push to talk (hold, release to send)</option>
        </select>
      </div>
      <div style={S.row}>
        <span style={S.label}>Language</span>
        <select aria-label="Dictation language" value={lang} style={S.input} onChange={(ev) => setLang(ev.target.value)}>
          {langs.map((l) => <option key={l} value={l}>{l === 'auto' ? 'auto (per-language table)' : l.toUpperCase()}</option>)}
        </select>
        <span style={S.hint}>The chip next to the mic changes it per browser; a fixed language picks that row's dictation provider.</span>
      </div>
      <div style={S.row}>
        <span style={S.label}>Insert</span>
        <select aria-label="Insert dictated text" value={insert} style={S.input} onChange={(ev) => setInsert(ev.target.value)}>
          <option value="caret">at the cursor in the composer</option>
          <option value="append">at the end of the draft</option>
          <option value="replace">replace the draft</option>
        </select>
      </div>
      <div style={S.row}>
        <label style={Object.assign({}, S.label, { display: 'flex', gap: '8px', alignItems: 'center' })}>
          <input type="checkbox" checked={polishOn} onChange={() => setPolishOn(!polishOn)} aria-label="Polish dictated text" />Polish
        </label>
        {models && models.length ? (
          <span style={{ display: 'flex', gap: '4px' }}>
            <select aria-label="Polish model provider" value={pmodel.provider || ''} style={S.input} onChange={(ev) => setPmodel({ provider: ev.target.value, model: '' })}>
              {models.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <select aria-label="Polish model" value={pmodel.model || ''} style={S.input} onChange={(ev) => setPmodel(Object.assign({}, pmodel, { model: ev.target.value }))}>
              <option value="">choose a model</option>
              {(prov ? prov.models : []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </span>
        ) : <span style={S.hint}>{(pmodel.provider || '?') + ' / ' + (pmodel.model || '?')}</span>}
        <span style={S.hint}>Punctuation and casing only, never a translation; Mistral and the local model stay as fallbacks.</span>
      </div>
      <div style={S.h}>Shortcuts</div>
      <table style={S.table}><tbody>
        {Object.keys(DEFAULT_SHORTCUTS).map((k) => (
          <tr key={k}>
            <td style={S.td}>{SHORTCUT_LABELS[k] || k}</td>
            <td style={S.td}>
              <input aria-label={'Shortcut: ' + (SHORTCUT_LABELS[k] || k)} value={keys[k] || ''} placeholder="off" style={S.input} onChange={(ev) => setKeys(Object.assign({}, keys, { [k]: ev.target.value }))} />
              {bad.indexOf(k) >= 0 ? <span style={Object.assign({}, S.hint, S.bad)}> invalid (needs Alt, Ctrl or Meta)</span> : null}
              {dup.some((x) => x[1].indexOf(k) >= 0) ? <span style={Object.assign({}, S.hint, S.bad)}> used twice</span> : null}
            </td>
          </tr>
        ))}
      </tbody></table>
      <div style={S.hint}>Empty turns a shortcut off. Keys are matched by position, so a Greek or Italian layout keeps them. DSH itself uses Alt or Shift with the arrow keys, Enter and Ctrl+O in the composer; these defaults avoid them.</div>
      <div style={S.row}><button type="button" className="p" onClick={save}>Save dictation and shortcuts</button><span role="status" aria-live="polite" style={S.hint}>{msg}</span></div>
    </div>
  )
}

/** The Voice section in Settings. */
export function VoiceSettings(props) {
  const cfg = useConfig()
  const quota = useQuota()
  const fallbackOn = usePref(FALLBACK_KEY, '1') !== '0'
  const rateSel = usePref(RATE_KEY, '1')
  const engine = cleanEngine(usePref(PREF_KEY, 'auto'), cfg)
  // __testView: a /settings answer to render without a fetch (server-render tests only).
  const [view, setView] = React.useState((props && props.__testView) || null)
  const [err, setErr] = React.useState('')
  const load = React.useCallback(() => {
    fetch('/api/voice/settings', { credentials: 'same-origin' })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (ok && j.ok) { setView(j); setErr('') } else setErr((j && j.error) || 'settings unavailable') })
      .catch((e) => setErr(String(e && e.message || e)))
  }, [])
  React.useEffect(() => { load() }, [load])
  const patch = async (body) => {
    const j = await mutate('/settings', 'PATCH', body)
    setView(j)
    refreshConfig(true)
    return j
  }
  const saveProvider = async (entry) => {
    const list = ((view && view.settings.providers) || []).filter((p) => p.id !== entry.id)
    const prev = ((view && view.settings.providers) || []).find((p) => p.id === entry.id) || {}
    list.push(Object.assign({}, prev, entry))
    try { await patch({ providers: list }) } catch (e) { setErr('save failed: ' + String(e && e.message || e)) }
  }
  const el = elevenOf(cfg)
  const left = engine === 'elevenlabs' ? charsLeftIn(cfg, quota || el.quota) : null
  const engineName = engine === 'auto' ? ((cfg && cfg.defaults && cfg.defaults.tts) || 'auto') : engine
  return (
    <div className="dv-set" style={{ padding: '4px 0 8px' }}>
      <div style={S.h}>This browser</div>
      <div style={S.row}>
        <label style={Object.assign({}, S.label, { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' })}>
          <input type="checkbox" checked={fallbackOn} aria-label="Browser-voice fallback" onChange={() => writePref(FALLBACK_KEY, fallbackOn ? '0' : '1')} />Browser-voice fallback
        </label>
        <span style={S.hint}>{fallbackOn ? 'On: when the chosen engine fails, the browser voice reads instead, and the message says so.' : 'Off: a failing engine shows its error instead of switching voices.'}</span>
      </div>
      <div style={S.row}>
        <span style={S.label}>Read-aloud speed</span>
        <select aria-label="Read-aloud speed" value={rateSel}
          onChange={(ev) => { writePref(RATE_KEY, ev.target.value); const c = currentAudio(); if (c && c.tagName === 'AUDIO') c.playbackRate = parseFloat(ev.target.value) }}>
          {RATES.map((v) => <option key={v} value={v}>{v + '\u00d7'}</option>)}
        </select>
        <span style={S.hint}>pitch preserved; dictation is unaffected</span>
      </div>
      <div style={Object.assign({}, S.hint, { marginTop: '4px' })}>{'Engine: ' + engineName + (left !== null ? ' \u00b7 ' + fmtChars(left) + ' characters left on ElevenLabs' : '')}</div>

      {err ? <div role="alert" style={Object.assign({}, S.hint, S.bad, { marginTop: '10px' })}>{'Provider settings unavailable: ' + err + '. Reading and dictation keep working; on a proxied host add it to security.trustedHosts of dsh-voice.'}</div> : null}
      {view ? (
        <div>
          <div style={S.h}>Providers</div>
          <div style={S.hint}>{'Stored in: ' + (view.backend === 'dsh-settings' ? 'DSH Settings' : view.backend === 'profile' ? 'the profile configuration' : 'the plugin settings file') + '. Keys are never sent to the browser.'}</div>
          {GROUPS.map((g) => {
            const rows = view.instances.filter((p) => (p.group || 'other') === g[0])
            if (!rows.length) return null
            return (
              <div key={g[0]} role="group" aria-label={g[1]}>
                <div style={S.sub}>{g[1]}</div>
                {rows.map((p) => <ProviderRow key={p.id} inst={p} saveProvider={saveProvider} onChanged={(reload) => { if (reload) load() }} />)}
              </div>
            )
          })}
          <AddProvider types={view.types} existing={view.instances.map((p) => p.id)} saveProvider={saveProvider} />
          <div style={S.h}>Languages</div>
          <Languages view={view} patch={patch} />
          <div style={S.h}>Detection and reading</div>
          <Detection view={view} patch={patch} />
          <div style={S.h}>Dictation</div>
          <Dictation view={view} patch={patch} />
        </div>
      ) : null}
    </div>
  )
}
