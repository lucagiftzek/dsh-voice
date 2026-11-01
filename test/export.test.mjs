// Phase 3 export: the byte-level joins, the decode path, and exportItem end to end with a fake /tts.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav, mergeWav, parseWav, concatBytes, strategyFor, joinParts, resample, isWavBytes, isMp3Bytes } from '../src/client/export.js'

const wav = (n, rate, v) => encodeWav(new Float32Array(n).fill(v || 0.25), rate || 16000)
const mp3 = (n) => { const b = new Uint8Array(10 + n); b.set([0x49, 0x44, 0x33]); return b }

test('encodeWav writes a valid 16-bit mono PCM header', () => {
  const w = wav(100, 24000)
  assert.ok(isWavBytes(w))
  const p = parseWav(w)
  assert.equal(p.data.length, 200)
  const dv = new DataView(p.fmt.buffer, p.fmt.byteOffset, p.fmt.byteLength)
  assert.equal(dv.getUint16(0, true), 1)
  assert.equal(dv.getUint16(2, true), 1)
  assert.equal(dv.getUint32(4, true), 24000)
  assert.equal(dv.getUint16(14, true), 16)
})

test('mergeWav joins same-format WAVs and refuses different formats', () => {
  const m = mergeWav([wav(100), wav(50)])
  assert.equal(parseWav(m).data.length, 300)
  assert.equal(mergeWav([wav(10, 16000), wav(10, 24000)]), null)
})

test('strategy: mp3 concat, wav merge, decode for mixed or paused input', () => {
  assert.equal(strategyFor([{ bytes: mp3(5) }, { bytes: mp3(5) }], 'mp3'), 'mp3-concat')
  assert.equal(strategyFor([{ bytes: wav(5) }, { bytes: wav(5) }], 'wav'), 'wav-merge')
  assert.equal(strategyFor([{ bytes: wav(5) }, { bytes: mp3(5) }], 'mp3'), 'decode')
  assert.equal(strategyFor([{ bytes: wav(5) }, { bytes: wav(5), pauseBeforeMs: 300 }], 'wav'), 'decode')
  assert.ok(isMp3Bytes(mp3(1)))
  assert.deepEqual(Array.from(concatBytes([Uint8Array.of(1), Uint8Array.of(2, 3)])), [1, 2, 3])
})

test('joinParts decode path: mono mixdown, resampling and pause silence', async () => {
  const decode = async (bytes) => (isWavBytes(bytes)
    ? { sampleRate: 16000, channels: [new Float32Array(1600).fill(0.5)] }
    : { sampleRate: 8000, channels: [new Float32Array(800).fill(1), new Float32Array(800).fill(0)] })
  const out = await joinParts([{ bytes: wav(10) }, { bytes: mp3(10), pauseBeforeMs: 500 }], 'wav', decode)
  assert.equal(out.strategy, 'decode')
  assert.equal(out.ext, 'wav')
  const p = parseWav(out.bytes)
  // 1600 + 8000 silence + 1600 resampled = 11200 samples * 2 bytes
  assert.equal(p.data.length, 11200 * 2)
  const dv = new DataView(p.data.buffer, p.data.byteOffset)
  assert.equal(dv.getInt16(2000 * 2, true), 0, 'pause is silent')
  assert.ok(Math.abs(dv.getInt16(10000 * 2, true) / 0x7fff - 0.5) < 0.01, 'stereo mixed down to mono')
  await assert.rejects(() => joinParts([], 'wav', decode), /nothing to export/)
  await assert.rejects(() => joinParts([{ bytes: wav(5) }, { bytes: mp3(5) }], 'wav'), /cannot decode/)
  assert.equal(resample(new Float32Array([0, 1]), 1, 2).length, 4)
})

// ---------------------------------------------------------------- exportItem end to end
const store = new Map()
const asked = []
before(() => {
  globalThis.window = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    setTimeout, clearTimeout,
  }
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body)
    asked.push({ url, body })
    // MiMo answers WAV, Mistral MP3, as in production
    const bytes = body.provider === 'mimo' || body.lang === 'en' ? wav(160) : mp3(32)
    return { ok: true, status: 200, headers: { get: () => null }, blob: async () => new Blob([bytes]) }
  }
})

const CFG = { engines: {}, routes: { en: { tts: 'mimo' }, el: { tts: 'local' } }, reading: { highlight: 'word' }, detection: { mode: 'heuristic' }, markers: { enabled: true } }

test('exportItem: every segment at normal speed, mixed formats decoded into one WAV', async () => {
  const { exportItem } = await import('../src/client/reader.js')
  store.set('dsh-voice.rate', '2')
  const progress = []
  const decode = async (bytes) => ({ sampleRate: 16000, channels: [new Float32Array(isWavBytes(bytes) ? 160 : 320)] })
  const out = await exportItem({ messageId: 'x', md: 'Hello there, friends. [[pause 250]][[el]]Γεια σας φίλοι.[[/]]', cfg: CFG, engine: 'auto', prefs: {} }, 'mp3', (i, n) => progress.push(i + '/' + n), decode)
  assert.equal(asked.length, 2)
  assert.deepEqual(asked.map((a) => a.body.lang), ['en', 'el'])
  assert.ok(asked.every((a) => a.url === '/api/voice/tts'), 'no alignment, plain synthesis')
  assert.equal(out.strategy, 'decode')
  assert.equal(out.ext, 'wav')
  assert.equal(parseWav(out.bytes).data.length, (160 + 4000 + 320) * 2, 'pause of 250 ms at 16 kHz included')
  assert.deepEqual(progress, ['0/2', '1/2', '2/2'])
})

test('exportItem: the browser voice cannot be exported', async () => {
  const { exportItem } = await import('../src/client/reader.js')
  await assert.rejects(() => exportItem({ messageId: 'y', md: 'Hello there.', cfg: Object.assign({}, CFG, { routes: { en: { tts: 'browser' } } }), engine: 'auto', prefs: {} }, 'wav'), /browser voice cannot be exported/)
})

test('exportItem: provider override and voice reach every request', async () => {
  const { exportItem } = await import('../src/client/reader.js')
  asked.length = 0
  await exportItem({ messageId: 'z', md: 'One sentence here. Another one there.', cfg: CFG, engine: 'mimo', voice: 'Mia', prefs: {} }, 'wav', null, async () => ({ sampleRate: 16000, channels: [new Float32Array(10)] }))
  assert.ok(asked.length >= 1)
  assert.ok(asked.every((a) => a.body.provider === 'mimo' && a.body.voice === 'Mia'))
})
