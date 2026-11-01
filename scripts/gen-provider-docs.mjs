#!/usr/bin/env node
/**
 * Generates the provider table and per-provider setup sections from the
 * adapters' own metadata, so README.md and docs/PROVIDERS.md cannot drift from
 * the code.
 *
 *   node scripts/gen-provider-docs.mjs --write    rewrite the generated blocks
 *   node scripts/gen-provider-docs.mjs --check    exit 1 when they are stale
 *
 * README.md blocks:  <!-- providers:begin --> ... <!-- providers:end -->
 *                    <!-- setup:begin --> ... <!-- setup:end -->
 * docs/PROVIDERS.md is written whole.
 */
import fs from 'node:fs'
import path from 'node:path'
import { TYPES, GROUP_ORDER, RESIDENCY_LABELS } from '../lib/server/registry.js'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const GROUP_TITLE = { eu: 'EU first', other: 'Others', self: 'Self-hosted and local' }

// Price notes come from the vendors' public pricing pages as read on the date in
// `verification`; "check" means the figure was not confirmed. They are notes, not quotes.
const PRICE = {
  mistral: 'TTS about $13 per 1M characters; STT $0.0035 to $0.008 per minute',
  speechmatics: 'STT from about $0.24 per hour',
  gladia: 'check the vendor pricing page',
  acapela: 'quote on request',
  readspeaker: 'credit plans via sales',
  elevenlabs: 'credits; flash v2.5 bills 0.5 credit per character',
  azure: 'TTS about $15 per 1M characters; STT about $1 per hour real time',
  google: 'check the vendor pricing page (Neural2 and Chirp 3 HD differ)',
  amazon: 'Polly neural about $16 per 1M characters; Transcribe per second',
  openai: 'per character (TTS) and per minute (STT), see the pricing page',
  'openai-compatible': 'depends on the server (free when self-hosted)',
  fish: 'check the vendor pricing page',
  cartesia: 'check the vendor pricing page',
  deepgram: 'STT about $0.46 per hour (nova-3); TTS per 1M characters',
  assemblyai: 'STT per hour, see the pricing page',
  mimo: 'Token Plan subscription',
  dashscope: 'per character',
  'elevenlabs-compatible': 'free (your server)',
  'tzekos-native': 'free (your server)',
  lfm3: 'free (local)',
  piper: 'free (local)',
  xtts: 'free (local, non-commercial licence)',
  browser: 'free',
}

const SETUP = {
  mistral: 'Credential: the API key (`env:MISTRAL_API_KEY`). Use the `mistral-eu` preset for EU-only inference. Greek has no preset voice: pick `voxtral-mini-tts-3-0` and a cloned or Italian-capable voice only after listening.',
  speechmatics: 'Credential: the API key. Region `eu1` (default) or `eu2`; keep it on an EU region. Speech to text only through the batch API; the English TTS preview is optional.',
  gladia: 'Credential: the API key (sent as `x-gladia-key`). Greek is transcribed with `solaria-1`; the adapter picks it for you.',
  acapela: 'Credential: one string `email:password` of the Acapela Cloud account (the adapter logs in and caches the token). Set `defaultVoice` to a voice of the account.',
  readspeaker: 'Credential: the speechCloud API key. Greek and Italian voice names are only in the customer portal: set `defaultVoice` (and `langCodes` if your account uses other codes).',
  elevenlabs: 'Credential: the API key (`env:ELEVENLABS_API_KEY`). Use the `elevenlabs-eu` preset only with an Enterprise EU-residency workspace and its own key.',
  azure: 'Credential: the Speech resource key; set the region of that resource (EU regions are listed first). Word timings use the TTS WebSocket (option `wordBoundary`); if it fails the read continues over REST.',
  google: 'Credential: a Cloud API key (or an OAuth bearer token starting `ya29.`). Region `eu` (default) uses the EU endpoints. Word timings need a non-Chirp voice (for example Neural2).',
  amazon: 'Credential: one string `ACCESSKEYID:SECRET` (add `:SESSIONTOKEN` for temporary credentials), for an IAM user allowed `polly:SynthesizeSpeech`, `polly:DescribeVoices` and `transcribe:StartStreamTranscriptionWebSocket`. Pick an EU region. Polly has no Greek voice.',
  openai: 'Credential: the API key. The `openai-eu` preset needs an EU data-residency project with approval from OpenAI. The TTS models retire on 2027-01-06 and whisper-1 plus the gpt-4o transcribe family on 2027-02-26.',
  'openai-compatible': 'Credential: the key the server expects (leave empty and tick `keyless` for a local server). Presets fill in the base URL: Kokoro-FastAPI (word timings through its captioned speech route, no Greek), Speaches, LocalAI, openedai-speech, Groq (speech to text), OVHcloud AI Endpoints.',
  fish: 'Credential: the API key. A new account has no credit: use the free model `s2.1-pro-free`. Greek is not advertised by the vendor.',
  cartesia: 'Credential: the API key. Word timings use the TTS WebSocket (option `wordTimestamps`), otherwise plain audio.',
  deepgram: 'Credential: the API key. Use the EU preset for `api.eu.deepgram.com`. Aura voices have no Greek; Nova-3 transcribes Greek and Italian.',
  assemblyai: 'Credential: the API key. Use the EU preset for `api.eu.assemblyai.com`. Greek is transcribed with Universal-2 only.',
  mimo: 'Credential: the Token Plan key (`env:MIMO_TOKEN_PLAN_API_KEY`); the base URL may be `http://host:port` for a relay.',
  dashscope: 'Legacy, off unless `legacy.engines` is on.',
  'elevenlabs-compatible': 'Credential: the server key. The Local TTS server preset points at a loopback server (`http://127.0.0.1:8771`).',
  'tzekos-native': 'Credential: the server key. Only `POST /api/tts` is ever called.',
  lfm3: 'No credential. Loopback llama.cpp router; shares the GPU, so it is only used as an explicit fallback.',
  piper: 'No credential needed. Start the Piper HTTP server (`python3 -m piper.http_server`) and point the base URL at it (default port 5000).',
  xtts: 'No credential needed. Set `defaultVoice` to a speaker sample name the server knows. Non-commercial licence.',
  browser: 'Nothing to set up. It is the last-resort fallback.',
}

const WORDS = { word: 'word', char: 'word (from characters)', sentence: 'sentence', duration: 'estimated', none: 'estimated' }

function row(a) {
  let c
  try { c = a.capabilities({ options: {}, models: {}, state: {}, secret: () => 'x', baseUrl: '', region: '' }) } catch (e) { c = { tts: false, stt: false, alignment: 'none' } }
  const t = (x) => (x === '*' ? 'any' : Array.isArray(x) ? x.join(' ') : '')
  return { a, c, t }
}

function table() {
  const out = []
  for (const g of GROUP_ORDER) {
    const list = Object.values(TYPES).filter((a) => (a.group || 'other') === g)
    if (!list.length) continue
    out.push('**' + GROUP_TITLE[g] + '**', '', '| Provider | TTS | STT | Word timings | Data residency | Price note | Docs |', '|---|---|---|---|---|---|---|')
    for (const a of list) {
      const { c } = row(a)
      const eu = a.residency === 'varies' && a.regions && a.regions.some((r) => r.eu) ? 'EU regions selectable' : (RESIDENCY_LABELS[a.residency] || '')
      const st = a.status === 'planned' ? ' (planned)' : a.status === 'unverified' ? ' (unverified)' : a.status === 'partial' ? ' (partly verified)' : ''
      const generic = a.type === 'openai-compatible'
      const tts = generic ? 'per preset' : c.tts ? 'yes' : (a.status === 'planned' ? 'planned' : 'no')
      const stt = generic ? 'per preset' : c.stt ? 'yes' : 'no'
      const words = generic ? 'Kokoro-FastAPI captions, else estimated' : c.tts ? WORDS[c.alignment] || 'estimated' : 'n/a'
      out.push('| `' + a.type + '` ' + a.label + st + ' | ' + tts + ' | ' + stt + ' | ' + words + ' | ' + eu + ' | ' + (PRICE[a.type] || '') + ' | ' + (a.docs ? '[docs](' + a.docs + ')' : 'n/a') + ' |')
    }
    out.push('')
  }
  return out.join('\n')
}

function setup() {
  const out = []
  for (const g of GROUP_ORDER) {
    const list = Object.values(TYPES).filter((a) => (a.group || 'other') === g)
    for (const a of list) {
      const { c, t } = row(a)
      out.push('#### ' + a.label + ' (`' + a.type + '`)', '')
      out.push(a.desc, '')
      const bits = []
      bits.push('Residency: ' + a.euNote)
      if (c.ttsLangs && c.tts) bits.push('TTS languages: ' + t(c.ttsLangs) + '.')
      if (c.sttLangs && c.stt) bits.push('STT languages: ' + t(c.sttLangs) + '.')
      if (a.regions && a.regions.length) bits.push('Regions (EU first): ' + a.regions.map((r) => (r.eu ? '**' + r.id + '**' : r.id)).join(', ') + '.')
      if (a.presets && a.presets.length) bits.push('Presets: ' + a.presets.map((p) => p.label || p.id).join(', ') + '.')
      if (SETUP[a.type]) bits.push(SETUP[a.type])
      out.push(bits.join(' '), '')
      if (a.verification) out.push('Verification: ' + a.verification, '')
    }
  }
  return out.join('\n')
}

function replaceBlock(text, name, body) {
  const b = '<!-- ' + name + ':begin -->'
  const e = '<!-- ' + name + ':end -->'
  const i = text.indexOf(b)
  const j = text.indexOf(e)
  if (i < 0 || j < i) throw new Error('README.md has no ' + name + ' markers')
  return text.slice(0, i + b.length) + '\n\n' + body.trim() + '\n\n' + text.slice(j)
}

const readmePath = path.join(root, 'README.md')
const docsPath = path.join(root, 'docs', 'PROVIDERS.md')
const readme = replaceBlock(replaceBlock(fs.readFileSync(readmePath, 'utf8'), 'providers', table()), 'setup', setup())
const docs = '# Providers\n\nGenerated from the adapters by `npm run docs`. See the README for credentials, routing and markers.\n\n## Table\n\n' + table() + '\n## Setup and verification notes\n\n' + setup()

if (process.argv.includes('--write')) {
  fs.writeFileSync(readmePath, readme)
  fs.mkdirSync(path.dirname(docsPath), { recursive: true })
  fs.writeFileSync(docsPath, docs)
  console.log('provider docs written')
} else {
  const stale = fs.readFileSync(readmePath, 'utf8') !== readme || !fs.existsSync(docsPath) || fs.readFileSync(docsPath, 'utf8') !== docs
  if (stale) { console.error('provider docs are stale: run npm run docs'); process.exit(1) }
  console.log('provider docs up to date')
}
