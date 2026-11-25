---
name: voice-doctor
description: Diagnose and fix dsh-voice problems step by step (no audio, microphone and dictation, Settings > Voice writes refused, wrong language, word highlight, self-hosted engines, residency, cost). Load it when a /api/voice route fails, an error carries a VOICE_* code, or the user reports that Read aloud is silent, dictation does not start, or Settings will not save.
---

# dsh-voice doctor

## Rules
- Read-only checks first. Never print secrets: read keys into a command, never echo them.
  Never paste `vault.json`, `capability.secret`, a provider key or the profile row.
- Never restart `dsh web` yourself: the chat you are in may run inside it. Ask the human.
- Steps marked [HUMAN] need the human (restart, provider console, billing, microphone
  permission in the browser, router or firewall).
- Spending: only the Test button of a provider row and `POST /api/voice/tts` spend a few
  characters at a paid provider. Do not call them without telling the human.
- Stop and report after a fix; verify with the step given.

## 0. Facts (read-only)
1. Plugin dir: `node -p "require('path').dirname(require.resolve('dsh-voice/package.json', {paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))"`
   Docs are in `docs/TROUBLESHOOTING.md` and `docs/ERRORS.md` inside it
   (fallback: the GitHub repository of the plugin).
2. Doctor: `curl -s <dsh-url>/api/voice/doctor` (`<dsh-url>` is for example `http://127.0.0.1:3080`).
   Read `status`, `host.settingsMode`, and each check `id`, `status`, `code`.
3. Routing now: `curl -s <dsh-url>/api/voice/config` (keys `defaults`, `routes`, `providers`).
4. Data directory modes: `ls -la "${DSH_VOICE_DATA_DIR:-$HOME/.config/dsh-voice}"` (names only).
5. Log lines start with the code: `grep VOICE_` in the DSH log.

## 1. Decision tree
- Doctor answers 404 or HTML: plugin not loaded. TROUBLESHOOTING "Common install problems", C1 and C2. [HUMAN] restart.
- Doctor answers 403 `VOICE_READ_REFUSED`: Host not trusted. Entry 3 (add the host to `security.trustedHosts`) [HUMAN].
- Check `providers` fails or `VOICE_NO_PROVIDER`, or `defaults.tts` is `browser`: entry 1. Configure a provider (Settings > Voice) [HUMAN for the key].
- Check `routing` warns (`VOICE_ROUTE_UNRESOLVED`): a language row names an unavailable provider. Entry 1, then fix the key or the row.
- Check `engines` warns (`VOICE_ENGINE_UNREACHABLE`): entry 6. Run the curl of that entry against the base URL (any HTTP status = reachable). Bind, firewall: [HUMAN].
- Check `settings` or `config` warns (`VOICE_SETTINGS_NOT_WIRED`, `VOICE_CONFIG_NOT_VISIBLE`) or `data-dir` / `files` fail: entry 10 and C3. Mode fix: `chmod 600 <file>` is safe to apply (see section 2).
- Check `trusted-hosts` warns: entry 3.
- Check `client` fails (`VOICE_CLIENT_BUNDLE_MISSING`): C1; reinstall the plugin [HUMAN].
- Check `retirements` lists a model: entry 7. Change the model in Settings.
- Error code in a response:
  - `VOICE_PROVIDER_UNAVAILABLE`: entry 1 (key pointer, enabled flag, direction).
  - `VOICE_PROVIDER_AUTH`: key rejected. [HUMAN] new key.
  - `VOICE_PROVIDER_QUOTA`: no credits or throttled. [HUMAN] billing, or route to another provider.
  - `VOICE_PROVIDER_LANGUAGE` or `VOICE_PROVIDER_VOICE`: entry 4 or 7.
  - `VOICE_PROVIDER_TIMEOUT` or `VOICE_PROVIDER_FAILED`: entry 6 (engine) or 7 (retired model).
  - `VOICE_WRITE_REFUSED` with `layer`: entry 3. L3 = reload the tab. L2 = trusted hosts. L4 = proxy cookies.
  - `VOICE_PROVIDER_ENTRY_REJECTED`: entry 3, cause 5 (https and public host for cloud types).
  - `VOICE_RATE_LIMITED`, cost question: entry 9.
  - `VOICE_INTERNAL`: collect the log line and report a bug.
- No error, but the symptom is in the browser:
  - Silent Read aloud, no code: entry 1 (autoplay policy: one click on the page first).
  - Microphone: entry 2 (secure context `https` or localhost, permission, STT provider).
  - Highlight drift or missing: entry 5. Wrong language: entry 4 (use `"mode":"heuristic"` in `POST /api/voice/detect`).
  - Two or no TTS Reader tab: entries 11 and 12.
  - EU data question: entry 8.

## 2. Fixes you may apply
- `chmod 600` on `vault.json` and `capability.secret`, `chmod 700` on the data directory
  (verify with `ls -la`). Report that you did it.
- Nothing else without the human: Settings, the profile row, `settings.yaml`, bundle lists
  and restarts are the human's decision. Back up any file before an approved edit
  (`cp file file.bak-$(date +%Y%m%d)`).

## 3. Steps that need the human
- Restart `dsh web`: say why (the server half loads only at start; the client half hot-reloads).
- A new provider key, credits, EU approvals at the provider console.
- Microphone permission in the browser and OS.
- Binding an engine to another interface, opening a firewall, a reverse proxy change.
- Adding the public host to `security.trustedHosts` (profile row on 0.2.x, `settings.yaml` on 0.1.5).

## 4. Report back
Tell the human: the failing check or code, the cause in one sentence, what you changed (if
anything), what they must do (with the exact setting or command), and how you verified.
