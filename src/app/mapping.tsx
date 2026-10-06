import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { SheetTitle } from '@/components/screen';
import { Segmented } from '@/components/states';
import { Button, Press, Txt } from '@/components/ui';
import { getSeries, useCatalog } from '@/data/catalog';
import { MAX_CHAPTER, validateProposal, type ProposalValue } from '@/data/mapping';
import { useSeasonState } from '@/data/mapping-store';
import { proposeCorrection, seasonContext } from '@/data/mapping-sync';
import { C, F, R, S, SHADOW } from '@/theme/tokens';

/**
 * Sheet "Corriger la correspondance": the season end ("La saison s'arrête au ch. X") or one
 * episode ("Épisode N adapte les ch. A–B"), prefilled with what is shown today. The proposal is
 * signed with the identity and only replaces the estimate once enough people agree.
 */
export default function MappingSheet() {
  const params = useLocalSearchParams<{ series: string; ep?: string }>();
  useCatalog();
  const series = getSeries(params.series);
  const state = useSeasonState(series?.id);
  const eps = series?.anime?.episodes ?? [];
  const ctx = series ? seasonContext(series) : undefined;

  const initialEp = Math.min(Math.max(1, Number(params.ep) || 1), Math.max(1, eps.length));
  const [mode, setMode] = useState<'end' | 'ep'>(params.ep ? 'ep' : 'end');
  const [ep, setEp] = useState(initialEp);
  const shownEnd = state?.end && !state.end.verified ? state.end.to : eps[eps.length - 1]?.chapters[1] ?? 1;
  const [end, setEnd] = useState(shownEnd);
  const rangeOf = (n: number) => {
    const pending = state?.eps?.[n];
    if (pending && pending.from !== undefined && !pending.verified) return [pending.from, pending.to] as const;
    return eps[n - 1]?.chapters ?? ([1, 1] as const);
  };
  const [from, setFrom] = useState(rangeOf(initialEp)[0]);
  const [to, setTo] = useState(rangeOf(initialEp)[1]);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string>();

  const value: ProposalValue = mode === 'end' ? { field: 'end', to: end } : { field: 'ep', ep, from, to };
  const error = ctx ? validateProposal(value, ctx) : 'Cette série n’a pas de correspondance à corriger.';
  const max = ctx?.knownTotal ?? MAX_CHAPTER;

  const hint = useMemo(() => {
    if (!ctx || mode !== 'end') return undefined;
    const ratio = (end - ctx.after) / Math.max(1, ctx.episodes);
    const start = ctx.after + 1;
    return `Saison du ch. ${ctx.afterReliable ? '' : '≈ '}${start} au ch. ${end} · ${ratio > 0 ? ratio.toFixed(1).replace('.', ',') : '–'} ch. par épisode`;
  }, [ctx, mode, end]);

  if (!series?.anime || !ctx) {
    return (
      <View style={styles.sheet}>
        <Txt v="body">Cette série n’a pas de correspondance anime ↔ manhwa à corriger.</Txt>
      </View>
    );
  }

  const pickEp = (n: number) => {
    const next = Math.min(Math.max(1, n), eps.length);
    setEp(next);
    const [a, b] = rangeOf(next);
    setFrom(a);
    setTo(b);
  };

  const send = async () => {
    if (error) return;
    setBusy(true);
    setSendError(undefined);
    try {
      await proposeCorrection(series, value);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      router.back();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const season = (series.mapping?.season ?? 0) + 1;

  return (
    // Form sheet: the header lives inside the ScrollView.
    <ScrollView style={{ flex: 1, backgroundColor: C.surface }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={{ paddingBottom: S.xxl }}>
      <SheetTitle title={`${series.title}${season > 1 ? ` · Saison ${season}` : ''}`} subtitle="Corriger la correspondance" />
      <View style={styles.sheet}>
      <Segmented
        accessibilityLabel="Ce que tu corriges"
        value={mode}
        onChange={setMode}
        options={[{ value: 'end', label: 'Fin de saison' }, { value: 'ep', label: 'Un épisode' }]}
      />

      {mode === 'end' ? (
        <View style={styles.card}>
          <Txt v="label">La saison s’arrête au chapitre</Txt>
          <Stepper value={end} onChange={setEnd} min={1} max={max} label="Dernier chapitre adapté" />
          {hint && <Txt v="small">{hint}</Txt>}
        </View>
      ) : (
        <View style={styles.card}>
          <View style={styles.line}>
            <Txt v="label" style={{ flex: 1 }}>Épisode</Txt>
            <Stepper value={ep} onChange={pickEp} min={1} max={eps.length} label="Épisode" compact />
          </View>
          <View style={styles.line}>
            <Txt v="label" style={{ flex: 1 }}>adapte du ch.</Txt>
            <Stepper value={from} onChange={setFrom} min={1} max={max} label="Premier chapitre" compact />
          </View>
          <View style={styles.line}>
            <Txt v="label" style={{ flex: 1 }}>au ch.</Txt>
            <Stepper value={to} onChange={setTo} min={1} max={max} label="Dernier chapitre" compact />
          </View>
        </View>
      )}

      {(error || sendError) && (
        <View style={styles.line}>
          <Ionicons name="alert-circle" size={16} color={C.danger} />
          <Txt v="small" color={C.danger} style={{ flex: 1 }}>{sendError ?? error}</Txt>
        </View>
      )}

      <Txt v="footnote" color={C.text3} style={{ lineHeight: 17 }}>
        Ta proposition est signée avec ton identité. Elle remplace l’estimation quand au moins 3 membres, dont
        assez d’habitués, donnent la même valeur. Tu peux la changer à tout moment : seule la plus récente compte.
      </Txt>

      <Button label="Envoyer" icon="paper-plane" loading={busy} disabled={!!error} onPress={send} />
      </View>
    </ScrollView>
  );
}

function Stepper({
  value,
  onChange,
  min,
  max,
  label,
  compact,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  label: string;
  compact?: boolean;
}) {
  const [text, setText] = useState<string>();
  const set = (n: number) => {
    setText(undefined);
    onChange(Math.min(max, Math.max(min, n)));
    Haptics.selectionAsync().catch(() => {});
  };
  return (
    <View style={[styles.stepper, !compact && { alignSelf: 'stretch' }]}>
      <Press onPress={() => set(value - 1)} style={styles.stepBtn} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${label} : moins`}>
        <Ionicons name="remove" size={18} color={C.text} />
      </Press>
      <TextInput
        value={text ?? String(value)}
        onChangeText={(t) => {
          const clean = t.replace(/[^0-9]/g, '').slice(0, 5);
          setText(clean);
          if (clean) onChange(Math.min(max, Math.max(min, Number(clean))));
        }}
        onBlur={() => setText(undefined)}
        keyboardType="number-pad"
        returnKeyType="done"
        selectTextOnFocus
        accessibilityLabel={label}
        style={[styles.stepInput, compact ? { width: 64 } : { flex: 1 }]}
      />
      <Press onPress={() => set(value + 1)} style={styles.stepBtn} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${label} : plus`}>
        <Ionicons name="add" size={18} color={C.text} />
      </Press>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: S.lg, paddingTop: S.md, gap: S.lg },
  card: {
    gap: S.md, padding: S.md, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border, boxShadow: SHADOW.inset,
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  stepBtn: {
    width: 44, height: 44, borderRadius: R.control, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, boxShadow: SHADOW.inset,
  },
  stepInput: {
    height: 44, borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.surface, color: C.text,
    textAlign: 'center', fontSize: 17, ...F.bold, borderWidth: 1, borderColor: C.border, fontVariant: ['tabular-nums'],
  },
  busy: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm, minHeight: 50 },
});
