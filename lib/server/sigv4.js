/**
 * dsh-voice: AWS Signature Version 4, hand written on node:crypto (no SDK).
 * Used by the Amazon adapter (Polly, Transcribe). Two forms:
 *
 *   signRequest(...)  header signing: returns the headers to send
 *   presignUrl(...)   query signing: returns a URL (Transcribe streaming
 *                     WebSocket, which cannot carry an Authorization header)
 *
 * Credentials are a plain object { accessKeyId, secretAccessKey, sessionToken? }.
 * Reference: docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-create-signed-request.html
 */
import crypto from 'node:crypto'

const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex')
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest()

/** RFC 3986 encode, as SigV4 wants it (everything but A-Z a-z 0-9 - _ . ~). */
export function uriEncode(s, keepSlash) {
  const e = encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return keepSlash ? e.replace(/%2F/g, '/') : e
}

export function amzDate(now) {
  return (now ? new Date(now) : new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '')
}

export function signingKey(secret, date8, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date8), region), service), 'aws4_request')
}

function canonicalQuery(url, extra) {
  const pairs = []
  url.searchParams.forEach((v, k) => pairs.push([uriEncode(k), uriEncode(v)]))
  for (const [k, v] of Object.entries(extra || {})) pairs.push([uriEncode(k), uriEncode(v)])
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return pairs.map((p) => p[0] + '=' + p[1]).join('&')
}

/**
 * Sign a request with headers. opts: { method, url, headers, body (Buffer|string),
 * region, service, credentials, now (ms|Date), payloadHash (override, e.g.
 * 'UNSIGNED-PAYLOAD'), includeContentSha (add x-amz-content-sha256, S3 style) }.
 * Returns a NEW headers object (lower-case names) with host, x-amz-date,
 * authorization (and x-amz-security-token when the credential has a session token).
 */
export function signRequest(opts) {
  const o = opts
  const url = o.url instanceof URL ? o.url : new URL(String(o.url))
  const amz = amzDate(o.now)
  const date8 = amz.slice(0, 8)
  const body = o.body === undefined ? '' : o.body
  const payloadHash = o.payloadHash || sha256hex(body)
  const headers = {}
  for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ')
  headers.host = url.host
  headers['x-amz-date'] = amz
  if (o.credentials.sessionToken) headers['x-amz-security-token'] = o.credentials.sessionToken
  if (o.includeContentSha) headers['x-amz-content-sha256'] = payloadHash
  const names = Object.keys(headers).sort()
  const canonHeaders = names.map((n) => n + ':' + headers[n] + '\n').join('')
  const signed = names.join(';')
  const path = url.pathname.split('/').map((seg) => uriEncode(decodeURIComponent(seg))).join('/') || '/'
  const canonical = [String(o.method || 'GET').toUpperCase(), path, canonicalQuery(url), canonHeaders, signed, payloadHash].join('\n')
  const scope = date8 + '/' + o.region + '/' + o.service + '/aws4_request'
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(canonical)].join('\n')
  const sig = crypto.createHmac('sha256', signingKey(o.credentials.secretAccessKey, date8, o.region, o.service)).update(toSign).digest('hex')
  headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + o.credentials.accessKeyId + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + sig
  return headers
}

/**
 * Query-signed URL. opts: { method, url, region, service, credentials, now, expires (s, default 300), query (extra params) }.
 * Returns the URL string with X-Amz-* parameters and X-Amz-Signature last.
 */
export function presignUrl(opts) {
  const o = opts
  const url = o.url instanceof URL ? new URL(o.url.href) : new URL(String(o.url))
  const amz = amzDate(o.now)
  const date8 = amz.slice(0, 8)
  const scope = date8 + '/' + o.region + '/' + o.service + '/aws4_request'
  const extra = Object.assign({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': o.credentials.accessKeyId + '/' + scope,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(o.expires || 300),
    'X-Amz-SignedHeaders': 'host',
  }, o.query || {})
  if (o.credentials.sessionToken) extra['X-Amz-Security-Token'] = o.credentials.sessionToken
  const path = url.pathname.split('/').map((seg) => uriEncode(decodeURIComponent(seg))).join('/') || '/'
  const query = canonicalQuery(url, extra)
  const canonical = [String(o.method || 'GET').toUpperCase(), path, query, 'host:' + url.host + '\n', 'host', o.payloadHash || sha256hex('')].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(canonical)].join('\n')
  const sig = crypto.createHmac('sha256', signingKey(o.credentials.secretAccessKey, date8, o.region, o.service)).update(toSign).digest('hex')
  return url.protocol + '//' + url.host + path + '?' + query + '&X-Amz-Signature=' + sig
}

/**
 * Parse a credential string into { accessKeyId, secretAccessKey, sessionToken }.
 * Accepted forms (the resolved value of an env:/file:/vault: pointer):
 *   AKIA...:secret            access key id and secret separated by a colon
 *   AKIA...:secret:token      plus a session token
 *   {"accessKeyId":...}       JSON with accessKeyId/secretAccessKey/sessionToken (or AWS_* names)
 * Returns null when it does not parse. Never logs.
 */
export function parseAwsCredential(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (s[0] === '{') {
    try {
      const j = JSON.parse(s)
      const a = j.accessKeyId || j.AccessKeyId || j.AWS_ACCESS_KEY_ID
      const b = j.secretAccessKey || j.SecretAccessKey || j.AWS_SECRET_ACCESS_KEY
      if (a && b) return { accessKeyId: String(a), secretAccessKey: String(b), sessionToken: String(j.sessionToken || j.SessionToken || j.AWS_SESSION_TOKEN || '') }
    } catch (e) { /* not json */ }
    return null
  }
  const p = s.split(':')
  if (p.length >= 2 && p[0] && p[1]) return { accessKeyId: p[0], secretAccessKey: p[1], sessionToken: p.slice(2).join(':') }
  return null
}
