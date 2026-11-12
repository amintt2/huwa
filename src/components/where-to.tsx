// « Où regarder » / « Où lire »: what an episode or a chapter opens when no extension can play it
// in Huwa (always in the App Store flavor). Huwa is a library: it shows the episode, where it sits
// in the story (the anime ↔ manhwa bridge), lets you mark it, and lists the official services that
// carry it (AniList's links: Crunchyroll, Netflix, ADN… / Webtoon, Piccoma, Delitoon…).
// No player, no reader, nothing that looks like it plays content Huwa does not have.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Linking, StyleSheet, View } from 'react-native';

import { anilistRef } from '@/data/anilist-api';
import { approxEp, chapterAfterEpisode, episodeForChapter } from '@/data/bridge';
import type { Chapter, Episode, Series } from '@/data/catalog';
import { episodeLink, languageLabel, officialSites, type OfficialSite } from '@/data/official-links';
import { useOfficialLinks } from '@/data/use-official-links';
import { useSettings } from '@/settings/settings';
import { markEpisodeDone, saveChapterProgress, unmarkChapter, unmarkEpisode, useStore } from '@/store/store';
import { C, R, S } from '@/theme/tokens';

import { Synopsis } from './detail';
import { Screen } from './screen';
import { Group, Loading, Row } from './social';
import { Button, Cover, Press, Txt, haptic } from './ui';

const open = (url: string) => Linking.openURL(url).catch(() => {});

export function WhereToWatch({ series, episode }: { series: Series; episode: Episode }) {
  const { lang } = useSettings();
  const ref = anilistRef(series.id);
  const links = useOfficialLinks(ref?.type === 'ANIME' ? ref.id : undefined);
  const done = useStore((s) => !!s.episodes[episode.id]?.done);
  const sites = officialSites(links.data?.links ?? [], lang);
  const direct = episodeLink(links.data?.episodes ?? [], episode.number);
  const eps = series.anime?.episodes ?? [];
  const next = eps.find((e) => e.number === episode.number + 1);
  const nextChapter = chapterAfterEpisode(series, episode);
  const toggle = () => {
    haptic('medium');
    if (done) unmarkEpisode(episode.id);
    else markEpisodeDone(episode.id);
  };

  return (
    <Screen title={`Épisode ${episode.number}`} subtitle={series.title}>
      <Header series={series} line={[episode.title && episode.title !== `Épisode ${episode.number}` ? episode.title : undefined, series.manhwa ? `${approxEp(series, episode)}chapitres ${episode.chapters[0]} à ${episode.chapters[1]} du manhwa` : undefined]} />

      <Button large variant={done ? 'soft' : 'solid'} icon={done ? 'checkmark-circle' : 'checkmark-circle-outline'} label={done ? 'Vu' : 'Marquer comme vu'} onPress={toggle} />

      <Group title="Où regarder" footer="Liens vers les services officiels qui diffusent la série, d’après AniList. Huwa n’héberge aucune vidéo.">
        {direct && (
          <Row icon="play-circle-outline" label={`Épisode ${episode.number} sur ${direct.site}`} detail={direct.title} external onPress={() => open(direct.url)} last={!sites.length} />
        )}
        <Sites sites={sites} loading={links.loading} lang={lang} empty="Aucun service officiel connu pour cette série pour l’instant." />
      </Group>

      {(next || nextChapter) && (
        <Group title="Ensuite">
          {next && <Row icon="arrow-forward-circle-outline" label={`Épisode ${next.number}`} onPress={() => router.replace(`/watch/${next.id}`)} last={!nextChapter} />}
          {nextChapter && (
            <Row icon="book-outline" label={`Continuer en manhwa : chapitre ${nextChapter.number}`} detail="La suite de cet épisode" onPress={() => router.push(`/read/${nextChapter.id}`)} last />
          )}
        </Group>
      )}

      {!!series.synopsis && <Synopsis text={series.synopsis} />}
    </Screen>
  );
}

export function WhereToRead({ series, chapter }: { series: Series; chapter: Chapter }) {
  const { lang } = useSettings();
  const ref = anilistRef(series.id);
  const mangaId = series.manhwaId ?? (ref?.type === 'MANGA' ? ref.id : undefined);
  const links = useOfficialLinks(mangaId);
  const done = useStore((s) => !!s.chapters[chapter.id]?.done);
  const sites = officialSites(links.data?.links ?? [], lang);
  const chapters = series.manhwa?.chapters ?? [];
  const next = chapters.find((c) => c.number === chapter.number + 1);
  const ep = episodeForChapter(series, chapter.number);
  const toggle = () => {
    haptic('medium');
    if (done) unmarkChapter(chapter.id);
    else saveChapterProgress(chapter.id, 1);
  };

  return (
    <Screen title={`Chapitre ${chapter.number}`} subtitle={series.title}>
      <Header series={series} line={[chapter.title && chapter.title !== `Chapitre ${chapter.number}` ? chapter.title : undefined, ep ? `${approxEp(series, ep)}adapté dans l’épisode ${ep.number} de l’anime` : undefined]} />

      <Button large variant={done ? 'soft' : 'solid'} icon={done ? 'checkmark-circle' : 'checkmark-circle-outline'} label={done ? 'Lu' : 'Marquer comme lu'} onPress={toggle} />

      <Group title="Où lire" footer="Liens vers les éditeurs et plateformes officiels du manhwa, d’après AniList. Huwa n’héberge aucune page.">
        <Sites sites={sites} loading={links.loading} lang={lang} empty="Aucune plateforme officielle connue pour ce manhwa pour l’instant." />
      </Group>

      {(next || ep) && (
        <Group title="Ensuite">
          {next && <Row icon="arrow-forward-circle-outline" label={`Chapitre ${next.number}`} onPress={() => router.replace(`/read/${next.id}`)} last={!ep} />}
          {ep && <Row icon="tv-outline" label={`Voir l’épisode ${ep.number}`} detail="L’adaptation de ce chapitre" onPress={() => router.push(`/watch/${ep.id}`)} last />}
        </Group>
      )}

      {!!series.synopsis && <Synopsis text={series.synopsis} />}
    </Screen>
  );
}

function Header({ series, line }: { series: Series; line: (string | undefined)[] }) {
  const text = line.filter(Boolean) as string[];
  return (
    <Press onPress={() => router.push(series.anime ? `/anime/${series.id}` : `/manhwa/${series.id}`)} scaleTo={0.98} accessibilityRole="link"
      accessibilityLabel={`${series.title}. Ouvrir la fiche`} style={styles.header}>
      <Cover palette={series.palette} image={series.image} width={64} height={92} radius={R.poster} />
      <View style={{ flex: 1, gap: 4 }}>
        <Txt v="label" numberOfLines={2}>{series.title}</Txt>
        {text.map((t) => (
          <Txt key={t} v="small" color={C.body} numberOfLines={2}>{t}</Txt>
        ))}
      </View>
      <Ionicons name="chevron-forward" size={16} color={C.text3} />
    </Press>
  );
}

function Sites({ sites, loading, lang, empty }: { sites: OfficialSite[]; loading: boolean; lang: string; empty: string }) {
  if (loading) return <Loading rows={3} />;
  if (!sites.length) return <Row icon="information-circle-outline" label={empty} chevron={false} last />;
  return (
    <>
      {sites.map((s, i) => (
        <Press key={s.site} onPress={() => open(s.url)} scaleTo={1} accessibilityRole="link" accessibilityLabel={`${s.site}${languageLabel(s.language, lang) ? `, ${languageLabel(s.language, lang)}` : ''}. Ouvre le service`}
          style={[styles.site, i < sites.length - 1 && styles.siteLine]}>
          <View style={[styles.logo, { backgroundColor: s.color ?? C.elevated }]}>
            {s.icon ? <Image source={{ uri: s.icon }} style={{ width: 20, height: 20 }} contentFit="contain" /> : <Ionicons name="globe-outline" size={18} color={C.white} />}
          </View>
          <View style={{ flex: 1, gap: 1 }}>
            <Txt v="label" numberOfLines={1}>{s.site}</Txt>
            {languageLabel(s.language, lang) && <Txt v="footnote" color={C.text3}>{languageLabel(s.language, lang)}</Txt>}
          </View>
          <Ionicons name="open-outline" size={16} color={C.text3} />
        </Press>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  site: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingVertical: 12, minHeight: 52 },
  siteLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
  logo: { width: 32, height: 32, borderRadius: 9, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center' },
});
