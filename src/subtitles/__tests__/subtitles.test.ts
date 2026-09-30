/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { parseAss } from '../ass';
import { decodeSingleByte, decodeSubtitleBytes } from '../decode';
import { parseAssColor, splitTags } from '../inline';
import { langMatches, normLang } from '../lang';
import { formatFromName, parseSubtitleBytes, parseSubtitleText } from '../parse';
import { DEFAULT_SUBTITLE_PREFS, sanitizeSubtitlePrefs } from '../prefs';
import { fadeOpacity, renderEvent, resolveAssFont } from '../render';
import { buildTracks, chooseTrack, groupTracks } from '../select';
import { parseSrt, parseVtt } from '../text';
import { timelineOf } from '../timeline';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const text = (name: string) => fixture(name).toString('utf8');
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ---------- ASS ----------

test('ASS: script info, styles and colours', () => {
  const doc = parseAss(text('fansub.ass'));
  assert.equal(doc.format, 'ass');
  assert.equal(doc.playResX, 1920);
  assert.equal(doc.playResY, 1080);
  assert.equal(doc.scaledBorder, true);
  const d = doc.styles.Default;
  assert.equal(d.fontName, 'Gandhi Sans');
  assert.equal(d.fontSize, 72);
  assert.equal(d.bold, true);
  assert.equal(d.italic, false);
  assert.deepEqual(d.primary, { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(d.outline, { r: 0x14, g: 0x14, b: 0x14, a: 1 });
  near(d.back.a, 1 - 0xa0 / 255);
  assert.equal(d.outlineWidth, 3.6);
  assert.equal(d.shadow, 1.8);
  assert.equal(d.marginV, 56);
  assert.equal(doc.styles.Italics.italic, true);
  assert.equal(doc.styles.Top.alignment, 8);
  assert.equal(doc.styles.Box.borderStyle, 3);
  // &H00F2E6C9 is BBGGRR: r=C9 g=E6 b=F2
  assert.deepEqual(doc.styles.Flashback.primary, { r: 0xc9, g: 0xe6, b: 0xf2, a: 1 });
});

test('ASS: events, comments skipped, \\N, commas in text, invalid timings dropped', () => {
  const doc = parseAss(text('fansub.ass'));
  const first = doc.events[0];
  near(first.start, 1);
  near(first.end, 4.2);
  assert.equal(first.plain, 'Tu entends ça ?\nLe vent chante, ce soir.');
  assert.ok(!doc.events.some((e) => e.plain.includes('TL note')));
  assert.ok(!doc.events.some((e) => e.plain.includes('ignoré')));
  const margins = doc.events.find((e) => e.plain.startsWith('Marges'))!;
  assert.equal(margins.plain, 'Marges et alignement, virgules, points, etc.');
  assert.equal(margins.align, 9);
  assert.deepEqual([margins.marginL, margins.marginR, margins.marginV], [300, 300, 120]);
  assert.equal(margins.spans[0].style.bold, false);
  assert.equal(margins.spans[0].style.underline, true);
});

test('ASS: inline overrides become spans', () => {
  const doc = parseAss(text('fansub.ass'));
  const e = doc.events.find((x) => x.plain.startsWith('Partir'))!;
  assert.deepEqual(e.spans.map((s) => [s.text, !!s.style.italic]), [['Partir', true], [', toujours partir.', false]]);
  const big = doc.events.find((x) => x.plain.startsWith('Plus grand'))!;
  assert.equal(big.spans[0].style.fontSize, 82);
  assert.deepEqual(big.spans[0].style.outlineColor, { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(big.spans[0].style.outlineWidth, 1);
  assert.equal(big.spans[0].style.shadow, 0);
  const moved = doc.events.find((x) => x.plain.startsWith('Déplacé'))!;
  assert.deepEqual(moved.pos, { x: 100, y: 100 });
  near(moved.spans[0].style.color!.a, 1 - 0x80 / 255);
  assert.deepEqual({ ...moved.spans[0].style.color!, a: 0 }, { r: 255, g: 255, b: 0, a: 0 });
  const flash = doc.events.find((x) => x.plain.startsWith('Souvenir'))!;
  assert.deepEqual(flash.spans[0].style.color, doc.styles.Flashback.primary);
});

test('ASS: signs keep \\pos, \\fad and alignment; stacked glow layers are merged', () => {
  const doc = parseAss(text('fansub.ass'));
  const station = doc.events.filter((e) => e.plain === 'Gare de Hoshimi');
  assert.equal(station.length, 1, 'blur + fill layers collapse into one');
  assert.equal(station[0].layer, 1);
  assert.deepEqual(station[0].pos, { x: 960, y: 210 });
  assert.deepEqual(station[0].fade, { in: 200, out: 300 });
  assert.equal(station[0].align, 5);
  const quay = doc.events.find((e) => e.plain.startsWith('Quai'))!;
  assert.equal(quay.align, 7);
  assert.equal(quay.plain, 'Quai n° 3 → Voie des étoiles');
  assert.equal(quay.spans[0].style.fontSize, 40);
});

test('ASS: karaoke tags stripped, drawings dropped, \\n / \\h / \\q2', () => {
  const doc = parseAss(text('fansub.ass'));
  assert.ok(doc.events.some((e) => e.plain === 'Hoshizora no kanata'));
  assert.ok(!doc.events.some((e) => /m 0 0 l/.test(e.plain)), 'vector drawing removed');
  assert.ok(doc.events.some((e) => e.plain === 'Texte dans une boîte opaque sur deux lignes ?'), '\\n is a soft break');
  assert.ok(doc.events.some((e) => e.plain === 'Retour forcé\nici même'), '\\q2 makes \\n hard, \\h is a hard space');
});

test('ASS: overlapping lines are all visible at once, in layer order', () => {
  const doc = parseAss(text('fansub.ass'));
  const tl = timelineOf(doc);
  assert.deepEqual(tl.at(9).map((e) => e.plain), ['Partir, toujours partir.', 'Attends-moi, Aoi !']);
  assert.deepEqual(tl.at(12).map((e) => e.plain), ['Gare de Hoshimi', 'Quai n° 3 → Voie des étoiles', '(Voix du haut-parleur) Le train de 22 h 10 est annoncé.']);
  assert.equal(tl.at(6.9).length, 0);
  near(tl.nextChange(6.9), 7);
  near(tl.nextChange(9), 10);
  assert.equal(tl.at(10).length, 0, 'end is exclusive');
});

test('SSA v4: decimal colours, legacy alignment, Marked field', () => {
  const doc = parseAss(text('legacy.ssa'));
  assert.equal(doc.format, 'ssa');
  assert.equal(doc.playResY, 480);
  assert.equal(doc.playResX, 640);
  assert.deepEqual(doc.styles.Default.primary, { r: 255, g: 255, b: 255, a: 1 });
  // 65535 = 0x00FFFF → BGR: r=FF g=FF b=00 (yellow)
  assert.deepEqual(doc.styles.TopTitle.primary, { r: 255, g: 255, b: 0, a: 1 });
  assert.equal(doc.styles.TopTitle.alignment, 8);
  assert.equal(doc.events.length, 3);
  assert.equal(doc.events[0].plain, 'Bonjour, vieux format !');
  assert.equal(doc.events.find((e) => e.plain === 'Milieu gauche')!.align, 4);
});

test('tag splitting handles names, parentheses and \\fn with spaces', () => {
  assert.deepEqual(splitTags('\\fnOpen Sans Semibold\\fs20\\pos(1,2)\\t(0,100,\\fscx120)\\rDefault\\1c&H0000FF&'), [
    { name: 'fn', arg: 'Open Sans Semibold' },
    { name: 'fs', arg: '20' },
    { name: 'pos', arg: '(1,2)' },
    { name: 't', arg: '(0,100,\\fscx120)' },
    { name: 'r', arg: 'Default' },
    { name: '1c', arg: '&H0000FF&' },
  ]);
  assert.deepEqual(parseAssColor('&H80FF0000'), { r: 0, g: 0, b: 255, a: 1 - 0x80 / 255 });
  assert.deepEqual(parseAssColor('&HFFFFFF&'), { r: 255, g: 255, b: 255, a: 1 });
});

// ---------- SRT / VTT ----------

test('SRT: CRLF, tags, {\\an8}, missing index, blank line inside a cue, entities', () => {
  const doc = parseSrt(text('episode.srt'));
  assert.equal(doc.format, 'srt');
  assert.deepEqual(doc.events.map((e) => e.plain), [
    'Il était une fois…',
    'Titre en haut de l’écran',
    'Jaune et gras,\nsur deux lignes',
    '- Chevauchement !\n- Oui.',
    'Avec une ligne\nvide au milieu',
    'L\'entité & les balises soulignées',
  ]);
  assert.equal(doc.events[0].spans[0].style.italic, true);
  assert.equal(doc.events[1].align, 8);
  const yellow = doc.events[2].spans[0];
  assert.equal(yellow.text, 'Jaune');
  assert.deepEqual(yellow.style.color, { r: 255, g: 255, b: 0, a: 1 });
  assert.equal(doc.events[2].spans.find((s) => s.text === 'gras')!.style.bold, true);
  near(doc.events[2].start, 6.5);
  // Overlap: both visible.
  assert.equal(timelineOf(doc).at(7.7).length, 2);
});

test('WebVTT: header, NOTE/STYLE skipped, voices, classes, placement, ruby, timestamps', () => {
  const doc = parseVtt(text('episode.vtt'));
  assert.equal(doc.format, 'vtt');
  assert.deepEqual(doc.events.map((e) => e.plain), [
    'Bonsoir, les étoiles !',
    'En haut de l’image',
    'À gauche',
    'Première ligne (haut)',
    '星 et karaoké & italique',
  ]);
  near(doc.events[0].start, 1);
  assert.deepEqual(doc.events[0].spans.find((s) => s.text === 'les étoiles')!.style.color, { r: 255, g: 255, b: 0, a: 1 });
  assert.equal(doc.events[1].align, 8);
  assert.deepEqual(doc.events[1].pos, { x: 500, y: 100 });
  assert.equal(doc.events[2].align, 1);
  assert.equal(doc.events[3].align, 8);
  assert.equal(doc.events[4].spans.find((s) => s.text === 'italique')!.style.italic, true);
});

test('format detection: content wins over the extension', () => {
  assert.equal(parseSubtitleText(text('fansub.ass')).format, 'ass');
  assert.equal(parseSubtitleText(text('episode.vtt'), 'srt').format, 'vtt');
  assert.equal(parseSubtitleText(text('episode.srt'), 'vtt').format, 'srt');
  assert.equal(formatFromName('https://x.org/sub/ep1.fr.ASS?token=1'), 'ass');
  assert.equal(formatFromName('/tmp/Show - 01.srt.gz'), 'srt');
  assert.equal(formatFromName('https://subs5.strem.io/en/download/file/1954593261'), undefined);
});

// ---------- encodings ----------

test('code page tables match the platform decoder', () => {
  const all = Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i);
  for (const enc of ['windows-1252', 'windows-1250', 'windows-1251'] as const) {
    const ours = decodeSingleByte(all, enc);
    const ref = new TextDecoder(enc).decode(all);
    for (let i = 0; i < 128; i++) {
      // Unassigned bytes: we use U+FFFD, WHATWG maps them to C1 controls.
      if (ours[i] === '�') continue;
      assert.equal(ours[i], ref[i], `${enc} 0x${(0x80 + i).toString(16)}`);
    }
  }
});

const encode1 = (s: string, enc: 'windows-1252' | 'windows-1250' | 'windows-1251') => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  const table = decodeSingleByte(all, enc);
  return Uint8Array.from([...s].map((ch) => {
    const i = table.indexOf(ch);
    if (i < 0) throw new Error(`${ch} not in ${enc}`);
    return i;
  }));
};

const SRT_FR = '1\r\n00:00:01,000 --> 00:00:02,000\r\nÇa va ? Déjà l’été, garçon… « Où es-tu ? » Œuvre\r\n';
const SRT_RU = '1\n00:00:01,000 --> 00:00:02,000\nПривет, как дела? Это субтитры для аниме.\n';
const SRT_PL = '1\n00:00:01,000 --> 00:00:02,000\nZażółć gęślą jaźń. Świat się kręci, łąka.\n';

test('encodings: UTF-8 (BOM or not), UTF-16 LE/BE (BOM or not), Windows-1252/1250/1251', () => {
  const utf8 = Buffer.from(SRT_FR, 'utf8');
  assert.equal(decodeSubtitleBytes(utf8).text, SRT_FR);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
  assert.deepEqual([decodeSubtitleBytes(bom).text, decodeSubtitleBytes(bom).encoding], [SRT_FR, 'utf-8']);
  const le = Buffer.from(SRT_FR, 'utf16le');
  assert.equal(decodeSubtitleBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), le])).text, SRT_FR);
  assert.equal(decodeSubtitleBytes(le).encoding, 'utf-16le');
  assert.equal(decodeSubtitleBytes(le).text, SRT_FR);
  const be = Buffer.from(le).swap16();
  assert.equal(decodeSubtitleBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text, SRT_FR);
  assert.equal(decodeSubtitleBytes(be).text, SRT_FR);

  const fr = decodeSubtitleBytes(encode1(SRT_FR, 'windows-1252'));
  assert.deepEqual([fr.encoding, fr.text], ['windows-1252', SRT_FR]);
  const ru = decodeSubtitleBytes(encode1(SRT_RU, 'windows-1251'));
  assert.deepEqual([ru.encoding, ru.text], ['windows-1251', SRT_RU]);
  const pl = decodeSubtitleBytes(encode1(SRT_PL, 'windows-1250'));
  assert.deepEqual([pl.encoding, pl.text], ['windows-1250', SRT_PL]);
});

test('gzip: .srt.gz and .ass.gz are inflated then decoded', () => {
  const gz = gzipSync(fixture('fansub.ass'));
  const parsed = parseSubtitleBytes(gz);
  assert.equal(parsed.gzip, true);
  assert.equal(parsed.doc.format, 'ass');
  assert.equal(parsed.doc.events[0].plain, 'Tu entends ça ?\nLe vent chante, ce soir.');
  const srt = parseSubtitleBytes(gzipSync(encode1(SRT_FR, 'windows-1252')));
  assert.equal(srt.encoding, 'windows-1252');
  assert.equal(srt.doc.events[0].plain, 'Ça va ? Déjà l’été, garçon… « Où es-tu ? » Œuvre');
});

test('unreadable files throw a clear error', () => {
  assert.throws(() => parseSubtitleBytes(Buffer.from('PK\u0003\u0004 zip archive')), /archive/);
  assert.throws(() => parseSubtitleBytes(Buffer.from('juste du texte sans horodatage')), /Aucun sous-titre/);
  assert.throws(() => parseSubtitleBytes(Uint8Array.from([0x1f, 0x8b, 1, 2, 3])), /illisible/);
});

// ---------- rendering model ----------

test('render: ASS look scales with the video, user look follows the preferences', () => {
  const doc = parseAss(text('fansub.ass'));
  const video = { x: 0, y: 0, width: 960, height: 540 };
  const ev = doc.events[0];
  const ass = renderEvent(ev, doc, { prefs: DEFAULT_SUBTITLE_PREFS, video, t: 2 });
  assert.equal(ass.user, false);
  near(ass.spans[0].fontSize, 72 * 0.5 * 0.86);
  near(ass.outline, 1.8);
  assert.equal(ass.spans[0].color, 'rgba(255,255,255,1)');
  assert.deepEqual(ass.placement, { kind: 'slot', slot: 2, marginL: 80, marginR: 80, marginV: 28 });
  assert.equal(ass.spans[0].bold, true);

  const prefs = { ...DEFAULT_SUBTITLE_PREFS, respectAss: false, color: '#FFE14D', size: 5, outline: 4 };
  const user = renderEvent(ev, doc, { prefs, video, t: 2 });
  assert.equal(user.user, true);
  assert.equal(user.spans[0].color, 'rgba(255,225,77,1)');
  near(user.spans[0].fontSize, 540 * 0.09);
  near(user.outline, 540 * 0.09 * 0.14);
  assert.deepEqual(user.spans[0].font, { kind: 'app', id: 'nunito' });
  // Positioned signs keep their ASS look even when the user style is forced.
  const sign = doc.events.find((e) => e.plain === 'Gare de Hoshimi')!;
  const s = renderEvent(sign, doc, { prefs, video, t: 12 });
  assert.equal(s.user, false);
  assert.deepEqual(s.placement, { kind: 'anchor', x: 480, y: 105, align: 5 });
  // Opaque box style (BorderStyle 3).
  const box = renderEvent(doc.events.find((e) => e.style.name === 'Box')!, doc, { prefs: DEFAULT_SUBTITLE_PREFS, video, t: 25 });
  assert.ok(box.box && box.outline === 0);
});

test('render: fades and ASS font mapping', () => {
  const doc = parseAss(text('fansub.ass'));
  const e = doc.events.find((x) => x.plain === 'Fondu')!;
  near(fadeOpacity(e, 40), 0);
  near(fadeOpacity(e, 40.125), 0.5);
  near(fadeOpacity(e, 40.5), 1);
  near(fadeOpacity(e, 40.75), 0.5);
  assert.deepEqual(resolveAssFont('Trebuchet MS', 'nunito', 'ios'), { kind: 'system', family: 'Trebuchet MS' });
  assert.deepEqual(resolveAssFont('Trebuchet MS', 'nunito', 'android'), { kind: 'app', id: 'nunito' });
  assert.deepEqual(resolveAssFont('Gandhi Sans', 'atkinson', 'ios'), { kind: 'app', id: 'atkinson' });
  assert.deepEqual(resolveAssFont('Wild Words', 'nunito', 'ios'), { kind: 'app', id: 'comic' });
  assert.deepEqual(resolveAssFont('Source Serif Pro', 'nunito', 'ios'), { kind: 'app', id: 'merriweather' });
  assert.deepEqual(resolveAssFont('MS Gothic', 'nunito', 'ios'), { kind: 'app', id: 'mplus' });
});

// ---------- languages & track choice ----------

test('language codes from addons are normalised', () => {
  assert.equal(normLang('fre'), 'fr');
  assert.equal(normLang('fr-FR'), 'fr');
  assert.equal(normLang('pob'), 'pt-br');
  assert.equal(normLang('pt_BR'), 'pt-br');
  assert.equal(normLang('spl'), 'es-419');
  assert.equal(normLang('English'), 'en');
  assert.equal(normLang('???'), 'und');
  assert.ok(langMatches('pt-br', 'pt'));
  assert.ok(!langMatches('pt', 'pt-br'));
});

test('auto choice: preferred language, then source, then non-forced', () => {
  const tracks = buildTracks(
    [{ language: 'en', label: 'English' }, { language: 'fr', label: 'Forced', name: 'Forced' }],
    [
      { url: 'https://a/1.srt', lang: 'eng', source: 'Stream' },
      { url: 'https://b/2.srt', lang: 'fre', source: 'OpenSubtitles' },
      { url: 'https://c/3.ass', lang: 'fre', source: 'Kitsunekko' },
    ],
  );
  // fr: embedded forced track has the best source, but a full track is preferred… only after source.
  assert.equal(chooseTrack(tracks, { enabled: true, languages: ['fr', 'en'] }), 'emb:1');
  const noEmb = tracks.filter((t) => t.kind !== 'embedded');
  assert.equal(chooseTrack(noEmb, { enabled: true, languages: ['fr', 'en'] }), 'ext:https://b/2.srt');
  assert.equal(chooseTrack(noEmb, { enabled: true, languages: ['de', 'en'] }), 'ext:https://a/1.srt');
  assert.equal(chooseTrack(noEmb, { enabled: true, languages: ['de'] }), 'off');
  assert.equal(chooseTrack(noEmb, { enabled: false, languages: ['fr'] }), 'off');
  // Same source: the full track wins over the forced one.
  const same = buildTracks([], [
    { url: 'https://x/forced.fr.srt', lang: 'fr', source: 'OS', label: 'Forced' },
    { url: 'https://x/full.fr.srt', lang: 'fr', source: 'OS' },
  ]);
  assert.equal(chooseTrack(same, { enabled: true, languages: ['fr'] }), 'ext:https://x/full.fr.srt');
  const groups = groupTracks(tracks, ['fr', 'en']);
  assert.deepEqual(groups.map((g) => g.title), ['Français', 'Anglais']);
  assert.equal(tracks.find((t) => t.url === 'https://c/3.ass')!.format, 'ass');
});

test('prefs are sanitised', () => {
  const p = sanitizeSubtitlePrefs({ size: 99, font: 'comic-sans', color: 'red', languages: ['fr'], bold: false });
  assert.equal(p.size, DEFAULT_SUBTITLE_PREFS.size);
  assert.equal(p.font, 'nunito');
  assert.equal(p.color, '#FFFFFF');
  assert.deepEqual(p.languages, ['fr']);
  assert.equal(p.bold, false);
});
