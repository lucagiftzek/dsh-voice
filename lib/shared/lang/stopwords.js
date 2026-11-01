/**
 * dsh-voice: stopword lists and cue patterns for the Latin-script scorer
 * (spec 4.1 step 4). High-frequency function words only, lowercase, no
 * accents stripped (accents are evidence). Words that are common in several
 * of these languages ("a", "e", "o", "in", "no", "se", "la", "me", "de") are
 * left out of every list on purpose: they carry no signal.
 */

export const STOPWORDS = {
  en: 'the of and to is was for that with as on at by this be are from or an it its not but have has had were which their they you we he she his her them our will would can could should there what when who how all any been if into more most than then these those up out about after also just only over such very your my do does did said like because while where why yes'.split(' '),
  it: 'il lo gli le un una uno del della dei delle degli dello nel nella nei nelle sul sulla sui con per tra fra che non di da è sono era erano ho hai ha abbiamo avete hanno questo questa questi queste quello quella quelli anche come più ma perché quando dove cosa chi molto tutto tutti sempre già ancora ci ne si mi ti vi suo sua suoi loro nostro mio tuo essere fare stato stata qui oggi però allora poi dopo prima ogni ecco grazie ciao bene sì così'.split(' '),
  fr: 'le les des du une est sont avons avez ont déjà pour avec dans sur pas que qui mais ou où donc car ce cette ces nous vous ils elles leur leurs été être avoir fait très plus aussi comme tout tous toutes bien sans chez entre après avant oui merci bonjour aux au je tu il elle on mon ma mes ton ta tes son sa ses notre votre'.split(' '),
  de: 'der die das und ist nicht mit den dem des ein eine einen einem einer zu von im auf für sich es ich du er sie wir ihr sind war waren hat haben wird werden auch noch nur wie aber oder wenn dass nach bei aus um so schon sehr mehr kein keine ja nein danke bitte hier heute'.split(' '),
  es: 'el los las del una es son está están para con por que pero como más muy también ya todo todos esta este estos estas ese esa eso hay ser estar tiene tienen hace fue era sus su mi tu yo nosotros ellos ellas usted cuando donde porque sí gracias hola bien sin sobre entre hasta desde'.split(' '),
}

/** Cue patterns: [regex, weight]. Applied to the lowercased sentence. */
export const CUES = {
  en: [[/\b\w+ing\b/g, 0.6], [/\b\w+'s\b/g, 0.8], [/\b(i'm|don't|it's|can't|you're|we're|isn't|doesn't)\b/g, 1.2], [/\bth\w+/g, 0.3]],
  it: [[/[àèìòù]/g, 0.9], [/\w+zion[ei]\b/g, 1.2], [/\b(l|dell|nell|sull|all|dall|un|c|d|po)'/g, 1.4], [/\bgli\b|\bche\b/g, 0.8], [/\w+(ggio|zza|zze|tto|tta)\b/g, 0.4], [/\b\w+(are|ere|ire)\b/g, 0.3]],
  fr: [[/[éêâîôûëïüç]/g, 0.9], [/\b(l|d|j|qu|n|s|c)'/g, 1.0], [/\w+(eux|aux|eau|ait|aient|tion)\b/g, 0.5]],
  de: [[/[äöüß]/g, 1.0], [/\b\w+(ung|keit|heit|lich|isch)\b/g, 0.8], [/\bsch\w+/g, 0.5]],
  es: [[/[ñ¿¡]/g, 1.4], [/[áíóú]/g, 0.6], [/\w+(ción|ciones|mente|ado|ada|idad)\b/g, 0.6]],
}

export const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v)]))
