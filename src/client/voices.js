/**
 * dsh-voice client: voice facets and presets.
 *
 * Providers name their voices in their own way ("gb_oliver_sad", "bm_george", "marin", "voice_482"),
 * which hides two things a person needs in order to choose: the language and the accent. This module
 * reads an id into facets, so both pickers can present the same order on every provider:
 *
 *   Provider > Model > Language > Accent > Voice > Tone
 *
 * A facet is shown only when the chosen voices carry it: an id that names no accent ships no accent
 * picker. A voice id that says nothing (a cloned "voice_482") still appears, under "Any language".
 *
 * Presets: a starred combination (provider, model, voice, language, accent) that the provider menus offer
 * as one entry, so picking it restores the whole voice at once. Pure module, stored by the caller.
 */

/** Language names for the codes a provider may publish. A code that is not here is shown as it is. */
export const LANGUAGE_NAMES = {
  en: 'English', it: 'Italian', el: 'Greek', fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese',
  nl: 'Dutch', pl: 'Polish', ro: 'Romanian', bg: 'Bulgarian', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
  fi: 'Finnish', cs: 'Czech', sk: 'Slovak', sl: 'Slovenian', hr: 'Croatian', sr: 'Serbian', hu: 'Hungarian',
  ru: 'Russian', uk: 'Ukrainian', tr: 'Turkish', ar: 'Arabic', he: 'Hebrew', hi: 'Hindi', ja: 'Japanese',
  ko: 'Korean', zh: 'Chinese', ca: 'Catalan', cy: 'Welsh', ga: 'Irish', is: 'Icelandic', lt: 'Lithuanian',
  lv: 'Latvian', et: 'Estonian', ms: 'Malay', id: 'Indonesian', fil: 'Filipino', tl: 'Filipino', vi: 'Vietnamese',
  th: 'Thai', ta: 'Tamil', te: 'Telugu', bn: 'Bengali', gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi',
  pa: 'Punjabi', ur: 'Urdu', fa: 'Persian', sw: 'Swahili', af: 'Afrikaans', az: 'Azerbaijani', bs: 'Bosnian',
  eu: 'Basque', gl: 'Galician', ka: 'Georgian', kk: 'Kazakh', mk: 'Macedonian', mn: 'Mongolian', ne: 'Nepali',
  sq: 'Albanian', yue: 'Cantonese', 'pt-br': 'Brazilian Portuguese', 'zh-tw': 'Chinese (Taiwan)',
}

/** A region tag as the accent it stands for (en-US is American, it-IT is Italian), for the ids that name a country. */
const REGION_NAMES = { US: 'American', GB: 'British', AU: 'Australian', CA: 'Canadian', IE: 'Irish', NZ: 'New Zealand', IN: 'Indian', ZA: 'South African', CN: 'Mainland', TW: 'Taiwan', HK: 'Hong Kong', IT: 'Italian', FR: 'French', DE: 'German', ES: 'Spanish', PT: 'Portuguese', BR: 'Brazilian', NL: 'Dutch', PL: 'Polish', RU: 'Russian', JA: 'Japanese', JP: 'Japanese', KO: 'Korean', KR: 'Korean', SE: 'Swedish', CH: 'Swiss', AT: 'Austrian', BE: 'Belgian', MX: 'Mexican', AR: 'Argentinian', SA: 'Saudi', EG: 'Egyptian' }

/** Region tags as accents, for the ids that carry a country (en-US, it-IT). */

/** Accent (or region) names for the tags providers use. "British" is the GB tag, "American" the US one. */
export const ACCENT_NAMES = {
  gb: 'British', uk: 'British', en: 'American', us: 'American', au: 'Australian', ca: 'Canadian', ie: 'Irish',
  nz: 'New Zealand', in: 'Indian', za: 'South African', ng: 'Nigerian', sg: 'Singapore', hk: 'Hong Kong',
  scot: 'Scottish', gb_scot: 'Scottish', br: 'Brazilian', pt: 'Portuguese (European)',
}

/** Kokoro spells its voices <language letter><gender><name>; the English ones also carry the accent. */
const KOKORO_LANG = { a: 'English', b: 'English', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Chinese' }
const KOKORO_ACCENT = { a: 'American', b: 'British' }   // af_ is American, bf_ British (am_adam, bm_george)

/** The tone words that are sold as part of a voice id, and the tone facet they become. */
const TONE_WORDS = ['sad', 'happy', 'neutral', 'frustrated', 'excited', 'confident', 'cheerful', 'angry', 'curious', 'sarcasm', 'confused', 'shameful', 'jealousy', 'calm', 'serious', 'warm', 'gentle', 'stern', 'skeptical', 'tired', 'urgent', 'hopeful', 'wistful', 'playful', 'proud', 'reflective', 'resigned', 'sensitive', 'somber', 'surprised', 'tense', 'apologetic', 'bored', 'amused', 'anxious', 'assertive', 'critical', 'determined', 'disappointed', 'disgusted', 'grateful', 'appreciative', 'dreamy', 'embarrassed', 'encouraging', 'enthusiastic', 'firm', 'guilty', 'heartbroken', 'lonely', 'melancholic', 'mischievous', 'nervous', 'nostalgic', 'panicked', 'reassuring', 'relieved', 'perky', 'formal', 'soft', 'deep']
/** Genders a provider may publish on its own, and the shorthand some ids use ("_female"). */
const GENDERS = { f: 'Female', female: 'Female', m: 'Male', male: 'Male', n: 'Neutral', neutral: 'Neutral' }

/** Language codes a voice id may carry. A pair that is only a name ("oliver") is not a language. */
const VOICE_LANGS = { en: 1, it: 1, el: 1, fr: 1, de: 1, es: 1, pt: 1, nl: 1, pl: 1, ro: 1, bg: 1, sv: 1, da: 1, no: 1, fi: 1, cs: 1, sk: 1, sl: 1, hr: 1, sr: 1, hu: 1, ru: 1, uk: 1, tr: 1, ar: 1, he: 1, hi: 1, ja: 1, jp: 1, ko: 1, kr: 1, zh: 1, cn: 1, tw: 1, ca: 1, cy: 1, ga: 1, is: 1, lt: 1, lv: 1, et: 1, ms: 1, id: 1, tl: 1, vi: 1, th: 1, ta: 1, te: 1, bn: 1, gu: 1, kn: 1, ml: 1, mr: 1, pa: 1, ur: 1, fa: 1, sw: 1, af: 1, az: 1, bs: 1, eu: 1, gl: 1, ka: 1, kk: 1, mk: 1, mn: 1, ne: 1, sq: 1, yue: 1 }

const title = (s) => {
  const t = String(s || '').replace(/[_-]+/g, ' ').trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''
}
const langName = (code) => {
  const k = String(code || '').toLowerCase()
  // gb and en are both English: gb only says which accent ("British English" would say it twice)
  if (k === 'gb' || k === 'uk') return 'English'
  if (k === 'us') return 'English'
  return LANGUAGE_NAMES[k] || String(code || '').toUpperCase()
}
const accentName = (code) => {
  const k = String(code || '').toLowerCase()
  if (k === 'en' || k === 'us' || k === 'it' || k === 'fr' || k === 'de' || k === 'es' || k === 'pt') return ''   // the language's own accent: no label
  return ACCENT_NAMES[k] || title(k)
}

/**
 * Read one voice into facets.
 * @param {string} id        the id the provider expects
 * @param {object} opts      { provider, model, langs, label, tags } hints the provider published
 * @returns {{ id, name, language, languageCode, accent, accentCode, tone, gender, known }}
 */
export function facetsOf(id, opts) {
  const raw = String(id || '')
  const o = opts || {}
  const published = (o.langs || []).map((l) => String(l).toLowerCase())
  const pubLang = published.length === 1 ? published[0] : ''
  const out = (f) => Object.assign({ id: raw, accent: '', accentCode: '', tone: '', gender: '', known: true }, f)
  const anyLang = { language: 'Any language', languageCode: '' }

  // Kokoro: <language letter><gender letter>_<name>. The letters only mean something for Kokoro, and they
  // would otherwise read as a language code plus a name (bm_george is George, British, not "Bm george").
  const kok = /^([abefijpz])([mf])_([a-z]+)$/.exec(raw)
  if (kok) {
    const code = { a: 'en', b: 'en', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt', z: 'zh' }[kok[1]] || 'en'
    return out({ name: title(kok[3]), language: langName(code), languageCode: code, accent: KOKORO_ACCENT[kok[1]] || '', accentCode: KOKORO_ACCENT[kok[1]] ? kok[1] : '', gender: kok[2] === 'f' ? 'Female' : 'Male' })
  }

  // Voxtral preset voices: <language>_<name>[_<tone>] (gb_oliver_sad, en_paul_neutral, fr_marie_happy).
  // A third word is a tone only when it IS one, so an unknown third word falls through to the other rules.
  const vox = /^([a-z]{2})_([a-z]+)(?:_([a-z]+))?$/.exec(raw)
  // the language must be a REAL code: gb and en are, gb is the accent tag Voxtral uses for British English
  if (vox && (LANGUAGE_NAMES[vox[1]] || ACCENT_NAMES[vox[1]]) && (!vox[3] || TONE_WORDS.includes(vox[3]))) {
    return out({ name: title(vox[2]), language: langName(vox[1]), languageCode: vox[1], accent: accentName(vox[1]), accentCode: vox[1], tone: vox[3] ? title(vox[3]) : '' })
  }

  // Azure, MAI and every locale id: en-US-JennyNeural, zh-CN-XiaoxiaoNeural, it-IT-Luca:MAI-Voice-2.1
  const az = /^([a-z]{2})-([A-Za-z]{2,3})(?:-|:)([A-Za-z0-9.]+)/.exec(raw)
  if (az && (LANGUAGE_NAMES[az[1].toLowerCase()] || ACCENT_NAMES[az[1].toLowerCase()])) {
    const region = az[2].toUpperCase()
    const spoken = az[3].replace(/Neural$|Multilingual$|Turbo$|HD$|Flash$|Standard$/, '')
    return out({ name: title(spoken.replace(/-/g, ' ')), language: langName(az[1]), languageCode: az[1].toLowerCase(), accent: REGION_NAMES[region] || title(region), accentCode: az[1].toLowerCase() + '-' + region })
  }

  // Deepgram Aura: aura-2-thalia-en, aura-2-cesare-it
  const aura = /^(?:aura(?:-\d)?-)?([a-z]+)-([a-z]{2})$/.exec(raw)
  if (aura && /aura/i.test(String(o.provider || '') + ' ' + String(o.model || ''))) {
    return out({ name: title(aura[1]), language: langName(aura[2]), languageCode: aura[2] })
  }

  // a numbered or cloned voice says nothing about itself: voice_482
  if (/^voice_?\d+$/i.test(raw)) {
    // translated synthetic voices share the model default voice, which carries the language and the name
    return out(Object.assign({ name: String(o.label || 'Voice ' + raw.replace(/^voice_?/i, '')), known: Boolean(o.label) }, pubLang ? { language: langName(pubLang), languageCode: pubLang } : anyLang))
  }

  // a plain name the provider publishes for ONE language is that language (marin on OpenAI is English);
  // a name with no language at all is a multilingual voice
  return out({
    name: title(raw), known: false,
    gender: GENDERS[String(raw).toLowerCase()] || '',
    plan: undefined,
    ...(pubLang ? { language: langName(pubLang), languageCode: pubLang } : anyLang),
  })
}

/** Facets for a whole voice list, with the choices each facet offers (empty when the facet does not apply). */
export function facetOptions(voices) {
  const list = (voices || []).map((v) => (typeof v === 'string' ? facetsOf(v) : facetsOf(v.id, v)))
  const uniq = (items, key) => {
    const seen = []
    for (const it of items) {
      const k = key(it)
      if (!k || seen.some((s) => s.value === k)) continue
      seen.push({ value: k, label: it.label })
    }
    return seen
  }
  return {
    voices: list,
    // grouped by what a person reads: one "English" even when its voices are tagged gb and en
    languages: uniq(list.filter((v) => v.languageCode).map((v) => ({ value: v.language, label: v.language })), (x) => x.value),
    accents: uniq(list.filter((v) => v.accentCode && v.accent).map((v) => ({ value: v.accentCode, label: v.accent })), (x) => x.value),
    tones: uniq(list.filter((v) => v.tone).map((v) => ({ value: v.tone, label: v.tone })), (x) => x.value),
    genders: uniq(list.filter((v) => v.gender).map((v) => ({ value: v.gender, label: v.gender })), (x) => x.value),
  }
}

/** The voices that match the chosen facets (an empty facet matches everything). */
export function filterVoices(voices, pick) {
  const p = pick || {}
  const n = String(p.name || '').toLowerCase()
  return (voices || []).map((v) => (typeof v === 'string' ? facetsOf(v) : v.facets || facetsOf(v.id, v)))
    .filter((v) => (!p.language || v.language === p.language)
      && (!p.accent || v.accentCode === p.accent)
      && (!p.tone || String(v.tone || '').toLowerCase() === String(p.tone).toLowerCase())
      && (!n || v.name.toLowerCase().indexOf(n) >= 0 || v.id.toLowerCase().indexOf(n) >= 0))
}

/**
 * A voice list as the picker shows it: a groups list for a <select> (one group per language, then per
 * accent), each option carrying the voice id. Voices that name no language come last, under "Any language".
 */
export function groupVoices(voices) {
  const facets = facetOptions(voices)
  const groups = new Map()
  for (const v of facets.voices) {
    const langKey = v.languageCode ? (v.language || 'Any language') : 'Any language'
    const accKey = v.accent || ''
    const gk = langKey + '|' + accKey
    if (!groups.has(gk)) groups.set(gk, { language: langKey, accent: accKey, items: [] })
    const tone = v.tone ? ' [' + v.tone + ']' : ''
    const gender = !v.tone && v.gender ? ' (' + v.gender + ')' : ''
    groups.get(gk).items.push({ id: v.id, label: v.name + tone + gender })
  }
  // languages alphabetically, the accent-less group of a language first (the language's own accent),
  // and the voices that name nothing last, under "Any language"
  const named = Array.from(groups.values()).filter((g) => g.language !== 'Any language')
  named.sort((x, y) => (x.language < y.language ? -1 : x.language > y.language ? 1 : (x.accent ? 1 : 0) - (y.accent ? 1 : 0)))
  const order = named.concat(Array.from(groups.values()).filter((g) => g.language === 'Any language'))
  return { groups: order, facets: { languages: facets.languages, accents: facets.accents, tones: facets.tones, genders: facets.genders } }
}

/**
 * Providers the readers do not offer (Luca, 2026-11-25): 'local' is the Tzekos engine (Maya1, on the hub)
 * and 'lfm3' is Liquid. The Kokoro engine ('grey', on the remote box) STAYS.
 * A saved pick of a hidden provider keeps working; it is only absent from the menus.
 */
export const HIDDEN_PROVIDERS = ['local', 'lfm3']

/**
 * A saved preset: the id of one starred voice on one model of one provider.
 * Shape: { id, provider, providerLabel, model, modelLabel, voice, voiceLabel, language, accent, tone, ts }.
 */
export function presetKey(p) {
  const v = p || {}
  return [v.provider, v.model, v.voice, v.language, v.accent, v.tone].map((x) => String(x || '')).join('|')
}

/** Does this preset describe the current pick? */
export function isPresetOf(preset, pick) {
  const p = preset || {}
  const s = pick || {}
  return p.provider === s.provider && String(p.model || '') === String(s.model || '') && String(p.voice || '') === String(s.voice || '') && String(p.language || '') === String(s.language || '') && String(p.accent || '') === String(s.accent || '') && String(p.tone || '') === String(s.tone || '')
}

/** Add (star) or remove (unstar) a preset; the newest first, one entry per identical pick. */
export function togglePreset(list, preset, star) {
  const cur = Array.isArray(list) ? list : []
  const key = presetKey(preset)
  const rest = cur.filter((p) => presetKey(p) !== key)
  if (star === false) return rest
  return [Object.assign({}, preset, { id: key, ts: Date.now() })].concat(rest)
}

/** The presets that belong to one provider (and model, when given), for its menu. */
export function presetsFor(list, provider, model) {
  return (Array.isArray(list) ? list : []).filter((p) => p && p.provider === provider && (model === undefined || model === '' || String(p.model || '') === String(model || '')))
}

/** One line describing a preset, built from its facets: "British, George" or "English (US), Oliver, Sad". */
export function presetLabel(p) {
  const v = p || {}
  const bits = []
  if (v.voiceLabel) bits.push(v.voiceLabel)
  else if (v.voice) bits.push(title(String(v.voice).replace(/^[a-z]{2}_/, '')))
  const where = [v.language, v.accent, v.tone].filter(Boolean).join(', ')
  return bits.join('') + (where ? ' \u00b7 ' + where : '')
}
