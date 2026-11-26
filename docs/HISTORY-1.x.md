> Historical notes of dsh-voice 1.x (measurements and decisions, kept for reference). The current documentation is README.md.

# dsh-voice

Read-aloud and microphone dictation for the DeepSeek Harness web UI.

dsh 0.1.2-rc.1 ships no speech capability of any kind, 0 of its 223 packages
reference `MediaRecorder`, `getUserMedia`, `SpeechSynthesis`, or any audio API , 
so both halves of this are built here.

## What you get

* A **🔊 speaker** on every finished assistant message. It reads the prose and
  *skips fenced code*, saying "code block skipped" instead, a spoken code fence
  is unusable. If the message has code, a second small **🔊{ }** button appears
  that reads the code too. Reasoning/thinking blocks are never read.
* A **🎤 microphone** in the composer. Click, speak, click again: the clip is
  transcribed, cleaned up by a small model, and written into the prompt box.
  Existing draft text is appended to, not replaced.
* An **engine picker** next to the microphone (remembered per browser).

## Engines, and why the defaults are what they are

All numbers measured on the development host, 2026-09-08, same 3.5s clip / same sentence.

| | engine | speech-to-text | text-to-speech | notes |
|---|---|---|---|---|
| **default** | Mistral Voxtral | **0.43s** | **1.07s** | voices are English only (`en_us`, `en_gb`) |
| **non-English STT** | Groq whisper-large-v3 | **0.46s** |, | Greek measured word-exact; cents-per-hour, `GROQ_API_KEY` |
| **non-English TTS** | ElevenLabs flash-v2_5 |, | ~1-2s | speaks Greek; `el` is in its 32 languages (v3: 74) |
| | Alibaba Qwen |, |, | wired, **not yet usable**, see below |
| | local `tzekos-tts` | 1.7s (whisper `base`) | 8.2s short / 18.0s paragraph | nicest voice, no network, no vendor |
| | browser | n/a | instant | `speechSynthesis`; robotic but always available |

Full dictation round trip on the cloud path: **~1.05s** press-to-draft.

### 2026-09-08 evening: browser dictation path fixed

Round one shipped a browser-side bug: `finish()` called `props.useInput()` , 
a `useSyncExternalStore` hook per `bindSnapshotSelector`, from an async
callback after the awaits. React threw "Invalid hook call", `finish`'s own
try/catch ate it as the red ⚠, and every *successful* transcription (traefik
logs show STT + polish answering 200 with real text throughout) was dropped
instead of landing in the composer. The draft is now read at render time into
a ref. Empty 200s (a too-short tap on the mic) report "no speech detected"
instead of going silent, and the upload suffix follows the blob's real
container (Safari records fMP4, not webm). Client-half changes are content-
hashed live: an ordinary page reload picks them up, no `dsh-web` restart.

`auto` routes English and French to Mistral for STT, everything else to **Groq
whisper-large-v3**; TTS voices go Mistral for English and **ElevenLabs** otherwise
(Maya1 local, then browser, as fallbacks). Why not Mistral for all of it: measured
2026-09-08 on a real Greek clip, Voxtral answered with **transliterated Cyrillic**
("Калисперасас…") while whisper-large-v3 returned the Greek word-for-word. Why not
Alibaba: see below. Every cloud failure still falls back rather than going silent.

### Transcript polish

A cheap fast transcriber plus a good small model beats an expensive slow
transcriber. `mistral-small-latest` (0.45s) turns

> Um, can you show me the Trefik config for the LLM host …

into

> Can you show me the Traefik config for the LLM host …

`ministral-3b-latest` was rejected despite being available: it prefixes "Here's
the cleaned-up prompt:" and invented "Treflix". Local `qwen3.5:4b` is the
fallback, as good, but only when resident (1.0s warm, 11.8-25s cold).

### Alibaba (and the DeepSeek question)

Asked and answered with measurements, 2026-09-08 evening: **there is no DeepSeek
audio model to use.** `api.deepseek.com/models` lists exactly three ids, all
text/vision; fed an `input_audio` part through the token-plan's
`deepseek-v4-pro`/`flash`, both answer **HTTP 200** while reasoning "no audio
file or link was provided", silent audio blindness, worse than a 403. The plan's
real audio models were re-swept the same night and still fail over HTTP:
`/audio/*` 404s, native multimodal TTS answers `url error`, chat+modalities
answers `InternalError`. Activate audio entitlements in the Model Studio console
for **ap-southeast-1** (or set `DSH_VOICE_ALI_AUDIO=1` once that changes) and
the routes here start working with no code change; Groq and ElevenLabs already
carry the load in the meantime.

## How it is built

Dual-face, like every dsh plugin:

* `lib/index.js`, host half. `inject: ['webServer']`, registers the `/api/voice`
  prefix route (`/config`, `/quota`, `/tts`, `/stt`, `/polish`). **Imports only
  node builtins.** This dsh crash-looped 794 times on 2026-09-08 because a plugin
  imported a name its dependency no longer exported; an ESM error at load takes
  the whole UI down, not just the plugin, so there is deliberately no version
  surface here to drift against.
* `lib/client.js`, browser half. One `window.__ModuleLoader__.load({id, factory})`
  call, `React.createElement`, **no build step**, the same shape as
  `dsh-model-picker-augmented`. Registers into the `conversation.chat.assistant-actions`
  and `conversation.input.right` slots.

Credentials are read server-side from `EnvironmentFile=` entries on
`dsh-web.service` and never reach the browser. `tzekos-tts` also has no CORS
middleware, so the page could not call it directly in any case.

The assistant message's text comes off the contract, not the DOM:
`ChatSnapshot.legacy.nodes` → the assistant node whose `messageId` matches →
`blocks.filter(kind === 'text')`.

## Kill switch

Add to the web profile's `cordis.patch.yml` (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: voice
  disabled: true
```

and `systemctl restart dsh-web`. Nothing else in the profile depends on it.

## Configuration

Everything is env, read by `dsh-web.service`:

| var | default | |
|---|---|---|
| `MISTRAL_API_KEY` |, | from `~/.config/mistral/credentials` |
| `TTS_API_KEY` |, | from `~/.config/tzekos-tts/credentials` |
| `ALIBABA_BAILIAN_API_KEY`, `ALIBABA_BAILIAN_HOST` |, | from `~/.config/alibaba-bailian/credentials` |
| `GROQ_API_KEY` |, | from `~/.config/groq/credentials`; enables whisper STT |
| `ELEVENLABS_API_KEY` |, | from `~/.config/elevenlabs/credentials`; enables multilingual voices |
| `DSH_VOICE_GROQ_STT` | `whisper-large-v3` | try `whisper-large-v3-turbo` for 0.3s, slightly less exact |
| `DSH_VOICE_ELEVEN_TTS` | `eleven_flash_v2_5` | `eleven_v3` for 74 languages, slower/pricier |
| `DSH_VOICE_ELEVEN_VOICE` | `onwK4e9ZLuTAKqWW03F9` | Daniel; the voice used when the composer's picker says "account default". The picker itself lists every voice the account owns |
| `DSH_VOICE_ELEVEN_TTL_MS` | `300000` | how long the voice list + credit balance are cached. A failed catalogue retries after 60s regardless |
| `DSH_VOICE_MISTRAL_STT` | `voxtral-mini-latest` | |
| `DSH_VOICE_MISTRAL_TTS` | `voxtral-mini-tts-latest` | |
| `DSH_VOICE_MISTRAL_VOICE` | `gb_oliver_neutral` | `GET /v1/audio/voices` lists 10 |
| `DSH_VOICE_MISTRAL_POLISH` | `mistral-small-latest` | |
| `DSH_VOICE_POLISH_MODEL` | `qwen3.5:4b` | local fallback |
| `DSH_VOICE_STT_PATH` | `/v1/speech-to-text-fast` | local; **not** the QA-grade `/v1/speech-to-text`. The picker's `?model=` rides on top of it |

`GET /api/voice/config` reports what is actually reachable right now.

## 2026-09-09: local model picker + the Qwen verdict

The local box turned out to hold MORE than one engine: `tzekos-tts` carries
Maya1 3B (voice DESIGN), Kokoro 82M (fast, fixed British cast), Qwen3-TTS 1.7B
(weights on disk) and four faster-whisper sizes, but selected its engine only
via a global env var, so from the composer's point of view it was one
indistinguishable "Local".

What changed, in order:

1. **tzekos-tts `server.py` patched** (`server.py.bak-20260909-permodel`):
   `_synth(..., engine=None)` keeps the global default EXACTLY, but honours an
   optional per-request `engine` (all three TTS routes); the two STT routes
   take `?model=base|base.en|small|medium` against a cached pool, defaulting
   to the old env values; `language_code` became the DETECTED language (it
   claimed `"en"` even on Greek); `/health` advertises `engines_available`,
   `engines_inert`, `whisper_sizes` so clients discover instead of assuming.
   Switching engines evicts the others under the GPU lock, the 1070's 8 GiB
   never holds two. Content Studio regression-checked: default engine, the
   single-element `alignment` timestamp contract, and the QA gate all behave
   as before.
2. **Qwen 1.7B: on disk, inert by declaration.** `--no-deps qwen-tts` had
   silently cost it `librosa`, `sox` and `accelerate`, all now baked into the
   image (Dockerfile tail RUNs; an earlier insertion would have re-downloaded
   the 2.5 GB torch layer for a 40 MB fix). With imports healed, its vendored
   modelling still dies on the transformers 5.x API (bare-vs-called
   `check_model_inputs`, missing `pad_token_id`, the reworked rope registry , 
   every compat shim just revealed the next break). A 4.x pin to fix it would
   collide with what kokoro/maya were validated on, so `ENGINES_INERT` 400s
   with that explanation rather than shipping a monkeypatch chain. Real
   un-inert path: a sidecar container with its own 4.x env.
3. **dsh-voice** surfaces it: `/config` copies the live `models` list from
   tzekos `/health` (an unpatched box means NO second dropdown, never a
   lying one); the composer shows a grouped **model** picker whenever the
   engine is Local, read-aloud options ride `body.model`, dictation options
   ride `&model=`, each side ignores the other's pick; tzekos's 400 details
   ride back as the error tooltip (`local tts 400: engine 'qwen': inert...`).
4. **ElevenLabs default voice** became **Daniel, Steady Broadcaster**
   (`onwK4e9ZLuTAKqWW03F9`): measured against `/v2/voices` (21 premade), the
   account holds exactly two British males, and the deep-formal one is Daniel;
   George stays one env var away.

Measured after all of it (harness, real vendors, 8s Greek clip):
`local/kokoro 200 · local/small 200 (Καλησπέρα σας!...) · auto/el → groq ·
elevenlabs(Daniel) 200 · inert and bogus models 400 with readable reasons`.

## 2026-09-22: "sometimes the quality voice, sometimes the browser reader"

Reported: picking ElevenLabs in the composer gives the good voice *sometimes* and
what sounds like the browser reader other times. It was never intermittent, and
the engine picker was never at fault.

**The account had run out of credits.** `GET /v1/user/subscription` answered
`tier: free, character_count: 10000, character_limit: 10000`, every credit of
the monthly allowance spent, resetting 2026-09-29. flash-v2_5 bills **half a
credit per character** (measured, not read: the vendor rejected a 26-character
sentence asking for 13), so the free tier is about 20,000 characters a month , 
a dozen answers like the one being read. Every read after that returned `401
quota_exceeded`, and the client's catch-all *silently* substituted
`speechSynthesis`. So the first reads of a period were ElevenLabs and every read
after them was the browser voice, with nothing on screen saying so.

What changed:

1. **The balance and the voice list ride in `/config`** (`engines.elevenlabs.quota`
   and `.voices`, cached 5 min, background-refreshed once warm). The engine menu
   now reads `ElevenLabs, Daniel, no credits left` *before* the click, and a
   quota failure zeroes the cached balance immediately so the menu corrects itself
   without a reload.
2. **Failures are typed.** `/tts` returns `429 quota_exceeded`, `502 bad_key`,
   `400 bad_voice` or `502 vendor` (plus `x-voice-error-code`), each with a
   sentence naming the cause, the numbers and the reset date. A voice id is now
   validated against the account's own list, so a stale id is a readable 400
   instead of a vendor 404.
3. **The fallback is labelled, never silent.** When the chosen engine fails, the
   browser voice may still take over, but the message row then shows
   `🔉 browser voice, <why>` (full reason in the tooltip) and the button's own
   title says which voice is speaking. A new `🔉browser` toggle in the composer
   turns the substitution off entirely, so a failure shows its error instead.
4. **A voice picker, like the local model picker.** Choosing ElevenLabs reveals
   the account's own 21 voices (name + accent + gender, from `GET /v1/voices`,
   never a hard-coded list), remembered per browser; "account default" keeps
   `DSH_VOICE_ELEVEN_VOICE`. The picker's tooltip carries the balance and the
   per-character cost.
5. **A live character counter.** Choosing ElevenLabs puts the remaining
   `8,000 chars` next to the picker (nothing to show for the unlimited engines),
   and every read moves it: the read buttons ask `GET /api/voice/quota`, a
   balance-only route, rate-limited to one vendor call every 3s, when they
   finish, so the number is the account's own, not a guess by the page. The
   read-aloud tooltip carries it too, with the cost of that message:
   `Read aloud (elevenlabs/Daniel), 8,000 chars left; this one ≈ 1,204`.
   Measured in the jsdom harness: 4,000 credits showed as `8,000 chars`, a
   42-character read took it to `7,958`, and a simulated top-up to 5,000 credits
   moved it to `9,958`, the counter follows the vendor, not its own arithmetic.
6. **`auto` is credit-aware, and says where it will land.** Having a key is not
   having credits: while the balance was spent, `auto` still resolved non-English
   text to ElevenLabs, which guaranteed a 429 and the browser voice, the same
   complaint through a different door. `chooseTts` now skips an exhausted
   account for the engine that is free and speaks the language anyway (local
   Maya1), refreshing the balance first (one rate-limited vendor call, never paid
   for English/French). Verified with the real engines, 2026-09-22:
   `auto + el → local, 200, 38,077 bytes` · `auto + en → mistral, 200` ·
   `elevenlabs explicit → 429 quota_exceeded`. `/config` publishes both
   resolutions (`defaults.tts`, `defaults.ttsNonEnglish`) so the read-aloud
   tooltip names the engine that will actually speak , 
   `Read aloud (local · this box, slow but unlimited)` for a Greek message,
   `Read aloud (mistral)` for an English one, instead of always claiming the
   English default.
7. **Preferences became reactive.** The engine/voice/rate prefs now notify every
   mounted button, so changing the picker updates the read-aloud buttons already
   on screen, before this, a message rendered earlier kept the OLD engine in its
   closure and the click quietly used it, which is its own version of the same
   complaint.
8. **Alibaba works, on the PAY-AS-YOU-GO key.** The Token Plan never lacked
   entitlement, it lacked a route. Its host answers 400 `url error` for every
   native audio path and 404 for `/compatible-mode/v1/audio/speech`, and the id
   the arena ranks (`qwen-audio-3.0-tts-plus`) is not served by the route that
   does exist. The PAYG workspace key is a different host and it speaks:
   `qwen3-tts-flash` on `/api/v1/services/aigc/multimodal-generation/generation`
   answers 200 with audio. Two things that cost time and are now encoded here:
   the response is **WAV** whatever the `format` parameter says (five shapes
   tried), so the container is sniffed from the bytes rather than declared; and
   Qwen3-TTS speaks ten languages **and not Greek**, so `ALI_TTS_LANGS` gates
   `auto` and Greek keeps going to Maya1 instead of into an engine that cannot
   say it. Credentials are read as `ALIBABA_PAYG_*` first, under names that
   cannot be confused with the prepaid plan key; enable with
   `DSH_VOICE_ALI_AUDIO=1`. Voices measured working: Cherry, Ethan, Serena,
   Chelsie, Dylan, Jada, Sunny.
9. **The engine menu re-reads the server when you open it.** /config was
   fetched once per page and cached for its lifetime, so restarting the plugin
   to enable an engine left every open page rendering it as *unavailable* until
   a full reload, which is exactly how the Alibaba option looked disabled on
   2026-09-22 while the server was already serving it. Focus now calls
   `refreshConfig()`, guarded by a 20 s TTL so opening the menu is not a request
   per click. Verified in jsdom: a page loaded with Alibaba disabled flips to
   enabled on menu open, and a second open inside the TTL makes no request.
10. **A voice belongs to one engine, the bug behind \"Alibaba defaults to the
    browser voice\".** The voice picker added above sent its preference with
    EVERY read, whatever the engine: the default `auto`, or an ElevenLabs id.
    Mistral answered `Voice 'auto' not found`, Alibaba answered `Invalid voice
    specified`, ElevenLabs answered 400, and the client's catch-all turned each
    of those into the browser voice. So the symptom looked like an engine
    problem and was a request-shape problem, and it hit `auto`/Mistral reads
    too, not just Alibaba. Fixed on both sides, because either alone leaves a
    way to lose a read:
    * **client**, `voice` now travels only with the engine that owns the pref
      (`voiceForEngine`), so Alibaba and Mistral send no voice at all and keep
      their own defaults.
    * **server**, each engine normalises what it is given instead of
      forwarding it: `aliVoice()` accepts only the seven Alibaba voices,
      `mistralVoice()` only the `xx_name_tone` shape, and an ElevenLabs voice
      absent from the account is dropped with an `x-voice-note` header rather
      than a 400. A read degrades to the engine's own default voice; it never
      degrades to a different engine.
    Measured after the fix (harness, real vendors): `alibaba + voice=auto → 200
    audio/wav` · `alibaba + foreign id → 200` · `auto + voice=auto → 200
    audio/mpeg` · `elevenlabs + voice=auto → voice dropped, x-voice-note set` ·
    `elevenlabs + a real voice → unchanged`. On the wire, from the jsdom client:
    `provider=alibaba voice=undefined` · `provider=auto voice=undefined` ·
    `provider=elevenlabs voice=undefined` (pref `auto`) · `provider=elevenlabs
    voice=\"JBFqnCBsd6RMkjVDRZzb\"` (picked).
11. **Pipelined playback, the silence before the first word.** Every read used
    to send the WHOLE message and wait for the whole answer, so the person sat
    in silence and the wait grew faster than the text. Measured here on
    2026-09-22: Alibaba answered 47 characters in 2.9 s, 359 in 7.0 s and 1679
    in **66 s**; Maya1 took 34.6 s for one sentence and 102 s for a paragraph;
    Mistral 1.4 s and Kokoro 1.0 s warm. The client now splits the prose at
    sentence boundaries and requests it **one chunk at a time, one chunk
    ahead**: the next is fetched the moment the current one starts playing, so
    time-to-first-audio is the first sentence, not the message. The first chunk
    is deliberately small (110 chars) to buy a fast start, and the rest larger
    (260) because they are fetched behind playback. The local GPU engines get a
    much coarser plan (400/900): their cost is mostly FIXED per request , 
    ~24 s + 0.22 s/char for Maya1 against ~2.2 s + 0.013 s/char for Alibaba, so
    splitting them finely would pay that 24 s once per sentence and make the
    read *slower*. Verified in jsdom with a delayed stub: chunk requests at
    62 ms and 363 ms, playback at 363 ms, the second request is issued while
    the first chunk plays. A failure on the first chunk still throws (so the
    labelled browser fallback can catch it); a failure later stops the read
    quietly instead of swapping voices mid-sentence. `stopAll()` bumps a play
    token and wakes the in-flight chunk, so stopping never leaves the pipeline
    hung on a promise nobody resolves.
12. **Qwen voices are selectable.** The route serves seven (Cherry, Ethan,
    Serena, Chelsie, Dylan, Jada, Sunny; anything else is 400 `Invalid voice
    specified`). /config publishes them, the composer shows an **Alibaba voice**
    picker next to the engine choice, and the pref rides only Alibaba requests.
13. **The composer lost two controls; Settings gained a Voice section.** The
    prompt row is only as wide as a prompt box and had grown to six controls,
    so the browser-fallback switch and the read-aloud speed moved to
    **Settings → Voice**, registered on the `settings.section` slot with the
    shape copied from the two registrations that work on this box (the
    first-party General section and DSH-Idle-Watchdog): `label` as a FUNCTION,
    plus an `inject` declaration, a plain string label is not what the settings
    shell expects. Both controls write the same pref store the buttons read, so
    a change lands on a read already playing. The section also states which
    engine `auto` resolves to and, for ElevenLabs, how many characters are left.
    The composer is now mic · engine · voice/model · rewind. Verified in jsdom:
    three slots register (`voice-speak`, `voice-settings`, `voice-mic`), the
    checkbox round-trips the pref, the rate select round-trips 1.5×, and the
    composer no longer contains either control.

Verified with two harnesses, no dsh-web restart: the host half was driven
directly (a fake `ctx.webServer` + real vendor calls) and the client half was
rendered in jsdom with React 18, menu label, voice list, the request body
(`provider: elevenlabs, voice: JBFqnCBsd6RMkjVDRZzb`), the fallback label with
the real quota sentence, and the no-substitution path with the toggle off.

**The code cannot buy credits.** Until the plan is upgraded, ElevenLabs reads are
the first ~20,000 characters of the period and the labelled browser fallback (or
another engine) covers the rest. Local Maya1 and Mistral Voxtral are unlimited
and unaffected.

Ops notes: tzekos-tts deploys via `docker compose up -d --force-recreate`
(plain `restart` loses the GPU on this driver, see the compose-file warning);
`.env` there is svc-owned so recreations need sudo; the dsh-web half of these
changes (like groq/elevenlabs) activates on the next `dsh-web` restart, the
client half on page reload.
