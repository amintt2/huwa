// Centered column for the phone-designed pages (series details, calendar…) on a wide screen.
// Stretched to 1200 px, their full-width buttons and one-line rows read as a spreadsheet; in a
// column they keep their proportions, over a blurred, dimmed backdrop of the series art so the
// space around is not dead. `ViewportCap` makes `useWindowDimensions()` report the column width.
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { C } from '@/theme/tokens';

import { ViewportCap, useContentDimensions } from './viewport';

export function WideColumn({ children, max = 920, backdrop }: { children: ReactNode; max?: number; backdrop?: string }) {
  const { width } = useContentDimensions();
  if (width <= max + 48) return <>{children}</>;
  return (
    <View style={styles.root}>
      {backdrop ? (
        <>
          <Image source={backdrop} style={[StyleSheet.absoluteFill, { opacity: 0.32 }]} contentFit="cover" blurRadius={48} transition={300} />
          <LinearGradient colors={['rgba(5,7,13,0.55)', C.bg]} locations={[0, 0.85]} style={StyleSheet.absoluteFill} pointerEvents="none" />
        </>
      ) : null}
      <View style={[styles.column, { maxWidth: max }]}>
        <ViewportCap.Provider value={max}>{children}</ViewportCap.Provider>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, alignItems: 'center' },
  column: {
    flex: 1, width: '100%', backgroundColor: C.bg, overflow: 'hidden',
    borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: C.hairline,
    boxShadow: '0px 0px 80px rgba(0,0,0,0.6)',
  },
});
