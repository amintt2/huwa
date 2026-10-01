// "Infos des extensions" in the sources menu: the rows addons return that are not videos
// (AIOStreams scrape summaries, removal reasons, errors such as "no debrid service", donation
// banners). Errors stay visible — they explain an empty list —, the rest folds into a summary.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { infoKind, type AddonStream, type InfoKind } from '@/addons/protocol';
import { C, R, S } from '@/theme/tokens';

import { Press, Txt, type IconName } from './ui';

const WARN = '#F5B544';
const ERROR = '#FF6B6B';

const TONE: Record<InfoKind, { color: string; icon: IconName }> = {
  error: { color: ERROR, icon: 'alert-circle' },
  warning: { color: WARN, icon: 'warning' },
  statistic: { color: C.success, icon: 'checkmark-circle' },
  promo: { color: C.accentText, icon: 'heart' },
};

type Pair = { key: string; value: string };
type Parsed = { kind: InfoKind; title: string; scope?: string; pairs: Pair[]; lines: string[]; link?: string; addon: string };

// Leading emoji / status markers ("🟢", "[❌]", "🔍"…) are replaced by our own icons.
const stripMarks = (t: string) => t.replace(/^[\s\p{Extended_Pictographic}️‍✔✓•─]+/u, '').replace(/^\[[❌✓✔!x]\]\s*/u, '').trim();

/** "🟢 [Meteor p2p] Scrape Summary" → scope "Meteor p2p", title "Scrape Summary". */
function parse(s: AddonStream): Parsed {
  const kind = infoKind(s) ?? 'statistic';
  const raw = stripMarks((s.name ?? s.title ?? '').replace(/\n/g, ' '));
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(raw);
  const scope = m?.[1];
  const title = (m ? m[2] : raw) || (kind === 'promo' ? 'Soutenir l’extension' : 'Info');
  const pairs: Pair[] = [];
  const lines: string[] = [];
  for (const line of (s.description ?? s.title ?? '').split('\n')) {
    const l = stripMarks(line);
    if (!l || /^[─━-]+$/.test(l)) continue;
    const kv = /^([^:]{1,24}?)\s*:\s*(.+)$/.exec(l);
    if (kv && !/^https?$/i.test(kv[1])) pairs.push({ key: kv[1].trim(), value: kv[2].trim() });
    else lines.push(l.replace(/\s{2,}/g, ' '));
  }
  return { kind, title, scope, pairs, lines, link: s.externalUrl, addon: s.addonName };
}

const pick = (p: Parsed, re: RegExp) => p.pairs.find((x) => re.test(x.key))?.value;

/** One-line summary of a scrape row: "13 flux · 291 ms". */
function summary(p: Parsed): string {
  const n = pick(p, /stream|flux|result/i);
  const t = pick(p, /time|durée|temps/i);
  const parts = [n && `${n} flux`, t?.replace(/(\d+)\.00ms/, '$1 ms')].filter(Boolean);
  return parts.length ? parts.join(' · ') : (p.lines[0] ?? p.pairs.map((x) => `${x.key} ${x.value}`).join(' · '));
}

function InfoRow({ p, expanded, onToggle }: { p: Parsed; expanded: boolean; onToggle: () => void }) {
  const tone = TONE[p.kind];
  const head = p.scope ?? p.title;
  const sub = p.scope ? p.title : undefined;
  if (p.kind === 'promo') {
    return (
      <Press onPress={() => p.link && Linking.openURL(p.link).catch(() => {})} style={styles.row} accessibilityRole="link">
        <Ionicons name={tone.icon} size={16} color={tone.color} />
        <Txt v="small" style={{ flex: 1 }} numberOfLines={1}>{p.lines[0] ?? head}</Txt>
        <Ionicons name="open-outline" size={14} color={C.text2} />
      </Press>
    );
  }
  return (
    <Press onPress={onToggle} style={styles.row} accessibilityRole="button" accessibilityState={{ expanded }}>
      <Ionicons name={tone.icon} size={16} color={tone.color} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: S.sm }}>
          <Txt v="label" style={{ fontSize: 14, flexShrink: 1 }} numberOfLines={1}>{head}</Txt>
          {sub && <Txt v="small" style={{ fontSize: 12 }} numberOfLines={1}>{sub}</Txt>}
        </View>
        {!expanded && <Txt v="small" numberOfLines={1}>{p.kind === 'error' ? (p.lines[0] ?? summary(p)) : summary(p)}</Txt>}
        {expanded && (
          <View style={{ gap: 3 }}>
            {p.pairs.map((x, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: S.sm }}>
                <Txt v="small" style={{ width: 92 }} numberOfLines={1}>{x.key}</Txt>
                <Txt v="small" color={C.body} style={{ flex: 1 }}>{x.value}</Txt>
              </View>
            ))}
            {p.lines.map((l, i) => <Txt key={i} v="small" color={C.body}>{l}</Txt>)}
          </View>
        )}
      </View>
      {(p.pairs.length > 0 || p.lines.length > 1) && (
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={C.text2} style={{ marginTop: 2 }} />
      )}
    </Press>
  );
}

export function AddonInfos({ infos }: { infos: AddonStream[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!infos.length) return null;
  const parsed = infos.map(parse);
  const errors = parsed.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'error');
  const rest = parsed.map((p, i) => ({ p, i })).filter(({ p }) => p.kind !== 'error');
  const warnings = rest.filter(({ p }) => p.kind === 'warning').length;
  const addons = [...new Set(parsed.map((p) => p.addon))].join(', ');
  const toggle = (i: number) => setExpanded((e) => (e === i ? null : i));

  return (
    <View style={{ gap: S.sm }}>
      <Txt v="caption">Infos des extensions</Txt>
      <View style={styles.card}>
        {errors.map(({ p, i }) => <InfoRow key={i} p={p} expanded={expanded === i} onToggle={() => toggle(i)} />)}
        {rest.length > 0 && (
          <Press onPress={() => setOpen((o) => !o)} style={styles.row} accessibilityRole="button" accessibilityState={{ expanded: open }}>
            <Ionicons name="pulse" size={16} color={C.accentText} />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label" style={{ fontSize: 14 }}>Détails de la recherche</Txt>
              <Txt v="small" numberOfLines={1}>
                {addons} · {rest.length} info{rest.length > 1 ? 's' : ''}{warnings ? ` · ${warnings} avertissement${warnings > 1 ? 's' : ''}` : ''}
              </Txt>
            </View>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={C.text2} />
          </Press>
        )}
        {open && rest.map(({ p, i }) => <InfoRow key={i} p={p} expanded={expanded === i} onToggle={() => toggle(i)} />)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: S.md, paddingHorizontal: S.md, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border
  },
});
