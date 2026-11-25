/**
 * Speech annotations (shared by the host and the browser bundle).
 *
 * ONE syntax for the person writing (or for the assistant writing a reply that
 * will be read aloud), adapted to what the selected model actually does:
 *
 *   [tone=happy] [emotion=happy]        a tone, from TONES (or "slightly"/"strongly" first)
 *   [pace=slow]   [rate=fast]           a speaking rate, from PACES
 *   [pitch=high]  [pitch=low]           pitch: high, up, down, low (and "slightly"/"strongly")
 *   [volume=soft] [volume=loud]         volume: soft, quiet, loud, shout
 *   [emphasis]                          stress the word or phrase that follows
 *   [breath] [laugh] [sigh] [pause] ... a sound or a pause, from SOUNDS
 *   **word**  __word__                  Markdown emphasis is the same stress
 *
 * What each model family receives is fixed in ADAPTATION, each rule read from the
 * vendor's own documentation (`verification` says when):
 *
 *   native tags   the family's own in-text syntax: Voxtral [emotion=][pace=],
 *                 ElevenLabs v3/v4 [tag], Gemini 3.8 <tag>, HeyGen [tag]/[pause],
 *                 Fish S2 [free text], Fish S1 (parens), Orpheus <tag>, and the
 *                 request-level delivery directions of OpenAI, Gemini and Fish
 *   ssml          <prosody rate|pitch|volume> and <break> (Azure, Amazon Polly)
 *   pause         [pause] becomes a real silence at that point (every model)
 *   none          nothing: annotations are removed and the text is spoken as is
 *
 * Whatever a model cannot use is REMOVED, never spoken. The result carries a map
 * from offsets in the text as written to offsets in the text as spoken, so the
 * word highlight keeps following the words on screen.
 *
 * Pure module: no node:, no browser API, no I/O.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const TONES = [
  'amused', 'angry', 'anxious', 'apologetic', 'appreciative', 'assertive', 'awestruck', 'bored', 'calm', 'cheerful',
  'confident', 'confused', 'critical', 'curious', 'determined', 'disappointed', 'disgusted', 'dreamy', 'embarrassed',
  'encouraging', 'enthusiastic', 'excited', 'exhausted', 'firm', 'frustrated', 'gentle', 'grateful', 'guilty', 'happy',
  'heartbroken', 'hopeful', 'jealous', 'lonely', 'melancholic', 'mischievous', 'nervous', 'nostalgic', 'panicked',
  'playful', 'proud', 'reflective', 'reassuring', 'relieved', 'resigned', 'sad', 'sarcastic', 'scared', 'serious',
  'shy', 'skeptical', 'sleepy', 'solemn', 'somber', 'stern', 'surprised', 'suspicious', 'sympathetic', 'tender',
  'thoughtful', 'tired', 'trembling', 'urgent', 'warm', 'whispering', 'wistful', 'worried',
]
export const PACES = ['very-slow', 'slow', 'moderate', 'fast', 'very-fast']
export const PITCHES = ['high', 'up', 'down', 'low']
export const VOLUMES = ['soft', 'quiet', 'loud', 'shout']
export const SOUNDS = [
  'breath', 'exhale', 'inhale', 'deep breath', 'sigh', 'frustrated sigh', 'laugh', 'laugh hard', 'chuckle', 'giggle',
  'snicker', 'snort', 'cough', 'throat clearing', 'clear throat', 'sniff', 'gasp', 'sob', 'cry', 'whimper', 'groan',
  'hum', 'sneeze', 'yawn', 'tsk', 'pant', 'pff', 'phew', 'cheer', 'hmm', 'scream', 'shout', 'argh', 'grunt', 'hiss',
  'applause', 'clap', 'pause', 'short pause', 'long pause',
]
/** Silences, in milliseconds, wherever a pause cannot be a tag. */
export const PAUSE_MS = { pause: 450, 'short pause': 250, 'long pause': 900 }

const SOUND_PLURAL = {
  laughs: 'laugh', sighs: 'sigh', chuckles: 'chuckle', giggles: 'giggle', snickers: 'snicker', snorts: 'snort',
  coughs: 'cough', sniffs: 'sniff', gasps: 'gasp', sobs: 'sob', cries: 'cry', whimpers: 'whimper', groans: 'groan',
  sneezes: 'sneeze', yawns: 'yawn', pants: 'pant', cheers: 'cheer', hums: 'hum', exhales: 'exhale', inhales: 'inhale',
  breaths: 'breath', claps: 'clap', pauses: 'pause',
}
const SOUND_ALIAS = {
  laughing: 'laugh', chuckling: 'chuckle', giggling: 'giggle', sighing: 'sigh', 'cracking up': 'laugh',
  'clears throat': 'throat clearing', 'throat-clearing': 'throat clearing', 'clear the throat': 'throat clearing',
  'laughs harder': 'laugh hard', 'laughing loudly': 'laugh hard', 'long break': 'long pause', 'short break': 'short pause',
  break: 'pause', breathing: 'breath', 'deep breaths': 'deep breath',
}

/**
 * A strength word laid over a value: "slightly sad", "extremely angry". "very fast" and "very slow" are
 * pace values in their own right, so "very" only means a strength when the words after it name a value.
 */
const STRENGTH_WORD = { slightly: 'slight', slight: 'slight', somewhat: 'slight', lightly: 'slight', softly: 'slight', strongly: 'strong', extremely: 'strong', really: 'strong', super: 'strong' }

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim()
const key = (s) => norm(s).replace(/[^a-z ]+/g, ' ').replace(/ +/g, ' ').trim()
const dashes = (s) => key(s).replace(/ +/g, '-')

export function normalizePace(v) {
  const k = key(v)
  const words = k.split(' ')
  if (words.length > 1 && /^(very|much)$/.test(words[0])) {
    const rest = words.slice(1).join(' ')
    if (/^(slow|slower|slowly)$/.test(rest)) return 'very-slow'
    if (/^(fast|faster|quick|quickly)$/.test(rest)) return 'very-fast'
  }
  if (PACES.includes(dashes(k))) return dashes(k)
  if (/^(very slow|very slower|much slower)$/.test(k)) return 'very-slow'
  if (/^(very fast|very faster|much faster)$/.test(k)) return 'very-fast'
  if (/^(slow|slower|slowly|slowed|slowing)$/.test(k)) return 'slow'
  if (/^(fast|faster|quick|quickly|rapid|rapidly|hurried|rush|rushed)$/.test(k)) return 'fast'
  if (/^(moderate|normal|natural|medium|steady|regular)$/.test(k)) return 'moderate'
  return ''
}

export function normalizePitch(v) {
  const k = key(v)
  if (PITCHES.includes(k)) return k
  if (/^(high|higher|raised|raise|up|rising|rise)$/.test(k)) return 'high'
  if (/^(low|lower|lowered|down|falling|fall|deep|deeper)$/.test(k)) return 'low'
  return ''
}

export function normalizeVolume(v) {
  const k = key(v)
  if (VOLUMES.includes(k)) return k
  if (/^(soft|softly|soft voice)$/.test(k)) return 'soft'
  if (/^(softer|quiet|quieter|whisper|whispering|murmur|muttering)$/.test(k)) return 'quiet'
  if (/^(loud|louder|raise|raised)$/.test(k)) return 'loud'
  if (/^(shout|shouting|yell|yelling|scream|screaming)$/.test(k)) return 'shout'
  return ''
}

function asSound(v) {
  const k = key(v)
  if (SOUNDS.includes(k)) return k
  if (SOUND_PLURAL[k]) return SOUND_PLURAL[k]
  if (SOUND_ALIAS[k] && SOUNDS.includes(SOUND_ALIAS[k])) return SOUND_ALIAS[k]
  return ''
}

/**
 * Parse the inside of one "[...]" (brackets excluded).
 * { kind: 'tone'|'pace'|'pitch'|'volume'|'emphasis'|'sound'|null, value, strength }.
 * kind null means "not an annotation": the caller keeps the brackets as text, so [1], [Section 4]
 * and [wiki] read as written.
 */
export function parseAnnotation(inner) {
  const raw = norm(inner)
  if (!raw) return { kind: null }
  const asValue = (chunk) => {
    const t = key(chunk).replace(/ (tone|voice|pace|volume|pitch)$/, '')
    if (!t) return null
    if (TONES.includes(t)) return { kind: 'tone', value: t, strength: '' }
    const p = normalizePace(t)
    if (p) return { kind: 'pace', value: p, strength: '' }
    const pi = normalizePitch(t)
    if (pi) return { kind: 'pitch', value: pi, strength: '' }
    const vol = normalizeVolume(t)
    if (vol) return { kind: 'volume', value: vol, strength: '' }
    const snd = asSound(t)
    if (snd) return { kind: 'sound', value: snd, strength: '' }
    return null
  }
  const eq = raw.indexOf('=')
  if (eq > 0) {
    const k = raw.slice(0, eq).replace(/\s/g, '')
    const tail = raw.slice(eq + 1)
    if (!norm(tail)) return { kind: null }
    const v = asValue(tail)
    if (!v) return { kind: null }
    if (['tone', 'emotion', 'style'].includes(k) && v.kind !== 'tone') return { kind: 'tone', value: key(tail), strength: '' }
    if (['pace', 'rate', 'speed'].includes(k) && v.kind !== 'pace') return { kind: null }
    if (k === 'pitch' && v.kind !== 'pitch') return { kind: null }
    if (['volume', 'loudness'].includes(k) && v.kind !== 'volume') return { kind: null }
    if (['sound', 'sfx'].includes(k) && v.kind !== 'sound') return { kind: null }
    return v
  }
  if (/^(emphasis|stress|emphasise|emphasize)$/.test(key(raw))) return { kind: 'emphasis' }
  // the phrase as written: "very fast" is a pace, "high pitch" is a pitch
  const whole = asValue(raw)
  if (whole) return whole
  // a strength word over a documented value: "slightly sad", "very excited"
  const first = key(raw).split(' ')[0]
  const rest = key(raw).replace(/^\S+\s+/, '')
  // "very fast" and "very slow" are documented values, so "very" is not a strength word here
  const strength = STRENGTH_WORD[first] || (first === 'very' && !/(very )?(fast|slow|quick)/.test(key(raw)) ? 'strong' : '')
  if (strength && rest !== key(raw)) {
    const over = asValue(rest)
    if (over) return Object.assign(over, { strength })
  }
  return { kind: null }
}

/** The syntax, for placeholders and docs. */
export const SYNTAX = '[tone=happy] [pace=slow] [pitch=high] [volume=soft] [laugh] [pause] [strongly excited]'

// ---------------------------------------------------------------------------
// Per model family
// ---------------------------------------------------------------------------

export const ADAPTATION = {
  voxtral: {
    label: 'Voxtral TTS 3', model: /voxtral-mini-tts-3/,
    tags: 'square', instructions: false, ssml: false,
    channels: { tone: true, pace: true, pitch: false, volume: false, emphasis: false, sounds: true },
    verification: 'Mistral "Emotion and pace tags" (docs.mistral.ai/studio/audio/text-to-speech/emotion-tags, fetched 2026-11-25): [emotion=] takes 34 documented values, [pace=] takes very-slow, slow, moderate, fast, very-fast; tags combine, a tag lasts until the next tag or the end of the input, no second tag of the same type in one section, tags are not read aloud, an undocumented value is not spoken, English at launch; disfluency tags such as [laugh], [sigh], [breath]; no pitch or volume tag; style instructions are not available at launch.',
  },
  elevenlabs: {
    label: 'ElevenLabs v3 and v4', model: /eleven[_-]v[34]/,
    tags: 'square', instructions: false, ssml: false,
    channels: { tone: true, pace: true, pitch: false, volume: true, emphasis: false, sounds: true },
    verification: 'ElevenLabs prompting guide (elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices, 2026-11-25): audio tags in square brackets ([whispering], [laughs], [sighs], [sarcastic], [curious], [low, gravelly voice]); v3 and v4 do not support SSML break tags; emphasis comes from capitalisation and punctuation. No pitch tag is documented.',
  },
  gemini: {
    label: 'Gemini TTS', model: /gemini-[\d.]+.*tts/,
    tags: 'angle', instructions: true, ssml: false,
    channels: { tone: true, pace: true, pitch: true, volume: true, emphasis: false, sounds: true },
    verification: 'Gemini 3.8 TTS guide (ai.google.dev/gemini-api/docs/speech-generation, 2026-11-25): the text is a verbatim transcript, sustained emotion, prosody, pitch, pace and volume go in speech_metadata.style, momentary vocal bursts and pauses are inline angle-bracket tags (<laugh>, <sigh>, <breath>, <short pause>, <long pause>), stress is capitalisation. Measured through OpenRouter on 2026-11-25: <laugh> is performed and never spoken.',
  },
  heygen: {
    label: 'HeyGen Voice', model: /heygen-voice/,
    tags: 'square', instructions: false, ssml: false,
    channels: { tone: true, pace: true, pitch: true, volume: true, emphasis: false, sounds: true },
    verification: 'HeyGen audio tags (developers.heygen.com/docs/voices/heygen-voice-audio-tags, 2026-11-25): 201 lower-case tags, one per position and never two side by side, intensity only as slightly or extremely and only on feelings and tone tags, a delivery tag lasts about 233 characters of English, acoustic tags act once, [pause] is a one-shot beat, no emphasis tag; the request-level instructions field has no effect on HeyGen.',
  },
  fish: {
    label: 'Fish Audio S2 and Drama 3', model: /fish-audio\/(s2|drama)/,
    tags: 'square', instructions: true, ssml: false,
    channels: { tone: true, pace: true, pitch: true, volume: true, emphasis: true, sounds: true },
    verification: 'Fish Audio docs (docs.fish.audio, 2026-11-25): S2 Pro and S2.1 Pro treat [bracket] cues as text ("any descriptive expression", not a fixed set), a cue lasts until the next cue or the end of the sentence, [emphasis] stresses the phrase after it; Drama 3 takes a plain-language direction in brackets plus the paired tags <whisper> <emphasis> <soft> <fast> <slow> <stress> <forceful>; OpenRouter appends the request-level instructions field to the text (OpenRouter TTS guide, 2026-11-23).',
  },
  fish_s1: {
    label: 'Fish Audio S1', model: /fish-audio\/s1$/,
    tags: 'paren', instructions: false, ssml: false,
    channels: { tone: true, pace: false, pitch: false, volume: false, emphasis: false, sounds: true },
    verification: 'Fish Audio "Emotions" page (docs.fish.audio/developer-guide/core-features/emotions, 2026-11-25): S1 requires (parentheses) and a fixed tag set; emotion tags go at the beginning of sentences; S1 retires on 2026-12-31.',
  },
  orpheus: {
    label: 'Orpheus TTS', model: /orpheus/,
    tags: 'angle', instructions: false, ssml: false,
    channels: { tone: false, pace: false, pitch: false, volume: false, emphasis: false, sounds: true },
    verification: 'Orpheus TTS README (github.com/canopyai/Orpheus-TTS, 2026-11-25): the documented in-text tags are sound tags only: <laugh>, <chuckle>, <sigh>, <cough>, <sniffle>, <groan>, <yawn>, <gasp>.',
  },
  openai: {
    label: 'OpenAI gpt-4o-mini-tts', model: /gpt-4o.*tts/,
    tags: 'square', instructions: true, ssml: false,
    channels: { tone: true, pace: true, pitch: false, volume: true, emphasis: false, sounds: true },
    verification: 'OpenAI text-to-speech guide (developers.openai.com/api/docs/guides/text-to-speech, 2026-11-25): gpt-4o-mini-tts lets prompts control accent, emotional range, intonation, impressions, speed of speech, tone and whispering (no pitch); instructions do not work on tts-1 or tts-1-hd; tts-1, tts-1-hd and gpt-4o-mini-tts shut down on 2027-01-06. Measured on the live API 2026-11-25: a bracketed [whispers] changed delivery and was not spoken, while the same words in instructions were not applied reliably, so annotations stay as text and the request instruction is added as a second channel.',
  },
  openai_legacy: {
    label: 'OpenAI tts-1 and tts-1-hd', model: /^tts-1/,
    tags: null, instructions: false, ssml: false,
    channels: { tone: false, pace: true, pitch: false, volume: false, emphasis: false, sounds: false },
    verification: 'OpenAI guide 2026-11-25: instructions do not work on tts-1 or tts-1-hd and no style markup is documented; the request speed parameter is the only control, so every annotation is removed.',
  },
  kokoro: {
    label: 'Kokoro 82M', model: /kokoro/,
    tags: null, instructions: false, ssml: false,
    channels: { tone: false, pace: true, pitch: false, volume: false, emphasis: false, sounds: false },
    verification: 'Kokoro documents no style control: the voice carries the delivery and the request speed is the only knob, so every annotation is removed.',
  },
  ssml: {
    label: 'SSML prosody', model: null, byType: true,
    tags: 'ssml', instructions: false, ssml: true,
    channels: { tone: false, pace: true, pitch: true, volume: true, emphasis: true, sounds: false },
    verification: 'SSML <prosody rate|pitch|volume> and <break time> are the documented mechanism of Azure AI Speech and Amazon Polly; this adapter sends <speak><prosody> with rate, pitch and volume, and a <break> for each pause.',
  },
  mute: {
    label: 'No annotations', model: null,
    tags: null, instructions: false, ssml: false,
    channels: { tone: false, pace: false, pitch: false, volume: false, emphasis: false, sounds: false },
    verification: 'Nothing is documented for this model, so annotations are removed rather than risked: a tag a model does not know can be read aloud.',
  },
}

/** Adapter types that build SSML themselves: the family is the adapter, not the model id. */
const SSML_TYPES = { azure: 1, amazon: 1, google: 1 }
/** First match wins: a specific family beats a generic one. */
const FAMILY_ORDER = ['voxtral', 'elevenlabs', 'gemini', 'heygen', 'fish_s1', 'fish', 'orpheus', 'openai', 'openai_legacy', 'kokoro']

function family(f) {
  const a = ADAPTATION[f]
  return {
    family: f, label: a.label, tags: a.tags, instructions: a.instructions, ssml: a.ssml,
    channels: Object.assign({}, a.channels), verification: a.verification,
    capsStress: f === 'gemini' || f === 'openai',
  }
}

/** The adaptation of one (adapter type, model id, provider id). */
export function adaptationFor(type, model, provider) {
  const id = String(model || '')
  const pid = String(provider || '')
  for (const f of FAMILY_ORDER) if (ADAPTATION[f].model && ADAPTATION[f].model.test(id)) return family(f)
  if (SSML_TYPES[type]) {
    // Google Cloud TTS sends plain text on /v1 (SSML only on its mark path), so it gets no prosody
    return family(type === 'google' ? 'mute' : 'ssml')
  }
  if (/kokoro/i.test(pid)) return family('kokoro')
  // Supertonic 3 (Supertone) documents no tag vocabulary at all: the text is read as written, so a marker is
  // removed rather than risked. Mapped explicitly so a future documented tag set has one place to change.
  if (type === 'supertonic') return family('mute')
  return family('mute')
}

/** The short description of a family for menus and Settings. */
export function annotationInfo(a) {
  const c = (a && a.channels) || {}
  const mech = []
  if (a && a.tags) mech.push('native tags')
  if (a && a.instructions) mech.push('instructions')
  if (a && a.ssml) mech.push('SSML prosody')
  mech.push('pauses')
  const can = []
  for (const k of ['tone', 'pace', 'pitch', 'volume', 'emphasis', 'sounds']) if (c[k]) can.push(k)
  return {
    family: (a && a.family) || 'mute',
    label: (a && a.label) || 'No annotations',
    summary: can.length ? can.join(', ') : 'none: annotations are removed',
    mechanism: mech.join(', '),
    verification: (a && a.verification) || '',
  }
}

/** The annotation menu of one model: only what the model can take. */
export function tagMenu(a) {
  const c = (a && a.channels) || {}
  const groups = []
  if (c.tone) groups.push({ group: 'Tone', items: TONES.map((t) => '[tone=' + t + ']') })
  if (c.pace) groups.push({ group: 'Pace', items: PACES.map((p) => '[pace=' + p + ']') })
  if (c.pitch) groups.push({ group: 'Pitch', items: PITCHES.map((p) => '[pitch=' + p + ']') })
  if (c.volume) groups.push({ group: 'Volume', items: VOLUMES.map((v) => '[volume=' + v + ']') })
  if (c.emphasis) groups.push({ group: 'Emphasis', items: ['[emphasis]', '**stress this**'] })
  if (c.sounds) groups.push({ group: 'Sounds and pauses', items: SOUNDS.map((s) => '[' + s + ']') })
  if (groups.length) groups.push({ group: 'Strength', items: ['[slightly sad]', '[strongly excited]'] })
  return { label: (a && a.label) || 'No annotations', family: (a && a.family) || 'mute', groups }
}

/** Which mechanism the adapter must use for a model at call time. */
export function mechanismFor(type, model, provider) {
  const a = adaptationFor(type, model, provider)
  return a.ssml ? 'ssml' : a.instructions ? 'instructions' : a.tags ? 'tags' : 'none'
}

// ---------------------------------------------------------------------------
// Each family's native form of an annotation
// ---------------------------------------------------------------------------

const VOXTRAL_EMOTION = ['amused', 'angry', 'anxious', 'apologetic', 'appreciative', 'assertive', 'bored', 'calm', 'confident', 'confused', 'critical', 'curious', 'determined', 'disappointed', 'disgusted', 'excited', 'frustrated', 'grateful', 'happy', 'hopeful', 'playful', 'proud', 'reflective', 'resigned', 'sad', 'sarcastic', 'skeptical', 'somber', 'surprised', 'tense', 'tired', 'urgent', 'warm', 'wistful']
const VOXTRAL_SOUND = { breath: 'breath', exhale: 'exhale', sigh: 'sigh', 'frustrated sigh': 'sigh', laugh: 'laugh', 'laugh hard': 'laugh hard', chuckle: 'chuckle', giggle: 'chuckle', snicker: 'laugh', snort: 'laugh', cough: 'cough', 'throat clearing': 'throat clearing', 'clear throat': 'throat clearing', sniff: 'sniff', gasp: 'gasp', sob: 'gasp', cry: 'gasp', whimper: 'gasp', groan: 'sigh', hum: 'um', sneeze: 'sniff', yawn: 'yawn', tsk: 'um', pant: 'breath', pff: 'sigh', phew: 'sigh', cheer: 'laugh', hmm: 'um', scream: 'gasp', shout: 'uh', argh: 'uh', grunt: 'um', hiss: 'uh', applause: 'laugh', clap: 'laugh' }
const HEYGEN_TONE = ['amused', 'angry', 'annoyed', 'anxious', 'awestruck', 'bored', 'confident', 'confused', 'curious', 'determined', 'disgusted', 'embarrassed', 'excited', 'exhausted', 'frustrated', 'grateful', 'guilty', 'happy', 'heartbroken', 'hopeful', 'jealous', 'lonely', 'melancholic', 'nervous', 'panicked', 'proud', 'relieved', 'sad', 'scared', 'shy', 'sleepy', 'surprised', 'tender', 'worried', 'apologetic', 'authoritative', 'calm', 'cheerful', 'cold', 'dismissive', 'dreamy', 'encouraging', 'enthusiastic', 'firm', 'gentle', 'mischievous', 'playful', 'reassuring', 'sarcastic', 'serious', 'sincere', 'smug', 'solemn', 'stern', 'suspicious', 'thoughtful', 'warm', 'somber', 'skeptical', 'resigned', 'reflective']
const HEYGEN_SOUND = { breath: 'breath', exhale: 'exhales', inhale: 'inhales', 'deep breath': 'sharp intake of breath', sigh: 'sighs', 'frustrated sigh': 'long tired sigh', laugh: 'laughs', 'laugh hard': 'belly laugh', chuckle: 'chuckles', giggle: 'giggles', snicker: 'snickers', snort: 'snorts', cough: 'coughs', 'throat clearing': 'clears throat', 'clear throat': 'clears throat', sniff: 'sniffs', gasp: 'gasps', sob: 'sobs', cry: 'whimpers', whimper: 'whimpers', groan: 'groans', hum: 'hums', sneeze: 'sneezes', yawn: 'yawns', tsk: 'tsks', pant: 'pants', pff: 'huffs', phew: 'exhales', cheer: 'calls out', hmm: 'hmm', scream: 'screams', shout: 'shouts', argh: 'groans', grunt: 'grunts', hiss: 'shushes', applause: 'applause', clap: 'claps' }
const ELEVEN_TONE = ['dismissive', 'cute', 'happy', 'professional', 'sympathetic', 'questioning', 'reassuring', 'impressed', 'dramatically', 'delighted', 'amazed', 'warmly', 'nervously', 'alarmed', 'sheepishly', 'stifling laughter', 'frustrated', 'desperately', 'deadpan', 'surprised', 'panicking', 'annoyed', 'sad', 'angry', 'appalled', 'thoughtful', 'sarcastic', 'curious', 'excited', 'mischievously', 'confident', 'calm', 'tired', 'solemn', 'wistful', 'nostalgic', 'gentle', 'urgent', 'firm', 'skeptical']
const ELEVEN_SOUND = { breath: 'exhales', exhale: 'exhales', inhale: 'inhales', 'deep breath': 'inhales deeply', sigh: 'sighs', 'frustrated sigh': 'frustrated sigh', laugh: 'laughs', 'laugh hard': 'laughs harder', chuckle: 'chuckles', giggle: 'giggles', snicker: 'snorts', snort: 'snorts', cough: 'clears throat', 'throat clearing': 'clears throat', 'clear throat': 'clears throat', sniff: 'gulps', gasp: 'happy gasp', sob: 'crying', cry: 'crying', whimper: 'crying', groan: 'sighs', hum: 'sings', sneeze: 'clears throat', yawn: 'exhales', tsk: 'sighs', pant: 'wheezing', pff: 'exhales', phew: 'sighs', cheer: 'clapping', hmm: 'sighs', scream: 'shouting', shout: 'shouting', argh: 'sighs', grunt: 'swallows', hiss: 'whispers', applause: 'applause', clap: 'clapping', pause: 'short pause', 'short pause': 'short pause', 'long pause': 'long pause' }
const ELEVEN_VOLUME = { quiet: 'whispering', soft: 'whispering', loud: 'shouting', shout: 'shouting' }
const GEMINI_SOUND = { breath: 'breath', exhale: 'exhales', inhale: 'breath', 'deep breath': 'heavy breath', sigh: 'sigh', 'frustrated sigh': 'sigh', laugh: 'laugh', 'laugh hard': 'laugh', chuckle: 'chuckle', giggle: 'giggle', snicker: 'snicker', snort: 'snort', cough: 'cough', 'throat clearing': 'throat-clearing', 'clear throat': 'throat-clearing', sniff: 'sniff', gasp: 'gasp', sob: 'sob', cry: 'cry', whimper: 'whimper', groan: 'groan', hum: 'hmm', sneeze: 'sneeze', yawn: 'yawn', tsk: 'tsk', pant: 'pant', pff: 'pff', phew: 'phew', cheer: 'cheer', hmm: 'hmm', scream: 'scream', shout: 'shout', argh: 'argh', grunt: 'grunt', hiss: 'hiss', applause: 'clap', clap: 'clap', pause: 'short pause', 'short pause': 'short pause', 'long pause': 'long pause' }
const FISH_INTENSITY = { slight: 'slightly ', strong: 'very ', '': '' }
const FISH_SOUND = { breath: 'breath', exhale: 'exhale', inhale: 'inhale', 'deep breath': 'inhale', sigh: 'sigh', 'frustrated sigh': 'sigh', laugh: 'laugh', 'laugh hard': 'laughing', chuckle: 'chuckle', giggle: 'laughing', snicker: 'laugh', snort: 'laugh', cough: 'cough', 'throat clearing': 'clear throat', 'clear throat': 'clear throat', sniff: 'sniff', gasp: 'gasp', sob: 'sobbing', cry: 'crying loudly', whimper: 'sobbing', groan: 'groaning', hum: 'humming', sneeze: 'cough', yawn: 'yawn', tsk: 'tsk', pant: 'panting', pff: 'sigh', phew: 'sigh', cheer: 'excited', hmm: 'hmm', scream: 'screaming', shout: 'shouting', argh: 'sigh', grunt: 'groaning', hiss: 'whisper', applause: 'applause', clap: 'applause', pause: 'pause', 'short pause': 'short pause', 'long pause': 'long pause' }
const S1_TONE = ['happy', 'sad', 'angry', 'excited', 'calm', 'nervous', 'confident', 'surprised', 'satisfied', 'delighted', 'scared', 'worried', 'upset', 'frustrated', 'depressed', 'empathetic', 'embarrassed', 'disgusted', 'moved', 'proud', 'relaxed', 'grateful', 'curious', 'sarcastic', 'disdainful', 'unhappy', 'anxious', 'hysterical', 'indifferent', 'uncertain', 'doubtful', 'confused', 'disappointed', 'regretful', 'guilty', 'ashamed', 'jealous', 'envious', 'hopeful', 'optimistic', 'pessimistic', 'nostalgic', 'lonely', 'bored', 'contemptuous', 'sympathetic', 'compassionate', 'determined', 'resigned']
const S1_SOUND = { breath: 'breath', sigh: 'sighing', 'frustrated sigh': 'sighing', laugh: 'laughing', 'laugh hard': 'laughing', chuckle: 'chuckling', giggle: 'laughing', snicker: 'laughing', snort: 'laughing', cough: 'cough', sniff: 'cough', gasp: 'gasping', sob: 'sobbing', cry: 'crying loudly', whimper: 'sobbing', groan: 'groaning', hum: 'humming', sneeze: 'cough', yawn: 'yawning', tsk: 'cough', pant: 'panting', pff: 'sighing', phew: 'sighing', cheer: 'laughing', hmm: 'humming', scream: 'screaming', shout: 'shouting', argh: 'groaning', grunt: 'groaning', hiss: 'whispering', applause: 'audience laughing', clap: 'audience laughing', pause: 'break', 'short pause': 'break', 'long pause': 'long-break' }
const ORPHEUS_SOUND = { laugh: 'laugh', 'laugh hard': 'laugh', chuckle: 'chuckle', giggle: 'chuckle', sigh: 'sigh', 'frustrated sigh': 'sigh', cough: 'cough', sniff: 'sniffle', sniffle: 'sniffle', groan: 'groan', yawn: 'yawn', gasp: 'gasp' }

function isSilence(v) { return Boolean(PAUSE_MS[v]) }

/**
 * The native form of one annotation in a family's own syntax, or '' when that family cannot take it.
 * A silence is never a tag here: the caller turns it into a pause instead.
 */
export function nativeTag(a, ann) {
  if (!a || !ann || !a.tags) return ''
  const c = a.channels || {}
  const v = ann.value
  const strength = ann.strength || ''
  if (ann.kind === 'sound' && isSilence(v)) return ''
  switch (a.family) {
    case 'voxtral':
      if (ann.kind === 'tone' && c.tone) return VOXTRAL_EMOTION.includes(v) ? '[emotion=' + v + ']' : ''
      if (ann.kind === 'pace' && c.pace) return PACES.includes(v) ? '[pace=' + v + ']' : ''
      if (ann.kind === 'sound' && c.sounds) return VOXTRAL_SOUND[v] ? '[' + VOXTRAL_SOUND[v] + ']' : ''
      return ''
    case 'elevenlabs':
      if (ann.kind === 'tone' && c.tone) return ELEVEN_TONE.includes(v) ? '[' + v + ']' : ''
      if (ann.kind === 'pace' && c.pace) return '[' + (v === 'slow' || v === 'very-slow' ? 'slowly' : v === 'moderate' ? 'moderately' : 'quickly') + ']'
      if (ann.kind === 'volume' && c.volume && ELEVEN_VOLUME[v]) return '[' + ELEVEN_VOLUME[v] + ']'
      if (ann.kind === 'sound' && c.sounds) return ELEVEN_SOUND[v] ? '[' + ELEVEN_SOUND[v] + ']' : ''
      return ''
    case 'gemini':
      if (ann.kind === 'sound' && c.sounds) return GEMINI_SOUND[v] ? '<' + GEMINI_SOUND[v] + '>' : ''
      return ''
    case 'heygen':
      // one tag per position: the strength is part of the tag, and only slightly and extremely are tags
      if (ann.kind === 'tone' && c.tone) return HEYGEN_TONE.includes(v) ? '[' + (strength === 'slight' ? 'slightly ' : strength === 'strong' ? 'extremely ' : '') + v + ']' : ''
      if (ann.kind === 'pace' && c.pace) return '[' + (v === 'slow' || v === 'very-slow' ? 'slowly' : 'quickly') + ']'
      if (ann.kind === 'pitch' && c.pitch) return '[' + (v === 'high' || v === 'up' ? 'high voice' : 'low voice') + ']'
      if (ann.kind === 'volume' && c.volume) return '[' + (v === 'loud' ? 'loudly' : v === 'shout' ? 'shouts' : 'softly') + ']'
      if (ann.kind === 'sound' && c.sounds) return HEYGEN_SOUND[v] ? '[' + HEYGEN_SOUND[v] + ']' : ''
      return ''
    case 'fish':
      if (ann.kind === 'tone' && c.tone) return '[' + (FISH_INTENSITY[strength] || '') + v + ']'
      if (ann.kind === 'pace' && c.pace) return '[' + (v === 'slow' || v === 'very-slow' ? (strength === 'strong' ? 'very slowly' : 'slowly') : 'quickly') + ']'
      if (ann.kind === 'pitch' && c.pitch) return '[' + (v === 'high' || v === 'up' ? 'higher pitch' : 'lower pitch') + ']'
      if (ann.kind === 'volume' && c.volume) return '[' + (v === 'loud' ? 'loud' : v === 'shout' ? 'shouting' : 'soft voice') + ']'
      if (ann.kind === 'emphasis' && c.emphasis) return '[emphasis]'
      if (ann.kind === 'sound' && c.sounds) return FISH_SOUND[v] ? '[' + FISH_SOUND[v] + ']' : ''
      return ''
    case 'fish_s1':
      if (ann.kind === 'tone' && c.tone) return S1_TONE.includes(v) ? '(' + v + ')' : ''
      if (ann.kind === 'sound' && c.sounds) return S1_SOUND[v] ? '(' + S1_SOUND[v] + ')' : ''
      return ''
    case 'orpheus':
      if (ann.kind === 'sound' && c.sounds) return ORPHEUS_SOUND[v] ? '<' + ORPHEUS_SOUND[v] + '>' : ''
      return ''
    case 'openai':
      // measured 2026-11-25: gpt-4o-mini-tts performs a bracketed direction and does not speak it
      if (ann.kind === 'tone' && c.tone) return '[' + v + ']'
      if (ann.kind === 'volume' && c.volume) return '[' + (v === 'loud' ? 'loudly' : v === 'shout' ? 'shouting' : 'whispers') + ']'
      if (ann.kind === 'sound' && c.sounds) return '[' + v + ']'
      return ''
    default:
      return ''
  }
}

// ---------------------------------------------------------------------------
// Parsing a text into parts
// ---------------------------------------------------------------------------

/** Markdown emphasis: **text** or __text__, as spans of the INNER text. */
export function emphasisSpans(text) {
  const s = String(text || '')
  const out = []
  const re = /(?<![*_])\*\*([^*\n]+)\*\*(?!\*)|(?<![*_])__([^_\n]+)__(?!_)/g
  let m
  while ((m = re.exec(s))) {
    const inner = m[1] !== undefined ? m[1] : m[2]
    const start = m.index + (m[0].length - inner.length) / 2
    out.push({ from: start, to: start + inner.length })
  }
  return out
}

/** Bracketed text that is not an annotation: [[el]] markers, [link](...) syntax and [1] citations stay text. */
const ANNOTATION = /\[(?![\[\]])(?![^\]\n]*"[^\]\n]*"[^\]\n]*\])([^[\]\n]{1,120})\](?!\()/g

/**
 * Split a text into parts in original order:
 *   { kind: 'text', from, to, text, stress, hasStress }   the original slice; stress means "starts inside **"
 *   { kind: 'ann', from, to, ann, inner }                 an annotation
 * Text parts are cut at the emphasis bounds, so the run inside ** ** is a part of its own.
 */
export function parts(text) {
  const s = String(text || '')
  const emph = emphasisSpans(s)
  const stressAt = (from) => emph.some((e) => from >= e.from && from < e.to)
  const bounds = []
  for (const e of emph) { bounds.push(Math.max(0, e.from - 2)); bounds.push(e.to) }
  const out = []
  let last = 0
  const addText = (from, to) => {
    if (to <= from) return
    const opens = /^(\*\*|__)/.test(s.slice(from, to))
    out.push({
      kind: 'text', from, to, text: s.slice(from, to),
      stress: stressAt(opens ? from + 2 : from),
      hasStress: emph.some((e) => e.from >= from && e.to <= to),
    })
  }
  const addRange = (from, to) => {
    if (to <= from) return
    const cuts = bounds.filter((b) => b > from && b < to).sort((x, y) => x - y)
    let at = from
    for (const c of cuts.concat([to])) { addText(at, c); at = c }
  }
  ANNOTATION.lastIndex = 0
  let m
  while ((m = ANNOTATION.exec(s))) {
    const ann = parseAnnotation(m[1])
    if (!ann.kind) continue
    addRange(last, m.index)
    out.push({ kind: 'ann', from: m.index, to: m.index + m[0].length, ann, inner: m[1] })
    last = m.index + m[0].length
  }
  addRange(last, s.length)
  return out
}

/** Every annotation in a text, with its offsets. */
export function listAnnotations(text) {
  return parts(text).filter((p) => p.kind === 'ann').map((p) => ({ from: p.from, to: p.to, kind: p.ann.kind, value: p.ann.value, strength: p.ann.strength, inner: p.inner }))
}

/** Drop the emphasis stars; with caps, the emphasised run is upper-cased (engines that read caps as stress). */
function stripStars(text, caps) {
  const s = String(text || '')
  if (!caps) return s.replace(/\*\*|__/g, '')
  return s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (m, a, b) => String(a !== undefined ? a : b).toUpperCase())
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }

/**
 * Apply the annotations of a text for one model.
 *
 * opts: { adaptation | type, model, provider, script }
 *   script: reading a code block, where annotations never apply.
 *
 * Returns:
 *   text          what to send to the provider (native tags, or <speak> SSML, or plain text)
 *   spoken        the words alone, one space between them: what the highlight matches
 *   instructions  request-level delivery direction ('' when the model takes none)
 *   pauses        [{ at, ms }] a silence before the sentence that starts at that offset of `spoken`
 *   map(c0, c1)   original offsets -> [spokenFrom, spokenTo]
 *   unmap(c0, c1) spoken offsets -> [origFrom, origTo]
 *   toWire(c0, c1) spoken offsets -> offsets in `text` (for a highlight inside a tag-based request)
 *   had / used / dropped   annotations found, reached the model, removed
 */
export function applyAnnotations(text, opts) {
  const o = opts || {}
  const a = o.adaptation || adaptationFor(o.type, o.model, o.provider)
  const script = Boolean(o.script)
  const stressCaps = Boolean(a.capsStress) && !script
  const ps = parts(text)

  // one pass builds both texts together: `wire` (the words with each tag) and `spoken` (the words alone).
  // Every visible run records its span in BOTH texts, so translating an offset is a lookup, never
  // arithmetic over removed characters.
  let wire = ''
  let spoken = ''
  const segs = []
  const pauses = []
  let had = 0
  let used = 0
  let dropped = 0
  let prev = ''
  for (const p of ps) {
    if (p.kind === 'text') {
      const caps = Boolean(p.hasStress) && stressCaps
      const opens = /^(\*\*|__)/.test(p.text)
      let vis = caps ? stripStars(p.text, true) : p.text.replace(/\*\*|__/g, '')
      if (!vis) continue
      // a removed annotation between two pieces leaves ONE space: fold the seam here, in both texts
      let from = p.from + (opens ? 2 : 0)
      // fold the seam of a removed annotation (never the very first space of the text: the lead is handled below)
      if (vis[0] === ' ' && prev === ' ') { vis = vis.slice(1); from += 1 }
      if (vis[0] === ' ' && spoken === '' && p.from > 0) { vis = vis.slice(1); from += 1 }
      if (!vis) continue
      const wf = wire.length
      const sf = spoken.length
      wire += vis
      spoken += vis
      segs.push({ origFrom: from, origTo: p.to, outFrom: wf, outTo: wire.length, spFrom: sf, spTo: spoken.length })
      prev = vis[vis.length - 1]
      continue
    }
    had += 1
    if (script) { dropped += 1; continue }
    const tag = nativeTag(a, p.ann)
    if (tag) { wire += tag; used += 1; continue }
    if (p.ann.kind === 'sound' && PAUSE_MS[p.ann.value]) {
      // the silence belongs after the space the removed annotation left, where the next word begins
      pauses.push({ at: spoken.length + 1, ms: PAUSE_MS[p.ann.value] })
      used += 1
      continue
    }
    dropped += 1
  }
  // the leading space of a message is layout, not a word
  let leadWire = 0
  let leadSpoken = 0
  if (wire[0] === ' ') { wire = wire.slice(1); leadWire = 1 }
  if (spoken[0] === ' ') { spoken = spoken.slice(1); leadSpoken = 1 }
  segs.forEach((g) => {
    g.outFrom -= Math.min(leadWire, g.outFrom)
    g.outTo -= Math.min(leadWire, g.outTo)
    g.spFrom -= Math.min(leadSpoken, g.spFrom)
    g.spTo -= Math.min(leadSpoken, g.spTo)
  })
  if (leadSpoken) pauses.forEach((q) => { q.at = Math.max(0, q.at - leadSpoken) })
  const finalWire = a.ssml ? toSsml(ps, a) : wire
  const finalSpoken = spoken
  const instructions = buildInstructions(ps, a)

  const segAt = (pos, fromKey, toKey) => {
    for (const g of segs) if (pos >= g[fromKey] && pos < g[toKey]) return g
    return null
  }
  const fwd = (pos) => { const g = segAt(pos, 'origFrom', 'origTo'); if (g) return g.spFrom + (pos - g.origFrom); const next = segs.find((x) => x.origFrom >= pos); return next ? next.spFrom : finalSpoken.length }
  const bwd = (pos) => { const g = segAt(pos, 'spFrom', 'spTo'); if (g) return g.origFrom + (pos - g.spFrom); const next = segs.find((x) => x.spFrom >= pos); return next ? next.origFrom : String(text || '').length }
  const swap = (pair) => { const f = num(pair && pair[0], 0); const t = num(pair && pair[1], f); const x = Math.min(f, t); const y = Math.max(f, t); return [x, y] }
  return {
    text: finalWire,
    spoken: finalSpoken,
    plain: finalSpoken,
    instructions,
    pauses,
    had,
    used,
    dropped,
    family: a.family,
    label: a.label,
    channels: a.channels || {},
    verification: a.verification,
    map(c0, c1) {
      const [x, y] = swap([c0, c1])
      const from = fwd(x)
      const to = fwd(y)
      return [[Math.min(from, to), Math.max(from, to)]].filter(([p1, p2]) => p2 > p1)
    },
    unmap(c0, c1) {
      const [x, y] = swap([c0, c1])
      const from = bwd(x)
      const to = bwd(y)
      return [[Math.min(from, to), Math.max(from, to)]].filter(([p1, p2]) => p2 > p1)
    },
    toWire(c0, c1) {
      const [x, y] = swap([c0, c1])
      const out = []
      for (const g of segs) {
        const a2 = Math.max(x, g.spFrom)
        const b2 = Math.min(y, g.spTo)
        if (b2 <= a2) continue
        out.push([g.outFrom + (a2 - g.spFrom), g.outFrom + (b2 - g.spFrom)])
      }
      return out
    },
  }
}

/** Text to send when nothing else is needed: annotations removed, the words as written. */
export function stripAnnotations(text, type, model, provider) {
  return applyAnnotations(text, { type, model, provider }).spoken
}

// ---------------------------------------------------------------------------
// SSML and instructions
// ---------------------------------------------------------------------------

const STRENGTH_SCALE = { slight: 0.5, strong: 1.25, '': 1 }
const PACE_FACTOR = { 'very-slow': 0.7, slow: 0.85, moderate: 1, fast: 1.15, 'very-fast': 1.35 }
const PITCH_SEMITONES = { high: 12, up: 6, down: -6, low: -12 }
const VOLUME_DB = { soft: '-6dB', quiet: '-6dB', loud: '+6dB', shout: '+9dB' }
const xml = (s) => String(s).replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]))

/** The SSML of one request: prosody spans, emphasis runs, and a break for each pause. */
export function toSsml(textOrParts, adaptation) {
  const ps = typeof textOrParts === 'string' ? parts(textOrParts) : textOrParts
  const c = (adaptation && adaptation.channels) || {}
  let pace = 1
  let pitch = 0
  let volume = ''
  let run = ''
  let body = ''
  let emphasis = false
  const close = () => {
    if (!run) return
    const trimmed = run.replace(/^ /, '').replace(/ $/, '')
    if (!trimmed) { run = ''; return }
    const rate = pace === 1 ? '' : (pace > 1 ? '+' : '') + Math.round((pace - 1) * 100) + '%'
    const semis = pitch === 0 ? '' : (pitch > 0 ? '+' : '') + Math.round(pitch) + 'st'
    const attrs = []
    if (rate) attrs.push('rate="' + rate + '"')
    if (semis) attrs.push('pitch="' + semis + '"')
    if (volume) attrs.push('volume="' + volume + '"')
    body += attrs.length ? '<prosody ' + attrs.join(' ') + '>' + trimmed + '</prosody>' : trimmed
    run = ''
  }
  for (const p of ps) {
    if (p.kind === 'text') {
      const t = xml(p.text.replace(/\*\*|__/g, ''))
      if (!t) continue
      const strong = c.emphasis && (emphasis || Boolean(p.stress) || Boolean(p.hasStress))
      run += strong ? '<emphasis level="strong">' + t + '</emphasis>' : t
      continue
    }
    if (p.ann.kind === 'pace' && c.pace) { close(); pace = Math.max(0.4, Math.min(2, 1 + (PACE_FACTOR[p.ann.value] - 1) * (STRENGTH_SCALE[p.ann.strength] || 1))) }
    else if (p.ann.kind === 'pitch' && c.pitch) { close(); pitch = PITCH_SEMITONES[p.ann.value] * (STRENGTH_SCALE[p.ann.strength] || 1) }
    else if (p.ann.kind === 'volume' && c.volume) { close(); volume = VOLUME_DB[p.ann.value] || '' }
    else if (p.ann.kind === 'emphasis' && c.emphasis) { close(); emphasis = true }
    else if (p.ann.kind === 'sound' && PAUSE_MS[p.ann.value]) { close(); body += '<break time="' + PAUSE_MS[p.ann.value] + 'ms"/>' }
  }
  close()
  return '<speak>' + body.replace(/^ /, '') + '</speak>'
}

/**
 * A delivery direction for the whole request, from its annotations (OpenAI, Gemini, Fish Audio).
 * The last value of each kind wins; sounds and pauses are not described. '' when nothing applies.
 */
export function buildInstructions(textOrParts, adaptation) {
  const a = adaptation
  if (!a || !a.instructions) return ''
  const c = a.channels || {}
  const ps = typeof textOrParts === 'string' ? parts(textOrParts) : textOrParts
  let tone = ''
  let pace = ''
  let pitch = ''
  let volume = ''
  for (const p of ps) {
    if (p.kind !== 'ann') continue
    const v = p.ann.value
    const strong = p.ann.strength === 'strong'
    const slight = p.ann.strength === 'slight'
    if (p.ann.kind === 'tone' && c.tone) tone = (slight ? 'slightly ' : strong ? 'very ' : '') + v
    if (p.ann.kind === 'pace' && c.pace) pace = (v === 'very-slow' || (v === 'slow' && strong)) ? 'very slowly' : v === 'slow' ? 'slowly' : (v === 'very-fast' || (v === 'fast' && strong)) ? 'very fast' : v === 'fast' ? 'fast' : 'at a moderate pace'
    if (p.ann.kind === 'pitch' && c.pitch) pitch = v === 'high' || v === 'up' ? 'a higher pitch' : 'a lower pitch'
    if (p.ann.kind === 'volume' && c.volume) volume = v === 'soft' || v === 'quiet' ? (strong ? 'a very quiet, whispering volume' : 'a soft volume') : v === 'loud' ? 'a loud volume' : 'shouting'
  }
  const bits = []
  if (tone) bits.push('in a ' + tone + ' tone')
  if (pace) bits.push('speaking ' + pace)
  if (pitch) bits.push('with ' + pitch)
  if (volume) bits.push('at ' + volume)
  return bits.length ? 'Speak ' + bits.join(', ') + '.' : ''
}