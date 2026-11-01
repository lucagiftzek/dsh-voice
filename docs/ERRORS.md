# Error codes: dsh-voice

Every HTTP error body has this shape (agent tool results would use the same one; this plugin
registers no agent tools):

```json
{ "ok": false, "error": "<legacy short string or message>", "code": "VOICE_PROVIDER_AUTH",
  "message": "...", "hint": "...", "docs": "docs/ERRORS.md#voice_provider_auth" }
```

Compatibility: the HTTP status and the `error` string are what 1.x clients read and they are
unchanged. Where a body used to carry a short lower-case `code` (`rate_limited`, `browser_only`,
`cross_site`, or a vendor code such as `bad_key`), that string is now in `legacyCode`, and the
response header `x-voice-error-code` keeps carrying it. `code` is always one of the codes below.
Success responses are unchanged.

Log lines start with the code, so `grep VOICE_PROVIDER_AUTH` finds them.
Codes marked "doctor check" appear only in `GET /api/voice/doctor`.

| Code | HTTP | Where it appears | Meaning | Agent action |
|---|---|---|---|---|
| VOICE_INTERNAL | 500 | any route, log | Unexpected exception inside a route. | Collect the log line that starts with the code and the request that caused it; report a bug. Retry once. ([details](#voice_internal)) |
| VOICE_BAD_REQUEST | 400 | route POST /api/voice/tts, /stt, /polish, PATCH /api/voice/settings | The request body is not valid JSON, is empty, or lacks the audio part. | Send a JSON body (`text`, `provider`, `lang`) or a multipart upload with a `file` part. ([details](#voice_bad_request)) |
| VOICE_BODY_TOO_LARGE | 413 | route POST /api/voice/stt, /tts | The body is larger than the route accepts (25 MB for audio, smaller for JSON). | Send a shorter recording or text. ([details](#voice_body_too_large)) |
| VOICE_RATE_LIMITED | 429 | route POST /tts, /stt, /polish, /detect | The per-minute limit of `security.rateLimit` was reached. | Wait a minute, or raise the limit in Settings if the burst is legitimate. Check that auto-read is not looping. ([details](#voice_rate_limited)) |
| VOICE_CROSS_SITE | 403 | route POST /tts, /stt, /polish | A browser request from another site (or with a foreign Origin) was refused, so no credit is spent. | Call the route from the DSH page itself, or from a script that sends no Origin header. ([details](#voice_cross_site)) |
| VOICE_UNTRUSTED_REQUEST | 403 | route POST /detect | The peer is not loopback, or Origin differs from Host, or the request is cross-site. | Reach DSH through its normal loopback proxy with the same Host and Origin. ([details](#voice_untrusted_request)) |
| VOICE_READ_REFUSED | 403 | route GET /session, /settings, /voices, /models, /doctor | A gated read route refused the request (method, non-loopback peer, or Host not trusted). The reason is in `message`. | Add the public host name to `security.trustedHosts`, and make sure the proxy connects from loopback. ([details](#voice_read_refused)) |
| VOICE_WRITE_REFUSED | 403 | route PATCH or POST /settings, POST /test | The mutating gate refused the request. `layer` says which: L0 method, L1 loopback peer, L2 Host, Origin, Fetch metadata or content type, L3 capability token, L4 harness session cookie. | Reload the tab (L3), fix `security.trustedHosts` (L2), make the proxy pass cookies (L4). ([details](#voice_write_refused)) |
| VOICE_SESSION_NOT_READY | 503 | route GET /session | The per-install secret is not loaded yet (the plugin just started or the data directory is not writable). | Retry after a few seconds; if it persists check the data directory (doctor check `data-dir`). ([details](#voice_session_not_ready)) |
| VOICE_PROVIDER_UNKNOWN | 404 | route GET /voices, POST /test | The provider id in the request is not an instance. | List ids with `GET /api/voice/config` (`providers[].id`) and retry with one of them. ([details](#voice_provider_unknown)) |
| VOICE_PROVIDER_UNAVAILABLE | 503 | route POST /tts, /stt | The chosen provider cannot be used right now: not configured, key missing, disabled, wrong direction (speech only or transcription only), or no speech to text engine at all. The legacy sentence is in `error`. | Configure the provider or key named in `message`, enable it, or choose another provider. ([details](#voice_provider_unavailable)) |
| VOICE_BROWSER_ONLY | 400 | route POST /tts | The browser voice is synthesised in the page, never on the server. | Let the page speak it (the player does this); do not call `/tts` with `provider: browser`. ([details](#voice_browser_only)) |
| VOICE_PROVIDER_ENTRY_REJECTED | 400 | route PATCH or POST /settings | A provider entry in the patch was refused: unknown type, a URL that is internal, has credentials, or is not https for a cloud provider, or a key pointer to another provider. | Correct the entry named in `message`: https and a public host for cloud types, a self-hosted type for a local server. ([details](#voice_provider_entry_rejected)) |
| VOICE_PROVIDER_AUTH | 502 | route POST /tts, /stt | The provider rejected the key (legacy code `bad_key`). | Renew or correct the key; use the Test button of the provider row to confirm. ([details](#voice_provider_auth)) |
| VOICE_PROVIDER_QUOTA | 429 | route POST /tts, /stt | The provider has no credits or quota left, or throttled the call (legacy code `quota_exceeded`). | Add credits, wait for the quota reset, or route the language to another provider. ([details](#voice_provider_quota)) |
| VOICE_PROVIDER_VOICE | 400 | route POST /tts | The voice or model asked for does not exist at the provider (legacy code `bad_voice`). | Pick a voice from the provider row list (`GET /api/voice/voices?provider=<id>`) or clear the voice field. ([details](#voice_provider_voice)) |
| VOICE_PROVIDER_LANGUAGE | 400 | route POST /tts, /stt | The provider does not cover the language (legacy code `unsupported_lang`). | Route that language to a provider that lists it, or enable the browser voice as fallback. ([details](#voice_provider_language)) |
| VOICE_PROVIDER_TIMEOUT | 504 | route POST /tts, /stt | The provider or self-hosted engine did not answer in time (legacy code `timeout`). | Retry; check the engine is up and fast enough (doctor check `engines`); use a shorter text. ([details](#voice_provider_timeout)) |
| VOICE_PROVIDER_FAILED | 502 | route POST /tts, /stt | The provider returned an error or an unusable answer (legacy code `vendor`), or the transport failed. `message` carries the scrubbed vendor text. | Read `message`; test the provider row; check the model is not retired; try another provider. ([details](#voice_provider_failed)) |
| VOICE_ROUTE_NOT_FOUND | 404 | route any unknown path under /api/voice | No such voice route. | Check the path against the README (HTTP routes); on all 404 see C2. ([details](#voice_route_not_found)) |
| VOICE_METHOD_NOT_ALLOWED | 405 | route /tts, /stt, /polish and unknown paths | The route needs POST. | Use POST with a JSON or multipart body. ([details](#voice_method_not_allowed)) |
| VOICE_SETTINGS_NOT_WIRED | n/a | doctor check `settings` | No DSH settings service is wired (settings mode `config`): values live only in the plugin settings file. | Use a plugin version for your DSH line; check the plugin declares the settings service (C3). ([details](#voice_settings_not_wired)) |
| VOICE_CONFIG_NOT_VISIBLE | n/a | doctor check `config` | The exported `Config` schema is not available, so DSH 0.2.x cannot render settings forms. | Check that the harness install provides its schema library (C3 b); update the plugin or the harness. ([details](#voice_config_not_visible)) |
| VOICE_NO_PROVIDER | n/a | doctor check `providers` | No provider can speak (or none can transcribe); only the browser voice is left. | Configure at least one provider in Settings > Voice and press Test. ([details](#voice_no_provider)) |
| VOICE_ROUTE_UNRESOLVED | n/a | doctor check `routing` | A language row names a provider that is not available, so reading falls through to the next provider or the browser voice. | Fix the key of that provider, or change the row or its fallback list. ([details](#voice_route_unresolved)) |
| VOICE_TRUSTED_HOSTS_UNSET | n/a | doctor check `trusted-hosts` | `security.trustedHosts` is empty although the request came through a proxy host name. | Add the public host name to `security.trustedHosts`. ([details](#voice_trusted_hosts_unset)) |
| VOICE_FILE_MODE | n/a | doctor check `files` | A secret file (`vault.json`, `capability.secret`) is readable by other users. | Run `chmod 600` on the file and `chmod 700` on its directory. ([details](#voice_file_mode)) |
| VOICE_DATA_DIR_UNWRITABLE | n/a | doctor check `data-dir` | The plugin data directory is missing or not writable, so keys, the secret and the file settings cannot be saved. | Create it, or fix the owner and mode; `DSH_VOICE_DATA_DIR` moves it. ([details](#voice_data_dir_unwritable)) |
| VOICE_ENGINE_UNREACHABLE | n/a | doctor check `engines` | A self-hosted or loopback engine did not answer a plain GET within 2 seconds. | Start the engine, fix the base URL or the interface it binds to (loopback vs LAN). ([details](#voice_engine_unreachable)) |
| VOICE_CLIENT_BUNDLE_MISSING | n/a | doctor check `client` | The browser bundle `lib/client.js` is missing or empty, so no speaker or microphone appears. | Reinstall the plugin; from a source checkout run `npm run build`. ([details](#voice_client_bundle_missing)) |

### VOICE_INTERNAL
- **Meaning:** Unexpected exception inside a route.
- **Where:** any route, log (status 500), log line `VOICE_INTERNAL ...`.
- **Likely causes:** an unhandled error in the plugin or an adapter.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Collect the log line that starts with the code and the request that caused it; report a bug. Retry once.
- **Needs the human:** no, unless it repeats
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#start-here)

### VOICE_BAD_REQUEST
- **Meaning:** The request body is not valid JSON, is empty, or lacks the audio part.
- **Where:** route POST /api/voice/tts, /stt, /polish, PATCH /api/voice/settings (status 400), log line `VOICE_BAD_REQUEST ...`.
- **Likely causes:** a script posts an empty body; a wrong content type; the upload has no file part.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Send a JSON body (`text`, `provider`, `lang`) or a multipart upload with a `file` part.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-dictation)

### VOICE_BODY_TOO_LARGE
- **Meaning:** The body is larger than the route accepts (25 MB for audio, smaller for JSON).
- **Where:** route POST /api/voice/stt, /tts (status 413), log line `VOICE_BODY_TOO_LARGE ...`.
- **Likely causes:** a very long dictation; a text over the JSON limit.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Send a shorter recording or text.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-dictation)

### VOICE_RATE_LIMITED
- **Meaning:** The per-minute limit of `security.rateLimit` was reached.
- **Where:** route POST /tts, /stt, /polish, /detect (status 429), log line `VOICE_RATE_LIMITED ...`.
- **Likely causes:** auto-read of many replies; a script calling the speech routes; limits set very low.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Wait a minute, or raise the limit in Settings if the burst is legitimate. Check that auto-read is not looping.
- **Needs the human:** only to raise a limit
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-cost)

### VOICE_CROSS_SITE
- **Meaning:** A browser request from another site (or with a foreign Origin) was refused, so no credit is spent.
- **Where:** route POST /tts, /stt, /polish (status 403), log line `VOICE_CROSS_SITE ...`.
- **Likely causes:** a page of another site posted to the route; a proxy rewrote Origin or Host.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Call the route from the DSH page itself, or from a script that sends no Origin header.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-refused)

### VOICE_UNTRUSTED_REQUEST
- **Meaning:** The peer is not loopback, or Origin differs from Host, or the request is cross-site.
- **Where:** route POST /detect (status 403), log line `VOICE_UNTRUSTED_REQUEST ...`.
- **Likely causes:** a direct non-loopback connection; a proxy that changes Host.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Reach DSH through its normal loopback proxy with the same Host and Origin.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-refused)

### VOICE_READ_REFUSED
- **Meaning:** A gated read route refused the request (method, non-loopback peer, or Host not trusted). The reason is in `message`.
- **Where:** route GET /session, /settings, /voices, /models, /doctor (status 403), log line `VOICE_READ_REFUSED ...`.
- **Likely causes:** DSH opened under a host name that is not in `security.trustedHosts`; a cross-site request.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Add the public host name to `security.trustedHosts`, and make sure the proxy connects from loopback.
- **Needs the human:** yes, a configuration edit
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-refused)

### VOICE_WRITE_REFUSED
- **Meaning:** The mutating gate refused the request. `layer` says which: L0 method, L1 loopback peer, L2 Host, Origin, Fetch metadata or content type, L3 capability token, L4 harness session cookie.
- **Where:** route PATCH or POST /settings, POST /test (status 403), log line `VOICE_WRITE_REFUSED ...`.
- **Likely causes:** token older than about 15 minutes; Host not trusted; no DSH session cookie; a script without Origin.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Reload the tab (L3), fix `security.trustedHosts` (L2), make the proxy pass cookies (L4).
- **Needs the human:** sometimes, for the configuration edit
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-refused)

### VOICE_SESSION_NOT_READY
- **Meaning:** The per-install secret is not loaded yet (the plugin just started or the data directory is not writable).
- **Where:** route GET /session (status 503), log line `VOICE_SESSION_NOT_READY ...`.
- **Likely causes:** plugin start in progress; data directory not writable.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Retry after a few seconds; if it persists check the data directory (doctor check `data-dir`).
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-not-saved)

### VOICE_PROVIDER_UNKNOWN
- **Meaning:** The provider id in the request is not an instance.
- **Where:** route GET /voices, POST /test (status 404), log line `VOICE_PROVIDER_UNKNOWN ...`.
- **Likely causes:** a typo; the provider was removed in Settings.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: List ids with `GET /api/voice/config` (`providers[].id`) and retry with one of them.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-no-audio)

### VOICE_PROVIDER_UNAVAILABLE
- **Meaning:** The chosen provider cannot be used right now: not configured, key missing, disabled, wrong direction (speech only or transcription only), or no speech to text engine at all. The legacy sentence is in `error`.
- **Where:** route POST /tts, /stt (status 503), log line `VOICE_PROVIDER_UNAVAILABLE ...`.
- **Likely causes:** key pointer does not resolve; provider disabled; wrong direction; no provider configured.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Configure the provider or key named in `message`, enable it, or choose another provider.
- **Needs the human:** yes, if a key must be obtained
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-no-audio)

### VOICE_BROWSER_ONLY
- **Meaning:** The browser voice is synthesised in the page, never on the server.
- **Where:** route POST /tts (status 400), log line `VOICE_BROWSER_ONLY ...`.
- **Likely causes:** a script asked the server for the browser voice.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Let the page speak it (the player does this); do not call `/tts` with `provider: browser`.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-no-audio)

### VOICE_PROVIDER_ENTRY_REJECTED
- **Meaning:** A provider entry in the patch was refused: unknown type, a URL that is internal, has credentials, or is not https for a cloud provider, or a key pointer to another provider.
- **Where:** route PATCH or POST /settings (status 400), log line `VOICE_PROVIDER_ENTRY_REJECTED ...`.
- **Likely causes:** a cloud provider pointed at a LAN or metadata address; userinfo inside the URL; a `vault:` pointer to another provider.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Correct the entry named in `message`: https and a public host for cloud types, a self-hosted type for a local server.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-refused)

### VOICE_PROVIDER_AUTH
- **Meaning:** The provider rejected the key (legacy code `bad_key`).
- **Where:** route POST /tts, /stt (status 502), log line `VOICE_PROVIDER_AUTH ...`.
- **Likely causes:** wrong, expired or revoked key; key for another region.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Renew or correct the key; use the Test button of the provider row to confirm.
- **Needs the human:** yes, new key from the provider console
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-no-audio)

### VOICE_PROVIDER_QUOTA
- **Meaning:** The provider has no credits or quota left, or throttled the call (legacy code `quota_exceeded`).
- **Where:** route POST /tts, /stt (status 429), log line `VOICE_PROVIDER_QUOTA ...`.
- **Likely causes:** credits exhausted; plan limit reached.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Add credits, wait for the quota reset, or route the language to another provider.
- **Needs the human:** yes, billing
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-cost)

### VOICE_PROVIDER_VOICE
- **Meaning:** The voice or model asked for does not exist at the provider (legacy code `bad_voice`).
- **Where:** route POST /tts (status 400), log line `VOICE_PROVIDER_VOICE ...`.
- **Likely causes:** voice id retired; voice of another provider; retired model.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Pick a voice from the provider row list (`GET /api/voice/voices?provider=<id>`) or clear the voice field.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-retirements)

### VOICE_PROVIDER_LANGUAGE
- **Meaning:** The provider does not cover the language (legacy code `unsupported_lang`).
- **Where:** route POST /tts, /stt (status 400), log line `VOICE_PROVIDER_LANGUAGE ...`.
- **Likely causes:** language row points at a provider without that language.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Route that language to a provider that lists it, or enable the browser voice as fallback.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-wrong-language)

### VOICE_PROVIDER_TIMEOUT
- **Meaning:** The provider or self-hosted engine did not answer in time (legacy code `timeout`).
- **Where:** route POST /tts, /stt (status 504), log line `VOICE_PROVIDER_TIMEOUT ...`.
- **Likely causes:** slow or stopped engine; network problem; very long text.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Retry; check the engine is up and fast enough (doctor check `engines`); use a shorter text.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-engine-unreachable)

### VOICE_PROVIDER_FAILED
- **Meaning:** The provider returned an error or an unusable answer (legacy code `vendor`), or the transport failed. `message` carries the scrubbed vendor text.
- **Where:** route POST /tts, /stt (status 502), log line `VOICE_PROVIDER_FAILED ...`.
- **Likely causes:** vendor outage; retired model; engine error; connection refused.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Read `message`; test the provider row; check the model is not retired; try another provider.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-engine-unreachable)

### VOICE_ROUTE_NOT_FOUND
- **Meaning:** No such voice route.
- **Where:** route any unknown path under /api/voice (status 404), log line `VOICE_ROUTE_NOT_FOUND ...`.
- **Likely causes:** wrong path; older plugin version loaded.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Check the path against the README (HTTP routes); on all 404 see C2.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#c2-route-404)

### VOICE_METHOD_NOT_ALLOWED
- **Meaning:** The route needs POST.
- **Where:** route /tts, /stt, /polish and unknown paths (status 405), log line `VOICE_METHOD_NOT_ALLOWED ...`.
- **Likely causes:** GET sent to a POST route.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Use POST with a JSON or multipart body.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-no-audio)

### VOICE_SETTINGS_NOT_WIRED
- **Meaning:** No DSH settings service is wired (settings mode `config`): values live only in the plugin settings file.
- **Where:** doctor check `settings`, log line `VOICE_SETTINGS_NOT_WIRED ...`.
- **Likely causes:** unsupported DSH line; headless run.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Use a plugin version for your DSH line; check the plugin declares the settings service (C3).
- **Needs the human:** sometimes
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-not-saved)

### VOICE_CONFIG_NOT_VISIBLE
- **Meaning:** The exported `Config` schema is not available, so DSH 0.2.x cannot render settings forms.
- **Where:** doctor check `config`, log line `VOICE_CONFIG_NOT_VISIBLE ...`.
- **Likely causes:** schema library not found from the plugin location.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Check that the harness install provides its schema library (C3 b); update the plugin or the harness.
- **Needs the human:** sometimes
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-not-saved)

### VOICE_NO_PROVIDER
- **Meaning:** No provider can speak (or none can transcribe); only the browser voice is left.
- **Where:** doctor check `providers`, log line `VOICE_NO_PROVIDER ...`.
- **Likely causes:** no key configured; every provider disabled.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Configure at least one provider in Settings > Voice and press Test.
- **Needs the human:** yes, for a key
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-no-audio)

### VOICE_ROUTE_UNRESOLVED
- **Meaning:** A language row names a provider that is not available, so reading falls through to the next provider or the browser voice.
- **Where:** doctor check `routing`, log line `VOICE_ROUTE_UNRESOLVED ...`.
- **Likely causes:** provider disabled or key missing; typo in a language row.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Fix the key of that provider, or change the row or its fallback list.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-no-audio)

### VOICE_TRUSTED_HOSTS_UNSET
- **Meaning:** `security.trustedHosts` is empty although the request came through a proxy host name.
- **Where:** doctor check `trusted-hosts`, log line `VOICE_TRUSTED_HOSTS_UNSET ...`.
- **Likely causes:** access through a reverse proxy.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Add the public host name to `security.trustedHosts`.
- **Needs the human:** yes, a configuration edit
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-refused)

### VOICE_FILE_MODE
- **Meaning:** A secret file (`vault.json`, `capability.secret`) is readable by other users.
- **Where:** doctor check `files`, log line `VOICE_FILE_MODE ...`.
- **Likely causes:** file copied or restored with a loose mode.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Run `chmod 600` on the file and `chmod 700` on its directory.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-not-saved)

### VOICE_DATA_DIR_UNWRITABLE
- **Meaning:** The plugin data directory is missing or not writable, so keys, the secret and the file settings cannot be saved.
- **Where:** doctor check `data-dir`, log line `VOICE_DATA_DIR_UNWRITABLE ...`.
- **Likely causes:** wrong owner after a restore; read-only mount.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Create it, or fix the owner and mode; `DSH_VOICE_DATA_DIR` moves it.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-not-saved)

### VOICE_ENGINE_UNREACHABLE
- **Meaning:** A self-hosted or loopback engine did not answer a plain GET within 2 seconds.
- **Where:** doctor check `engines`, log line `VOICE_ENGINE_UNREACHABLE ...`.
- **Likely causes:** engine stopped; wrong URL or port; bound to loopback of another host or container.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Start the engine, fix the base URL or the interface it binds to (loopback vs LAN).
- **Needs the human:** sometimes, for firewall or bind changes
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-engine-unreachable)

### VOICE_CLIENT_BUNDLE_MISSING
- **Meaning:** The browser bundle `lib/client.js` is missing or empty, so no speaker or microphone appears.
- **Where:** doctor check `client`, log line `VOICE_CLIENT_BUNDLE_MISSING ...`.
- **Likely causes:** incomplete install.
- **Agent action:** read-only checks first (`GET /api/voice/doctor`), then: Reinstall the plugin; from a source checkout run `npm run build`.
- **Needs the human:** sometimes
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#c1-not-loaded)
