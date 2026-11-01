# dsh-tts-reader (retired)

The TTS Reader sidebar tab now ships inside **dsh-voice 2**, with the same tab id (`dsh-tts-reader:main`) and title, so a saved sidebar layout keeps it.

This package is a stub: it keeps profiles that still list `dsh-tts-reader` loading, registers nothing (so there is never a second Reader tab) and no longer requires `dsh-better-sidebar`. Remove it from the profile when convenient.

Browser preferences of the old tab (`dsh-tts-reader.text`, `.model`, `.rate`, `.voice.*`) are left in place; dsh-voice 2 starts from the saved text, the model pick and its voice.

---

Made by Luca Tzekos for [Job Opportunities API](https://jobopportunitiesapi.org).
