// Language of a source chapter, shown as a flag on chapter dividers.
const FLAGS: Record<string, string> = {
  fr: '🇫🇷', en: '🇬🇧', es: '🇪🇸', 'es-la': '🇲🇽', pt: '🇵🇹', 'pt-br': '🇧🇷', it: '🇮🇹', de: '🇩🇪', ru: '🇷🇺', ar: '🇸🇦',
  tr: '🇹🇷', id: '🇮🇩', vi: '🇻🇳', th: '🇹🇭', pl: '🇵🇱', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', 'zh-hk': '🇭🇰', 'zh-tw': '🇹🇼', uk: '🇺🇦',
};

export function langFlag(lang?: string): string | undefined {
  if (!lang) return undefined;
  const l = lang.toLowerCase().replace('_', '-');
  return FLAGS[l] ?? FLAGS[l.split('-')[0]];
}
