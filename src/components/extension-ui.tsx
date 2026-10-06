// Shared look of the extension screens (hub, add, install, detail, manhwa sources): logo with a
// monogram fallback, capability chips, preview card, section header, one-line trust note.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { hasResource, resourceNames, type Manifest } from '@/addons/protocol';
import { C, F, R, S, SHADOW } from '@/theme/tokens';

import { Button, Press, Txt, type IconName } from './ui';

export const ADDON_LEGAL =
  'Huwa ne fournit, n’héberge ni n’indexe aucun contenu, et ne vérifie pas les extensions. Une extension est un service tiers, hébergé par son auteur : ' +
  'tu es seul responsable de celles que tu installes et de la légalité de leurs contenus dans ton pays.';

export const hostOf = (u: string) => /^[a-z][\w+.-]*:\/\/([^/?#]+)/i.exec(u)?.[1] ?? u;

/** Manifest logo (`logo`, or the non-standard `icon` some addons use). */
export const logoOf = (m?: Manifest) => m?.logo || (m as { icon?: string } | undefined)?.icon || undefined;

export /** Where the new addon shows up, from what it provides. */
function installedWhat(m: Manifest) {
  const parts = [
    hasResource(m, 'stream') && 'ses sources dans le menu Sources de chaque épisode',
    hasResource(m, 'subtitles') && 'ses sous-titres dans le lecteur',
    hasResource(m, 'catalog') && 'ses catalogues dans Découvrir',
  ].filter(Boolean) as string[];
  if (!parts.length) return 'Elle complète les fiches et identifiants utilisés par tes autres extensions.';
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} et ${parts[parts.length - 1]}` : parts[0];
  return `Tu trouveras ${text}.`;
}

// ---------- logo ----------

const initials = (name: string) => {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
};

/** Square logo; a two-letter monogram when there is none or it fails to load. */
export function ExtLogo({ uri, name, size = 44, icon }: { uri?: string; name: string; size?: number; icon?: IconName }) {
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const box = { width: size, height: size, borderRadius: size * 0.26, borderCurve: 'continuous' as const };
  if (uri && failed !== uri) {
    return (
      <View style={[box, styles.logoBox]}>
        <Image source={{ uri }} style={{ width: size, height: size }} contentFit="contain" onError={() => setFailed(uri)} cachePolicy="memory-disk" />
      </View>
    );
  }
  return (
    <View style={[box, styles.logoBox, { backgroundColor: C.accentSoft, borderColor: C.accentLine }]} accessibilityElementsHidden importantForAccessibility="no">
      {icon ? (
        <Ionicons name={icon} size={size * 0.46} color={C.accentText} />
      ) : (
        <Txt allowFontScaling={false} color={C.accentText} style={{ ...F.black, fontSize: Math.round(size * 0.36), lineHeight: Math.round(size * 0.5), textAlign: 'center' }}>{initials(name)}</Txt>
      )}
    </View>
  );
}

// ---------- capabilities ----------

const CAP: Record<string, { label: string; icon: IconName }> = {
  stream: { label: 'Flux', icon: 'play-circle-outline' },
  subtitles: { label: 'Sous-titres', icon: 'text-outline' },
  catalog: { label: 'Catalogues', icon: 'grid-outline' },
  meta: { label: 'Fiches', icon: 'information-circle-outline' },
  addon_catalog: { label: 'Annuaire', icon: 'albums-outline' },
};
const TYPE_LABEL: Record<string, string> = { series: 'Séries', movie: 'Films', anime: 'Anime', channel: 'Chaînes', tv: 'TV', other: 'Autres' };

export type Cap = { label: string; icon?: IconName; tone?: 'accent' | 'neutral' | 'warn' };

export function capabilities(m: Manifest, withTypes = true): Cap[] {
  const caps: Cap[] = [...new Set(resourceNames(m))].map((r) => ({ ...(CAP[r] ?? { label: r }), tone: 'accent' as const }));
  if (withTypes) for (const t of m.types ?? []) caps.push({ label: TYPE_LABEL[t] ?? t, tone: 'neutral' });
  if (m.behaviorHints?.p2p) caps.push({ label: 'Torrent', icon: 'git-network-outline', tone: 'warn' });
  if (m.behaviorHints?.adult) caps.push({ label: 'Adulte', icon: 'warning-outline', tone: 'warn' });
  return caps;
}

export const capabilitySummary = (m: Manifest) => [...new Set(resourceNames(m))].map((r) => CAP[r]?.label ?? r).join(', ');

const WARN = '#FFC857';

export function CapChip({ cap }: { cap: Cap }) {
  const tone = cap.tone ?? 'neutral';
  const fg = tone === 'accent' ? C.accentText : tone === 'warn' ? WARN : C.body;
  return (
    <View style={[styles.cap, tone === 'accent' && { backgroundColor: C.accentSoft, borderColor: C.accentLine }, tone === 'warn' && { backgroundColor: 'rgba(255,200,87,0.12)', borderColor: 'rgba(255,200,87,0.35)' }]}>
      {cap.icon && <Ionicons name={cap.icon} size={11} color={fg} />}
      <Txt v="small" color={fg} numberOfLines={1} style={{ fontSize: 11, ...F.semibold }}>{cap.label}</Txt>
    </View>
  );
}

export function CapChips({ caps, max }: { caps: Cap[]; max?: number }) {
  const shown = max ? caps.slice(0, max) : caps;
  const more = caps.length - shown.length;
  if (!caps.length) return null;
  return (
    <View style={styles.caps}>
      {shown.map((c) => <CapChip key={c.label} cap={c} />)}
      {more > 0 && <CapChip cap={{ label: `+${more}` }} />}
    </View>
  );
}

// ---------- preview card ----------

export type PreviewLine = { icon: IconName; text: string; tone?: 'warn' | 'ok' };

/** Logo, name, meta line, description, chips and a few trust lines, on one card. */
export function PreviewCard({
  logo,
  icon,
  name,
  meta,
  kind,
  description,
  caps,
  lines,
  children,
}: {
  logo?: string;
  icon?: IconName;
  name: string;
  meta?: string;
  kind?: string;
  description?: string;
  caps?: Cap[];
  lines?: PreviewLine[];
  children?: ReactNode;
}) {
  return (
    <View style={styles.preview}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <ExtLogo uri={logo} name={name} icon={icon} size={56} />
        <View style={{ flex: 1, gap: 3 }}>
          {kind ? <Txt v="caption" color={C.accentText} style={{ fontSize: 10 }} numberOfLines={1}>{kind}</Txt> : null}
          <Txt v="title" style={{ fontSize: 20 }} numberOfLines={2}>{name}</Txt>
          {meta ? <Txt v="small" numberOfLines={1}>{meta}</Txt> : null}
        </View>
      </View>
      {description ? <Txt v="body" numberOfLines={6} style={{ color: C.body }}>{description}</Txt> : null}
      {caps?.length ? <CapChips caps={caps} /> : null}
      {lines?.length ? (
        <View style={styles.lines}>
          {lines.map((l) => (
            <View key={l.text} style={{ flexDirection: 'row', gap: S.sm, alignItems: 'flex-start' }}>
              <Ionicons name={l.icon} size={15} color={l.tone === 'warn' ? WARN : l.tone === 'ok' ? C.success : C.text2} style={{ marginTop: 1 }} />
              <Txt v="small" style={{ flex: 1, lineHeight: 18 }} color={l.tone === 'warn' ? WARN : C.body}>{l.text}</Txt>
            </View>
          ))}
        </View>
      ) : null}
      {children}
    </View>
  );
}

// ---------- trust note ----------

/** One friendly line; "En savoir plus" unfolds the full responsibility text. */
export function TrustNote({ text = 'Huwa ne fournit aucun contenu : les extensions viennent de leurs auteurs, et tu choisis ce que tu installes.', more = ADDON_LEGAL }: { text?: string; more?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.trust}>
      <Ionicons name="shield-checkmark-outline" size={18} color={C.accentText} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: S.xs }}>
        <Txt v="small" color={C.body} style={{ lineHeight: 18 }}>{text}</Txt>
        {open ? <Txt v="small" style={{ lineHeight: 18, color: C.body }}>{more}</Txt> : null}
        <Press onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={8} style={{ alignSelf: 'flex-start' }}>
          <Txt v="small" color={C.accentText} style={F.semibold}>{open ? 'Masquer' : 'En savoir plus'}</Txt>
        </Press>
      </View>
    </View>
  );
}

// ---------- hub section ----------

export function SectionTitle({ icon, title, subtitle, count, action, onAction }: { icon: IconName; title: string; subtitle?: string; count?: number; action?: string; onAction?: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
      <View style={styles.sectionIcon}>
        <Ionicons name={icon} size={18} color={C.accentText} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
          <Txt v="section" numberOfLines={1} style={{ flexShrink: 1 }} accessibilityRole="header">{title}</Txt>
          {count != null && (
            <View style={styles.count} accessibilityLabel={`${count} installée${count > 1 ? 's' : ''}`}>
              <Txt v="small" color={C.body} style={{ fontSize: 12, ...F.bold }}>{count}</Txt>
            </View>
          )}
        </View>
        {subtitle ? <Txt v="small" numberOfLines={2}>{subtitle}</Txt> : null}
      </View>
      {action && (
        <Press onPress={onAction} accessibilityRole="button" accessibilityLabel={`${action} : ${title}`} hitSlop={6} style={[styles.addPill, styles.softPill]}>
          <Ionicons name="add" size={16} color={C.accentText} />
          <Txt v="small" color={C.accentText} style={F.bold} numberOfLines={1}>{action}</Txt>
        </Press>
      )}
    </View>
  );
}

/** Rounded container of rows, with hairlines between them. */
export function Card({ children, tinted }: { children: ReactNode; tinted?: boolean }) {
  return <View style={[styles.card, tinted && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>{children}</View>;
}

/** Guiding empty state inside a card. */
export function EmptyCard({ icon, text, action, onAction }: { icon: IconName; text: string; action: string; onAction: () => void }) {
  return (
    <View style={styles.card}>
      <View style={{ alignItems: 'center', gap: S.md, padding: S.xl }}>
        <View style={styles.emptyIcon}>
          <Ionicons name={icon} size={24} color={C.accentText} />
        </View>
        <Txt v="small" style={{ textAlign: 'center', lineHeight: 19, color: C.body, maxWidth: 300 }}>{text}</Txt>
        <Button small variant="soft" icon="add" label={action} onPress={onAction} />
      </View>
    </View>
  );
}

/** A link-like row inside a Card: icon tile, label, hint, chevron. Pressed: highlight, no scale (rows). */
export function LinkRow({ icon, label, hint, onPress, last, right, external }: { icon: IconName; label: string; hint?: string; onPress: () => void; last?: boolean; right?: ReactNode; external?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole={external ? 'link' : 'button'} accessibilityLabel={hint ? `${label}, ${hint}` : label}
      style={({ pressed }) => [styles.linkRow, pressed && { backgroundColor: 'rgba(255,255,255,0.06)' }]}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={17} color={C.accentText} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" numberOfLines={2}>{label}</Txt>
        {hint ? <Txt v="small" numberOfLines={3} style={{ lineHeight: 18 }}>{hint}</Txt> : null}
      </View>
      {right}
      <Ionicons name={external ? 'open-outline' : 'chevron-forward'} size={16} color={C.text3} />
      {!last && <View style={styles.inset} />}
    </Pressable>
  );
}

export const extStyles = StyleSheet.create({
  line: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
});

const styles = StyleSheet.create({
  logoBox: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border },
  caps: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cap: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 3, paddingHorizontal: 8,
    borderRadius: R.pill, backgroundColor: C.pill, borderWidth: 1, borderColor: C.pillLine,
  },
  preview: { gap: S.md, padding: S.lg, borderRadius: R.card + 4, borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border },
  lines: { gap: S.sm, paddingTop: S.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.hairline },
  trust: { flexDirection: 'row', gap: S.md, padding: 14, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: 'rgba(47,107,235,0.08)', borderWidth: 1, borderColor: 'rgba(127,176,255,0.20)' },
  sectionIcon: { width: 36, height: 36, borderRadius: 11, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: C.accentSoft },
  count: { minWidth: 24, height: 22, paddingHorizontal: 7, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: C.pill },
  addPill: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 34, paddingHorizontal: 12, borderRadius: R.pill, backgroundColor: C.accent },
  softPill: { backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine },
  card: { borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, overflow: 'hidden', boxShadow: SHADOW.inset },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.accentLine, boxShadow: `0px 0px 0px 8px rgba(47,107,235,0.10), ${SHADOW.inset}` },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: S.md, paddingHorizontal: S.md, minHeight: 56 },
  rowIcon: { width: 30, height: 30, borderRadius: 8, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: C.accentSoft },
  inset: { position: 'absolute', left: S.md + 30 + S.md, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: C.hairline },
  line: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
});
