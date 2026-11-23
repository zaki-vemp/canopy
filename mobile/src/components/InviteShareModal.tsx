import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  buildWebInviteUrl,
  createPodInvite,
  revokePodInvite,
} from '../api/client';
import type { PodDetail, PodInviteDto } from '../types/canopy';
import { PALETTE, TOUCH_MIN, capacityTierBadge } from '../theme/palette';

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

const EXPIRY_OPTIONS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 168, label: '7d' },
  { hours: 24, label: '24h' },
  { hours: 0, label: 'Never' },
];

const MAX_USES_OPTIONS: ReadonlyArray<{ uses: number; label: string }> = [
  { uses: 0, label: 'Unlimited' },
  { uses: 1, label: '1 use' },
  { uses: 5, label: '5 uses' },
];

async function copyToWebClipboard(text: string): Promise<boolean> {
  const nav = (
    globalThis as {
      navigator?: {
        clipboard?: { writeText?: (value: string) => Promise<void> };
      };
    }
  ).navigator;
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function formatExpiryLabel(invite: PodInviteDto): string {
  if (invite.isRevoked) return 'Revoked';
  if (invite.isExpired) return 'Expired';
  if (!invite.expiresAt) return 'Never expires';
  const ts = Date.parse(invite.expiresAt);
  if (Number.isNaN(ts)) return 'Active';
  const hoursLeft = Math.max(0, Math.round((ts - Date.now()) / 3_600_000));
  if (hoursLeft < 24) return `Expires in ${hoursLeft}h`;
  const daysLeft = Math.round(hoursLeft / 24);
  return `Expires in ${daysLeft}d`;
}

export interface InviteShareModalProps {
  visible: boolean;
  pod: Pick<
    PodDetail,
    'podId' | 'code' | 'interestLabel' | 'memberCount' | 'maxMembers'
  > | null;
  onClose: () => void;
}

export function InviteShareModal({
  visible,
  pod,
  onClose,
}: InviteShareModalProps) {
  const [expiresInHours, setExpiresInHours] = useState<number>(168);
  const [maxUses, setMaxUses] = useState<number>(0);
  const [invite, setInvite] = useState<PodInviteDto | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToastMsg(null);
    }, 2400);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const podId = pod?.podId ?? '';

  const upsertInviteMutation = useMutation({
    mutationFn: (vars: {
      maxUses: number;
      expiresInHours: number;
      regenerate: boolean;
      toast?: string;
      syncControls?: boolean;
    }) =>
      createPodInvite(podId, {
        maxUses: vars.maxUses,
        expiresInHours: vars.expiresInHours,
        regenerate: vars.regenerate,
      }),
    onSuccess: (res, vars) => {
      setErrorMsg(null);
      setInvite(res.invite);
      if (vars.syncControls) {
        if (
          res.invite.maxUses === 0 ||
          res.invite.maxUses === 1 ||
          res.invite.maxUses === 5
        ) {
          setMaxUses(res.invite.maxUses);
        }
        if (res.invite.expiresAt === null) {
          setExpiresInHours(0);
        }
      }
      if (vars.toast) {
        showToast(vars.toast);
      }
    },
    onError: (err) => {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not create pod invite.'
      );
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (code: string) => revokePodInvite(podId, code),
    onSuccess: () => {
      setErrorMsg(null);
      setInvite((prev) =>
        prev ? { ...prev, isRevoked: true, canAccept: false } : null
      );
      showToast('Invite revoked');
    },
    onError: (err) => {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not revoke pod invite.'
      );
    },
  });

  useEffect(() => {
    if (!visible || !podId) return;
    setExpiresInHours(168);
    setMaxUses(0);
    setInvite(null);
    setErrorMsg(null);
    setToastMsg(null);
    upsertInviteMutation.mutate({
      maxUses: 0,
      expiresInHours: 168,
      regenerate: false,
      syncControls: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, podId]);

  const handleSelectExpiry = (nextHours: number) => {
    setExpiresInHours(nextHours);
    if (!podId) return;
    upsertInviteMutation.mutate({
      maxUses,
      expiresInHours: nextHours,
      regenerate: true,
      toast: 'Updated expiry',
    });
  };

  const handleSelectMaxUses = (nextUses: number) => {
    setMaxUses(nextUses);
    if (!podId) return;
    upsertInviteMutation.mutate({
      maxUses: nextUses,
      expiresInHours,
      regenerate: true,
      toast: 'Updated max uses',
    });
  };

  const handleShare = async () => {
    if (!pod || !invite || invite.isRevoked) return;
    const webUrl = buildWebInviteUrl(invite.code);
    const message = `Join anonymous pod #${pod.code} (${pod.interestLabel}) on Canopy — random animal aliases, zero real names:\n${webUrl}\nInvite code: ${invite.code}`;

    if (Platform.OS === 'web') {
      const copied = await copyToWebClipboard(webUrl);
      if (copied) {
        showToast('Copied!');
      }
      const webNav = (
        globalThis as {
          navigator?: {
            share?: (data: {
              title?: string;
              text?: string;
              url?: string;
            }) => Promise<void>;
          };
        }
      ).navigator;
      if (webNav?.share) {
        try {
          await webNav.share({
            title: `Join #${pod.code} on Canopy`,
            text: message,
            url: webUrl,
          });
        } catch {
          // user dismissed share sheet
        }
      } else if (!copied) {
        showToast('Select the link above to copy');
      }
      return;
    }

    try {
      await Share.share({
        title: `Join #${pod.code} on Canopy`,
        message,
      });
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to open native share sheet.'
      );
    }
  };

  const handleCopyValue = async (value: string, label: string) => {
    const copied = await copyToWebClipboard(value);
    if (copied) {
      showToast('Copied!');
      return;
    }
    try {
      await Share.share({ message: value, title: label });
    } catch {
      showToast('Long-press the code above to copy');
    }
  };

  const webInviteUrl = invite ? buildWebInviteUrl(invite.code) : '';
  const busy = upsertInviteMutation.isPending || revokeMutation.isPending;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        {/* Charcoal Header */}
        <View style={styles.header}>
          <View style={styles.headerTextCol}>
            <Text style={styles.headerTitle}>
              Invite Peers to #{pod?.code ?? 'pod'}
            </Text>
            <Text style={styles.headerSub}>
              {pod
                ? `${pod.interestLabel} · ${capacityTierBadge(
                    invite?.memberCount ?? pod.memberCount,
                    invite?.maxMembers ?? pod.maxMembers
                  )}`
                : 'Peer-blind room invite'}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close invite modal"
            onPress={onClose}
            style={styles.closeBtn}
          >
            <Ionicons name="close" size={22} color={PALETTE.card} />
          </Pressable>
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {/* Blind Guarantee Note */}
          <View style={styles.guaranteeCard}>
            <Ionicons
              name="shield-checkmark-outline"
              size={18}
              color={PALETTE.forest}
            />
            <Text style={styles.guaranteeText}>
              Recipients join with a random animal alias — zero real names,
              genders, or flags shown
            </Text>
          </View>

          {toastMsg ? (
            <View style={styles.toastBanner}>
              <Ionicons
                name="checkmark-circle"
                size={16}
                color={PALETTE.forest}
              />
              <Text style={styles.toastText}>{toastMsg}</Text>
            </View>
          ) : null}

          {errorMsg ? (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle" size={16} color={PALETTE.danger} />
              <Text style={styles.errorText}>{errorMsg}</Text>
            </View>
          ) : null}

          {/* Invite Code + Web Link Card */}
          <View style={styles.codeCard}>
            {upsertInviteMutation.isPending && !invite ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator color={PALETTE.forest} />
                <Text style={styles.loadingText}>
                  Preparing blind invite link...
                </Text>
              </View>
            ) : invite && !invite.isRevoked ? (
              <>
                <View style={styles.fieldGroup}>
                  <View style={styles.fieldHeaderRow}>
                    <Text style={styles.fieldLabel}>Invite Code</Text>
                    <Text style={styles.metaStatsText}>
                      {invite.maxUses > 0
                        ? `${invite.usesCount}/${invite.maxUses} uses`
                        : `${invite.usesCount} uses · Unlimited`}{' '}
                      · {formatExpiryLabel(invite)}
                    </Text>
                  </View>
                  <View style={styles.codeDisplayRow}>
                    <Text selectable style={styles.inviteCodeText}>
                      {invite.code}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Copy invite code"
                      onPress={() =>
                        handleCopyValue(invite.code, 'Canopy Invite Code')
                      }
                      style={styles.copyIconBtn}
                    >
                      <Ionicons
                        name="copy-outline"
                        size={17}
                        color={PALETTE.charcoal}
                      />
                      <Text style={styles.copyBtnLabel}>Copy</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>Web Invite Link</Text>
                  <View style={styles.linkDisplayRow}>
                    <Text
                      selectable
                      style={styles.webLinkText}
                      numberOfLines={2}
                    >
                      {webInviteUrl}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Copy web invite link"
                      onPress={() =>
                        handleCopyValue(webInviteUrl, 'Canopy Invite Link')
                      }
                      style={styles.copyIconBtn}
                    >
                      <Ionicons
                        name="link-outline"
                        size={17}
                        color={PALETTE.charcoal}
                      />
                      <Text style={styles.copyBtnLabel}>Copy</Text>
                    </Pressable>
                  </View>
                </View>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Share invite"
                  disabled={busy}
                  onPress={handleShare}
                  style={[styles.sharePrimaryBtn, busy && styles.disabledBtn]}
                >
                  <Ionicons
                    name="share-social-outline"
                    size={18}
                    color={PALETTE.charcoal}
                  />
                  <Text style={styles.sharePrimaryText}>Share Invite</Text>
                </Pressable>
              </>
            ) : (
              <View style={styles.revokedBox}>
                <Ionicons
                  name="ban-outline"
                  size={22}
                  color={PALETTE.muted}
                />
                <Text style={styles.revokedTitle}>
                  {invite?.isRevoked
                    ? 'Active invite revoked'
                    : 'No active invite loaded'}
                </Text>
                <Text style={styles.revokedSub}>
                  Tap Regenerate below to mint a fresh invite code for #
                  {pod?.code ?? 'pod'}.
                </Text>
              </View>
            )}
          </View>

          {/* Expiry & Max-Uses Pills */}
          <View style={styles.controlsCard}>
            <View style={styles.controlSection}>
              <Text style={styles.controlLabel}>Expires After</Text>
              <View style={styles.pillsRow}>
                {EXPIRY_OPTIONS.map((opt) => {
                  const selected = expiresInHours === opt.hours;
                  return (
                    <Pressable
                      key={opt.label}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      disabled={busy}
                      onPress={() => handleSelectExpiry(opt.hours)}
                      style={[styles.pillBtn, selected && styles.pillBtnActive]}
                    >
                      <Text
                        style={[
                          styles.pillText,
                          selected && styles.pillTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.controlSection}>
              <Text style={styles.controlLabel}>Max Uses</Text>
              <View style={styles.pillsRow}>
                {MAX_USES_OPTIONS.map((opt) => {
                  const selected = maxUses === opt.uses;
                  return (
                    <Pressable
                      key={opt.label}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      disabled={busy}
                      onPress={() => handleSelectMaxUses(opt.uses)}
                      style={[styles.pillBtn, selected && styles.pillBtnActive]}
                    >
                      <Text
                        style={[
                          styles.pillText,
                          selected && styles.pillTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Regenerate + Revoke Actions */}
            <View style={styles.manageActionsRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Regenerate invite code"
                disabled={busy || !podId}
                onPress={() =>
                  upsertInviteMutation.mutate({
                    maxUses,
                    expiresInHours,
                    regenerate: true,
                    toast: 'Regenerated new invite code!',
                  })
                }
                style={[styles.regenerateBtn, busy && styles.disabledBtn]}
              >
                {upsertInviteMutation.isPending ? (
                  <ActivityIndicator size="small" color={PALETTE.mint} />
                ) : (
                  <>
                    <Ionicons
                      name="refresh"
                      size={16}
                      color={PALETTE.mint}
                    />
                    <Text style={styles.regenerateText}>Regenerate</Text>
                  </>
                )}
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Revoke invite code"
                disabled={busy || !invite || invite.isRevoked}
                onPress={() => {
                  if (invite && !invite.isRevoked) {
                    revokeMutation.mutate(invite.code);
                  }
                }}
                style={[
                  styles.revokeBtn,
                  (busy || !invite || invite.isRevoked) && styles.disabledBtn,
                ]}
              >
                <Ionicons
                  name="trash-outline"
                  size={16}
                  color={PALETTE.danger}
                />
                <Text style={styles.revokeText}>Revoke</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: PALETTE.surface,
  },
  flex: {
    flex: 1,
  },
  header: {
    backgroundColor: PALETTE.charcoal,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  headerTextCol: {
    flex: 1,
    gap: 2,
  },
  headerTitle: {
    color: PALETTE.card,
    fontSize: 17,
    fontWeight: '700',
    fontFamily: MONO_FONT,
  },
  headerSub: {
    color: PALETTE.mint,
    fontSize: 12,
    fontWeight: '600',
  },
  closeBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2a2d2a',
  },
  content: {
    padding: 14,
    gap: 12,
    paddingBottom: 28,
  },
  guaranteeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    borderRadius: 14,
    padding: 12,
  },
  guaranteeText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: PALETTE.forest,
  },
  toastBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  toastText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: PALETTE.dangerSoft,
    borderRadius: 12,
    padding: 12,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.danger,
  },
  codeCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: 12,
  },
  loadingWrap: {
    paddingVertical: 22,
    alignItems: 'center',
    gap: 8,
  },
  loadingText: {
    fontSize: 13,
    color: PALETTE.muted,
  },
  fieldGroup: {
    gap: 6,
  },
  fieldHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 4,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontFamily: MONO_FONT,
  },
  metaStatsText: {
    fontSize: 11,
    fontWeight: '600',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  codeDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: PALETTE.codeBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
  },
  inviteCodeText: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: PALETTE.charcoal,
    fontFamily: MONO_FONT,
    letterSpacing: 0.6,
  },
  linkDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: PALETTE.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PALETTE.border,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
  },
  webLinkText: {
    flex: 1,
    fontSize: 12,
    color: PALETTE.ink,
    fontFamily: MONO_FONT,
  },
  copyIconBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: PALETTE.card,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  copyBtnLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  sharePrimaryBtn: {
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
    borderColor: PALETTE.forest,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 2,
  },
  sharePrimaryText: {
    fontSize: 15,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  revokedBox: {
    paddingVertical: 18,
    alignItems: 'center',
    gap: 6,
  },
  revokedTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  revokedSub: {
    fontSize: 13,
    lineHeight: 18,
    color: PALETTE.muted,
    textAlign: 'center',
  },
  controlsCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: 14,
  },
  controlSection: {
    gap: 6,
  },
  controlLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontFamily: MONO_FONT,
  },
  pillsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  pillBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 11,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  pillBtnActive: {
    backgroundColor: PALETTE.mint,
    borderColor: PALETTE.forest,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.ink,
  },
  pillTextActive: {
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  manageActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  regenerateBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.charcoal,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
  },
  regenerateText: {
    color: PALETTE.mint,
    fontSize: 13,
    fontWeight: '700',
  },
  revokeBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: PALETTE.dangerSoft,
    borderWidth: 1,
    borderColor: '#f3c1bd',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  revokeText: {
    color: PALETTE.danger,
    fontSize: 13,
    fontWeight: '700',
  },
  disabledBtn: {
    opacity: 0.45,
  },
});
