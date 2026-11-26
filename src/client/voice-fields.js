/**
 * dsh-voice client: the shared voice pickers (reader tab and chat reader).
 *
 * Provider > Model > Language > Accent > Voice > Tone, each facet a select of its own that appears only
 * when the chosen voices carry it, plus the presets entry of the current provider. The facets are read from
 * the voice ids by ./voices.js.
 */
import * as React from 'react'

function Facet(props) {
  return React.createElement('label', { className: props.cls || 'dv-field' },
    React.createElement('span', null, props.label),
    React.createElement('select', {
      'aria-label': props.label, value: props.value || '', className: 'dv-sel',
      title: props.text || undefined, onChange: (ev) => props.onChange(ev.target.value),
    }, props.options))
}

const opt = (value, label) => React.createElement('option', { key: value || '_any', value }, label)

/**
 * The voice picker.
 *   models, model, catalogue, onModel      the model select (shown when the caller asks for it)
 *   facets                                 { languages, accents, tones } from voices.js
 *   pick                                   { language, accent, tone } chosen ('' means any)
 *   voice, voiceOptions, onVoice           the filtered voices and the chosen id
 *   presets, presetPick, onPreset, presetLabel, starred, onStar
 *   text: { model, preset, language, accent, voice, tone, star, starred } labels, overridable by the caller
 */
export function VoiceFields(props) {
  const p = props
  const f = p.facets || { languages: [], accents: [], tones: [] }
  const t = p.text || {}
  const kids = []
  if (p.models && p.models.length) {
    kids.push(React.createElement(Facet, {
      key: 'model', label: t.model || 'Model', value: p.model, onChange: p.onModel, text: t.modelHint,
      options: (p.catalogue ? [] : [opt('', t.modelDefault || 'default model')]).concat(p.models.map((m) => opt(m.id, m.label || m.id))),
    }))
  }
  if (p.presets && p.presets.length) {
    kids.push(React.createElement('label', { key: 'preset', className: 'dv-field' },
      React.createElement('span', null, t.preset || 'Presets'),
      React.createElement('select', {
        'aria-label': t.preset || 'Presets', value: p.presetPick || '', className: 'dv-sel',
        title: t.presetHint, onChange: (ev) => { const v = ev.target.value; if (v && p.onPreset) p.onPreset(v) },
      }, [opt('', p.presetPick ? (t.presetDefault || 'default voice') : (t.presetAny || 'Presets') + ' (' + p.presets.length + ')')]
        .concat(p.presets.map((x) => opt(x.id, p.presetLabel ? p.presetLabel(x) : x.id))))))
  }
  if (f.languages.length > 1) {
    kids.push(React.createElement(Facet, { key: 'lang', label: t.language || 'Language', text: t.languageHint, value: p.pick.language, onChange: p.onLanguage,
      options: [opt('', t.languageAny || 'all languages')].concat(f.languages.map((x) => opt(x.value, x.label))) }))
  }
  if (f.accents.length) {
    kids.push(React.createElement(Facet, { key: 'accent', label: t.accent || 'Accent', text: t.accentHint, value: p.pick.accent, onChange: p.onAccent,
      options: [opt('', t.accentAny || 'all accents')].concat(f.accents.map((x) => opt(x.value, x.label))) }))
  }
  if (p.voiceOptions && p.voiceOptions.length) {
    kids.push(React.createElement(Facet, { key: 'voice', label: (t.voice || 'Voice') + ' (' + p.voiceOptions.length + ')', text: t.voiceHint, value: p.voice, onChange: p.onVoice,
      options: [opt('', t.voiceDefault || 'default voice')].concat(p.voiceOptions.map((x) => opt(x.id, x.label))) }))
  }
  if (f.tones.length > 1) {
    kids.push(React.createElement(Facet, { key: 'tone', label: t.tone || 'Tone', text: t.toneHint, value: p.pick.tone, onChange: p.onTone,
      options: [opt('', t.toneAny || 'all tones')].concat(f.tones.map((x) => opt(x.value, x.label))) }))
  }
  kids.push(React.createElement('button', {
    key: 'star', type: 'button', className: 'dv-btn g sm', onClick: p.onStar,
    title: p.starred ? (t.starredHint || 'Remove this voice from Presets') : (t.starHint || 'Save this voice as a Preset'),
    'aria-label': p.starred ? (t.unstar || 'Unstar this voice') : (t.star || 'Star this voice'), 'aria-pressed': Boolean(p.starred),
  },
  React.createElement('span', { 'aria-hidden': 'true', style: { color: p.starred ? 'var(--dv-warn)' : 'inherit' } }, p.starred ? '\u2605' : '\u2606'),
  ' ' + (p.starred ? (t.saved || 'Saved') : (t.save || 'Save as preset'))))
  return React.createElement('div', { className: p.cls || 'dv-grid' }, kids)
}

/** The provenance line: what the facets were read from, so a wrong parse is visible (and fixable). */
export function VoiceNote(props) {
  if (!props.text) return null
  return React.createElement('div', { className: 'dv-hint' }, props.text)
}
