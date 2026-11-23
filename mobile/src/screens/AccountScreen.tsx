import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
  dmCallNoticeAtom,
  peerLastReadByPodPeerAtom,
  unreadDmByPodPeerAtom,
  unreadGroupByPodAtom,
} from '../state/atoms';
import { PALETTE, TOUCH_MIN } from '../theme/palette';
import { GENDER_OPTIONS, NATIONALITY_CHIPS } from './AuthScreen';

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

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
  const setDmCallNotice = useSetAtom(dmCallNoticeAtom);
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
      setErrorMsg('Full Name cannot be empty.');
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
      setStatusMsg('Private profile saved.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Save failed.');
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
          ? 'Upgraded to Canopy Pro — custom Admin groups unlocked.'
          : 'Switched account to Free plan.'
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not update plan tier.'
      );
    } finally {
      setUpdatingPlan(false);
    }
  };

  const handleSaveServerUrl = async () => {
    const updated = await setStoredApiBaseUrl(serverDraft);
    setApiBaseUrl(updated);
    setServerDraft(updated);
    setServerStatus(`Saved Server URL: ${updated}`);
  };

  const handleResetServerUrl = async () => {
    const def = await resetStoredApiBaseUrl();
    setApiBaseUrl(def);
    setServerDraft(def);
    setServerStatus(`Reset to default: ${def}`);
  };

  const handleLogout = async () => {
    if (onLeaveVoiceOnLogout) {
      onLeaveVoiceOnLogout();
    }
    await logoutAccount();
    await clearStoredToken();
    setVoiceSession(null);
    setActiveDmCall(null);
    setDmCallNotice(null);
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
      {/* Privacy Boundary Card */}
      <View style={styles.privacyBanner}>
        <Text style={styles.privacyBadgeText}>
          🔒 Private to you · Hidden from all rooms
        </Text>
        <Text style={styles.privacyDescription}>
          Peers inside your pods never see your email, real name, gender, or
          nationality. Every pod assigns you an isolated room-scoped animal
          alias and deterministic peer hash.
        </Text>
      </View>

      {/* Membership Plan Card (Free vs Canopy Pro) */}
      <View style={[styles.card, isPro && styles.proCardBorder]}>
        <View style={styles.planHeaderRow}>
          <Text style={styles.cardTitle}>Membership Plan</Text>
          <View style={[styles.planBadge, isPro && styles.planBadgePro]}>
            <Text
              style={[styles.planBadgeText, isPro && styles.planBadgeTextPro]}
            >
              {isPro ? '👑 Canopy Pro' : 'Free'}
            </Text>
          </View>
        </View>
        <Text style={styles.helperText}>
          Free includes unlimited 25-member democratic pods, 1:1 private member
          DMs, and pod audio calls. Canopy Pro unlocks creating &amp; owning
          custom Admin groups (private invite-only or publicized in the
          directory) with 100% peer-blind aliases.
        </Text>
        {planNotice ? <Text style={styles.successText}>{planNotice}</Text> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            isPro ? 'Switch to Free' : 'Upgrade to Canopy Pro'
          }
          disabled={updatingPlan}
          onPress={handleTogglePlan}
          style={isPro ? styles.secondaryBtn : styles.saveBtn}
        >
          {updatingPlan ? (
            <ActivityIndicator color={PALETTE.charcoal} />
          ) : (
            <Text
              style={isPro ? styles.secondaryBtnText : styles.saveBtnText}
            >
              {isPro ? 'Switch to Free' : 'Upgrade to Canopy Pro'}
            </Text>
          )}
        </Pressable>
      </View>

      {/* Private Profile Editor */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Private Account Identity</Text>

        <View style={styles.field}>
          <Text style={styles.label}>Account Email (Read-Only)</Text>
          <View style={styles.readOnlyBox}>
            <Text style={styles.readOnlyText}>{user?.email ?? '—'}</Text>
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Full Name</Text>
          <TextInput
            value={fullName}
            onChangeText={setFullName}
            placeholder="Your full name"
            placeholderTextColor={PALETTE.muted}
            style={styles.input}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Gender</Text>
          <View style={styles.pillsWrap}>
            {GENDER_OPTIONS.map((opt) => {
              const active = gender === opt;
              return (
                <Pressable
                  key={opt}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => setGender(opt)}
                  style={[styles.pill, active && styles.pillActive]}
                >
                  <Text
                    style={[styles.pillText, active && styles.pillTextActive]}
                  >
                    {opt}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Nationality (ISO-2)</Text>
          <View style={styles.pillsWrap}>
            {NATIONALITY_CHIPS.map((chip) => {
              const active = nationalityCode === chip.code;
              return (
                <Pressable
                  key={chip.code}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => setNationalityCode(chip.code)}
                  style={[styles.isoChip, active && styles.pillActive]}
                >
                  <Text
                    style={[
                      styles.isoChipText,
                      active && styles.pillTextActive,
                    ]}
                  >
                    {chip.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}
        {statusMsg ? <Text style={styles.successText}>{statusMsg}</Text> : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save private profile"
          disabled={saving}
          onPress={handleSaveProfile}
          style={styles.saveBtn}
        >
          {saving ? (
            <ActivityIndicator color={PALETTE.charcoal} />
          ) : (
            <Text style={styles.saveBtnText}>Save Private Profile</Text>
          )}
        </Pressable>
      </View>

      {/* Server URL Override Card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Backend Server URL</Text>
        <Text style={styles.helperText}>
          Default for this platform: {getDefaultApiBaseUrl()}. Override with
          your machine&apos;s LAN IP when testing on physical Wi-Fi devices.
        </Text>
        <TextInput
          value={serverDraft}
          onChangeText={setServerDraft}
          placeholder="http://localhost:8090"
          placeholderTextColor={PALETTE.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.monoInput]}
        />
        <View style={styles.rowActions}>
          <Pressable
            accessibilityRole="button"
            onPress={handleSaveServerUrl}
            style={styles.darkBtn}
          >
            <Text style={styles.darkBtnText}>Update URL</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={handleResetServerUrl}
            style={styles.secondaryBtn}
          >
            <Text style={styles.secondaryBtnText}>Reset Default</Text>
          </Pressable>
        </View>
        {serverStatus ? (
          <Text style={styles.successText}>{serverStatus}</Text>
        ) : null}
      </View>

      {/* Sign Out */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign out"
        onPress={handleLogout}
        style={styles.logoutBtn}
      >
        <Ionicons name="log-out-outline" size={18} color={PALETTE.danger} />
        <Text style={styles.logoutBtnText}>Sign Out of Canopy</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.surface,
  },
  content: {
    padding: 16,
    gap: 14,
    paddingBottom: 32,
  },
  privacyBanner: {
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    borderRadius: 16,
    padding: 14,
    gap: 6,
  },
  privacyBadgeText: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  privacyDescription: {
    fontSize: 13,
    lineHeight: 19,
    color: PALETTE.ink,
  },
  card: {
    backgroundColor: PALETTE.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: PALETTE.border,
    padding: 16,
    gap: 12,
  },
  proCardBorder: {
    borderColor: PALETTE.forest,
    borderWidth: 1.5,
  },
  planHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  planBadge: {
    backgroundColor: PALETTE.surfaceMuted,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  planBadgePro: {
    backgroundColor: PALETTE.charcoal,
    borderColor: PALETTE.forest,
  },
  planBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.ink,
    fontFamily: MONO_FONT,
  },
  planBadgeTextPro: {
    color: PALETTE.mint,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  helperText: {
    fontSize: 12,
    lineHeight: 18,
    color: PALETTE.muted,
  },
  field: {
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  readOnlyBox: {
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.surfaceMuted,
    borderWidth: 1,
    borderColor: PALETTE.border,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  readOnlyText: {
    fontSize: 14,
    color: PALETTE.muted,
    fontFamily: MONO_FONT,
  },
  input: {
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    paddingHorizontal: 12,
    fontSize: 15,
    color: PALETTE.ink,
  },
  monoInput: {
    fontFamily: MONO_FONT,
    fontSize: 13,
  },
  pillsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  pill: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  isoChip: {
    minHeight: TOUCH_MIN,
    minWidth: 54,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillActive: {
    backgroundColor: PALETTE.mint,
    borderColor: PALETTE.forest,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.ink,
  },
  isoChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.ink,
    fontFamily: MONO_FONT,
  },
  pillTextActive: {
    color: PALETTE.charcoal,
    fontWeight: '700',
  },
  errorText: {
    fontSize: 13,
    color: PALETTE.danger,
    fontWeight: '600',
  },
  successText: {
    fontSize: 13,
    color: PALETTE.forest,
    fontWeight: '600',
  },
  saveBtn: {
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 8,
  },
  darkBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.charcoal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  darkBtnText: {
    color: PALETTE.mint,
    fontWeight: '700',
    fontSize: 13,
  },
  secondaryBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: {
    color: PALETTE.ink,
    fontWeight: '600',
    fontSize: 13,
  },
  logoutBtn: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: PALETTE.dangerSoft,
    borderWidth: 1,
    borderColor: '#f5b8b4',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  logoutBtnText: {
    color: PALETTE.danger,
    fontWeight: '700',
    fontSize: 15,
  },
});
