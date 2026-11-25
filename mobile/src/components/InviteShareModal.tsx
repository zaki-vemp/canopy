import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../theme/ui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  buildWebInviteUrl,
  createPodInvite,
  revokePodInvite,
} from '../api/client';
import type { PodDetail, PodInviteDto } from '../types/canopy';
import { PIECES, PIECE_HEX, TOUCH_MIN, capacityTierBadge } from '../theme/palette';
import { Sheet } from './Sheet';
import { Btn, Chip } from './Pieces';

const MONO_FONT = 'DMMono_500Medium';

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
  if (invite.isRevoked) return 'Cancelled';
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
        err instanceof Error ? err.message : 'Could not make the invite.'
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
      showToast('Invite cancelled');
    },
    onError: (err) => {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not cancel the invite.'
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
      toast: 'Expiry changed',
    });
  };

  const handleSelectMaxUses = (nextUses: number) => {
    setMaxUses(nextUses);
    if (!podId) return;
    upsertInviteMutation.mutate({
      maxUses: nextUses,
      expiresInHours,
      regenerate: true,
      toast: 'Uses changed',
    });
  };

  const handleShare = async () => {
    if (!pod || !invite || invite.isRevoked) return;
    const webUrl = buildWebInviteUrl(invite.code);
    const message = `Join the ${pod.interestLabel} room on Canopy. Everyone sits under an alias, no real names:\n${webUrl}\nInvite code: ${invite.code}`;

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
            title: `Join a ${pod.interestLabel} room on Canopy`,
            text: message,
            url: webUrl,
          });
        } catch {
          // user dismissed share sheet
        }
      } else if (!copied) {
        showToast('Select the link above to copy it');
      }
      return;
    }

    try {
      await Share.share({
        title: `Join a ${pod.interestLabel} room on Canopy`,
        message,
      });
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not open the share sheet.'
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
      showToast('Press and hold the code to copy it');
    }
  };

  const webInviteUrl = invite ? buildWebInviteUrl(invite.code) : '';
  const busy = upsertInviteMutation.isPending || revokeMutation.isPending;

  const roomLabel = pod?.interestLabel ?? 'room';

  return (
    <Sheet
      visible={visible}
      title={`Invite to ${roomLabel}`}
      lead={
        pod
          ? `${capacityTierBadge(
              invite?.memberCount ?? pod.memberCount,
              invite?.maxMembers ?? pod.maxMembers
            )}. People who join get a fresh alias. No real names, genders or flags show.`
          : undefined
      }
      onClose={onClose}
    >
      {toastMsg ? (
        <View style={styles.toastBanner} accessibilityRole="alert">
          <Text style={styles.bannerText}>{toastMsg}</Text>
        </View>
      ) : null}

      {errorMsg ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.bannerText}>{errorMsg}</Text>
        </View>
      ) : null}

      {upsertInviteMutation.isPending && !invite ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={PIECES.ink} />
          <Text style={styles.muted}>Making your invite...</Text>
        </View>
      ) : invite && !invite.isRevoked ? (
        <>
          <View style={styles.codeBlock}>
            <Text style={styles.fieldLabel}>Code</Text>
            <Text selectable style={styles.inviteCodeText}>
              {invite.code}
            </Text>
            <Text style={styles.metaStatsText}>
              {invite.maxUses > 0
                ? `${invite.usesCount} of ${invite.maxUses} uses`
                : `${invite.usesCount} uses, no limit`}
              . {formatExpiryLabel(invite)}.
            </Text>
            <Btn
              label="Copy code"
              icon="copy-outline"
              kind="white"
              onPress={() => handleCopyValue(invite.code, 'Canopy invite code')}
            />
          </View>

          <View style={styles.linkBlock}>
            <Text style={styles.fieldLabel}>Link</Text>
            <Text selectable style={styles.webLinkText} numberOfLines={2}>
              {webInviteUrl}
            </Text>
            <Btn
              label="Copy link"
              icon="link-outline"
              kind="white"
              onPress={() => handleCopyValue(webInviteUrl, 'Canopy invite link')}
            />
          </View>

          <Btn
            label="Share invite"
            icon="share-social-outline"
            kind="blue"
            big
            wide
            disabled={busy}
            onPress={handleShare}
          />
        </>
      ) : (
        <View style={styles.revokedBox}>
          <Text style={styles.revokedTitle}>
            {invite?.isRevoked ? 'That invite is cancelled' : 'No invite yet'}
          </Text>
          <Text style={styles.muted}>
            Press New code to make a fresh invite for this room.
          </Text>
        </View>
      )}

      <View style={styles.controlSection}>
        <Text style={styles.controlLabel}>Expires after</Text>
        <View style={styles.pillsRow}>
          {EXPIRY_OPTIONS.map((opt) => (
            <Chip
              key={opt.label}
              label={opt.label}
              active={expiresInHours === opt.hours}
              onPress={() => handleSelectExpiry(opt.hours)}
            />
          ))}
        </View>
      </View>

      <View style={styles.controlSection}>
        <Text style={styles.controlLabel}>Uses</Text>
        <View style={styles.pillsRow}>
          {MAX_USES_OPTIONS.map((opt) => (
            <Chip
              key={opt.label}
              label={opt.label}
              active={maxUses === opt.uses}
              onPress={() => handleSelectMaxUses(opt.uses)}
            />
          ))}
        </View>
      </View>

      <View style={styles.pillsRow}>
        <Btn
          label="New code"
          icon="refresh"
          kind="ink"
          loading={upsertInviteMutation.isPending}
          disabled={busy || !podId}
          onPress={() =>
            upsertInviteMutation.mutate({
              maxUses,
              expiresInHours,
              regenerate: true,
              toast: 'New code made.',
            })
          }
          a11yLabel="Make a new invite code"
        />
        <Btn
          label="Cancel invite"
          kind="off"
          disabled={busy || !invite || invite.isRevoked}
          onPress={() => {
            if (invite && !invite.isRevoked) {
              revokeMutation.mutate(invite.code);
            }
          }}
          a11yLabel="Cancel this invite"
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  toastBanner: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 22, backgroundColor: PIECE_HEX.mint },
  errorBanner: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: PIECES.off,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 0,
  },
  bannerText: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  muted: { fontSize: 14, lineHeight: 20, color: PIECES.muted },
  loadingWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  codeBlock: { backgroundColor: PIECE_HEX.cobalt, borderRadius: 24, padding: 16, gap: 8, alignItems: 'flex-start' },
  linkBlock: { backgroundColor: PIECE_HEX.birch, borderRadius: 24, padding: 16, gap: 8, alignItems: 'flex-start' },
  fieldLabel: { fontSize: 14, fontWeight: '600', color: PIECES.ink },
  inviteCodeText: { fontSize: 26, fontFamily: MONO_FONT, color: PIECES.ink },
  metaStatsText: { fontSize: 13, color: PIECES.ink2 },
  webLinkText: { fontSize: 14, fontFamily: MONO_FONT, color: PIECES.ink },
  revokedBox: { gap: 6 },
  revokedTitle: { fontSize: 20, fontWeight: '600', color: PIECES.ink },
  controlSection: { gap: 8 },
  controlLabel: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  pillsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
