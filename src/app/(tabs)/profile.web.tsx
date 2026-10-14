// Web Profile tab: the native profile once signed in; otherwise the sign-in screen (D7, D16).
// Phase 1 wires the three ways in to what exists today (see src/web/sign-in.tsx).
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Txt, Wordmark } from '@/components/ui';
import { useMe } from '@/p2p/hooks';
import { C, R, S, SHADOW } from '@/theme/tokens';
import { SignInActions, SignInHeader } from '@/web/sign-in';
import { WIDE } from '@/web/viewport';

import type NativeProfile from './profile';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Profile: typeof NativeProfile = require('./profile.tsx').default;

const POINTS = [
  { title: 'Une clé, pas un mot de passe', text: 'Ton compte est une paire de clés gardée dans ce navigateur. Aucun serveur ne la détient.' },
  { title: 'Un navigateur, une session', text: 'Se connecter ici ne connecte personne d’autre : chaque navigateur a sa propre session.' },
  { title: 'Tes extensions te suivent', text: 'Une fois lié à ton téléphone, ce navigateur retrouve tes extensions et ta progression.' },
];

export default function ProfileTab() {
  const me = useMe();
  if (me) return <Profile />;
  return <SignInScreen />;
}

function SignInScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={[styles.page, { paddingTop: insets.top + (wide ? S.xxl * 2 : S.xl) }]}>
      <View style={[styles.column, wide && styles.card]}>
        {!wide && <Wordmark size={28} />}
        <SignInHeader reason="account" large />
        <SignInActions />
        <View style={styles.points}>
          {POINTS.map((p) => (
            <View key={p.title} style={{ gap: 2 }}>
              <Txt v="label">{p.title}</Txt>
              <Txt v="small" style={{ lineHeight: 18 }}>{p.text}</Txt>
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, alignItems: 'center', paddingHorizontal: S.lg, paddingBottom: S.xxl * 2 },
  column: { width: '100%', maxWidth: 480, gap: S.xl },
  card: {
    padding: S.xxl, borderRadius: R.sheet, borderCurve: 'continuous', backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.border, boxShadow: `${SHADOW.raised}, ${SHADOW.inset}`,
  },
  points: { gap: S.md, paddingTop: S.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.hairline },
});
