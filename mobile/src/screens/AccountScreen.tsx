import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../theme/ui';
import { useAtom, useSetAtom } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  clearStoredToken,
  getDefaultApiBaseUrl,
  logoutAccount,
  resetStoredApiBaseUrl,
  setStoredApiBaseUrl,
  updateMe,
  updatePlanTier,
} from '../api/client';
import {
  activeDmCallAtom,
  activeDmPeerByPodAtom,
  activePodIdAtom,
  activeVoiceSessionAtom,
  apiBaseUrlAtom,
  authTokenAtom,
  authUserAtom,
  callNoticeAtom,
  peerLastReadByPodPeerAtom,
  unreadDmByPodPeerAtom,
  unreadGroupByPodAtom,
} from '../state/atoms';
import { GUTTER, INSET, PIECES, TOUCH_MIN } from '../theme/palette';
import { Btn, Chip, fieldStyles } from '../components/Pieces';
import { GENDER_OPTIONS, NATIONALITY_CHIPS } from './AuthScreen';

const MONO_FONT = 'DMMono_500Medium';

export function AccountScreen({
  onLeaveVoiceOnLogout,
}: {
  onLeaveVoiceOnLogout?: () => void;
}) {
  const queryClient = useQueryClient();
  const [user, setUser] = useAtom(authUserAtom);
  const setToken = useSetAtom(authTokenAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const setActiveDmPeerMap = useSetAtom(activeDmPeerByPodAtom);
  const setUnreadGroupMap = useSetAtom(unreadGroupByPodAtom);
  const setUnreadDmMap = useSetAtom(unreadDmByPodPeerAtom);
  const setPeerLastReadMap = useSetAtom(peerLastReadByPodPeerAtom);
  const setVoiceSession = useSetAtom(activeVoiceSessionAtom);
  const setActiveDmCall = useSetAtom(activeDmCallAtom);
  const setCallNotice = useSetAtom(callNoticeAtom);
  const [apiBaseUrl, setApiBaseUrl] = useAtom(apiBaseUrlAtom);

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [gender, setGender] = useState(user?.gender ?? 'Prefer not to say');
  const [nationalityCode, setNationalityCode] = useState(
    user?.nationalityCode ?? 'IN'
  );
  const [saving, setSaving] = useState(false);
  const [updatingPlan, setUpdatingPlan] = useState(false);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isPro = user?.planTier === 'PREMIUM';

  const [serverDraft, setServerDraft] = useState(apiBaseUrl);
  const [serverStatus, setServerStatus] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setFullName(user.fullName);
      setGender(user.gender);
      setNationalityCode(user.nationalityCode);
    }
  }, [user]);

  const handleSaveProfile = async () => {
    setStatusMsg(null);
    setErrorMsg(null);
    if (!fullName.trim()) {
      setErrorMsg('Type your name.');
      return;
    }
    setSaving(true);
    try {
      const res = await updateMe({
        fullName: fullName.trim(),
        gender,
        nationalityCode,
      });
      setUser(res.user);
      setStatusMsg('Saved. Only your account sees this.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const handleTogglePlan = async () => {
    setPlanNotice(null);
    setErrorMsg(null);
    const nextTier = isPro ? 'FREE' : 'PREMIUM';
    setUpdatingPlan(true);
    try {
      const res = await updatePlanTier(nextTier);
      setUser(res.user);
      setPlanNotice(
        res.user.planTier === 'PREMIUM'
          ? 'You are on Canopy Pro. You can make your own groups.'
          : 'You are on the Free plan.'
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not change your plan.'
      );
    } finally {
      setUpdatingPlan(false);
    }
  };

  const handleSaveServerUrl = async () => {
    const updated = await setStoredApiBaseUrl(serverDraft);
    setApiBaseUrl(updated);
    setServerDraft(updated);
    setServerStatus(`Saved: ${updated}`);
  };

  const handleResetServerUrl = async () => {
    const def = await resetStoredApiBaseUrl();
    setApiBaseUrl(def);
    setServerDraft(def);
    setServerStatus(`Back to ${def}`);
  };

  const handleLogout = async () => {
    if (onLeaveVoiceOnLogout) {
      onLeaveVoiceOnLogout();
    }
    await logoutAccount();
    await clearStoredToken();
    setVoiceSession(null);
    setActiveDmCall(null);
    setCallNotice(null);
    setActiveDmPeerMap({});
    setUnreadGroupMap({});
    setUnreadDmMap({});
    setPeerLastReadMap({});
    setActivePodId(null);
    setUser(null);
    setToken(null);
    queryClient.clear();
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.pageTitle}>Account</Text>

      {/* The dark blocks: what stays in your account */}
      <View style={styles.privateRow}>
        {['Full name', 'Email', 'Gender', 'Nationality'].map((k) => (
          <View key={k} style={styles.privateBlock}>
            <Text style={styles.privateName}>{k}</Text>
            <Text style={styles.privateNote}>
              {k === 'Gender' || k === 'Nationality'
                ? 'Never read by matching'
                : 'Account only'}
            </Text>
          </View>
        ))}
      </View>
      <Text style={[styles.helperText, styles.pageText]}>
        Rooms never see these. Every room you join deals you its own alias.
      </Text>

      {/* Plan */}
      <View style={styles.card}>
        <View style={styles.planHeaderRow}>
          <Text style={styles.cardTitle}>Your plan</Text>
          <Text style={[styles.planBadge, isPro && styles.planBadgePro]}>
            {isPro ? 'Canopy Pro' : 'Free'}
          </Text>
        </View>
        <Text style={styles.helperText}>
          Free covers rooms of 10, 25 or 50, private chats and the room call.
          Canopy Pro lets you make and run your own group, invite only or
          listed for anyone to join.
        </Text>
        {planNotice ? <Text style={styles.successText}>{planNotice}</Text> : null}
        <Btn
          label={isPro ? 'Switch to Free' : 'Go Pro'}
          kind={isPro ? 'glass' : 'blue'}
          big
          wide
          loading={updatingPlan}
          onPress={handleTogglePlan}
          a11yLabel={isPro ? 'Switch to Free' : 'Upgrade to Canopy Pro'}
        />
      </View>

      {/* Private details */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Your details</Text>

        <View style={styles.field}>
          <Text style={fieldStyles.label}>Email</Text>
          <View style={styles.readOnlyBox}>
            <Text style={styles.readOnlyText}>{user?.email ?? '—'}</Text>
          </View>
        </View>

        <View style={styles.field}>
          <Text style={fieldStyles.label}>Full name</Text>
          <TextInput
            value={fullName}
            onChangeText={setFullName}
            placeholder="Your full name"
            placeholderTextColor={PIECES.muted}
            accessibilityLabel="Full name"
            style={fieldStyles.input}
          />
        </View>

        <View style={styles.field}>
          <Text style={fieldStyles.label}>Gender</Text>
          <View style={styles.pillsWrap}>
            {GENDER_OPTIONS.map((opt) => (
              <Chip
                key={opt}
                label={opt}
                active={gender === opt}
                onPress={() => setGender(opt)}
              />
            ))}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={fieldStyles.label}>Nationality</Text>
          <View style={styles.pillsWrap}>
            {NATIONALITY_CHIPS.map((chip) => (
              <Chip
                key={chip.code}
                label={chip.label}
                active={nationalityCode === chip.code}
                onPress={() => setNationalityCode(chip.code)}
                a11yLabel={chip.code === 'ZZ' ? 'Somewhere else' : chip.code}
              />
            ))}
          </View>
        </View>

        {errorMsg ? (
          <View style={styles.alertBox} accessibilityRole="alert">
            <Text style={styles.alertText}>{errorMsg}</Text>
          </View>
        ) : null}
        {statusMsg ? <Text style={styles.successText}>{statusMsg}</Text> : null}

        <Btn
          label="Save"
          kind="blue"
          big
          wide
          loading={saving}
          onPress={handleSaveProfile}
          a11yLabel="Save your details"
        />
      </View>

      {/* Server address */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Server</Text>
        <Text style={styles.helperText}>
          This device talks to {getDefaultApiBaseUrl()} by default. On a phone
          over Wi-Fi, use your computer's address instead.
        </Text>
        <TextInput
          value={serverDraft}
          onChangeText={setServerDraft}
          placeholder="http://localhost:8090"
          placeholderTextColor={PIECES.muted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Server address"
          style={[fieldStyles.input, styles.monoInput]}
        />
        <View style={styles.rowActions}>
          <Btn label="Save address" kind="ink" onPress={handleSaveServerUrl} />
          <Btn label="Reset" onPress={handleResetServerUrl} />
        </View>
        {serverStatus ? <Text style={styles.successText}>{serverStatus}</Text> : null}
      </View>

      <Btn
        label="Sign out"
        kind="off"
        big
        wide
        icon="log-out-outline"
        onPress={handleLogout}
        a11yLabel="Sign out"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PIECES.bg },
  content: { padding: GUTTER, gap: GUTTER, paddingBottom: 28, width: '100%', maxWidth: 640, alignSelf: 'center' },
  pageTitle: { fontSize: 32, lineHeight: 36, color: PIECES.ink, fontWeight: '600', paddingHorizontal: INSET, paddingTop: 4 },
  privateRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  privateBlock: {
    width: '48%',
    flexGrow: 1,
    backgroundColor: PIECES.ink,
    borderRadius: 20,
    paddingHorizontal: INSET,
    paddingVertical: 12,
    minHeight: 64,
  },
  privateName: { fontSize: 16, fontWeight: '600', color: PIECES.sheet },
  privateNote: { fontSize: 13, color: '#c9c9c9', marginTop: 2 },
  card: { backgroundColor: PIECES.sheet, borderRadius: 28, padding: INSET, gap: 14 },
  cardTitle: { fontSize: 22, color: PIECES.ink, fontWeight: '600' },
  planHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  planBadge: {
    fontSize: 14,
    fontWeight: '600',
    color: PIECES.ink,
    backgroundColor: PIECES.bg,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
    overflow: 'hidden',
  },
  planBadgePro: { backgroundColor: '#e6a92e' },
  helperText: { fontSize: 14, lineHeight: 20, color: PIECES.muted },
  // Outside a card, text lines up with the text inside the cards.
  pageText: { paddingHorizontal: INSET },
  successText: { fontSize: 14, fontWeight: '600', color: PIECES.ink, backgroundColor: '#9bddbb', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, overflow: 'hidden' },
  alertBox: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    backgroundColor: PIECES.off,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 0,
  },
  alertText: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  field: { gap: 8 },
  readOnlyBox: { minHeight: 56, borderRadius: 28, backgroundColor: PIECES.bg, paddingHorizontal: 22, justifyContent: 'center' },
  readOnlyText: { fontSize: 16, color: PIECES.ink2 },
  pillsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  monoInput: { fontFamily: MONO_FONT, fontSize: 15 },
  rowActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});
