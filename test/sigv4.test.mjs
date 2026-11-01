import test from 'node:test'
import assert from 'node:assert/strict'
import { signRequest, presignUrl, parseAwsCredential, uriEncode } from '../lib/server/sigv4.js'

// The public AWS documentation example credentials (not real).
const CRED = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }
const NOW = Date.parse('2015-08-30T12:36:00Z')

test('sigv4: AWS test-suite vector get-vanilla', () => {
  const h = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/', region: 'us-east-1', service: 'service', credentials: CRED, now: NOW })
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
  assert.equal(h['x-amz-date'], '20150830T123600Z')
})

test('sigv4: session token is signed, query is sorted, payload hash changes the signature', () => {
  const a = signRequest({ method: 'POST', url: 'https://polly.eu-west-1.amazonaws.com/v1/speech?b=2&a=1', body: '{"x":1}', region: 'eu-west-1', service: 'polly', credentials: Object.assign({ sessionToken: 'tok' }, CRED), now: NOW })
  const b = signRequest({ method: 'POST', url: 'https://polly.eu-west-1.amazonaws.com/v1/speech?a=1&b=2', body: '{"x":2}', region: 'eu-west-1', service: 'polly', credentials: Object.assign({ sessionToken: 'tok' }, CRED), now: NOW })
  assert.match(a.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token/)
  assert.equal(a['x-amz-security-token'], 'tok')
  assert.notEqual(a.authorization, b.authorization)
})

test('sigv4: presigned url carries the X-Amz parameters and a hex signature last', () => {
  const u = presignUrl({ method: 'GET', url: 'wss://transcribestreaming.eu-west-1.amazonaws.com:8443/stream-transcription-websocket?language-code=en-US', region: 'eu-west-1', service: 'transcribe', credentials: CRED, now: NOW, expires: 60 })
  assert.match(u, /^wss:\/\/transcribestreaming\.eu-west-1\.amazonaws\.com:8443\/stream-transcription-websocket\?/)
  assert.match(u, /X-Amz-Expires=60/)
  assert.match(u, /X-Amz-SignedHeaders=host/)
  assert.match(u, /&X-Amz-Signature=[0-9a-f]{64}$/)
})

test('sigv4: uriEncode and credential parsing', () => {
  assert.equal(uriEncode("a b/c!'()*"), 'a%20b%2Fc%21%27%28%29%2A')
  assert.equal(uriEncode('a/b', true), 'a/b')
  assert.deepEqual(parseAwsCredential('AKIA1:sec1'), { accessKeyId: 'AKIA1', secretAccessKey: 'sec1', sessionToken: '' })
  assert.equal(parseAwsCredential('AKIA1:sec1:tok:en').sessionToken, 'tok:en')
  assert.deepEqual(parseAwsCredential('{"AWS_ACCESS_KEY_ID":"a","AWS_SECRET_ACCESS_KEY":"b"}'), { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: '' })
  assert.equal(parseAwsCredential('garbage'), null)
  assert.equal(parseAwsCredential(''), null)
})
