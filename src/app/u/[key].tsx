import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ActionSheetIOS, Alert, Platform, Share, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HistoryRow } from '@/components/history';
import { reportAccount } from '@/components/report';
import { Callout } from '@/components/feedback';
import { BAR_H, NavBar, useScreenScroll } from '@/components/screen';
import { Avatar, BadgeGrid, Empty, Loading, RankCard, profileLink, shortKey } from '@/components/social';
import { Button, Chip, IconButton, Txt } from '@/components/ui';
import { social, useBlocked, useMe, useProfile, useRank } from '@/p2p/hooks';
import { setPrefs, usePrefs } from '@/p2p/prefs';
import { fingerprint, isPublicKey } from '@/social/identity';
import { C, R, S, SHADOW } from '@/theme/tokens';

const since = (t: number) => (t ? new Date(t).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }) : undefined);

export default function PublicProfile() {
  const { key: raw } = useLocalSearchParams<{ key: string }>();
  const key = (raw ?? '').toLowerCase();
  const insets = useSafeAreaInsets();
  const { y, onScroll } = useScreenScroll();
  const me = useMe();
  const { profile, loading } = useProfile(key);
  const r = useRank(key);
  const blocked = useBlocked().includes(key);
  const following = usePrefs((p) => p.follows.includes(key));
  const subscribed = usePrefs((p) => p.subscriptions.includes(key));
  const petname = usePrefs((p) => p.petnames[key]);
  const isMe = key === me?.key;
  const valid = isPublicKey(key);
  const fp = useMemo(() => (valid ? fingerprint(key) : ''), [key, valid]);
  const name = petname || profile?.name || `pair ${fp}`;

  const share = () => Share.share({ message: `${isMe ? 'Mon profil' : name} sur Huwa : ${profileLink(key)}` });

  const setPetname = () => {
    const apply = (v?: string) => setPrefs((p) => ({ ...p, petnames: { ...p.petnames, [key]: (v ?? '').trim().slice(0, 24) } }));
    if (Platform.OS === 'ios')
      Alert.prompt('Surnom', 'Visible seulement par toi, à la place de son pseudo.', [{ text: 'Annuler', style: 'cancel' }, { text: 'OK', onPress: apply }], 'plain-text', petname ?? profile?.name ?? '');
    else Alert.alert('Surnom', 'Disponible bientôt sur Android.');
  };

  const toggleBlock = () => {
    if (blocked) return social.setBlocked(key, false);
    Alert.alert(`Bloquer ${name} ?`, 'Ses commentaires seront masqués et il ne pourra plus t’écrire.', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Bloquer',
        style: 'destructive',
        onPress: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          social.setBlocked(key, true);
        },
      },
    ]);
  };

  // Same flow as in messages: published report, optional local block, e-mail to a human.
  const report = () => reportAccount({ key, name, where: 'profil', blocked });

  const more = () => {
    const actions = [
      { label: petname ? 'Modifier le surnom' : 'Donner un surnom', run: setPetname },
      { label: subscribed ? 'Ne plus utiliser sa liste de blocage' : 'Utiliser sa liste de blocage', run: () => social.setSubscribed(key, !subscribed) },
      { label: 'Signaler', run: report },
      { label: blocked ? 'Débloquer' : 'Bloquer', run: toggleBlock, destructive: !blocked },
    ];
    if (Platform.OS === 'ios')
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...actions.map((a) => a.label), 'Annuler'], cancelButtonIndex: actions.length, destructiveButtonIndex: blocked ? undefined : actions.length - 1, userInterfaceStyle: 'dark' },
        (i) => actions[i]?.run(),
      );
    else Alert.alert(name, undefined, [...actions.slice(1).map((a) => ({ text: a.label, onPress: a.run }))]);
  };

  if (!valid)
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + BAR_H, justifyContent: 'center', paddingBottom: 120 }}>
        <Empty icon="help-circle-outline" title="Lien de profil invalide" text="Ce lien ne contient pas de clé Huwa valide." />
        <NavBar alwaysSolid />
      </View>
    );

  const recent = r.loading ? [] : [...r.rank.accepted].reverse().slice(0, 8);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: insets.top + BAR_H, paddingHorizontal: S.lg, paddingBottom: insets.bottom + S.xxl, gap: S.xl }}>
        <View style={{ alignItems: 'center', gap: S.sm }}>
          <View style={styles.avatarRing}>
            <Avatar seed={key} name={name} size={92} />
          </View>
          <Txt v="title" accessibilityRole="header" style={{ textAlign: 'center', marginTop: S.xs }}>{name}</Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Txt v="small" style={{ fontVariant: ['tabular-nums'] }}>{fp}</Txt>
            {petname && profile?.name && <Txt v="small">{`· se fait appeler ${profile.name}`}</Txt>}
            {isMe && <Chip kind="accent" label="Toi" />}
            {following && <Chip kind="accent" label="Suivi" />}
          </View>
          {profile?.bio ? <Txt v="body" style={{ textAlign: 'center' }}>{profile.bio}</Txt> : null}
          {since(profile?.createdAt ?? 0) ? <Txt v="small">{`Sur Huwa depuis ${since(profile!.createdAt)}`}</Txt> : null}
          {!profile && !loading && (
            <Txt v="small" style={{ textAlign: 'center' }}>Profil pas encore reçu : il s’affichera quand un pair qui le connaît sera en ligne.</Txt>
          )}
        </View>

        {blocked && (
          <Callout icon="ban" tone="danger">Tu as bloqué ce compte. Ses commentaires sont masqués.</Callout>
        )}

        {isMe ? (
          <View style={{ flexDirection: 'row', gap: S.sm }}>
            <Button style={{ flex: 1 }} variant="soft" icon="create-outline" label="Modifier" onPress={() => router.push('/profile-edit')} />
            <Button style={{ flex: 1 }} variant="ghost" icon="share-outline" label="Partager" onPress={share} />
          </View>
        ) : !blocked ? (
          <View style={{ flexDirection: 'row', gap: S.sm }}>
            <Button
              style={{ flex: 1 }}
              variant={following ? 'ghost' : 'solid'}
              icon={following ? 'checkmark' : 'person-add-outline'}
              label={following ? 'Suivi' : 'Suivre'}
              onPress={() => {
                Haptics.selectionAsync();
                social.setFollow(key, !following);
              }}
            />
            <Button style={{ flex: 1 }} variant="soft" icon="chatbubble-outline" label="Message" onPress={() => router.push(`/dm/${key}`)} />
          </View>
        ) : (
          <Button variant="ghost" icon="lock-open-outline" label="Débloquer" onPress={toggleBlock} />
        )}

        {r.loading ? (
          <Loading />
        ) : (
          <>
            <View style={{ gap: S.sm }}>
              <RankCard rank={r.rank} onPress={() => router.push({ pathname: '/rank', params: { key } })} />
              <Txt v="small" style={{ paddingHorizontal: S.xs }}>
                Rang recalculé par ton appareil à partir de son journal signé ({r.rank.rejected.length} entrée{r.rank.rejected.length > 1 ? 's' : ''} non comptée{r.rank.rejected.length > 1 ? 's' : ''}).
              </Txt>
            </View>

            <View style={{ gap: S.md }}>
              <Txt v="section">Succès</Txt>
              <BadgeGrid badges={r.badges} limit={6} />
            </View>

            <View style={{ gap: S.xs }}>
              <Txt v="section">Activité récente</Txt>
              {recent.length ? (
                recent.map((a, i) => <HistoryRow key={i} entry={a.entry} xp={a.xp} />)
              ) : (
                <Txt v="small" style={{ paddingVertical: S.md }}>Pas encore d’activité.</Txt>
              )}
            </View>
          </>
        )}

        {isMe && (
          <View style={styles.qrCard}>
            <View style={styles.qr}>
              <QRCode value={profileLink(key)} size={148} color="#05070D" backgroundColor="#FFFFFF" quietZone={8} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Txt v="label">Mon QR de profil</Txt>
              <Txt v="small">{`Fais-le scanner pour qu’on te retrouve sans homonyme. ${shortKey(key)}`}</Txt>
            </View>
          </View>
        )}
      </Animated.ScrollView>
      <NavBar
        title={name}
        y={y}
        right={
          <>
            <IconButton icon="share-outline" label="Partager le profil" size={40} onPress={share} />
            {!isMe && <IconButton icon="ellipsis-horizontal" label="Plus d’actions" size={40} onPress={more} />}
          </>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  avatarRing: { padding: 4, borderRadius: 52, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, boxShadow: `${SHADOW.raised}, 0px 0px 0px 8px rgba(47,107,235,0.08)` },
  qrCard: { flexDirection: 'row', alignItems: 'center', gap: S.lg, padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, boxShadow: `${SHADOW.raised}, ${SHADOW.inset}` },
  qr: { borderRadius: R.control, overflow: 'hidden' },
});
