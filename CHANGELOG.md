# Changelog

## Unreleased

### Added
- Provider type `supertonic`: Supertonic 3 on the resident Rust service, the second self-hosted engine beside Kokoro. Ten voice styles over 31 languages including Greek, which Kokoro does not speak. Discovered from `SUPERTONIC_TTS_URL`, never in automatic routing. Same wire shape as Kokoro (`POST /api/tts`, `xi-api-key`, WAV), so it needs no credential beyond the service key.
- The annotation layer maps the `supertonic` type explicitly: the model documents no tag vocabulary, so markers are stripped rather than risked, and a future documented tag set has one place to change.
- **Speech tools for the assistant**: `voice_annotations` (how a text will be spoken, and the text wrapped for a tone), `voice_speak` (text to mp3; a long passage becomes numbered sentence clips so the first sentence plays without waiting for the last), `voice_announce` and `voice_announce_stop`. Written to the DSH tool contract: a canonical value validated against the output schema, content blocks for the model, and a presentation projection carrying clip paths to a UI without showing them to the model. Reference: `docs/TOOLS.md`.
- `POST /api/voice/tts` takes `saveTo`: the clip is written inside the home directory at mode 0600 and named in the reply, and a path outside the home is refused. This is how a tool leaves an mp3 behind.
- `tools.provider`, `tools.voice`, `tools.model`, `tools.language`, `tools.clipDir` and `tools.chunkChars` in the configuration, so every value the tools use is visible in Settings and none is hardcoded.
- The speech tools register only when the host provides a tools service; without one the plugin serves speech exactly as before and logs `tools skipped`.
- Docs and diagnostics standard: `docs/TROUBLESHOOTING.md`, `docs/ERRORS.md` (stable `VOICE_*` codes), the bundled `voice-doctor` skill and a README section "When something goes wrong".
- Every HTTP error body now has the shape `{ ok: false, error, code, message, hint, docs }`. Statuses and the `error` strings are unchanged. A body that carried a short lower-case `code` (`rate_limited`, `browser_only`, `cross_site`, or a vendor code such as `bad_key`) now carries it as `legacyCode`, because `code` is the `VOICE_*` code; the `x-voice-error-code` header is unchanged.
- Log lines of failed routes start with the code.
- `GET /api/voice/doctor`: read-only self-check (settings mode, Config, providers, routing, trusted hosts, data directory and secret file modes, self-hosted engine reachability with a 2 s GET, retirements, client bundle). No secrets in the output, no paid call.
- The `voice-doctor` skill is registered with the harness skill registry at start (`ctx.inject(['skills'])`).

## 2.1.0

Speech annotations, the OpenRouter provider, and the reader's model catalogue.

### Added
- **Speech annotations**: one syntax for the person writing (`[tone=happy]`, `[pace=slow]`, `[pitch=high]`, `[volume=soft]`, `[emphasis]`, `**word**`, `[laugh]`, `[pause]`, `[slightly sad]`) adapted per model family in `lib/shared/annotations.js`. Each family's rules were read from its vendor documentation on 2026-11-25 and the source is quoted in the entry's `verification` note: Voxtral TTS 3 (`[emotion=]`, `[pace=]`, disfluency tags), ElevenLabs v3 and v4 (`[tag]`), Gemini 3.8 TTS (angle tags plus `speech_metadata.style`), HeyGen Voice (one tag per position, `slightly`/`extremely` only), Fish Audio S2 and Drama 3 (free text cues, `[emphasis]`), Fish Audio S1 (parentheses), Orpheus (sound tags only), OpenAI gpt-4o-mini-tts (bracketed direction plus `instructions`, measured live), Azure AI Speech and Amazon Polly (SSML `<prosody>` and `<break>`).
- Anything a model cannot take is removed, never spoken. A pause becomes a real silence on every model. Brackets that are not annotations (`[1]`, `[Section 4]`, `[[el]]`, catalogue lines such as `[punctuation="*"]`) stay text.
- Offset maps in both directions (`map`, `unmap`, `toWire`), so the word highlight follows the text on screen through removed tags, Markdown headings and bold markers. `buildSegments` now returns `map` (prose offset -> text offset) and each segment its `start`.
- Provider type `openrouter`: `POST /v1/audio/speech` and `/v1/audio/transcriptions` over one key for 40+ vendors' models, with the live catalogue (`GET /v1/audio/speech/models`) that publishes each model's voices, formats, speed range and instruction support. PCM-only models are wrapped into a WAV at the rate the response header names. Options pin provider routing (`preferProviders`, `onlyProviders`, `zdr`) to slugs that actually serve the chosen model.
- `GET /api/voice/annotations?provider&model&text`: every annotation of a text, how many of them the selected model can take, its menu and the delivery instruction it would receive.
- `/config` publishes `engines[id].ttsModels` (each model with its own voices and its annotation family) and `engines[id].v2.annotation` (family, summary, menu, syntax) for every provider.
- `GET /api/voice/voices?provider&model`: the voices of one model where a provider has a catalogue.
- The TTS Reader and the chat reader list every provider's models, and the voices follow the chosen model; the annotation menu offers only what that model can take.

### Changed
- Every speech adapter sends the text the annotation layer returns for its model (Mistral, ElevenLabs, Azure, Amazon, Google, OpenAI, OpenAI-compatible, OpenRouter, Fish, Cartesia, MiMo, DashScope, tzekos-native, LFM3).
- An engine lists its models even when it cannot speak right now, so the menus show what a provider would offer.
- `openai` voices are listed per model (13 for gpt-4o-mini-tts, 9 for tts-1 and tts-1-hd), and gpt-4o-mini-tts records a delivery instruction when the caller passes one.

### Fixed
- The polish rate-limit test no longer waits on whichever local model the host offers (it points at a closed port).
- `speakableProseMapped` aligns the prose against the source text, so a heading or an escaped entity never shifts a mapped offset.

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
