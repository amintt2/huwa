// "Statistiques de lecture": how long starts take on this device (overall, by path, engine,
// warm/cold, resume), stalls, success rate, addon response times — all measured and kept on the
// device. Optional, OFF by default: "Comparer avec la communauté" (anonymous aggregates over P2P,
// see src/stats/share.ts), behind an explicit consent sheet.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';

import { Callout } from '@/components/feedback';
import { Screen } from '@/components/screen';
import { Sheet } from '@/components/sheet';
import { DANGER, Empty, Group, Row, SwitchRow } from '@/components/social';
import { CompareRow, Figure, MetricRow, Sparkline, StatCard } from '@/components/stats';
import { Button, Txt } from '@/components/ui';
import { isDemo } from '@/demo/flags';
import { communityView, K_MIN, WEEK_MS } from '@/stats/community';
import { DEMO_ADDONS, DEMO_COMMUNITY, DEMO_EVENTS } from '@/stats/demo';
import { addonTable, describeStart, DUB_OUTCOME_LABEL, DUB_OUTCOMES, formatMs, formatPct, PATH_LABEL, PATHS, summarize, summarizeDubs, summarizeSwitches, SWITCH_REASON_LABEL, type Group as StatGroup, type SwitchReasonStat } from '@/stats/model';
import { useCommunityStats } from '@/stats/share';
import { resetStats, setCommunity, useStats } from '@/stats/store';
import { C, S } from '@/theme/tokens';

const ENGINE_LABEL = { native: 'Lecteur natif (AVPlayer)', mpv: 'mpv' } as const;
const KIND_LABEL = { start: 'Nouvel épisode', resume: 'Reprise', next: 'Épisode suivant' } as const;
const FAIL_LABEL = { 'no-source': 'aucune source', network: 'réseau', http: 'lien refusé', format: 'format', timeout: 'trop long', other: 'autre' } as const;

/** Starts detailed step by step in "Derniers démarrages". */
const RECENT_STARTS = 8;

const daysUntil =(ts: number) => Math.max(1, Math.ceil((ts - Date.now()) / 86_400_000));

const detailOf = (g: StatGroup) =>
  `${g.n} lecture${g.n > 1 ? 's' : ''} · p90 ${formatMs(g.p90)}${g.success != null ? ` · ${formatPct(g.success)} réussies` : ''}`;

export default function PlaybackStats() {
  const stored = useStats((s) => s.events);
  const storedAddons = useStats((s) => s.addons);
  const community = useStats((s) => s.community);
  const lastShared = useStats((s) => s.lastShared);
  const demo = isDemo && stored.length === 0;
  const events = demo ? DEMO_EVENTS : stored;
  const addons = demo ? DEMO_ADDONS : storedAddons;
  const sum = useMemo(() => summarize(events), [events]);
  // Newest first, only starts that ended (played or failed).
  const recent = useMemo(
    () =>
      events
        .filter((e) => e.tFirstFrame != null || e.failed)
        .slice(-RECENT_STARTS)
        .reverse()
        .map((e, i) => ({ key: `${e.at}-${i}`, line: describeStart(e) })),
    [events],
  );
  const rows = useMemo(() => addonTable(addons), [addons]);
  const switches = useStats((s) => s.switches);
  const switchSum = useMemo(() => summarizeSwitches(switches ?? []), [switches]);
  const switchReasons = Object.entries(switchSum.byReason).sort((a, b) => b[1] - a[1]) as [SwitchReasonStat, number][];
  const dubs = useStats((s) => s.dubs);
  const dubSum = useMemo(() => summarizeDubs(dubs ?? []), [dubs]);
  const dubRows = DUB_OUTCOMES.filter((o) => dubSum.counts[o]);
  const net = useCommunityStats();
  const network = communityView(demo && community ? DEMO_COMMUNITY : net.data);
  const [consent, setConsent] = useState(false);

  const paths = PATHS.filter((p) => sum.byPath[p]);
  const slowest = Math.max(1, ...paths.map((p) => sum.byPath[p]!.median ?? 0));
  const cap = Math.max(2000, (sum.overall.p90 ?? 0) * 1.15);
  const engines = (['native', 'mpv'] as const).filter((e) => sum.byEngine[e]);
  const kinds = (['start', 'resume', 'next'] as const).filter((k) => sum.byKind[k]);
  const failures = Object.entries(sum.failures).sort((a, b) => b[1] - a[1]);
  const addonMax = Math.max(1, ...rows.map((r) => r.median ?? 0));

  const onReset = () =>
    Alert.alert('Réinitialiser les statistiques ?', 'Les mesures enregistrées sur cet appareil seront effacées.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Réinitialiser', style: 'destructive', onPress: resetStats },
    ]);
  const onToggle = (on: boolean) => {
    if (on) setConsent(true);
    else setCommunity(false);
  };

  return (
    <>
    <Screen title="Statistiques">
        <Callout icon="lock-closed-outline">
          Ces mesures restent sur ton appareil. Elles disent combien de temps met un épisode à démarrer, selon la source et le lecteur — jamais ce que tu regardes.
        </Callout>

        {events.length === 0 ? (
          <Group>
            <Empty icon="speedometer-outline" title="Pas encore de mesures" text="Lance un épisode : le temps de démarrage de chaque lecture s’affichera ici." />
          </Group>
        ) : (
          <>
            <StatCard title="Temps avant l’image">
              <View style={styles.figures}>
                <Figure value={formatMs(sum.overall.median)} label="médian" />
                <Figure value={formatMs(sum.overall.p90)} label="p90 (9 sur 10 en moins de)" />
                <Figure
                  value={formatPct(sum.overall.success)}
                  label="démarrages réussis"
                  tone={sum.overall.success != null && sum.overall.success < 0.8 ? '#F5B544' : undefined}
                />
              </View>
              {sum.recent.length > 1 ? (
                <>
                  <Txt v="small" style={styles.sparkLabel}>{`${sum.recent.length} derniers démarrages`}</Txt>
                  <Sparkline values={sum.recent} cap={cap} />
                </>
              ) : null}
            </StatCard>

            {paths.length > 0 && (
              <StatCard title="Par source" footer="Débrid : torrent servi par ton service débrid. Lien d’agrégateur : l’extension résout elle-même le lien (Torrentio, Comet…).">
                {paths.map((p, i) => (
                  <MetricRow key={p} label={PATH_LABEL[p]} value={formatMs(sum.byPath[p]!.median)} detail={detailOf(sum.byPath[p]!)}
                    fraction={(sum.byPath[p]!.median ?? 0) / slowest} last={i === paths.length - 1} />
                ))}
              </StatCard>
            )}

            <StatCard title="Démarrage préchauffé" footer="Préchauffé : l’épisode était déjà ouvert en arrière-plan (pré-recherche, épisode suivant) et le lecteur a été repris tel quel.">
              <View style={styles.figures}>
                <Figure small value={formatMs(sum.warm.median)} label={`préchauffé · ${sum.warm.n}`} tone={C.success} />
                <Figure small value={formatMs(sum.cold.median)} label={`à froid · ${sum.cold.n}`} />
              </View>
            </StatCard>

            {(engines.length > 0 || kinds.length > 0) && (
              <StatCard title="Lecteur et type de lancement">
                {engines.map((e) => (
                  <MetricRow key={e} label={ENGINE_LABEL[e]} value={formatMs(sum.byEngine[e]!.median)} detail={detailOf(sum.byEngine[e]!)} />
                ))}
                {kinds.map((k, i) => (
                  <MetricRow key={k} label={KIND_LABEL[k]} value={formatMs(sum.byKind[k]!.median)} detail={detailOf(sum.byKind[k]!)} last={i === kinds.length - 1 && sum.fallbackRate == null} />
                ))}
                {sum.fallbackRate != null && (
                  <MetricRow label="Bascule vers mpv" value={formatPct(sum.fallbackRate)} detail="Le lecteur natif n’a pas su lire la source" last />
                )}
              </StatCard>
            )}

            {switchSum.total > 0 && (
              <StatCard
                title="Changements de source automatiques"
                footer="Coupures par minute de la source quittée (sur les 90 s d’avant) et de la nouvelle (sur les 2 min d’après).">
                <View style={styles.figures}>
                  <Figure small value={String(switchSum.total)} label={`changements · ${switchSum.seamless} sans coupure`} />
                  <Figure small value={formatPct(switchSum.helped)} label="ont réduit les coupures" tone={C.success} />
                </View>
                {switchReasons.map(([reason, n], i) => (
                  <MetricRow key={reason} label={SWITCH_REASON_LABEL[reason]} value={String(n)} last={i === switchReasons.length - 1 && switchSum.measured === 0} />
                ))}
                {switchSum.measured > 0 && (
                  <MetricRow
                    label="Coupures / min avant → après"
                    value={`${(switchSum.stallsPerMinBefore ?? 0).toFixed(1).replace('.', ',')} → ${(switchSum.stallsPerMinAfter ?? 0).toFixed(1).replace('.', ',')}`}
                    detail={`${switchSum.measured} changement${switchSum.measured > 1 ? 's' : ''} mesuré${switchSum.measured > 1 ? 's' : ''} · bascule ${formatMs(switchSum.tSwitch)}`}
                    last
                  />
                )}
              </StatCard>
            )}

            {dubSum.starts + (dubSum.counts['track-miss'] ?? 0) > 0 && (
              <StatCard
                title="Version doublée"
                footer="Mode « Doublés » : épisodes lancés avec une version doublée, ou sans (autre version, retour, source choisie à la main).">
                <View style={styles.figures}>
                  <Figure small value={formatPct(dubSum.hitRate)} label={`en version doublée · ${dubSum.starts} épisode${dubSum.starts > 1 ? 's' : ''}`} tone={C.success} />
                  <Figure small value={formatMs(dubSum.hitMs)} label="pour trouver la VF (médiane)" />
                </View>
                {dubRows.map((o, i) => (
                  <MetricRow key={o} label={DUB_OUTCOME_LABEL[o]} value={String(dubSum.counts[o])} last={i === dubRows.length - 1} />
                ))}
              </StatCard>
            )}

            <StatCard title="Étapes (médianes)">
              <MetricRow label="Premières sources" value={formatMs(sum.steps.sources)} />
              <MetricRow label="Source choisie" value={formatMs(sum.steps.decision)} />
              <MetricRow label="Lien prêt" value={formatMs(sum.steps.url)} />
              <MetricRow label="Image" value={formatMs(sum.overall.median)} last />
            </StatCard>

            {recent.length > 0 && (
              <StatCard
                title="Derniers démarrages"
                footer="Chaque étape en temps depuis l’appui. Moteur torrent : métadonnées (sonde, magnet ou déjà là), 1er pair connecté, requête du lecteur, 1re pièce du fichier, 1er octet servi au lecteur.">
                {recent.map(({ key, line }, i) => (
                  <MetricRow
                    key={key}
                    label={line.label}
                    value={line.value}
                    tone={line.failed ? DANGER : undefined}
                    detail={[line.stages, line.slowest, line.engine].filter(Boolean).join('\n')}
                    last={i === recent.length - 1}
                  />
                ))}
              </StatCard>
            )}

            <StatCard title="Coupures et échecs" footer="Coupure : la vidéo s’arrête pour charger, dans les 5 premières minutes.">
              <MetricRow label="Lectures avec coupure" value={formatPct(sum.stalls.rate)} detail={sum.stalls.medianMs != null ? `${formatMs(sum.stalls.medianMs)} d’attente médiane quand ça coupe` : undefined}
                tone={sum.stalls.rate != null && sum.stalls.rate > 0.25 ? '#F5B544' : undefined} last={failures.length === 0} />
              {failures.length > 0 && (
                <MetricRow label="Échecs" value={String(failures.reduce((s, [, n]) => s + n, 0))}
                  detail={failures.map(([k, n]) => `${FAIL_LABEL[k as keyof typeof FAIL_LABEL]} ${n}`).join(' · ')} tone={DANGER} last />
              )}
            </StatCard>
          </>
        )}

        {rows.length > 0 && (
          <StatCard title="Extensions" footer="Temps de réponse à la recherche de sources (médiane) et part des réponses réussies.">
            {rows.slice(0, 12).map((r, i) => (
              <MetricRow key={r.id} label={r.name} value={formatMs(r.median)} detail={`${r.n} requête${r.n > 1 ? 's' : ''} · ${formatPct(r.success)} réussies`}
                fraction={(r.median ?? 0) / addonMax} tone={r.success < 0.8 ? '#F5B544' : undefined} last={i === Math.min(rows.length, 12) - 1} />
            ))}
          </StatCard>
        )}

        <Group
          title="Communauté"
          footer={
            community
              ? lastShared
                ? `Dernière contribution anonyme : ${new Date(lastShared).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}. Suivante au plus tôt dans ${daysUntil(lastShared + WEEK_MS)} j.`
                : 'Première contribution anonyme après ta prochaine lecture (au plus une par semaine).'
              : 'Désactivé : rien ne quitte ton appareil.'
          }>
          <SwitchRow icon="people-outline" label="Comparer avec la communauté" detail="Moyennes anonymes du réseau P2P" value={community} onChange={onToggle} />
          <Row icon="information-circle-outline" label="Ce qui est partagé" onPress={() => setConsent(true)} last />
        </Group>

        {community && (
          <StatCard title="Ton temps vs la communauté">
            {network ? (
              <>
                <CompareRow label="Temps avant l’image (médian)" mine={sum.overall.median} theirs={network.overall.median} />
                {PATHS.filter((p) => network.byPath[p]).map((p) => (
                  <CompareRow key={p} label={PATH_LABEL[p]} mine={sum.byPath[p]?.median} theirs={network.byPath[p]!.median} />
                ))}
                <MetricRow label="Démarrages réussis" value={`${formatPct(sum.overall.success)} · réseau ${formatPct(network.success)}`} />
                <MetricRow label="Lectures avec coupure" value={`${formatPct(sum.stalls.rate)} · réseau ${formatPct(network.stallRate)}`}
                  detail={`${network.contributions} contributions anonymes, valeurs brouillées`} last />
              </>
            ) : (
              <View style={styles.waiting}>
                {net.loading ? <ActivityIndicator color={C.text2} /> : <Ionicons name="hourglass-outline" size={20} color={C.text2} />}
                <Txt v="small" style={{ flex: 1, lineHeight: 18 }}>
                  {net.loading
                    ? 'Recherche des contributions sur le réseau…'
                    : `Pas encore assez de contributions pour comparer (${net.data?.contributions ?? 0} sur ${K_MIN} minimum). Les moyennes ne s’affichent qu’à partir de ${K_MIN}, pour que personne ne puisse s’y reconnaître.`}
                </Txt>
                {!net.loading && <Button small variant="ghost" icon="refresh" label="Actualiser" onPress={net.refresh} />}
              </View>
            )}
          </StatCard>
        )}

        <Group>
          <Row icon="trash-outline" label="Réinitialiser les statistiques" destructive chevron={false} onPress={onReset} last />
        </Group>
    </Screen>

      <ConsentSheet
        visible={consent}
        enabled={community}
        onClose={() => setConsent(false)}
        onAccept={() => {
          setCommunity(true);
          setConsent(false);
        }}
      />
    </>
  );
}

function Point({ icon, children, tone = C.accentText }: { icon: 'checkmark-circle-outline' | 'close-circle-outline' | 'alert-circle-outline'; children: string; tone?: string }) {
  return (
    <View style={styles.point}>
      <Ionicons name={icon} size={18} color={tone} style={{ marginTop: 1 }} />
      <Txt v="body" style={{ flex: 1, fontSize: 14, lineHeight: 20 }}>{children}</Txt>
    </View>
  );
}

/** Exactly what "Comparer avec la communauté" shares — shown before switching it on. */
function ConsentSheet({ visible, enabled, onClose, onAccept }: { visible: boolean; enabled: boolean; onClose: () => void; onAccept: () => void }) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Comparer avec la communauté"
      detents={['medium', 'large']}
      footer={
        enabled ? (
          <Button label="Fermer" variant="soft" onPress={onClose} />
        ) : (
          <View style={{ flexDirection: 'row', gap: S.sm }}>
            <Button label="Pas maintenant" variant="ghost" onPress={onClose} style={{ flex: 1 }} />
            <Button label="Activer" icon="people-outline" onPress={onAccept} style={{ flex: 1.4 }} />
          </View>
        )
      }>
          <Txt v="body" style={{ color: C.body }}>
            Pour savoir si tes démarrages sont rapides, Huwa peut publier sur le réseau pair-à-pair, au plus une fois par semaine, un résumé grossier et brouillé de ta semaine. Huwa n’a pas de serveur : ces résumés sont additionnés par les pairs.
          </Txt>

          <View style={{ gap: S.sm }}>
            <Txt v="caption">Ce qui est partagé</Txt>
            <Point icon="checkmark-circle-outline">Pour chaque type de source (HTTP direct, débrid, moteur torrent, lecteur web, lien d’agrégateur) : combien de démarrages ont pris moins de 0,5 s, 1 s, 2 s, 4 s… (11 tranches). Un type n’est envoyé qu’à partir de 3 lectures.</Point>
            <Point icon="checkmark-circle-outline">Trois compteurs : lectures réussies, échouées, avec coupure.</Point>
            <Point icon="checkmark-circle-outline">Chaque nombre reçoit un bruit aléatoire : impossible d’en retrouver une lecture précise, les bruits s’annulent seulement quand on additionne beaucoup de contributions.</Point>
          </View>

          <View style={{ gap: S.sm }}>
            <Txt v="caption">Ce qui ne l’est jamais</Txt>
            <Point icon="close-circle-outline" tone={C.text2}>Aucun titre, épisode, lien, extension ni heure de visionnage.</Point>
            <Point icon="close-circle-outline" tone={C.text2}>Ni ton identité Huwa, ni ton pseudo, ni ton appareil : chaque contribution part d’une clé jetable, sur une connexion séparée. Deux contributions ne peuvent pas être reliées entre elles ni à toi.</Point>
          </View>

          <View style={{ gap: S.sm }}>
            <Txt v="caption">À savoir</Txt>
            <Point icon="alert-circle-outline" tone={C.star}>Comme pour toute connexion pair-à-pair, ton adresse IP est visible des pairs connectés à ce moment-là.</Point>
            <Point icon="alert-circle-outline" tone={C.star}>Une contribution publiée est lisible par tous les pairs et ne peut pas être retirée, puisque rien ne la relie à toi. Désactiver arrête les suivantes.</Point>
            <Point icon="alert-circle-outline" tone={C.star}>{`La comparaison s’affiche à partir de ${K_MIN} contributions.`}</Point>
          </View>

    </Sheet>
  );
}

const styles = StyleSheet.create({
  figures: { flexDirection: 'row', gap: S.md, padding: S.md },
  sparkLabel: { paddingHorizontal: S.md, paddingBottom: S.sm, fontSize: 12 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, flexWrap: 'wrap' },
  point: { flexDirection: 'row', gap: S.sm, alignItems: 'flex-start' },
});
