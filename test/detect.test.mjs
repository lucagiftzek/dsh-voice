// Phase 2 detection: the Latin scorer, the model pass (batching, cache, timeout, degradation) and /detect.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latinScore, normaliseSentence, hasLatinRun } from '../lib/shared/lang/heuristics.js'
import { buildSegments, splitBySpans } from '../lib/shared/lang/segment.js'
import { detectSegments, createDetectCache, parseAnswer, askModel } from '../lib/server/detect.js'
import { normalise } from '../lib/server/settings.js'
import { createHandler } from '../lib/server/routes.js'
import { createSettingsStore } from '../lib/server/settings-store.js'

const EN = [
  'The quick brown fox jumps over the lazy dog.',
  'I think this is the right way to do it.',
  'Please restart the server when you have a moment.',
  'We should check the logs before the next deploy.',
  'It is working now, thanks for the help.',
  'What time does the meeting start tomorrow?',
  'They have already sent the invoice to the client.',
  'You can find the report in the shared folder.',
]
const IT = [
  'Questa è la soluzione che cercavamo da tempo.',
  'Il server è pronto per il deploy di stasera.',
  'La configurazione del database non funziona ancora.',
  'Non lo so, forse domani sarà più chiaro.',
  'Ho già mandato la fattura al cliente ieri sera.',
  "Puoi trovare il rapporto nella cartella condivisa.",
  "C'è un problema con l'aggiornamento della pagina.",
  'Grazie mille per il tuo aiuto, sei stato gentile.',
]
const EL = ['Καλημέρα σας, τι κάνετε σήμερα;', 'Ο διακομιστής είναι έτοιμος.', 'Ευχαριστώ πολύ για τη βοήθεια.']

test('scorer: English sentences', () => {
  for (const s of EN) assert.equal(latinScore(s, ['en', 'it', 'el']).lang, 'en', s)
})

test('scorer: Italian sentences', () => {
  for (const s of IT) assert.equal(latinScore(s, ['en', 'it', 'el']).lang, 'it', s)
})

test('scorer: confidence grows with evidence; short lines stay unsure', () => {
  const long = latinScore('I think this is the right way to do it.', ['en', 'it'])
  const short = latinScore('It works.', ['en', 'it'])
  assert.ok(long.conf > 0.9)
  assert.ok(short.conf < 0.75, 'a two-word line must not claim certainty')
  assert.equal(latinScore('Ok.', ['en', 'it']), null)
  assert.equal(latinScore('Ciao!', ['en', 'it']).lang, 'it')
})

test('scorer: fr/de/es compete only when enabled', () => {
  const fr = 'Nous avons déjà envoyé la facture au client.'
  assert.equal(latinScore(fr, ['en', 'it', 'fr']).lang, 'fr')
  assert.notEqual(latinScore(fr, ['en', 'it']).lang, 'fr')
  assert.equal(latinScore('Wir haben die Rechnung schon geschickt, danke.', ['en', 'it', 'de']).lang, 'de')
  assert.equal(latinScore('Ya hemos enviado la factura, gracias por todo.', ['en', 'it', 'es']).lang, 'es')
})

test('segments: en/it/el single-language messages', () => {
  for (const s of EN) assert.deepEqual(buildSegments(s).segments.map((x) => x.lang), ['en'], s)
  for (const s of IT) assert.deepEqual(buildSegments(s).segments.map((x) => x.lang), ['it'], s)
  for (const s of EL) assert.deepEqual(buildSegments(s).segments.map((x) => x.lang), ['el'], s)
})

test('segments: mixed lines split per language, short lines follow neighbours', () => {
  const md = 'We should check the logs before the next deploy. Il server è pronto per il deploy di stasera. Ok. Ο διακομιστής είναι έτοιμος. Yes.'
  assert.deepEqual(buildSegments(md).segments.map((x) => x.lang), ['en', 'it', 'el'])
})

test('segments: an English technical word inside an Italian sentence stays Italian', () => {
  assert.deepEqual(buildSegments('Ho fatto il deploy del backend con Docker ieri sera.').segments.map((x) => x.lang), ['it'])
})

test('uncertain list: unsure sentences and Greek with a Latin run, never markers', () => {
  const b = buildSegments('It is fine now. Ο server τρέχει το new release build σήμερα. [[it]]forse si forse no[[/]]')
  assert.ok(b.uncertain.some((t) => /Ο server/.test(t)))
  assert.ok(!b.uncertain.some((t) => /forse/.test(t)))
  assert.ok(hasLatinRun('Ο server τρέχει το new release build σήμερα.'))
})

test('resolver beats heuristics but never a marker; spans split a sentence', () => {
  const b = buildSegments('This sentence is quite clearly English. [[el]]Γεια[[/]]', { resolve: (s) => (/English/.test(s) ? { lang: 'it' } : null) })
  assert.deepEqual(b.segments.map((x) => [x.lang, x.source]), [['it', 'model'], ['el', 'marker']])
  const parts = splitBySpans(' Say buongiorno to all. ', 'en', [{ from: 4, to: 14, lang: 'it' }])
  assert.deepEqual(parts.map((p) => [p.lang, p.text]), [['en', ' Say '], ['it', 'buongiorno'], ['en', ' to all. ']])
})

test('parseAnswer tolerates fences and prose around the array', () => {
  assert.deepEqual(parseAnswer('```json\n[{"i":0,"lang":"it"}]\n```'), [{ i: 0, lang: 'it' }])
  assert.deepEqual(parseAnswer('Sure: [{"i":1,"lang":"el"}] done'), [{ i: 1, lang: 'el' }])
  assert.equal(parseAnswer('no json here'), null)
})

function fakeLlm(answer, opts) {
  const o = opts || {}
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs))
      if (o.throws) throw new Error('model down')
      const text = typeof answer === 'function' ? answer(JSON.parse(options.messages[0].content[0].text)) : answer
      for (const piece of [text.slice(0, 5), text.slice(5)]) yield { type: 'text-delta', index: 0, text: piece }
      yield { type: 'finish', finish: { kind: 'stop' } }
    },
  }
}

const SETTINGS = () => normalise({})
const UNSURE = 'It works. Yes it does. Ο server τρέχει το new release build σήμερα. Non so davvero.'

test('model pass: ONE batched call for every unsure sentence, answers applied', async () => {
  const llm = fakeLlm((items) => JSON.stringify(items.map((x) => ({ i: x.i, lang: /server/.test(x.text) ? 'el' : 'en' }))))
  const cache = createDetectCache()
  const out = await detectSegments(UNSURE, { settings: SETTINGS(), llm, cache })
  assert.equal(llm.calls.length, 1)
  const items = JSON.parse(llm.calls[0].messages[0].content[0].text)
  assert.ok(items.length >= 2)
  assert.equal(llm.calls[0].provider, 'mistral')
  assert.equal(llm.calls[0].model, 'mistral-small-latest')
  assert.equal(llm.calls[0].temperature, 0)
  assert.equal(llm.calls[0].messages[0].source.kind, 'plugin:dsh-voice')
  assert.ok(out.model.used)
  assert.ok(out.segments.some((s) => s.source === 'model'))
  // Second time: from the cache, no call.
  const again = await detectSegments(UNSURE, { settings: SETTINGS(), llm, cache })
  assert.equal(llm.calls.length, 1)
  assert.ok(again.model.cached >= items.length)
  assert.equal(again.model.used, false)
})

test('cache keys are sentence hashes (no text stored), LRU and TTL', () => {
  let t = 0
  const c = createDetectCache({ max: 2, ttlMs: 1000, now: () => t })
  c.set('Hello  World.', { lang: 'en' })
  assert.deepEqual(c.get('hello world'), { lang: 'en' })
  assert.ok(c.keys().every((k) => /^[0-9a-f]{64}$/.test(k)))
  c.set('b', { lang: 'it' }); c.set('c', { lang: 'el' })
  assert.equal(c.size, 2)
  t = 5000
  assert.equal(c.get('c'), null)
  assert.equal(normaliseSentence('  "Hello,  World!" '), 'hello, world')
})

test('model timeout, a thrown error or invalid JSON leave the heuristic result', async () => {
  const s = SETTINGS()
  s.detection.timeoutMs = 50
  const slow = fakeLlm('[{"i":0,"lang":"it"}]', { delayMs: 300 })
  const t0 = Date.now()
  const a = await detectSegments(UNSURE, { settings: s, llm: slow, cache: createDetectCache() })
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(a.model.used, false)
  assert.ok(a.segments.every((x) => x.source !== 'model'))
  const bad = await detectSegments(UNSURE, { settings: SETTINGS(), llm: fakeLlm('I cannot tell'), cache: createDetectCache() })
  assert.equal(bad.model.used, false)
  const thrown = await detectSegments(UNSURE, { settings: SETTINGS(), llm: fakeLlm('', { throws: true }), cache: createDetectCache() })
  assert.equal(thrown.model.used, false)
})

test('fallback model is tried when the first answers nothing', async () => {
  let n = 0
  const llm = { calls: [], async *stream(o) { n += 1; this.calls.push(o); yield { type: 'text-delta', text: n === 1 ? 'nope' : '[{"i":0,"lang":"en"}]' } } }
  const out = await detectSegments(UNSURE, { settings: SETTINGS(), llm, cache: createDetectCache() })
  assert.equal(llm.calls.length, 2)
  assert.equal(llm.calls[1].provider, 'deepseek-official')
  assert.equal(out.model.provider, 'deepseek-official')
})

test('no model service, heuristic mode, or nothing unsure: no call', async () => {
  const none = await detectSegments(UNSURE, { settings: SETTINGS(), llm: null, cache: createDetectCache() })
  assert.equal(none.model.used, false)
  const llm = fakeLlm('[]')
  const s = SETTINGS(); s.detection.mode = 'heuristic'
  await detectSegments(UNSURE, { settings: s, llm, cache: createDetectCache() })
  await detectSegments('We should check the logs before the next deploy.', { settings: SETTINGS(), llm, cache: createDetectCache() })
  assert.equal(llm.calls.length, 0)
  assert.equal((await askModel(llm, [], { model: { provider: 'x', model: 'y' }, enabled: ['en'] })).size, 0)
})

test('model spans and other:<code> answers are cleaned', async () => {
  const llm = fakeLlm((items) => JSON.stringify(items.map((x) => ({ i: x.i, lang: 'other:fr', spans: [{ from: 0, to: 2, lang: 'IT' }, { from: 5, to: 9999, lang: 'en' }] }))))
  const ans = await askModel(llm, [{ i: 0, text: 'Hello there' }], { model: { provider: 'p', model: 'm' }, enabled: ['en', 'it'] })
  assert.deepEqual(ans.get(0), { lang: 'fr', spans: [{ from: 0, to: 2, lang: 'it' }] })
})

test('/detect route uses the model service and degrades without it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshv-detect-'))
  const llm = fakeLlm((items) => JSON.stringify(items.map((x) => ({ i: x.i, lang: 'en' }))))
  let llmOn = true
  const h = createHandler({ store: createSettingsStore({ dataDir: dir }), env: { DSH_VOICE_LFM3_PORT: '9', DSH_VOICE_OLLAMA_PORT: '9', DSH_VOICE_TTS_PORT: '9' }, home: dir, secret: () => 'x'.repeat(40), llm: () => (llmOn ? llm : null) })
  const srv = http.createServer(h)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const post = (body, headers) => fetch('http://127.0.0.1:' + port + '/api/voice/detect', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(body) })
  try {
    let j = await (await post({ text: UNSURE })).json()
    assert.equal(j.ok, true)
    assert.equal(j.llm, true)
    assert.equal(j.model.used, true)
    llmOn = false
    j = await (await post({ text: 'Another short one. Fine.', mode: 'heuristic+model' })).json()
    assert.equal(j.llm, false)
    assert.ok(Array.isArray(j.segments))
    const cross = await post({ text: 'x' }, { origin: 'https://evil.example' })
    assert.equal(cross.status, 403)
  } finally { srv.close() }
})
