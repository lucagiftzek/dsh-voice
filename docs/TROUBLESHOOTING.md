# Troubleshooting dsh-voice

Checked on: DSH 0.1.5-rc.1 and 0.2.1-rc.5, plugin 2.0.0-rc.2.

<a id="start-here"></a>
**Start here.** Ask your agent to load the `voice-doctor` skill, or run the doctor
yourself (it is read-only, makes no paid call and prints no secret):

```bash
curl -s <dsh-url>/api/voice/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.status,r.host);for(const c of r.checks)console.log(c.status,c.id,c.code||"",typeof c.detail==="string"?c.detail:JSON.stringify(c.detail||""))})'
```

Every error the plugin returns carries a `code`; look it up in [ERRORS.md](ERRORS.md).
`<dsh-url>` is where your DSH web UI answers (for example `http://127.0.0.1:3080`).

## Quick index

| # | Symptom (what you see) | Most likely cause | Jump |
|---|---|---|---|
| 1 | No sound, or the Read aloud button does nothing | no provider configured or key missing; auto chain ends at the browser voice; browser autoplay policy | [1](#t-no-audio) |
| 2 | The microphone does not start, or dictation returns nothing | microphone permission, page not on https or localhost, no speech-to-text provider | [2](#t-dictation) |
| 3 | Saving in Settings > Voice is refused | Host not in `security.trustedHosts`, cross-site or stale token, provider entry points at a disallowed host | [3](#t-settings-refused) |
| 4 | The wrong language is spoken or detected | detection mode, no model service, language not enabled, per-language provider | [4](#t-wrong-language) |
| 5 | Word highlight is out of sync or missing | provider without word timings (estimate used), browser lacks the Custom Highlight API | [5](#t-highlight) |
| 6 | A self-hosted engine (Kokoro, Piper, XTTS, OpenAI-compatible) is unreachable | wrong base URL, loopback vs LAN bind, firewall, missing key | [6](#t-engine-unreachable) |
| 7 | A model stops working or a retirement note shows in Settings | the vendor retired the model | [7](#t-retirements) |
| 8 | Data must stay in the EU | provider residency, region not chosen, live recognition in the browser | [8](#t-residency) |
| 9 | The provider bill is higher than expected | billed characters, auto-read, word timings, retries | [9](#t-cost) |
| 10 | Settings do not save or reset (DSH 0.2.x) | Config not visible, profile row, a script rewriting `settings.yaml` | [10](#t-settings-not-saved) |
| 11 | The TTS Reader tab is duplicated or missing | the old reader package still bundled, or the sidebar host absent | [11](#t-reader-tab) |
| 12 | Does the plugin need dsh-better-sidebar? | it is optional | [12](#t-sidebar-optional) |
| C1 to C7 | Install and update problems shared by DSH plugins | | [Common install problems](#common-install-problems-on-dsh) |

## 0. Collect facts (read-only, always safe)

```bash
dsh --version
D="${DSH_HOME:-$HOME/.dsh}"
# plugin directory and version
node -p "const p=require('path').dirname(require.resolve('dsh-voice/package.json',{paths:['$D/profiles/web']}));p+' '+require(p+'/package.json').version"
# self-check
curl -s <dsh-url>/api/voice/doctor
# what routing resolves to right now (provider ids and availability, no secrets)
curl -s <dsh-url>/api/voice/config | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("defaults",JSON.stringify(r.defaults));for(const p of r.providers)console.log(p.id,p.type,"enabled="+p.enabled,"tts="+p.tts,"stt="+p.stt,p.residency)})'
# plugin data directory and file modes (names and modes only, never print the files)
ls -la "${DSH_VOICE_DATA_DIR:-$HOME/.config/dsh-voice}"
# recent plugin log lines carry the error code first
journalctl -u <your-dsh-unit> --since "1 hour ago" | grep -E 'VOICE_|dsh-voice' | tail -40
```

The settings store mode is in the doctor report (`host.settingsMode`: `register` on
DSH 0.1.5, `forms` on 0.2.x, `config` when no settings service is wired).

<a id="t-no-audio"></a>
## 1. No sound, or the Read aloud button does nothing

**Likely causes** (most likely first)
1. No usable provider: nothing is configured, a key is missing, or the provider is
   disabled. Auto routing then ends at the browser voice, which may have no voices.
2. A provider is chosen explicitly but is not available (key pointer does not resolve,
   service down). The route answers `VOICE_PROVIDER_UNAVAILABLE` (HTTP 503).
3. The browser blocked playback: autoplay policy lets audio start only after the page
   had a click or key press (affects auto-read of new replies most).
4. The provider refused the call (bad key, no credits, language not covered): codes
   `VOICE_PROVIDER_AUTH`, `VOICE_PROVIDER_QUOTA`, `VOICE_PROVIDER_LANGUAGE`.
5. Auto routing: the shipped chain sends English to one cloud engine, then another,
   and other languages to a local engine; ElevenLabs, Groq and Alibaba stay out of
   automatic routing unless legacy engines are on. If none of the chain is configured
   the browser voice is used.

**Diagnose** (read-only)
```bash
curl -s <dsh-url>/api/voice/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);for(const c of r.checks.filter(c=>["providers","routing"].includes(c.id)))console.log(c.status,c.id,c.code||"",JSON.stringify(c.detail))})'
curl -s <dsh-url>/api/voice/config | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify(r.defaults),JSON.stringify(r.routes))})'
```
Expected when healthy: the `providers` check is `ok` and `defaults.tts` is a provider id
other than `browser`. `defaults.tts` equal to `browser` = cause 1 or 5. In the browser,
open the devtools console: `NotAllowedError` from `play()` = cause 3.

To prove a provider end to end, use the Test button of its row in Settings > Voice
(it speaks one short phrase, so it spends a few characters at a paid provider) **[HUMAN]**.

**Fix**
- Cause 1, 2, 5: in Settings > Voice add a provider and press Test, or export the key the
  provider type expects to the environment of `dsh web` and restart **[HUMAN]**
  (the credential pointer forms are in the README, "Credentials"). A key stored through
  Settings lives in the plugin's own `vault.json`, not in the environment.
- Cause 3: click once anywhere in the chat, then press Read aloud again; for auto-read,
  interact with the page before the reply finishes.
- Cause 4: follow the code in [ERRORS.md](ERRORS.md) (renew the key, add credits, pick a
  provider that covers the language).
- No browser voices: install a speech engine for the browser or add a real provider.

**Verify**
```bash
curl -s <dsh-url>/api/voice/config | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).defaults))'
```
`tts` is a real provider id, and Read aloud plays.

**Related codes:** `VOICE_PROVIDER_UNAVAILABLE`, `VOICE_NO_PROVIDER`, `VOICE_ROUTE_UNRESOLVED`,
`VOICE_PROVIDER_AUTH`, `VOICE_PROVIDER_QUOTA`, `VOICE_PROVIDER_LANGUAGE`, `VOICE_BROWSER_ONLY`.

<a id="t-dictation"></a>
## 2. The microphone does not start, or dictation inserts nothing

**Likely causes**
1. The browser needs a **secure context** for the microphone: `https://` or `localhost`.
   A plain `http://` address on another machine is refused (message
   `microphone unavailable: ...`).
2. Microphone permission was denied for the site (or the OS blocks the browser).
3. No speech-to-text provider is usable, so `POST /api/voice/stt` answers 503
   (`VOICE_PROVIDER_UNAVAILABLE`, message "no speech-to-text engine is configured").
4. The browser's own Web Speech recognition is not available (only some browsers have it);
   it is used only when live recognition is switched on (`dictation.liveInterim`, off by
   default) or when the browser voice is the chosen engine.
5. The provider failed (key, quota, timeout): `VOICE_PROVIDER_AUTH`, `VOICE_PROVIDER_QUOTA`,
   `VOICE_PROVIDER_TIMEOUT`, `VOICE_PROVIDER_FAILED`.

**Diagnose**
```bash
curl -s <dsh-url>/api/voice/config | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("stt default:",r.defaults.stt);console.log(JSON.stringify(r.dictation))})'
```
`stt default: null` = cause 3. In the browser console run
`window.isSecureContext` (must be `true`) and
`navigator.permissions.query({name:"microphone"}).then(p=>p.state)` (`denied` = cause 2).
`"SpeechRecognition" in window || "webkitSpeechRecognition" in window` tells cause 4.

**Fix**
- Cause 1: open DSH over https (a reverse proxy with a certificate) or on `localhost`.
- Cause 2: allow the microphone in the site settings of the browser (and the OS privacy
  settings) **[HUMAN]**, then reload the tab.
- Cause 3: configure a provider that does speech to text (Settings > Voice, Test button).
- Cause 4: use a browser with Web Speech, or rely on a provider (the default path records in
  the page and sends the audio to the provider through the DSH server).
- Cause 5: follow the code in [ERRORS.md](ERRORS.md).

**Verify:** press the microphone, say a short sentence, release; the text appears at the
composer cursor.

**Related codes:** `VOICE_PROVIDER_UNAVAILABLE`, `VOICE_PROVIDER_AUTH`, `VOICE_PROVIDER_QUOTA`,
`VOICE_PROVIDER_TIMEOUT`, `VOICE_PROVIDER_FAILED`, `VOICE_RATE_LIMITED`, `VOICE_BAD_REQUEST`.

<a id="t-settings-refused"></a>
## 3. Saving in Settings > Voice is refused

Writes are guarded by layers: loopback peer (L1), trusted Host and same origin (L2), a
short-lived capability token (L3), the DSH browser-session cookie (L4). The response
`VOICE_WRITE_REFUSED` names the `layer` and the reason.

**Likely causes**
1. **Host check (L2):** DSH is opened through a host name that is not loopback and not in
   `security.trustedHosts` (typical behind a reverse proxy or on a LAN name). Reads
   (`VOICE_READ_REFUSED`) fail the same way.
2. **Cross-site or missing Origin (L2):** the request came from another site, a script
   without `Origin`, or a content type other than JSON. Cross-site POSTs to the speech
   routes are refused with `VOICE_CROSS_SITE`.
3. **Token expired (L3):** the page was open for more than about 15 minutes. Reload the tab.
4. **No session cookie (L4):** the proxy strips cookies, or `security.requireHarnessCookie`
   is on and the browser has no DSH session.
5. **Provider entry rejected:** `VOICE_PROVIDER_ENTRY_REJECTED`. A cloud provider must use
   https on a public host; metadata addresses, credentials inside the URL and internal
   addresses are refused (only self-hosted provider types may point at loopback or LAN);
   a stored key may only be used by its own provider.

**Diagnose**
```bash
curl -s -i <dsh-url>/api/voice/settings | head -20   # 403 body names the reason; 200 = reads are fine
curl -s <dsh-url>/api/voice/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);for(const c of r.checks.filter(c=>c.id==="trusted-hosts"))console.log(c.status,c.detail)})'
```
The error body of the refused save has `layer` and `message`; the browser network tab shows it.

**Fix**
- Cause 1: add the public host name to `security.trustedHosts`. On DSH 0.1.5:
  `dsh-voice: { security: { trustedHosts: [your.host] } }` in `$DSH_HOME/settings.yaml`.
  On 0.2.x: in the profile row `- id: voice`, under `config:`, key `security`, `trustedHosts`
  (a partial `security` section is accepted). Back up the file first **[HUMAN]**, because it
  edits DSH configuration; the change applies live on 0.2.x, on 0.1.5 after a restart.
- Cause 2: use the Settings page of DSH in a normal browser tab, not a script.
- Cause 3: reload the tab. Cause 4: make the proxy pass cookies and `Host` unchanged.
- Cause 5: correct the URL of the entry; use a self-hosted type for a local server, https for a cloud one.

**Verify:** save again; the response is the redacted settings view and the row shows the new value.

**Related codes:** `VOICE_WRITE_REFUSED`, `VOICE_READ_REFUSED`, `VOICE_CROSS_SITE`,
`VOICE_UNTRUSTED_REQUEST`, `VOICE_SESSION_NOT_READY`, `VOICE_PROVIDER_ENTRY_REJECTED`,
`VOICE_TRUSTED_HOSTS_UNSET`.

<a id="t-wrong-language"></a>
## 4. The wrong language is spoken or detected

**Likely causes**
1. The language is not in `languages.enabled`, so it falls into the `*` row.
2. `detection.mode` is `off` or `heuristic`: short or mixed sentences follow their
   neighbours (by design) and are not sent to a model.
3. The model pass cannot run: the host has no model service (`detection.llm` false in
   `/api/voice/config`), the chosen model is unavailable, or the call exceeded
   `detection.timeoutMs`. The heuristics then stand and nothing fails.
4. The language row routes to a provider that does not cover the language (see the language
   list under the provider row); a manual provider pick in the composer overrides rows.
5. A text marker forces a language (`[[el]]` is sticky until `[[auto]]` or `[[/]]`).

**Diagnose** (heuristics only, no model tokens spent)
```bash
curl -s -X POST <dsh-url>/api/voice/detect -H 'content-type: application/json' -d '{"text":"Hello there. Καλημέρα σε όλους. Ciao a tutti.","mode":"heuristic"}'
curl -s <dsh-url>/api/voice/config | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify(r.detection),JSON.stringify(r.languages),JSON.stringify(r.routes))})'
```
Each returned segment has a language, a source and a confidence.

**Fix:** enable the language; set `detection.mode` to `heuristic+model` and pick a
model in Settings; give each language its own provider row; remove a stray marker; pass an
explicit marker `[[it]]...[[/]]` for text that detection cannot decide.

**Verify:** run the detect call again with `"mode":"heuristic+model"` (spends a little model
tokens **[HUMAN]** if the model is a paid one) or listen to the badge (EN, IT, EL) while reading.

**Related codes:** `VOICE_PROVIDER_LANGUAGE`, `VOICE_ROUTE_UNRESOLVED`, `VOICE_RATE_LIMITED`.

<a id="t-highlight"></a>
## 5. Word highlight is out of sync, or missing

**Likely causes**
1. The provider returns no word timings, so the word position is a proportional estimate
   (letters per word plus pauses, scaled to the real audio length). It drifts on long
   sentences or unusual text. The timing badge on the provider row says "word timings" or
   "estimated".
2. `reading.highlight` is `sentence` or `off`.
3. The browser lacks the CSS Custom Highlight API (`CSS.highlights`); only the page
   scroll and the player work then.
4. The chat DOM changed while reading (the reply re-rendered); the highlight is rebuilt on
   the next sentence.

**Diagnose:** browser console: `typeof CSS !== "undefined" && "highlights" in CSS` must be
`true`. Settings > Voice: provider timing badge. `reading.highlight` in
`curl -s <dsh-url>/api/voice/config` (key `reading`).

**Fix:** pick a provider with timings for that language (the README lists them), set
`reading.highlight` to `word`, update the browser. Estimated timing is expected behaviour,
not a fault.

**Verify:** read a short reply; the sentence is lit and, with timings, the word moves with the voice.

**Related codes:** none (no error is raised; this is a capability limit).

<a id="t-engine-unreachable"></a>
## 6. A self-hosted engine is unreachable

Applies to Kokoro, Piper, XTTS, an OpenAI-compatible server, an ElevenLabs-compatible
server and the local engine. The DSH server calls the engine, not the browser, so CORS is
never involved.

**Likely causes**
1. Wrong base URL or port (check the type's default in Settings).
2. Loopback vs LAN: the engine listens on `127.0.0.1` of another machine or container, or
   DSH runs in a container where `127.0.0.1` is the container itself.
3. A firewall or the engine is not running.
4. The engine needs an API key that is not set (401 or 403).
5. Settings refuse the URL (`VOICE_PROVIDER_ENTRY_REJECTED`): see entry 3.

**Diagnose** (read-only; any HTTP status, even 404, means the port answers)
```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 2 <engine-base-url>/
ss -ltn | grep ':<engine-port>'     # on the engine host: bound to 127.0.0.1 or to all interfaces?
curl -s <dsh-url>/api/voice/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const c of JSON.parse(s).checks.filter(c=>c.id==="engines"))console.log(c.status,c.code||"",JSON.stringify(c.detail))})'
```
No answer (`000`) = causes 1 to 3. `401`/`403` = cause 4.

**Fix:** correct the base URL in Settings; bind the engine to the interface DSH can reach
(or publish its port) **[HUMAN]**; open the firewall for the DSH host only **[HUMAN]**; set
the key the engine expects.

**Verify:** the curl above prints an HTTP status; the Test button of the row passes.

**Related codes:** `VOICE_ENGINE_UNREACHABLE`, `VOICE_PROVIDER_UNAVAILABLE`,
`VOICE_PROVIDER_TIMEOUT`, `VOICE_PROVIDER_FAILED`, `VOICE_PROVIDER_ENTRY_REJECTED`.

<a id="t-retirements"></a>
## 7. A model stops working, or Settings shows a retirement note

Vendors retire models on published dates. The plugin knows the OpenAI ones and shows a
note on the provider row (source and dates: `lib/shared/retirements.js`): the speech
models `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` have no successor on the speech endpoint
(2027-01-06), and the transcription models `whisper-1` and the `gpt-4o-transcribe` family
are replaced by `gpt-transcribe` (2027-02-26). Check the vendor's deprecation page; dates
change.

**Diagnose:** Settings > Voice, the note under the OpenAI or OpenAI-compatible row;
`curl -s <dsh-url>/api/voice/doctor` lists them in the `retirements` check. After a
retirement date the vendor answers an error, shown as `VOICE_PROVIDER_FAILED`.

**Fix:** switch the row's model to the successor, or move that language to another provider.
Self-hosted engines keep working with their own models.

**Verify:** Test button on the row.

**Related codes:** `VOICE_PROVIDER_FAILED`, `VOICE_PROVIDER_VOICE`.

<a id="t-residency"></a>
## 8. EU endpoints and data residency

Each provider row shows a residency badge: EU (EU company and processing), EU region
available (non-EU company, EU region chosen explicitly in the instance), outside the EU,
self-hosted, on device. Text and audio you send to a provider go to that provider.

**Check:** `curl -s <dsh-url>/api/voice/config` lists `residency` per provider. A provider
left on its default endpoint of a non-EU company is outside the EU even if an EU region
exists. Chrome's live speech recognition (`dictation.liveInterim`, off by default) sends
audio to the browser vendor.

**Fix:** choose providers in the EU group or self-hosted ones; for an "EU region available"
provider, add the instance with its EU endpoint or region and make the language rows use it;
keep `dictation.liveInterim` off. Some EU endpoints need a vendor-side approval
**[HUMAN]** (provider console).

**Verify:** the row badge reads EU or self-hosted, and every language row in
`routes` resolves to such a provider.

**Related codes:** none.

<a id="t-cost"></a>
## 9. Cost surprises

Providers bill what they synthesise or transcribe, in characters or seconds, including
long replies, code blocks read with the `{ }` button, auto-read of every new reply, and
repeated reads.

**Likely causes:** `reading.autoRead` is on; a very long reply read in full; word timings
that cost a second call at some providers (the provider note says so); a Test button used
repeatedly; dictation polish using a paid model; fallbacks chained to a paid provider.

**Diagnose:** `reading.autoRead` in `/api/voice/config`; the provider's own billing page
**[HUMAN]**; for ElevenLabs `GET <dsh-url>/api/voice/quota`. Rate limits per minute bound
the burst (`security.rateLimit`, `VOICE_RATE_LIMITED`).

**Fix:** set `reading.autoRead` to `off`; use a self-hosted or browser voice for routine
reading; lower the per-minute limits; keep paid providers only as fallbacks of the languages
that need them.

**Verify:** the provider's usage page after a normal day **[HUMAN]**.

**Related codes:** `VOICE_RATE_LIMITED`, `VOICE_PROVIDER_QUOTA`.

<a id="t-settings-not-saved"></a>
## 10. Settings do not save, or reset (DSH 0.2.x)

See also C3 below. Specific to this plugin:

**Likely causes**
1. `Config` is not visible to the loader: the doctor check `config` fails (no schema
   library found), so 0.2.x shows no form.
2. The doctor reports `settingsMode: config`: no settings service is wired and values go to
   the plugin's own `settings.json` in the data directory.
3. The profile row for `voice` was edited by hand with an invalid value, or a home patch
   or command-line overlay sets the same key and wins.
4. A script rewrites `settings.yaml`; 0.2.x imports it again at each boot.
5. Provider keys typed in Settings are kept in `vault.json` (not in the profile row): a
   missing `vault.json` loses them while the row still says `vault:<id>`.

**Diagnose**
```bash
curl -s <dsh-url>/api/voice/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.host.settingsMode);for(const c of r.checks.filter(c=>["settings","config","data-dir","files"].includes(c.id)))console.log(c.status,c.id,c.code||"",JSON.stringify(c.detail))})'
D="${DSH_HOME:-$HOME/.dsh}"; grep -n -A12 -- '- id: voice' "$D/profiles/web/cordis.patch.yml"   # may hold settings, do not paste it anywhere
```

**Fix:** use the settings mode the doctor expects (`forms` on 0.2.x, `register` on 0.1.5);
correct or remove the bad value in the row after a backup **[HUMAN]**; stop scripts that
rewrite `settings.yaml`; restore `vault.json` from a backup or re-enter the key.

**Verify:** change a setting, reload the tab, it persists; the doctor shows no warning for these checks.

**Related codes:** `VOICE_SETTINGS_NOT_WIRED`, `VOICE_CONFIG_NOT_VISIBLE`, `VOICE_DATA_DIR_UNWRITABLE`, `VOICE_FILE_MODE`.

<a id="t-reader-tab"></a>
## 11. The TTS Reader tab is duplicated or missing

The TTS Reader tab now ships inside dsh-voice (tab id `dsh-tts-reader:main`). The old
`dsh-tts-reader` package is a stub that registers nothing, so a second tab means an old
copy of the previous reader is still loaded.

**Likely causes:** (1) an old reader bundle (not the stub) is still in the profile's bundle
list; (2) `dsh-better-sidebar` is missing or too old, so no tab can be registered (everything
else still works); (3) the saved sidebar layout hides the tab.

**Diagnose**
```bash
D="${DSH_HOME:-$HOME/.dsh}/profiles/web"
node -e 'const p=require(process.argv[1]);console.log((p.dsh?.profile?.bundles||[]).join("\n"))' "$D/package.json" | grep -n -E 'dsh-voice|tts-reader|better-sidebar'
```
Browser console: a line from the stub says it is retired; a line from the plugin saying the
reader tab was not registered points to cause 2.

**Fix:** remove the old reader package (or replace it by the stub) from the bundle list and
restart `dsh web` **[HUMAN]**; install or update `dsh-better-sidebar` (see C4 for version
notes); reset the sidebar layout from the sidebar menu.

**Verify:** exactly one "TTS Reader" tab appears.

**Related codes:** none.

<a id="t-sidebar-optional"></a>
## 12. dsh-better-sidebar is optional

The plugin injects the sidebar host optionally. Without it only the TTS Reader tab is
absent; Read aloud, dictation, shortcuts and Settings load as usual. If the whole web UI
fails to render after an update, it is not this plugin's sidebar inject: follow C4.

**Verify:** `package.json` of the installed plugin lists only the chat and conversation
client injects as required.

**Related codes:** none.

<!-- dsh-common-install:v1 -->
## Common install problems on DSH

Placeholders: `<dsh-url>` is where your DSH web UI answers (for example
`http://127.0.0.1:3080`), `DSH_HOME` defaults to `~/.dsh`, the profile is `web`.

<a id="c1-not-loaded"></a>
### C1. The plugin does not appear at all (no speaker button, no settings, no tools)

**Causes:** (1) the package is installed but not in the profile's bundle list;
(2) it is in the list but `dsh web` was not restarted; (3) DSH refused it as
incompatible (engines or peer range); (4) its server entry threw at start.

**Diagnose**
```bash
D="${DSH_HOME:-$HOME/.dsh}/profiles/web"
node -e 'const p=require(process.argv[1]);console.log((p.dsh?.profile?.bundles||[]).join("\n"))' "$D/package.json" | grep -n 'dsh-voice' || echo "NOT IN BUNDLES"
ls -la "$D/node_modules/dsh-voice" 2>/dev/null || echo "NOT INSTALLED"
dsh --profile web --dump-config 2>/dev/null | grep -n -i 'voice' | head    # composed tree, does not boot
# DSH log: the terminal running `dsh web`, or your service manager, e.g.
journalctl -u <your-dsh-unit> --since "1 hour ago" | grep -i -E 'dsh-voice|voice|incompatible|skipped|exemption' | tail -40
```

**Fix:** install with `dsh plugin --profile web add dsh-voice` (it adds the package to
`dsh.profile.bundles` when the package declares `dsh.bundle`), then restart
`dsh web` **[HUMAN if your chat runs inside dsh web]**. If the log says the bundle
was skipped as incompatible, update the plugin; DSH 0.2.x also offers an exact-version
exemption (`dsh plugin allow-version`, see the log message), which must be granted
again after every DSH version change.

**Verify:** the speaker button and the Voice settings page appear; `curl -s -o /dev/null -w '%{http_code}\n' <dsh-url>/api/voice/doctor` prints `200`.

<a id="c2-route-404"></a>
### C2. Every plugin route answers 404

**Causes:** the plugin's server half is not loaded (C1), or it was updated and the
running `dsh web` still has the old server code (the client half hot-reloads, the
server half loads only at start). A 404 on ONE path while others answer means a
wrong path, not a load problem.

**Diagnose**
```bash
for p in doctor config does-not-exist; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' <dsh-url>/api/voice/$p)"; done
```
All 404 = route prefix not registered. `200` on doctor and config and `404` on the last = healthy.
(The plugin's own unknown-route answer is JSON with code `VOICE_ROUTE_NOT_FOUND`; a bare
HTML 404 comes from DSH or a proxy.)

**Fix:** restart `dsh web` **[HUMAN]**. If you open DSH through a browser login or a
reverse proxy, check the proxy forwards `/api/voice/` to DSH. After a restart the
web UI may ask you to open the launch URL again (the one `dsh web` prints, with its
one-time token); that is expected and unrelated to plugin routes.

<a id="c3-settings-not-saved"></a>
### C3. Settings do not save, or reset after a restart

**Causes by DSH line:**
- **0.1.5:** the plugin registers a settings namespace; values live in
  `$DSH_HOME/settings.yaml` under the plugin's section. A hand edit with a YAML error
  makes the whole file unreadable.
- **0.2.x:** settings are forms over the plugin's exported `Config`; values live in
  `$DSH_HOME/profiles/web/cordis.patch.yml` under the row `- id: voice` `config:`.
  (a) Only fields marked live (`volatile`) are editable in forms; others are edited in
  the row and remount the plugin. (b) The loader reads `Config` from the DEFAULT export
  when the module has one: a plugin that exports `default { name, apply }` without
  `Config` gets no form. (c) A plugin that touches `ctx.settings` without declaring
  `inject: ['settings']` throws on 0.2.x. (d) A home patch or command-line overlay that
  sets the same key wins, and the form write is refused. (e) On first boot 0.2.x renames
  `settings.yaml` to `settings.yaml.imported` and imports only sections whose name equals
  an entry id with all keys declared live; a `settings.yaml` that reappears (a script
  rewriting it) is imported AGAIN at every boot and overwrites profile rows.

**Diagnose**
```bash
dsh --version
curl -s <dsh-url>/api/voice/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.host);for(const c of r.checks)console.log(c.status,c.id,c.detail||"")})'
D="${DSH_HOME:-$HOME/.dsh}"; ls -la "$D/settings.yaml" "$D/settings.yaml.imported" 2>/dev/null
grep -n -A12 -- '- id: voice' "$D/profiles/web/cordis.patch.yml"   # 0.2.x row (may contain secrets: do not paste it anywhere)
```

**Fix:** use a plugin version that supports your DSH line (the doctor's `settingsMode`
must not be `config` on a normal install). On 0.2.x stop any script that rewrites
`settings.yaml`, and edit non-live fields in the row. Back up the file before any hand
edit (`cp file file.bak-$(date +%Y%m%d)`).

<a id="c4-gui-blank"></a>
### C4. After a DSH update the web UI does not render ("Failed to load plugins", blank page)

**Causes:** on 0.2.x an unmet REQUIRED client inject stops the whole GUI, not just one
plugin. Typical: a plugin requires `dsh-better-sidebar` (or another client service) and
that package was refused as too old for the new DSH. Older plugin builds that require
their sidebar host are affected; current ones inject it optionally.

**Diagnose:** browser devtools console (the first red error names the plugin), and the
DSH log for `skipped` / `incompatible` bundles (C1 command).

**Fix:** update `dsh-better-sidebar` (0.28 or newer for DSH 0.2.1) and the plugin;
or disable the failing bundle by row and restart **[HUMAN]**:
```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: voice
  disabled: true
```

<a id="c5-model-404"></a>
### C5. After a DSH update every model turn fails (HTTP 404) for one provider

**Cause:** an environment variable such as `DEEPSEEK_BASE_URL` changed meaning between
DSH lines (0.1.5: plain API host; 0.2.x: the Anthropic-messages base, for example
`https://api.deepseek.com/anthropic`). Not a plugin bug, but it looks like one.

**Fix:** set the base URL the new line expects (env or the provider row), restart **[HUMAN]**.

<a id="c6-oom-install"></a>
### C6. The machine runs out of memory during an install

**Cause:** a profile-level `pnpm install` (or `npm i -g` of the harness) can grow to many
GB on a large profile; with swap full, the kernel or earlyoom kills unrelated services.

**Fix:** check `free -m` first, then install inside a memory-capped scope:
```bash
systemd-run --user --scope -p MemoryMax=3G dsh plugin --profile web add dsh-voice
# pnpm only: add --child-concurrency 1 to reduce peak memory
```
A runaway then kills only itself. Check afterwards that your other services are up.

<a id="c7-stale-client"></a>
### C7. UI shows new options but they do nothing, or "restart dsh web" banners

**Cause:** the client half (browser bundle) hot-reloaded, the server half did not. Mixed
versions are tolerated by design, but new server features stay off until a restart.
**Fix:** restart `dsh web` when convenient **[HUMAN]**; reload the browser tab.
<!-- /dsh-common-install -->
