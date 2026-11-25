# What is coming in 2.1.0

> This page describes the release on the `release/squash` branch. It is not part of a published package yet, so it does not ship with one.

The `main` branch of this repository is the released **2.0.1**. The next release is built and tested on the branch
`release/squash`, which sits directly on top of it: one commit, no history rewritten. This page says what changes for
you, so you can read and try it before `main` moves.

## Try it before it lands

```
git clone -b release/squash https://github.com/lucagiftzek/dsh-voice
cd dsh-voice && npm install && npm test
```

The suite is 400 tests and it is the same one that guards this repository. Nothing in the release depends on a machine
of the author's: no host names, no private paths, no credentials.

## What changes

**Speech annotations.** One in-text syntax for the person writing: `[tone=happy]`, `[pace=slow]`, `[pitch=high]`,
`[volume=soft]`, `[emphasis]`, `[laugh]`, `[pause]`, `[slightly sad]`. Each is adapted to the selected model from that
vendor's own documentation, and removed for any model that cannot take it. A pause becomes a real silence everywhere.
Brackets that are not annotations, such as `[1]` or `[Section 4]`, stay text.

**Providers.** A new `openrouter` type speaks through `POST /v1/audio/speech` and transcribes through
`/v1/audio/transcriptions` with one key, using the live speech catalogue so a model added on OpenRouter appears without
a plugin change. A new `supertonic` type runs Supertonic 3 on your own machine: ten voices over 31 languages including
Greek, beside Kokoro, which now serves all 54 voices of its installed pack in nine languages instead of 14 English ones.

**The readers.** Voice pickers follow Provider > Model > Language > Accent > Voice > Tone, each step appearing only when
the chosen voices carry it, with a star that saves the combination as a preset. Model and voice now follow each other
where a provider publishes a catalogue.

**Speech tools for the assistant.** Four model-facing tools: `voice_annotations` shows how a text will be spoken and can
wrap it for a tone, `voice_speak` turns text into an mp3, `voice_announce` says something out loud now and
`voice_announce_stop` ends it. A player appears at the end of the turn beside the file cards. See
[TOOLS.md](TOOLS.md) on the release branch.

**Browser voice.** A Natural or Neural cloud voice, which Edge and Windows ship, now beats the mechanical offline set,
while an ordinary online voice is still never picked. A voice name you configure wins.

## What does not change

- The HTTP routes `GET /config`, `POST /tts`, `POST /stt` and `POST /polish`, and their error shapes. `POST /tts` gains
  an optional `saveTo` for a tool that wants a file; without it the response is the same audio stream as before.
- Your settings keep working: the plugin reads the same rows, and a missing key still falls back to its environment
  equivalent.
- The plugin still runs on DSH 0.2.x and 0.1.5, and the client half keeps the same slots plus one new entry for the
  clip player.

## One thing to know before you upgrade

The package name is the open question in this release. `2.0.1` is published on npm as `@lucagiftzek/dsh-voice`; the
release branch names the package `dsh-voice`. The client bundle identifies itself with the package name, and a loader
matches a running plugin by that string, so pick the install you mean:

- from npm, keep `@lucagiftzek/dsh-voice`;
- from the repository, install by path and the name in `package.json` is what a loader will look for.

Whichever you choose, do not upgrade across the two names in place: uninstall the old one first, restart, then install
the new one. That is true of every DSH plugin, not only this one.
