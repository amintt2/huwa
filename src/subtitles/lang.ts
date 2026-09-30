// Language codes seen in subtitle sources (ISO 639-1, 639-2/B and /T, OpenSubtitles' `pob`,
// BCP 47 tags, English names…) → one key per language, plus French display names.

const ALIASES: Record<string, string> = {
  fre: 'fr', fra: 'fr', french: 'fr', francais: 'fr', 'français': 'fr',
  eng: 'en', english: 'en', anglais: 'en',
  jpn: 'ja', jp: 'ja', japanese: 'ja',
  spa: 'es', spanish: 'es', espanol: 'es', 'español': 'es', spl: 'es-419', ea: 'es-419',
  por: 'pt', portuguese: 'pt', pob: 'pt-br', pb: 'pt-br', 'pt-br': 'pt-br', brazilian: 'pt-br',
  ger: 'de', deu: 'de', german: 'de',
  ita: 'it', italian: 'it',
  rus: 'ru', russian: 'ru',
  ara: 'ar', arabic: 'ar',
  chi: 'zh', zho: 'zh', chinese: 'zh', zht: 'zh-tw', 'zh-hant': 'zh-tw', 'zh-tw': 'zh-tw', 'zh-hk': 'zh-tw', zhs: 'zh', 'zh-hans': 'zh', 'zh-cn': 'zh',
  kor: 'ko', korean: 'ko',
  pol: 'pl', polish: 'pl',
  tur: 'tr', turkish: 'tr',
  dut: 'nl', nld: 'nl', dutch: 'nl',
  swe: 'sv', dan: 'da', nor: 'no', nob: 'no', nno: 'no', fin: 'fi', ice: 'is', isl: 'is',
  cze: 'cs', ces: 'cs', slo: 'sk', slk: 'sk', hun: 'hu', rum: 'ro', ron: 'ro', mol: 'ro', bul: 'bg', hrv: 'hr', scc: 'sr', srp: 'sr', slv: 'sl',
  gre: 'el', ell: 'el', heb: 'he', iw: 'he', hin: 'hi', ind: 'id', in: 'id', may: 'ms', msa: 'ms', tha: 'th', vie: 'vi', ukr: 'uk',
  per: 'fa', fas: 'fa', cat: 'ca', baq: 'eu', eus: 'eu', glg: 'gl', lit: 'lt', lav: 'lv', est: 'et', tgl: 'tl', fil: 'tl',
};

const NAMES: Record<string, string> = {
  fr: 'Français', en: 'Anglais', ja: 'Japonais', es: 'Espagnol', 'es-419': 'Espagnol (Amérique latine)', pt: 'Portugais',
  'pt-br': 'Portugais (Brésil)', de: 'Allemand', it: 'Italien', ru: 'Russe', ar: 'Arabe', zh: 'Chinois', 'zh-tw': 'Chinois traditionnel',
  ko: 'Coréen', pl: 'Polonais', tr: 'Turc', nl: 'Néerlandais', sv: 'Suédois', da: 'Danois', no: 'Norvégien', fi: 'Finnois', is: 'Islandais',
  cs: 'Tchèque', sk: 'Slovaque', hu: 'Hongrois', ro: 'Roumain', bg: 'Bulgare', hr: 'Croate', sr: 'Serbe', sl: 'Slovène', el: 'Grec',
  he: 'Hébreu', hi: 'Hindi', id: 'Indonésien', ms: 'Malais', th: 'Thaï', vi: 'Vietnamien', uk: 'Ukrainien', fa: 'Persan', ca: 'Catalan',
  eu: 'Basque', gl: 'Galicien', lt: 'Lituanien', lv: 'Letton', et: 'Estonien', tl: 'Filipino',
};

/** Languages offered in the preferences, most useful first for this audience. */
export const COMMON_LANGS = ['fr', 'en', 'es', 'es-419', 'pt-br', 'pt', 'de', 'it', 'ar', 'ja', 'ru', 'pl', 'tr', 'nl', 'ko', 'zh', 'id', 'vi'];

/** Normalised key (`fr`, `pt-br`, `es-419`…) or `und` when unknown. */
export function normLang(raw: string | undefined | null): string {
  if (!raw) return 'und';
  const s = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!s) return 'und';
  if (ALIASES[s]) return ALIASES[s];
  const [base, region] = s.split('-');
  if (base === 'pt' && region === 'br') return 'pt-br';
  if (base === 'es' && region && region !== 'es') return 'es-419';
  if (base === 'zh' && region && ['tw', 'hk', 'mo', 'hant'].includes(region)) return 'zh-tw';
  if (ALIASES[base]) return ALIASES[base];
  if (/^[a-z]{2}$/.test(base)) return base;
  return 'und';
}

export function langName(key: string): string {
  if (key === 'und') return 'Langue inconnue';
  return NAMES[key] ?? key.toUpperCase();
}

/** Does track language `key` satisfy preference `pref`? (`pt` accepts `pt-br`, `es` accepts `es-419`.) */
export function langMatches(key: string, pref: string): boolean {
  const p = normLang(pref);
  if (p === 'und' || key === 'und') return false;
  return key === p || key.split('-')[0] === p;
}
