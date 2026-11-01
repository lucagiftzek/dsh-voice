# Changelog

## 2.0.0 (2026-11-02)

First public release (squashed history).

### Changed
- Public tree: user-visible labels of the loopback server preset and the native Kokoro provider are generic ("Local TTS server", "Kokoro (native /api/tts)"); the type and preset ids are unchanged, so saved settings keep working. The native preset falls back to the voice `default`.
- `scripts/privacy-check.mjs` takes private terms from `PRIVACY_TERMS` instead of a built-in list.


### Added
- Docs and diagnostics standard: `docs/TROUBLESHOOTING.md`, `docs/ERRORS.md` (stable `VOICE_*` codes), the bundled `voice-doctor` skill and a README section "When something goes wrong".
- Every HTTP error body now has the shape `{ ok: false, error, code, message, hint, docs }`. Statuses and the `error` strings are unchanged. A body that carried a short lower-case `code` (`rate_limited`, `browser_only`, `cross_site`, or a vendor code such as `bad_key`) now carries it as `legacyCode`, because `code` is the `VOICE_*` code; the `x-voice-error-code` header is unchanged.
- Log lines of failed routes start with the code.
- `GET /api/voice/doctor`: read-only self-check (settings mode, Config, providers, routing, trusted hosts, data directory and secret file modes, self-hosted engine reachability with a 2 s GET, retirements, client bundle). No secrets in the output, no paid call.
- The `voice-doctor` skill is registered with the harness skill registry at start (`ctx.inject(['skills'])`).

## 2.0.0-rc.2

Pre-merge review of the release candidate.

### Security
- Settings writes check where a key would be sent: a cloud provider's `baseUrl`, `options.wsBaseUrl` and `options.ttsHost` must be `https` on a public host (literal and DNS check); self-hosted types (and OpenAI-compatible) may use loopback and LAN; an unchanged environment-configured value (a relay) stays saveable; a `vault:<id>` credential only for its own provider; URLs with user info are refused.
- `/tts`, `/stt` and `/polish` refuse cross-site browser requests (`Sec-Fetch-Site: cross-site` or a foreign `Origin`); same-origin callers and callers without Fetch metadata are unchanged.
- `security.rateLimit.polishPerMin` (default 30).

### Fixed
- Amazon Polly: `billedChars` counts the speech-marks request, which Polly bills like a speech request.
- Verification notes re-checked against the vendor references: Azure WordBoundary WebSocket (Speech SDK), Amazon Transcribe streaming events, Google v1beta1 timepoints on the EU endpoint, Cartesia languages (44 incl. Greek and Italian on the WebSocket) and residency, MiMo docs URL.

### Added
- Settings > Voice shows a note on OpenAI models that retire (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` on 2027-01-06; `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize` on 2027-02-26; the 2025-03-20 mini transcribe snapshot on 2027-01-20).
- `LICENSE` (MIT); the privacy check runs over the whole tree (bundle and 1.x notes included) as part of the tests.

### Changed
- The remote Kokoro engine (id `grey`, unchanged) is labelled "Kokoro (remote)"; set `DSH_VOICE_GREY_LABEL` to name it.

## 2.0.0-rc.1

Release candidate of dsh-voice 2 (phases 1 to 4 of the v2 plan).

### Added
- **Provider catalogue**, EU vendors first: Speechmatics (STT, EU regions), Gladia (STT), Acapela Cloud (TTS with word events), ReadSpeaker speechCloud (TTS); then Azure AI Speech (TTS with WordBoundary word timings over the TTS WebSocket, fast-transcription STT, EU regions first), Google Cloud (TTS with SSML mark timepoints, STT, EU endpoints), Amazon Polly (speech-mark word timings) and Transcribe streaming (hand-written SigV4, no SDK), OpenAI, the generic OpenAI-compatible type with presets (Kokoro-FastAPI with word timings, Speaches, LocalAI, openedai-speech, Groq, OVHcloud), Fish Audio, Cartesia (word timestamps over its WebSocket, batch STT), Deepgram (Aura-2 TTS, Nova-3 STT, EU endpoint), AssemblyAI (STT, EU endpoint); self-hosted Piper (HTTP server) and Coqui XTTS servers.
- Adapter metadata (`group`, `residency`, `desc`, `docs`, `status`, `verification`, `regions`, `optionFields`, `residencyOf`) exposed through `GET /api/voice/settings`.
- Settings > Voice: providers grouped EU first, Others, Self-hosted; residency and timing badges; Add provider dialog with a one-line description and docs link per type; region and per-type option fields; the Test button of a speech-to-text-only provider borrows a spoken sample from another provider.
- Shared building blocks: `lib/server/ws.js` (dependency-free WebSocket client), `lib/server/sigv4.js` (AWS Signature V4, header and query signing), `lib/server/ssml.js`, `tokensToWords` and `startsToWords` alignment helpers.
- `npm run docs` generates the README provider table, the setup notes and `docs/PROVIDERS.md` from the adapters; `npm run privacy` checks a diff for private hosts, machine names, home paths, key-shaped strings and dashes.

### Changed
- README: provider table, setup per provider, per-language defaults, privacy notes, publishing note.
- An unverified WebSocket (Azure word timings) that fails is skipped for ten minutes, so one broken socket costs one handshake, not one per read.

### Notes
- Only the 1.x engines are discovered from the environment; every new provider is added in Settings with a credential pointer (`env:NAME`, `file:/path#NAME`, `dsh-ref:NAME`, or a key kept in the 0600 vault file).
- Verification status per provider is recorded in each adapter and in `docs/PROVIDERS.md`; nothing was exercised against a live vendor in this release candidate.
- OpenAI: the TTS models retire on 2027-01-06 and `whisper-1` plus the gpt-4o transcribe family (including diarize) on 2027-02-26 (the v2 spec had an earlier date).
