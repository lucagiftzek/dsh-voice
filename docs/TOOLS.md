# Speech tools (model-facing)

dsh-voice gives the assistant four tools: read how a text will be spoken, turn text into an mp3, announce something out loud, and stop it. They call the same providers, voices and annotation layer the readers use, so a tool never sounds different from the same pick in the UI.

If your DSH host has no tools service, or predates the tool runtime, the plugin still serves speech normally and simply registers nothing. The log line says `tools skipped`.

## What the model gets, and what your screen gets

Each tool returns a short sentence for the transcript plus a small payload the interface may use. That payload is never shown to the model: a `presentationMeta` projection keeps the model's view clean while the UI learns which clip to play.

## `voice_annotations`

Shows what a text will do when a model speaks it, and optionally returns it ready to speak.

| argument | type | meaning |
|---|---|---|
| `text` | string, required | up to 20000 characters |
| `provider` | string | provider id, defaults to `tools.provider` from the settings |
| `model` | string | model id when a provider has several |
| `wrap` | boolean | return the text marked up with the annotations this model accepts |
| `tone` | string | with `wrap`, one tone for the passage (`warm`, `calm`, `excited`, ...) |

The answer names the annotation family in play, how many markers the text carries, which ones this model keeps and which it drops. Use it before `voice_speak` when delivery matters, so you are not guessing whether a model wants `[emotion=x]`, `[x]` or `<x>`.

## `voice_speak`

Text in, mp3 on disk.

| argument | type | meaning |
|---|---|---|
| `text` | string, required | up to 20000 characters |
| `provider`, `voice`, `model`, `language` | string | override the settings for this one call |
| `filename` | string | base name of the mp3; anything resembling a path is flattened and stripped of directories |
| `speed` | number | 0.5 to 2 |

A long passage is split on sentence boundaries into numbered clips (`name-01.mp3`, `name-02.mp3`, ...) for engines that synthesise a whole utterance per call, so you hear the first sentence instead of waiting for the last. All clips are returned, so a player can queue them.

Clips are written **only inside your home directory**, `0600`, into `tools.clipDir` (default `~/reports/voice-clips`). A path outside it is refused with the message `saveTo must be inside the home directory`.

## `voice_announce` and `voice_announce_stop`

`voice_announce` synthesises a short message (up to 2000 characters) and speaks it immediately, returning an id. `voice_announce_stop` stops it, by that id or, with no id, whatever is playing. Stopping when nothing plays is not an error, and says so.

## Settings

Everything the tools use lives in the plugin's configuration, so it is visible in Settings and never hardcoded:

```yaml
- id: voice
  config:
    tools:
      provider: ''        # empty: the routed default
      voice: ''           # empty: the provider default
      model: ''
      language: ''
      clipDir: ''         # empty: ~/reports/voice-clips
      chunkChars: 400     # longest piece a whole-utterance engine receives
```

## In the transcript

`voice_speak` results appear with a player at the end of the turn, beside the file and image cards, one player per clip. `voice_announce` shows the same player and a stop control. Choosing whether playback begins by itself is a browser decision: a page you have not touched may wait for one click before sound starts.

## Errors

A failure returns `ok: false` with an `error` string, and the transcript sentence names the failing piece. Nothing is written when the engine refuses, so a failed `voice_speak` leaves no half-file behind.

## The route behind the players

The players fetch their clips from the plugin itself: `GET /api/voice/clips/<name>`. Only a bare file name ending in `.mp3` is accepted, from the configured clip directory, so a request cannot reach another folder or another kind of file. Anything else answers `VOICE_BAD_REQUEST`, which was verified against traversal (`..%2f`), a missing file and a wrong extension.
