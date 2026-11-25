import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../theme/ui';
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
import { GUTTER, INSET, PALETTE, PIECES, TOUCH_MIN } from '../theme/palette';
import { Logo } from '../components/Pieces';

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

const MONO_FONT = 'DMMono_500Medium';

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

  const registering = mode === 'register';

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
          <View style={styles.logoRow}>
            <Logo size={26} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={registering ? 'Go to sign in' : 'Go to make an account'}
              onPress={() => {
                setMode(registering ? 'login' : 'register');
                setErrorMsg(null);
              }}
              style={styles.swapBtn}
            >
              <Text style={styles.swapBtnText}>
                {registering ? 'Sign in' : 'Make an account'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.sheet}>
            <Text style={styles.title}>
              {registering ? 'Make an account' : 'Sign in'}
            </Text>
            <Text style={styles.lead}>
              {registering
                ? 'The dark blocks stay in your account. Every room you join deals you a new coloured one.'
                : 'Your rooms, votes and private chats are where you left them.'}
            </Text>

            {registering ? (
              <View style={styles.privateRow}>
                {['Full name', 'Email', 'Gender', 'Nationality'].map((k) => (
                  <View key={k} style={styles.privateBlock}>
                    <Text style={styles.privateName}>{k}</Text>
                    <Text style={styles.privateNote}>Account only</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {errorMsg ? (
              <View style={styles.errorBox} accessibilityRole="alert">
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            {registering ? (
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Full name</Text>
                <TextInput
                  value={fullName}
                  onChangeText={setFullName}
                  placeholder="Aarav Sharma"
                  placeholderTextColor={PALETTE.muted}
                  autoCapitalize="words"
                  accessibilityLabel="Full name"
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
                accessibilityLabel="Email"
                style={styles.input}
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder={registering ? 'Six characters or more' : ''}
                placeholderTextColor={PALETTE.muted}
                secureTextEntry
                autoCapitalize="none"
                accessibilityLabel="Password"
                style={styles.input}
              />
            </View>

            {registering ? (
              <>
                <View style={styles.fieldGroup}>
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
                  <Text style={styles.label}>Nationality</Text>
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
              </>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={registering ? 'Make an account' : 'Sign in'}
              disabled={submitting}
              onPress={handleSubmit}
              style={({ pressed }) => [
                styles.primaryBtn,
                (pressed || submitting) && styles.primaryBtnPressed,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={PALETTE.card} />
              ) : (
                <Text style={styles.primaryBtnText}>
                  {registering ? 'Make an account' : 'Sign in'}
                </Text>
              )}
            </Pressable>
          </View>

          {/* Server URL: collapsed by default, for phones on Wi-Fi */}
          <View style={styles.serverCard}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Toggle server address"
              onPress={() => setServerSectionOpen((prev) => !prev)}
              style={styles.serverHeaderBtn}
            >
              <Text style={styles.serverTitle} numberOfLines={1}>
                Server · {apiBaseUrl}
              </Text>
              <Ionicons
                name={serverSectionOpen ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={PALETTE.ink}
              />
            </Pressable>

            {serverSectionOpen ? (
              <View style={styles.serverBody}>
                <Text style={styles.serverHint}>
                  Default: {getDefaultApiBaseUrl()}. The Android emulator uses
                  10.0.2.2:8090; a phone on Wi-Fi needs your computer's address,
                  like http://192.168.1.20:8090.
                </Text>
                <TextInput
                  value={serverDraft}
                  onChangeText={setServerDraft}
                  placeholder="http://localhost:8090"
                  placeholderTextColor={PALETTE.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Server address"
                  style={styles.input}
                />
                <View style={styles.serverActionsRow}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={handleSaveServerUrl}
                    style={styles.saveUrlBtn}
                  >
                    <Text style={styles.saveUrlBtnText}>Save</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={handleResetServerUrl}
                    style={styles.resetUrlBtn}
                  >
                    <Text style={styles.resetUrlBtnText}>Reset</Text>
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
  safe: { flex: 1, backgroundColor: PALETTE.surface },
  flex: { flex: 1 },
  scrollContent: { padding: GUTTER, paddingBottom: 32, gap: GUTTER, width: '100%', maxWidth: 520, alignSelf: 'center' },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: TOUCH_MIN,
  },
  swapBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 18,
    borderRadius: 22,
    backgroundColor: PALETTE.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swapBtnText: { fontSize: 15, fontWeight: '600', color: PALETTE.ink },
  sheet: {
    backgroundColor: PALETTE.card,
    borderRadius: 28,
    padding: INSET,
    gap: 16,
  },
  title: { fontSize: 32, lineHeight: 36, color: PALETTE.ink, fontWeight: '700' },
  lead: { fontSize: 16, lineHeight: 23, color: PALETTE.muted },
  privateRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  privateBlock: {
    width: '48%',
    flexGrow: 1,
    backgroundColor: PALETTE.ink,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 60,
  },
  privateName: { fontSize: 15, fontWeight: '600', color: PALETTE.card },
  privateNote: { fontSize: 13, color: '#c9c9c9', marginTop: 2 },
  fieldGroup: { gap: 8 },
  label: { fontSize: 15, fontWeight: '600', color: PALETTE.ink },
  input: {
    minHeight: 56,
    borderRadius: 28,
    backgroundColor: PALETTE.surface,
    paddingHorizontal: 22,
    fontSize: 16,
    color: PALETTE.ink,
  },
  pillsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 16,
    borderRadius: 22,
    backgroundColor: PALETTE.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillActive: { backgroundColor: PALETTE.ink },
  pillText: { fontSize: 15, fontWeight: '500', color: PALETTE.ink },
  pillTextActive: { color: PALETTE.card },
  isoChip: {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN + 8,
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: PALETTE.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  isoChipText: { fontSize: 14, fontWeight: '500', color: PALETTE.ink, fontFamily: MONO_FONT },
  errorBox: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 0,
    backgroundColor: PIECES.off,
  },
  errorText: { fontSize: 15, fontWeight: '600', color: PALETTE.ink },
  primaryBtn: {
    minHeight: 56,
    borderRadius: 28,
    backgroundColor: PALETTE.blue,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  primaryBtnPressed: { backgroundColor: PALETTE.blueDown },
  primaryBtnText: { fontSize: 18, color: PALETTE.card, fontWeight: '600' },
  serverCard: { backgroundColor: PALETTE.card, borderRadius: 24, overflow: 'hidden' },
  serverHeaderBtn: {
    minHeight: TOUCH_MIN + 4,
    paddingHorizontal: INSET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  serverTitle: { flex: 1, fontSize: 14, color: PALETTE.muted, fontFamily: MONO_FONT },
  serverBody: { paddingHorizontal: INSET, paddingBottom: INSET, gap: 12 },
  serverHint: { fontSize: 14, lineHeight: 20, color: PALETTE.muted },
  serverActionsRow: { flexDirection: 'row', gap: 8 },
  saveUrlBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 22,
    backgroundColor: PALETTE.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveUrlBtnText: { fontSize: 15, fontWeight: '600', color: PALETTE.card },
  resetUrlBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 22,
    backgroundColor: PALETTE.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resetUrlBtnText: { fontSize: 15, fontWeight: '600', color: PALETTE.ink },
  savedBannerText: { fontSize: 14, color: PALETTE.muted, fontFamily: MONO_FONT },
});
