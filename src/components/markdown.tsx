// Markdown subset → React Native Text spans (parser: src/social/markdown.ts). No WebView, no HTML.
// Links show their domain and are confirmed before opening; ||spoilers|| reveal on tap; anchors
// (12:47, p. 12) are tappable chips.
import * as WebBrowser from 'expo-web-browser';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Alert, Platform, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { anchorA11y, anchorLabel, type Anchor } from '@/social/anchors';
import { parseMarkdown, type Block, type Inline, type MdOptions } from '@/social/markdown';
import { C, F, R, S } from '@/theme/tokens';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export function confirmLink(href: string, domain: string) {
  Alert.alert(`Ouvrir ${domain} ?`, `${href}\n\nCe lien quitte Huwa. Vérifie qu’il mène bien où tu crois.`, [
    { text: 'Annuler', style: 'cancel' },
    { text: 'Ouvrir', onPress: () => WebBrowser.openBrowserAsync(href).catch(() => {}) },
  ]);
}

type Ctx = {
  onAnchor?: (a: Anchor) => void;
  revealed: Set<number>;
  reveal: (k: number) => void;
  counter: { n: number };
  base: TextStyle;
};

function renderInline(nodes: Inline[], ctx: Ctx, key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={k}>{n.s}</Fragment>;
      case 'br':
        return <Fragment key={k}>{'\n'}</Fragment>;
      case 'b':
        return <Text key={k} style={F.bold}>{renderInline(n.c, ctx, k)}</Text>;
      case 'i':
        return <Text key={k} style={{ fontStyle: 'italic' }}>{renderInline(n.c, ctx, k)}</Text>;
      case 's':
        return <Text key={k} style={{ textDecorationLine: 'line-through' }}>{renderInline(n.c, ctx, k)}</Text>;
      case 'code':
        return <Text key={k} style={styles.code}>{n.s}</Text>;
      case 'link':
        return (
          <Text key={k} style={styles.link} onPress={() => confirmLink(n.href, n.domain)} accessibilityRole="link" accessibilityHint={`Ouvre ${n.domain}`}>
            {renderInline(n.c, ctx, k)}
            <Text style={styles.domain}>{` (${n.domain})`}</Text>
          </Text>
        );
      case 'anchor': {
        const tappable = !!ctx.onAnchor;
        return (
          <Text
            key={k}
            style={[styles.anchor, !tappable && { color: ctx.base.color }]}
            onPress={tappable ? () => ctx.onAnchor!(n.anchor) : undefined}
            accessibilityRole={tappable ? 'button' : undefined}
            accessibilityLabel={anchorA11y(n.anchor)}>
            {n.anchor.type === 'time' ? '▸ ' : ''}
            {anchorLabel(n.anchor)}
          </Text>
        );
      }
      case 'spoiler': {
        const id = ctx.counter.n++;
        const open = ctx.revealed.has(id);
        return (
          <Text
            key={k}
            onPress={open ? undefined : () => ctx.reveal(id)}
            accessibilityRole={open ? undefined : 'button'}
            accessibilityLabel={open ? undefined : 'Spoiler masqué, touche pour afficher'}
            style={open ? styles.spoilerOpen : styles.spoiler}>
            {renderInline(n.c, ctx, k)}
          </Text>
        );
      }
    }
  });
}

function renderBlocks(blocks: Block[], ctx: Ctx, key = ''): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}/${i}`;
    switch (b.t) {
      case 'p':
        return <Text key={k} style={ctx.base}>{renderInline(b.c, ctx, k)}</Text>;
      case 'code':
        return (
          <View key={k} style={styles.codeBlock}>
            <Text style={[ctx.base, { fontFamily: MONO, fontSize: 13, lineHeight: 18 }]}>{b.s}</Text>
          </View>
        );
      case 'quote':
        return (
          <View key={k} style={styles.quote}>
            {renderBlocks(b.c, { ...ctx, base: { ...ctx.base, color: C.text2 } }, k)}
          </View>
        );
      case 'list':
        return (
          <View key={k} style={{ gap: 2 }}>
            {b.items.map((it, j) => (
              <View key={j} style={{ flexDirection: 'row', gap: 6 }}>
                <Text style={[ctx.base, { minWidth: 14, color: C.text3 }]}>{b.ordered ? `${b.start + j}.` : '•'}</Text>
                <Text style={[ctx.base, { flex: 1 }]}>{renderInline(it, ctx, `${k}-${j}`)}</Text>
              </View>
            ))}
          </View>
        );
    }
  });
}

/** Rendered comment body. `times` / `pages` turn typed anchors into chips. */
export function Markdown({
  text,
  options,
  onAnchor,
  style,
}: {
  text: string;
  options?: MdOptions;
  onAnchor?: (a: Anchor) => void;
  style?: TextStyle;
}) {
  const blocks = useMemo(() => parseMarkdown(text, options), [text, options]);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const base: TextStyle = { ...F.regular, fontSize: 15, lineHeight: 21, color: C.body, ...style };
  const ctx: Ctx = { onAnchor, revealed, reveal: (k) => setRevealed((s) => new Set(s).add(k)), counter: { n: 0 }, base };
  return <View style={{ gap: 6 }}>{renderBlocks(blocks, ctx)}</View>;
}

const styles = StyleSheet.create({
  code: { fontFamily: MONO, fontSize: 13, backgroundColor: 'rgba(255,255,255,0.08)', color: C.text },
  codeBlock: { padding: S.sm + 2, borderRadius: R.chip, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: C.hairline },
  quote: { borderLeftWidth: 3, borderLeftColor: C.borderStrong, paddingLeft: 10, gap: 4 },
  link: { color: C.accentText, textDecorationLine: 'underline' },
  domain: { color: C.text3, textDecorationLine: 'none', fontSize: 12 },
  anchor: { color: C.accentText, ...F.semibold, fontVariant: ['tabular-nums'] },
  spoiler: { backgroundColor: C.text3, color: C.text3 },
  spoilerOpen: { backgroundColor: 'rgba(255,255,255,0.08)' },
});
