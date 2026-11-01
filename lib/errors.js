/**
 * dsh-voice: the stable error catalog (standard: docs/ERRORS.md).
 *
 * Every HTTP error body is { ok:false, error, code, message, hint, docs }. `error` keeps
 * the 1.x string (a vendor or gate sentence) and the HTTP status is unchanged. A body that
 * used to carry a short lower-case `code` (rate_limited, browser_only, cross_site, or a
 * vendor code such as bad_key) now has it in `legacyCode`.
 * Codes are an API: add, never rename.
 */
import { defineErrors } from './plugin-errors.js'
import { scrub } from './server/http.js'

/** Gate and vendor sentences are short; keep them whole (scrub still masks key-shaped runs). */
const scrubText = (s) => scrub(s, 400)

export const E = defineErrors('VOICE', {
  VOICE_INTERNAL: { status: 500, message: 'Unexpected exception inside a route',
    hint: 'Collect the log line that starts with the code and the request that caused it; report a bug. Retry once.' },
  VOICE_BAD_REQUEST: { status: 400, message: 'The request body is not valid JSON, is empty, or lacks the audio part',
    hint: 'Send a JSON body (`text`, `provider`, `lang`) or a multipart upload with a `file` part.' },
  VOICE_BODY_TOO_LARGE: { status: 413, message: 'The body is larger than the route accepts (25 MB for audio, smaller for JSON)',
    hint: 'Send a shorter recording or text.' },
  VOICE_RATE_LIMITED: { status: 429, message: 'The per-minute limit of `security.rateLimit` was reached',
    hint: 'Wait a minute, or raise the limit in Settings if the burst is legitimate. Check that auto-read is not looping.' },
  VOICE_CROSS_SITE: { status: 403, message: 'A browser request from another site (or with a foreign Origin) was refused, so no credit is spent',
    hint: 'Call the route from the DSH page itself, or from a script that sends no Origin header.' },
  VOICE_UNTRUSTED_REQUEST: { status: 403, message: 'The peer is not loopback, or Origin differs from Host, or the request is cross-site',
    hint: 'Reach DSH through its normal loopback proxy with the same Host and Origin.' },
  VOICE_READ_REFUSED: { status: 403, message: 'A gated read route refused the request (method, non-loopback peer, or Host not trusted)',
    hint: 'Add the public host name to `security.trustedHosts`, and make sure the proxy connects from loopback.' },
  VOICE_WRITE_REFUSED: { status: 403, message: 'The mutating gate refused the request',
    hint: 'Reload the tab (L3), fix `security.trustedHosts` (L2), make the proxy pass cookies (L4).' },
  VOICE_SESSION_NOT_READY: { status: 503, message: 'The per-install secret is not loaded yet (the plugin just started or the data directory is not writable)',
    hint: 'Retry after a few seconds; if it persists check the data directory (doctor check `data-dir`).' },
  VOICE_PROVIDER_UNKNOWN: { status: 404, message: 'The provider id in the request is not an instance',
    hint: 'List ids with `GET /api/voice/config` (`providers[].id`) and retry with one of them.' },
  VOICE_PROVIDER_UNAVAILABLE: { status: 503, message: 'The chosen provider cannot be used right now: not configured, key missing, disabled, wrong direction (speech only or transcription only), or no speech to text engine at all',
    hint: 'Configure the provider or key named in `message`, enable it, or choose another provider.' },
  VOICE_BROWSER_ONLY: { status: 400, message: 'The browser voice is synthesised in the page, never on the server',
    hint: 'Let the page speak it (the player does this); do not call `/tts` with `provider: browser`.' },
  VOICE_PROVIDER_ENTRY_REJECTED: { status: 400, message: 'A provider entry in the patch was refused: unknown type, a URL that is internal, has credentials, or is not https for a cloud provider, or a key pointer to another provider',
    hint: 'Correct the entry named in `message`: https and a public host for cloud types, a self-hosted type for a local server.' },
  VOICE_PROVIDER_AUTH: { status: 502, message: 'The provider rejected the key (legacy code `bad_key`)',
    hint: 'Renew or correct the key; use the Test button of the provider row to confirm.' },
  VOICE_PROVIDER_QUOTA: { status: 429, message: 'The provider has no credits or quota left, or throttled the call (legacy code `quota_exceeded`)',
    hint: 'Add credits, wait for the quota reset, or route the language to another provider.' },
  VOICE_PROVIDER_VOICE: { status: 400, message: 'The voice or model asked for does not exist at the provider (legacy code `bad_voice`)',
    hint: 'Pick a voice from the provider row list (`GET /api/voice/voices?provider=<id>`) or clear the voice field.' },
  VOICE_PROVIDER_LANGUAGE: { status: 400, message: 'The provider does not cover the language (legacy code `unsupported_lang`)',
    hint: 'Route that language to a provider that lists it, or enable the browser voice as fallback.' },
  VOICE_PROVIDER_TIMEOUT: { status: 504, message: 'The provider or self-hosted engine did not answer in time (legacy code `timeout`)',
    hint: 'Retry; check the engine is up and fast enough (doctor check `engines`); use a shorter text.' },
  VOICE_PROVIDER_FAILED: { status: 502, message: 'The provider returned an error or an unusable answer (legacy code `vendor`), or the transport failed',
    hint: 'Read `message`; test the provider row; check the model is not retired; try another provider.' },
  VOICE_ROUTE_NOT_FOUND: { status: 404, message: 'No such voice route',
    hint: 'Check the path against the README (HTTP routes); on all 404 see C2.' },
  VOICE_METHOD_NOT_ALLOWED: { status: 405, message: 'The route needs POST',
    hint: 'Use POST with a JSON or multipart body.' },
  VOICE_SETTINGS_NOT_WIRED: { status: 500, message: 'No DSH settings service is wired (settings mode `config`): values live only in the plugin settings file',
    hint: 'Use a plugin version for your DSH line; check the plugin declares the settings service (C3).' },
  VOICE_CONFIG_NOT_VISIBLE: { status: 500, message: 'The exported `Config` schema is not available, so DSH 0.2.x cannot render settings forms',
    hint: 'Check that the harness install provides its schema library (C3 b); update the plugin or the harness.' },
  VOICE_NO_PROVIDER: { status: 500, message: 'No provider can speak (or none can transcribe); only the browser voice is left',
    hint: 'Configure at least one provider in Settings > Voice and press Test.' },
  VOICE_ROUTE_UNRESOLVED: { status: 500, message: 'A language row names a provider that is not available, so reading falls through to the next provider or the browser voice',
    hint: 'Fix the key of that provider, or change the row or its fallback list.' },
  VOICE_TRUSTED_HOSTS_UNSET: { status: 500, message: '`security.trustedHosts` is empty although the request came through a proxy host name',
    hint: 'Add the public host name to `security.trustedHosts`.' },
  VOICE_FILE_MODE: { status: 500, message: 'A secret file (`vault.json`, `capability.secret`) is readable by other users',
    hint: 'Run `chmod 600` on the file and `chmod 700` on its directory.' },
  VOICE_DATA_DIR_UNWRITABLE: { status: 500, message: 'The plugin data directory is missing or not writable, so keys, the secret and the file settings cannot be saved',
    hint: 'Create it, or fix the owner and mode; `DSH_VOICE_DATA_DIR` moves it.' },
  VOICE_ENGINE_UNREACHABLE: { status: 500, message: 'A self-hosted or loopback engine did not answer a plain GET within 2 seconds',
    hint: 'Start the engine, fix the base URL or the interface it binds to (loopback vs LAN).' },
  VOICE_CLIENT_BUNDLE_MISSING: { status: 500, message: 'The browser bundle `lib/client.js` is missing or empty, so no speaker or microphone appears',
    hint: 'Reinstall the plugin; from a source checkout run `npm run build`.' },
}, { scrub: scrubText })

/** Vendor and adapter failures carry a lower-case `code` (http.js voiceErr); map it to a catalog code. */
const VENDOR = {
  bad_key: 'VOICE_PROVIDER_AUTH',
  quota_exceeded: 'VOICE_PROVIDER_QUOTA',
  bad_voice: 'VOICE_PROVIDER_VOICE',
  unsupported_lang: 'VOICE_PROVIDER_LANGUAGE',
  timeout: 'VOICE_PROVIDER_TIMEOUT',
  browser_only: 'VOICE_BROWSER_ONLY',
  too_large: 'VOICE_BODY_TOO_LARGE',
  disabled: 'VOICE_PROVIDER_UNAVAILABLE',
}

/** Catalog code for a caught error: a known VOICE_ code, a mapped legacy vendor code, else `fallback`. */
export function codeFor(err, fallback = 'VOICE_PROVIDER_FAILED') {
  const c = err && typeof err.code === 'string' ? err.code : ''
  if (E.has(c)) return c
  return VENDOR[c] || fallback
}

/**
 * Send a caught failure as the standard body. `error` stays the original message, the
 * status stays `err.status || fallbackStatus`, a legacy code goes to `legacyCode`.
 */
export function sendFailure(res, err, fallbackStatus, extra, fallbackCode) {
  const code = codeFor(err, fallbackCode)
  const legacy = err && typeof err.code === 'string' && !E.has(err.code) ? err.code : undefined
  const message = String((err && err.message) || err || 'failed')
  const body = Object.assign({ message }, extra || {})
  if (legacy) body.legacyCode = legacy
  const status = (err && err.status) || fallbackStatus || E.status(code)
  return E.send(res, code, Object.assign(body, { status }))
}
