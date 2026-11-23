import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAtom, useSetAtom } from 'jotai';
import { Ionicons } from '@expo/vector-icons';
import {
  getDefaultApiBaseUrl,
  loginAccount,
  registerAccount,
  resetStoredApiBaseUrl,
  setStoredApiBaseUrl,
  setStoredToken,
} from '../api/client';
import { apiBaseUrlAtom, authTokenAtom, authUserAtom } from '../state/atoms';
import { PALETTE, TOUCH_MIN } from '../theme/palette';

export const GENDER_OPTIONS = [
  'Female',
  'Male',
  'Non-binary',
  'Prefer not to say',
] as const;

export const NATIONALITY_CHIPS: ReadonlyArray<{
  code: string;
  label: string;
}> = [
  { code: 'IN', label: 'IN' },
  { code: 'US', label: 'US' },
  { code: 'GB', label: 'GB' },
  { code: 'DE', label: 'DE' },
  { code: 'CA', label: 'CA' },
  { code: 'JP', label: 'JP' },
  { code: 'AU', label: 'AU' },
  { code: 'SG', label: 'SG' },
  { code: 'BR', label: 'BR' },
  { code: 'FR', label: 'FR' },
  // ISO 3166-1 2-letter code ZZ satisfies backend ^[A-Z]{2}$ check for OTHER
  { code: 'ZZ', label: 'OTHER' },
];

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [apiBaseUrl, setApiBaseUrl] = useAtom(apiBaseUrlAtom);
  const setAuthToken = useSetAtom(authTokenAtom);
  const setAuthUser = useSetAtom(authUserAtom);

  const [serverSectionOpen, setServerSectionOpen] = useState(false);
  const [serverDraft, setServerDraft] = useState(apiBaseUrl);
  const [serverSavedBanner, setServerSavedBanner] = useState<string | null>(
    null
  );

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [gender, setGender] = useState<string>('Prefer not to say');
  const [nationalityCode, setNationalityCode] = useState<string>('IN');

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSaveServerUrl = async () => {
    const updated = await setStoredApiBaseUrl(serverDraft);
    setApiBaseUrl(updated);
    setServerDraft(updated);
    setServerSavedBanner(`Active API: ${updated}`);
  };

  const handleResetServerUrl = async () => {
    const def = await resetStoredApiBaseUrl();
    setApiBaseUrl(def);
    setServerDraft(def);
    setServerSavedBanner(`Reset to ${def}`);
  };

  const handleSubmit = async () => {
    setErrorMsg(null);
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      setErrorMsg('Please enter your email and password.');
      return;
    }
    if (mode === 'register' && !fullName.trim()) {
      setErrorMsg('Full Name is required for account verification.');
      return;
    }
    if (mode === 'register' && password.length < 6) {
      setErrorMsg('Password must be at least 6 characters.');
      return;
    }

    setSubmitting(true);
    try {
      const res =
        mode === 'login'
          ? await loginAccount({ email: cleanEmail, password })
          : await registerAccount({
              email: cleanEmail,
              password,
              fullName: fullName.trim(),
              gender,
              nationalityCode,
            });
      await setStoredToken(res.token);
      setAuthToken(res.token);
      setAuthUser(res.user);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Authentication failed.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Brand Tile Header */}
          <View style={styles.heroCard}>
            <View style={styles.brandRow}>
              <View style={styles.mintDot} />
              <Text style={styles.brandTag}>CANOPY MOBILE · PEER-BLIND PODS</Text>
            </View>
            <Text style={styles.heroTitle}>
              Interest rooms where nobody sees your real name.
            </Text>
            <Text style={styles.heroSubtitle}>
              Join 25-member democratic pods — Compact (10), Standard (25), or
              Club (50) — with YES/NO governance votes, Slack threads, voice
              notes, and persistent voice lounges.
            </Text>
          </View>

          {/* Segmented Mode Control */}
          <View style={styles.segmentedBar}>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === 'login' }}
              onPress={() => {
                setMode('login');
                setErrorMsg(null);
              }}
              style={[
                styles.segmentBtn,
                mode === 'login' && styles.segmentBtnActive,
              ]}
            >
              <Text
                style={[
                  styles.segmentText,
                  mode === 'login' && styles.segmentTextActive,
                ]}
              >
                Sign In
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === 'register' }}
              onPress={() => {
                setMode('register');
                setErrorMsg(null);
              }}
              style={[
                styles.segmentBtn,
                mode === 'register' && styles.segmentBtnActive,
              ]}
            >
              <Text
                style={[
                  styles.segmentText,
                  mode === 'register' && styles.segmentTextActive,
                ]}
              >
                Create Account
              </Text>
            </Pressable>
          </View>

          {/* Main Auth Form Card */}
          <View style={styles.formCard}>
            {mode === 'register' ? (
              <View style={styles.guaranteeCard}>
                <View style={styles.guaranteeHeader}>
                  <Ionicons
                    name="shield-checkmark"
                    size={18}
                    color={PALETTE.forest}
                  />
                  <Text style={styles.guaranteeTitle}>Blind Pod Guarantee</Text>
                </View>
                <Text style={styles.guaranteeBody}>
                  Stored privately for account verification only — rooms only
                  show random animal aliases (like Cobalt Fox or Mint Owl).
                </Text>
              </View>
            ) : null}

            {mode === 'register' ? (
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Full Name (Private)</Text>
                <TextInput
                  value={fullName}
                  onChangeText={setFullName}
                  placeholder="Aarav Sharma"
                  placeholderTextColor={PALETTE.muted}
                  autoCapitalize="words"
                  style={styles.input}
                />
              </View>
            ) : null}

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={PALETTE.muted}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Minimum 6 characters"
                placeholderTextColor={PALETTE.muted}
                secureTextEntry
                autoCapitalize="none"
                style={styles.input}
              />
            </View>

            {mode === 'register' ? (
              <>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Gender (Private)</Text>
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
                            style={[
                              styles.pillText,
                              active && styles.pillTextActive,
                            ]}
                          >
                            {opt}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Nationality ISO-2 (Private)</Text>
                  <View style={styles.pillsWrap}>
                    {NATIONALITY_CHIPS.map((chip) => {
                      const active = nationalityCode === chip.code;
                      return (
                        <Pressable
                          key={chip.code}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          onPress={() => setNationalityCode(chip.code)}
                          style={[
                            styles.isoChip,
                            active && styles.pillActive,
                          ]}
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
              </>
            ) : null}

            {errorMsg ? (
              <View style={styles.errorBox}>
                <Ionicons
                  name="alert-circle"
                  size={16}
                  color={PALETTE.danger}
                />
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                mode === 'login' ? 'Sign In' : 'Create Account'
              }
              disabled={submitting}
              onPress={handleSubmit}
              style={({ pressed }) => [
                styles.primaryBtn,
                (pressed || submitting) && styles.primaryBtnPressed,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={PALETTE.charcoal} />
              ) : (
                <Text style={styles.primaryBtnText}>
                  {mode === 'login' ? 'Sign In to Pods' : 'Create Blind Account'}
                </Text>
              )}
            </Pressable>
          </View>

          {/* Collapsible Server URL Setting */}
          <View style={styles.serverCard}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Toggle Server URL settings"
              onPress={() => setServerSectionOpen((prev) => !prev)}
              style={styles.serverHeaderBtn}
            >
              <View style={styles.serverHeaderLeft}>
                <Ionicons
                  name="server-outline"
                  size={16}
                  color={PALETTE.forest}
                />
                <Text style={styles.serverTitle}>
                  Server URL · {apiBaseUrl}
                </Text>
              </View>
              <Ionicons
                name={serverSectionOpen ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={PALETTE.muted}
              />
            </Pressable>

            {serverSectionOpen ? (
              <View style={styles.serverBody}>
                <Text style={styles.serverHint}>
                  Default: {getDefaultApiBaseUrl()} (Android Emulator uses
                  10.0.2.2:8090; physical Wi-Fi phones can enter your LAN IP,
                  e.g. http://192.168.1.20:8090).
                </Text>
                <TextInput
                  value={serverDraft}
                  onChangeText={setServerDraft}
                  placeholder="http://localhost:8090"
                  placeholderTextColor={PALETTE.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.serverInput}
                />
                <View style={styles.serverActionsRow}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={handleSaveServerUrl}
                    style={styles.saveUrlBtn}
                  >
                    <Text style={styles.saveUrlBtnText}>Save URL</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={handleResetServerUrl}
                    style={styles.resetUrlBtn}
                  >
                    <Text style={styles.resetUrlBtnText}>Reset Default</Text>
                  </Pressable>
                </View>
                {serverSavedBanner ? (
                  <Text style={styles.savedBannerText}>{serverSavedBanner}</Text>
                ) : null}
              </View>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: PALETTE.surface,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 14,
  },
  heroCard: {
    backgroundColor: PALETTE.charcoal,
    borderRadius: 18,
    padding: 18,
    gap: 8,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mintDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: PALETTE.mint,
  },
  brandTag: {
    color: PALETTE.mint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: MONO_FONT,
  },
  heroTitle: {
    color: PALETTE.card,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700',
  },
  heroSubtitle: {
    color: '#c9cfc9',
    fontSize: 13,
    lineHeight: 19,
  },
  segmentedBar: {
    flexDirection: 'row',
    backgroundColor: PALETTE.surfaceMuted,
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  segmentBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentBtnActive: {
    backgroundColor: PALETTE.card,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
  },
  segmentText: {
    fontSize: 14,
    fontWeight: '600',
    color: PALETTE.muted,
  },
  segmentTextActive: {
    color: PALETTE.charcoal,
    fontWeight: '700',
  },
  formCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: 14,
  },
  guaranteeCard: {
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  guaranteeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  guaranteeTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  guaranteeBody: {
    fontSize: 12,
    lineHeight: 18,
    color: PALETTE.ink,
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  input: {
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    backgroundColor: PALETTE.surface,
    paddingHorizontal: 14,
    fontSize: 15,
    color: PALETTE.ink,
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
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: PALETTE.dangerSoft,
    borderRadius: 10,
    padding: 10,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: PALETTE.danger,
    fontWeight: '600',
  },
  primaryBtn: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnPressed: {
    opacity: 0.85,
  },
  primaryBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  serverCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PALETTE.border,
    overflow: 'hidden',
  },
  serverHeaderBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  serverHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  serverTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: PALETTE.ink,
    fontFamily: MONO_FONT,
    flex: 1,
  },
  serverBody: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: PALETTE.border,
    paddingTop: 10,
  },
  serverHint: {
    fontSize: 12,
    lineHeight: 17,
    color: PALETTE.muted,
  },
  serverInput: {
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    backgroundColor: PALETTE.surface,
    paddingHorizontal: 12,
    fontSize: 13,
    fontFamily: MONO_FONT,
    color: PALETTE.ink,
  },
  serverActionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  saveUrlBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.charcoal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveUrlBtnText: {
    color: PALETTE.mint,
    fontSize: 13,
    fontWeight: '700',
  },
  resetUrlBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resetUrlBtnText: {
    color: PALETTE.ink,
    fontSize: 13,
    fontWeight: '600',
  },
  savedBannerText: {
    fontSize: 12,
    color: PALETTE.forest,
    fontWeight: '600',
    fontFamily: MONO_FONT,
  },
});
