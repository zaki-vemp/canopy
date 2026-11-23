import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  ApiError,
  acceptPodInvite,
  createCustomPod,
  fetchInterests,
  fetchPods,
  fetchPublicizedPods,
  joinPublicizedPod,
  leavePod,
  matchPods,
  saveMyInterests,
  updatePlanTier,
  updatePodStatus,
} from '../api/client';
import {
  activeDmPeerByPodAtom,
  activePodIdAtom,
  activeTabAtom,
  authUserAtom,
  dmConvoKey,
  unreadDmByPodPeerAtom,
  unreadGroupByPodAtom,
  voicePeersByPodAtom,
} from '../state/atoms';
import {
  extractInviteCode,
  sanitizePodHandle,
  type PodCapacityPreset,
  type PodDetail,
} from '../types/canopy';
import {
  PALETTE,
  TOUCH_MIN,
  capacityTierBadge,
  safePeerColor,
} from '../theme/palette';
import { InviteShareModal } from '../components/InviteShareModal';

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

const SIZE_OPTIONS: ReadonlyArray<{
  value: PodCapacityPreset | null;
  label: string;
}> = [
  { value: null, label: 'Any' },
  { value: 10, label: 'Compact (10)' },
  { value: 25, label: 'Standard (25)' },
  { value: 50, label: 'Club (50)' },
];

const CUSTOM_GROUP_SIZES: ReadonlyArray<{
  value: PodCapacityPreset;
  label: string;
}> = [
  { value: 10, label: 'Compact (10)' },
  { value: 25, label: 'Standard (25)' },
  { value: 50, label: 'Club (50)' },
];

type DiscoveryTab = 'match' | 'publicized' | 'create';

function formatInviteAcceptError(err: unknown): string {
  if (err instanceof ApiError) {
    const hasServerDetail =
      Boolean(err.message) && !/^Request failed \(\d+\)$/.test(err.message);
    if (err.status === 409) {
      return hasServerDetail
        ? err.message
        : 'This pod is full — ask for another room or match below.';
    }
    if (err.status === 410) {
      return hasServerDetail
        ? err.message
        : 'Invite expired, reached max uses, or was revoked.';
    }
    if (err.status === 404) {
      return hasServerDetail
        ? err.message
        : 'Invalid invite code — double-check the link or code.';
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Could not join pod with invite.';
}

export function PodsHubScreen() {
  const queryClient = useQueryClient();
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const setActiveDmPeerMap = useSetAtom(activeDmPeerByPodAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const [authUser, setAuthUser] = useAtom(authUserAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);
  const unreadGroupMap = useAtomValue(unreadGroupByPodAtom);
  const unreadDmMap = useAtomValue(unreadDmByPodPeerAtom);

  const isPro = authUser?.planTier === 'PREMIUM';

  // Invite join & share state
  const [inviteRawInput, setInviteRawInput] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [shareModalPod, setShareModalPod] = useState<PodDetail | null>(null);

  // Discovery switcher: Match 25-Seat Pod | Publicized Groups | Create Own Group (Pro)
  const [discoveryTab, setDiscoveryTab] = useState<DiscoveryTab>('match');
  const [publicizedFilter, setPublicizedFilter] = useState('');

  // Custom Admin Group Creator state (Canopy Pro)
  const [groupTitle, setGroupTitle] = useState('');
  const [groupHandle, setGroupHandle] = useState('');
  const [groupInterest, setGroupInterest] = useState('gaming');
  const [groupDescription, setGroupDescription] = useState('');
  const [groupMaxMembers, setGroupMaxMembers] =
    useState<PodCapacityPreset>(25);
  const [groupPublicized, setGroupPublicized] = useState<boolean>(true);

  // Multi-pod matcher controls (default 25-member Standard)
  const [selectedSize, setSelectedSize] = useState<PodCapacityPreset | null>(
    25
  );
  const [forceNewPod, setForceNewPod] = useState<boolean>(false);
  const [selectedSlugs, setSelectedSlugs] = useState<string[]>([]);
  const [customInterest, setCustomInterest] = useState('');
  const [feedbackBanner, setFeedbackBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Per-pod status editor state
  const [editingStatusPodId, setEditingStatusPodId] = useState<string | null>(
    null
  );
  const [statusDraft, setStatusDraft] = useState('');

  const podsQuery = useQuery({
    queryKey: ['pods'],
    queryFn: fetchPods,
  });

  const interestsQuery = useQuery({
    queryKey: ['interests'],
    queryFn: fetchInterests,
  });

  const publicizedQuery = useQuery({
    queryKey: ['publicized-pods', publicizedFilter],
    queryFn: () => fetchPublicizedPods(publicizedFilter),
    enabled: discoveryTab === 'publicized',
  });

  useEffect(() => {
    if (interestsQuery.data?.interests) {
      const preselected = interestsQuery.data.interests
        .filter((i) => i.selected)
        .map((i) => i.slug);
      setSelectedSlugs((prev) => (prev.length > 0 ? prev : preselected));
    }
  }, [interestsQuery.data]);

  useEffect(() => {
    const pods = podsQuery.data?.pods ?? [];
    if (pods.length > 0 && !pods.some((p) => p.podId === activePodId)) {
      setActivePodId(pods[0].podId);
    }
  }, [podsQuery.data, activePodId, setActivePodId]);

  const joinSingleInterestMutation = useMutation({
    mutationFn: (interest: string) =>
      matchPods({
        interest,
        matchAll: false,
        maxMembers: selectedSize,
        forceNewPod,
        allowAdditional: true,
      }),
    onSuccess: (res) => {
      setErrorBanner(null);
      queryClient.setQueryData(['pods'], { pods: res.pods });
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      if (res.matched.length > 0) {
        const newest = res.matched[0];
        setActivePodId(newest.podId);
        setFeedbackBanner(
          `Joined #${newest.code} as ${newest.myAlias} (${capacityTierBadge(
            newest.memberCount,
            newest.maxMembers
          )})`
        );
      } else {
        setFeedbackBanner('Updated active pods.');
      }
    },
    onError: (err) => {
      setErrorBanner(err instanceof Error ? err.message : 'Match failed.');
    },
  });

  const matchSelectedMutation = useMutation({
    mutationFn: async (slugs: string[]) => {
      await saveMyInterests(slugs);
      return matchPods({
        matchAll: true,
        maxMembers: selectedSize,
        forceNewPod,
      });
    },
    onSuccess: (res) => {
      setErrorBanner(null);
      queryClient.setQueryData(['pods'], { pods: res.pods });
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      if (res.matched.length > 0) {
        setActivePodId(res.matched[0].podId);
        setFeedbackBanner(
          `Matched into ${res.matched.length} new ${
            res.matched.length === 1 ? 'pod' : 'pods'
          }!`
        );
      } else {
        setFeedbackBanner(
          'Interests saved (use + Join Pod on any card to open additional rooms).'
        );
      }
    },
    onError: (err) => {
      setErrorBanner(
        err instanceof Error ? err.message : 'Batch match failed.'
      );
    },
  });

  const leaveOrSwitchMutation = useMutation({
    mutationFn: ({
      podId,
      rematch,
    }: {
      podId: string;
      rematch: boolean;
    }) =>
      leavePod(podId, {
        rematch,
        maxMembers: selectedSize,
        forceNewPod,
      }),
    onSuccess: (res, vars) => {
      setErrorBanner(null);
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      if (vars.rematch && res.newPod) {
        setActivePodId(res.newPod.podId);
        setFeedbackBanner(
          `Switched into #${res.newPod.code} as ${res.newPod.myAlias}`
        );
      } else {
        setFeedbackBanner('Left pod cleanly (recorded opt-out).');
      }
    },
    onError: (err) => {
      setErrorBanner(
        err instanceof Error ? err.message : 'Could not update pod membership.'
      );
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ podId, status }: { podId: string; status: string }) =>
      updatePodStatus(podId, status),
    onSuccess: () => {
      setEditingStatusPodId(null);
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
  });

  const acceptInviteMutation = useMutation({
    mutationFn: (code: string) => acceptPodInvite(code),
    onSuccess: (res) => {
      setInviteError(null);
      setErrorBanner(null);
      setInviteRawInput('');
      if (Array.isArray(res.pods) && res.pods.length > 0) {
        queryClient.setQueryData(['pods'], { pods: res.pods });
      } else if (res.pod) {
        queryClient.setQueryData(
          ['pods'],
          (old: { pods: PodDetail[] } | undefined) => {
            const prev = old?.pods ?? [];
            const exists = prev.some((p) => p.podId === res.pod.podId);
            return {
              pods: exists
                ? prev.map((p) => (p.podId === res.pod.podId ? res.pod : p))
                : [res.pod, ...prev],
            };
          }
        );
      }
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      setActivePodId(res.pod.podId);
      setActiveTab('chat');
    },
    onError: (err) => {
      setInviteError(formatInviteAcceptError(err));
    },
  });

  const upgradeProMutation = useMutation({
    mutationFn: () => updatePlanTier('PREMIUM'),
    onSuccess: (res) => {
      setErrorBanner(null);
      setAuthUser(res.user);
      setFeedbackBanner(
        'Upgraded to Canopy Pro! You can now create custom Admin groups.'
      );
    },
    onError: (err) => {
      setErrorBanner(
        err instanceof Error ? err.message : 'Could not upgrade to Canopy Pro.'
      );
    },
  });

  const joinPublicizedMutation = useMutation({
    mutationFn: (podId: string) => joinPublicizedPod(podId),
    onSuccess: (res) => {
      setErrorBanner(null);
      if (Array.isArray(res.pods) && res.pods.length > 0) {
        queryClient.setQueryData(['pods'], { pods: res.pods });
      } else {
        queryClient.invalidateQueries({ queryKey: ['pods'] });
      }
      queryClient.invalidateQueries({ queryKey: ['publicized-pods'] });
      setActivePodId(res.pod.podId);
      setActiveTab('chat');
    },
    onError: (err) => {
      setErrorBanner(
        err instanceof Error ? err.message : 'Could not join publicized group.'
      );
    },
  });

  const createGroupMutation = useMutation({
    mutationFn: () =>
      createCustomPod({
        title: groupTitle.trim(),
        code: sanitizePodHandle(groupHandle, groupTitle),
        interest: groupInterest.trim() || 'gaming',
        description: groupDescription.trim(),
        maxMembers: groupMaxMembers,
        isPublicized: groupPublicized,
      }),
    onSuccess: (res) => {
      setErrorBanner(null);
      setGroupTitle('');
      setGroupHandle('');
      setGroupDescription('');
      if (Array.isArray(res.pods) && res.pods.length > 0) {
        queryClient.setQueryData(['pods'], { pods: res.pods });
      } else {
        queryClient.invalidateQueries({ queryKey: ['pods'] });
      }
      queryClient.invalidateQueries({ queryKey: ['publicized-pods'] });
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      setActivePodId(res.pod.podId);
      setActiveTab('chat');
    },
    onError: (err) => {
      setErrorBanner(
        err instanceof Error ? err.message : 'Could not create custom group.'
      );
    },
  });

  const handleJoinByInvite = () => {
    const code = extractInviteCode(inviteRawInput);
    if (!code) {
      setInviteError(
        'Paste a valid invite link or code (e.g. k8m4p2x9q7w3).'
      );
      return;
    }
    setInviteError(null);
    acceptInviteMutation.mutate(code);
  };

  const toggleInterestSlug = (slug: string) => {
    setSelectedSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
    );
  };

  const handleAddCustomInterest = () => {
    const clean = customInterest.trim();
    if (!clean) return;
    setCustomInterest('');
    joinSingleInterestMutation.mutate(clean);
  };

  const openChatForPod = (pod: PodDetail) => {
    setActivePodId(pod.podId);
    setActiveDmPeerMap((prev) => ({
      ...prev,
      [pod.podId]: prev[pod.podId] ?? null,
    }));
    setActiveTab('chat');
  };

  const getPodVoiceCount = (pod: PodDetail): number => {
    const livePeers = voicePeersByPod[pod.podId];
    if (livePeers) {
      return livePeers.length;
    }
    return pod.members.filter((m) => m.inVoice).length;
  };

  const pods = podsQuery.data?.pods ?? [];
  const interests = interestsQuery.data?.interests ?? [];
  const publicizedGroups = publicizedQuery.data?.groups ?? [];
  const refreshing =
    podsQuery.isRefetching ||
    interestsQuery.isRefetching ||
    publicizedQuery.isRefetching;

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              podsQuery.refetch();
              interestsQuery.refetch();
              if (discoveryTab === 'publicized') {
                publicizedQuery.refetch();
              }
            }}
            tintColor={PALETTE.forest}
          />
        }
      >
        {/* Status / Error Feedback */}
        {feedbackBanner ? (
          <View style={styles.mintBanner}>
            <Ionicons name="checkmark-circle" size={18} color={PALETTE.forest} />
            <Text style={styles.mintBannerText}>{feedbackBanner}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss notification"
              onPress={() => setFeedbackBanner(null)}
              style={styles.dismissHit}
            >
              <Ionicons name="close" size={16} color={PALETTE.forest} />
            </Pressable>
          </View>
        ) : null}

        {errorBanner ? (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color={PALETTE.danger} />
            <Text style={styles.errorBannerText}>{errorBanner}</Text>
          </View>
        ) : null}

        {/* TOP CARD: Join with Invite Link or Code */}
        <View style={styles.inviteJoinCard}>
          <View style={styles.inviteJoinHeader}>
            <View style={styles.inviteTitleRow}>
              <Ionicons name="ticket-outline" size={18} color={PALETTE.forest} />
              <Text style={styles.inviteJoinTitle}>
                Join with Invite Link or Code
              </Text>
            </View>
            <Text style={styles.inviteJoinSub}>
              Paste a web invite URL or code to jump straight into a pod with a
              blind animal alias.
            </Text>
          </View>

          <View style={styles.inviteInputRow}>
            <TextInput
              value={inviteRawInput}
              onChangeText={(val) => {
                setInviteRawInput(val);
                if (inviteError) setInviteError(null);
              }}
              placeholder="Paste invite link or code (e.g. k8m4p2x9q7w3)..."
              placeholderTextColor={PALETTE.muted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={handleJoinByInvite}
              style={styles.inviteInput}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Join Pod with invite"
              disabled={acceptInviteMutation.isPending}
              onPress={handleJoinByInvite}
              style={[
                styles.inviteJoinBtn,
                acceptInviteMutation.isPending && styles.disabledBtn,
              ]}
            >
              {acceptInviteMutation.isPending ? (
                <ActivityIndicator size="small" color={PALETTE.charcoal} />
              ) : (
                <Text style={styles.inviteJoinBtnText}>Join Pod</Text>
              )}
            </Pressable>
          </View>

          {inviteError ? (
            <View style={styles.inviteInlineError}>
              <Ionicons name="alert-circle" size={16} color={PALETTE.danger} />
              <Text style={styles.inviteInlineErrorText}>{inviteError}</Text>
            </View>
          ) : null}
        </View>

        {/* SECTION 1: Active Pods List */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Your Active Pods ({pods.length})</Text>
        <Text style={styles.sectionMeta}>Multi-pod anonymous hub</Text>
      </View>

      {podsQuery.isLoading ? (
        <View style={styles.loadingCard}>
          <ActivityIndicator color={PALETTE.forest} />
          <Text style={styles.loadingText}>Loading your pods...</Text>
        </View>
      ) : pods.length === 0 ? (
        <View style={styles.emptyCard}>
          <Ionicons name="planet-outline" size={28} color={PALETTE.forest} />
          <Text style={styles.emptyTitle}>No active pods yet</Text>
          <Text style={styles.emptySub}>
            Pick a pod size below and tap + Join Pod on any interest to get an
            instant room-scoped animal alias.
          </Text>
        </View>
      ) : (
        <View style={styles.podsList}>
          {pods.map((pod) => {
            const isSelected = pod.podId === activePodId;
            const voiceCount = getPodVoiceCount(pod);
            const aliasColor = safePeerColor(pod.myColor, pod.myAlias);
            const isEditingStatus = editingStatusPodId === pod.podId;
            const groupUnread =
              unreadGroupMap[pod.podId] ?? pod.unreadGroupCount ?? 0;
            const dmUnread = (pod.dmConversations ?? []).reduce(
              (sum, dm) =>
                sum +
                (unreadDmMap[dmConvoKey(pod.podId, dm.peerId)] ??
                  dm.unreadCount ??
                  0),
              0
            );

            return (
              <View
                key={pod.podId}
                style={[styles.podCard, isSelected && styles.podCardActive]}
              >
                {/* Top Row: title/#code + governance + capacity + live voice */}
                <View style={styles.podTopRow}>
                  <View style={styles.podCodeWrap}>
                    <Text style={styles.podCode}>
                      {pod.title?.trim() ? pod.title : `#${pod.code}`}
                    </Text>
                    <Text style={styles.podInterestLabel}>
                      {pod.title?.trim() ? `#${pod.code} · ` : ''}
                      {pod.interestLabel}
                    </Text>
                    {pod.description?.trim() ? (
                      <Text style={styles.podDescSnippet} numberOfLines={2}>
                        {pod.description}
                      </Text>
                    ) : null}
                  </View>

                  <View style={styles.badgesRight}>
                    <View
                      style={[
                        styles.govBadge,
                        pod.governanceMode === 'ADMIN' && styles.govBadgeAdmin,
                      ]}
                    >
                      <Text
                        style={[
                          styles.govBadgeText,
                          pod.governanceMode === 'ADMIN' &&
                            styles.govBadgeTextAdmin,
                        ]}
                      >
                        {pod.governanceMode === 'ADMIN'
                          ? `👑 Admin · ${
                              pod.isPublicized ? 'Publicized' : 'Private'
                            }`
                          : '⚖️ Democratic'}
                      </Text>
                    </View>
                    {groupUnread + dmUnread > 0 ? (
                      <View style={styles.openVotesPill}>
                        <Text style={styles.openVotesPillText}>
                          {dmUnread > 0
                            ? `${groupUnread + dmUnread} Unread (${dmUnread} DM)`
                            : `${groupUnread} Unread`}
                        </Text>
                      </View>
                    ) : null}
                    {pod.openProposalsCount > 0 ? (
                      <View style={styles.openVotesPill}>
                        <Text style={styles.openVotesPillText}>
                          🗳️ {pod.openProposalsCount} Open
                        </Text>
                      </View>
                    ) : null}
                    {voiceCount > 0 ? (
                      <View style={styles.voiceLiveBadge}>
                        <Ionicons
                          name="volume-high"
                          size={12}
                          color={PALETTE.charcoal}
                        />
                        <Text style={styles.voiceLiveText}>
                          {voiceCount} in Voice
                        </Text>
                      </View>
                    ) : null}
                    <View style={styles.tierBadge}>
                      <Text style={styles.tierBadgeText}>
                        {capacityTierBadge(pod.memberCount, pod.maxMembers)}
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Blind Alias Pill + Custom Pod Status Editor */}
                <View style={styles.identityRow}>
                  <View
                    style={[
                      styles.aliasPill,
                      { borderColor: aliasColor },
                    ]}
                  >
                    <View
                      style={[
                        styles.aliasDot,
                        { backgroundColor: aliasColor },
                      ]}
                    />
                    <Text style={styles.aliasPillText}>
                      You: {pod.myAlias}
                    </Text>
                  </View>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Edit custom status in ${pod.code}`}
                    onPress={() => {
                      if (isEditingStatus) {
                        setEditingStatusPodId(null);
                      } else {
                        setEditingStatusPodId(pod.podId);
                        setStatusDraft(pod.myStatus || '');
                      }
                    }}
                    style={styles.statusTriggerBtn}
                  >
                    <Ionicons
                      name="pricetag-outline"
                      size={14}
                      color={PALETTE.muted}
                    />
                    <Text style={styles.statusTriggerText} numberOfLines={1}>
                      {pod.myStatus ? pod.myStatus : 'Set pod status'}
                    </Text>
                  </Pressable>
                </View>

                {isEditingStatus ? (
                  <View style={styles.statusEditorRow}>
                    <TextInput
                      value={statusDraft}
                      onChangeText={setStatusDraft}
                      placeholder="e.g. Ready for co-op tonight"
                      placeholderTextColor={PALETTE.muted}
                      maxLength={80}
                      style={styles.statusInput}
                    />
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        statusMutation.mutate({
                          podId: pod.podId,
                          status: statusDraft.trim(),
                        })
                      }
                      style={styles.statusSaveBtn}
                    >
                      <Text style={styles.statusSaveText}>Save</Text>
                    </Pressable>
                  </View>
                ) : null}

                {/* Action Buttons (44pt minimum touch height) */}
                <View style={styles.podActionsGrid}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open chat for ${pod.code}`}
                    onPress={() => openChatForPod(pod)}
                    style={styles.openChatBtn}
                  >
                    <Ionicons
                      name="chatbubbles"
                      size={15}
                      color={PALETTE.charcoal}
                    />
                    <Text style={styles.openChatText}>Open Chat</Text>
                  </Pressable>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Share or invite to ${pod.code}`}
                    onPress={() => setShareModalPod(pod)}
                    style={styles.shareActionBtn}
                  >
                    <Ionicons
                      name="share-social-outline"
                      size={15}
                      color={PALETTE.forest}
                    />
                    <Text style={styles.shareActionText}>Share / Invite</Text>
                  </Pressable>
                </View>

                <View style={styles.podActionsSecondaryRow}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Join another ${pod.interestLabel} pod`}
                    disabled={joinSingleInterestMutation.isPending}
                    onPress={() =>
                      joinSingleInterestMutation.mutate(pod.interestSlug)
                    }
                    style={styles.secondaryActionBtn}
                  >
                    <Text style={styles.secondaryActionText}>
                      + Another Pod
                    </Text>
                  </Pressable>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Switch pod ${pod.code}`}
                    disabled={leaveOrSwitchMutation.isPending}
                    onPress={() =>
                      leaveOrSwitchMutation.mutate({
                        podId: pod.podId,
                        rematch: true,
                      })
                    }
                    style={styles.secondaryActionBtn}
                  >
                    <Ionicons
                      name="shuffle"
                      size={15}
                      color={PALETTE.ink}
                    />
                    <Text style={styles.secondaryActionText}>Switch Pod</Text>
                  </Pressable>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Leave pod ${pod.code}`}
                    disabled={leaveOrSwitchMutation.isPending}
                    onPress={() =>
                      leaveOrSwitchMutation.mutate({
                        podId: pod.podId,
                        rematch: false,
                      })
                    }
                    style={styles.leaveActionBtn}
                  >
                    <Text style={styles.leaveActionText}>Leave</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* SECTION 2: Segmented Discovery Hub */}
      <View style={styles.matcherCard}>
        {/* 3-Way Segmented Switcher */}
        <View style={styles.discoverySegmented}>
          {(
            [
              { key: 'match', label: 'Match 25-Seat Pod' },
              { key: 'publicized', label: 'Publicized Groups' },
              { key: 'create', label: 'Create Own Group (Pro)' },
            ] as const
          ).map((seg) => {
            const active = discoveryTab === seg.key;
            return (
              <Pressable
                key={seg.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  setDiscoveryTab(seg.key);
                  setErrorBanner(null);
                }}
                style={[
                  styles.discoverySegBtn,
                  active && styles.discoverySegBtnActive,
                ]}
              >
                <Text
                  style={[
                    styles.discoverySegText,
                    active && styles.discoverySegTextActive,
                  ]}
                  numberOfLines={2}
                >
                  {seg.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* SUB-VIEW 1: Match 25-Seat Democratic Pod */}
        {discoveryTab === 'match' ? (
          <>
            <View style={styles.matcherHeader}>
              <Text style={styles.matcherTitle}>
                Match 25-Member Democratic Pod
              </Text>
              <Text style={styles.matcherSub}>
                Every matched pod is 100% peer-blind & governed by YES/NO
                votes. Pick Compact (10), Standard (25), or Club (50).
              </Text>
            </View>

            {/* Pod Size Selector */}
            <View style={styles.controlBlock}>
              <Text style={styles.controlLabel}>Pod Capacity</Text>
              <View style={styles.sizeGrid}>
                {SIZE_OPTIONS.map((opt) => {
                  const active = selectedSize === opt.value;
                  return (
                    <Pressable
                      key={opt.label}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() => setSelectedSize(opt.value)}
                      style={[styles.sizeChip, active && styles.sizeChipActive]}
                    >
                      <Text
                        style={[
                          styles.sizeChipText,
                          active && styles.sizeChipTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Mode Toggle: Join Open Pod vs Force New Pod */}
            <View style={styles.controlBlock}>
              <Text style={styles.controlLabel}>Match Mode</Text>
              <View style={styles.modeToggleRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: !forceNewPod }}
                  onPress={() => setForceNewPod(false)}
                  style={[
                    styles.modeBtn,
                    !forceNewPod && styles.modeBtnActive,
                  ]}
                >
                  <Ionicons
                    name="people-outline"
                    size={16}
                    color={!forceNewPod ? PALETTE.charcoal : PALETTE.muted}
                  />
                  <Text
                    style={[
                      styles.modeBtnText,
                      !forceNewPod && styles.modeBtnTextActive,
                    ]}
                  >
                    Join Open
                  </Text>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: forceNewPod }}
                  onPress={() => setForceNewPod(true)}
                  style={[
                    styles.modeBtn,
                    forceNewPod && styles.modeBtnActive,
                  ]}
                >
                  <Ionicons
                    name="add-circle-outline"
                    size={16}
                    color={forceNewPod ? PALETTE.charcoal : PALETTE.muted}
                  />
                  <Text
                    style={[
                      styles.modeBtnText,
                      forceNewPod && styles.modeBtnTextActive,
                    ]}
                  >
                    Force New Pod
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Custom Interest Input */}
            <View style={styles.customRow}>
              <TextInput
                value={customInterest}
                onChangeText={setCustomInterest}
                placeholder="Custom interest (e.g. Synthwave, Bouldering)..."
                placeholderTextColor={PALETTE.muted}
                onSubmitEditing={handleAddCustomInterest}
                style={styles.customInput}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Join custom interest pod"
                disabled={
                  !customInterest.trim() || joinSingleInterestMutation.isPending
                }
                onPress={handleAddCustomInterest}
                style={[
                  styles.customAddBtn,
                  !customInterest.trim() && styles.disabledBtn,
                ]}
              >
                <Text style={styles.customAddText}>+ Join</Text>
              </Pressable>
            </View>

            {/* Batch Match Selected Bar */}
            <View style={styles.batchBar}>
              <Text style={styles.batchCountText}>
                {selectedSlugs.length} selected
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={
                  selectedSlugs.length === 0 || matchSelectedMutation.isPending
                }
                onPress={() => matchSelectedMutation.mutate(selectedSlugs)}
                style={[
                  styles.batchMatchBtn,
                  selectedSlugs.length === 0 && styles.disabledBtn,
                ]}
              >
                {matchSelectedMutation.isPending ? (
                  <ActivityIndicator size="small" color={PALETTE.mint} />
                ) : (
                  <Text style={styles.batchMatchText}>Match Selected</Text>
                )}
              </Pressable>
            </View>

            {/* Seeded & Custom Interest Cards */}
            <View style={styles.interestGrid}>
              {interests.map((item) => {
                const isChecked = selectedSlugs.includes(item.slug);
                return (
                  <View
                    key={item.slug}
                    style={[
                      styles.interestCard,
                      isChecked && styles.interestCardChecked,
                    ]}
                  >
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isChecked }}
                      onPress={() => toggleInterestSlug(item.slug)}
                      style={styles.interestSelectArea}
                    >
                      <Ionicons
                        name={isChecked ? 'checkbox' : 'square-outline'}
                        size={20}
                        color={isChecked ? PALETTE.forest : PALETTE.muted}
                      />
                      <View style={styles.interestTextCol}>
                        <Text style={styles.interestLabel}>{item.label}</Text>
                        <Text style={styles.interestStats}>
                          {item.openPods} open · {item.activeMembers} peers ·{' '}
                          {item.category}
                        </Text>
                      </View>
                    </Pressable>

                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Join ${item.label} pod`}
                      disabled={joinSingleInterestMutation.isPending}
                      onPress={() =>
                        joinSingleInterestMutation.mutate(item.slug)
                      }
                      style={styles.quickJoinBtn}
                    >
                      <Text style={styles.quickJoinText}>+ Join Pod</Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          </>
        ) : null}

        {/* SUB-VIEW 2: Publicized Groups Directory */}
        {discoveryTab === 'publicized' ? (
          <View style={styles.subViewStack}>
            <View style={styles.matcherHeader}>
              <Text style={styles.matcherTitle}>
                Publicized Blind Groups Directory
              </Text>
              <Text style={styles.matcherSub}>
                Browse custom Canopy Pro communities publicized by their owners
                and join instantly with a room-scoped animal alias.
              </Text>
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterPillsRow}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: publicizedFilter === '' }}
                onPress={() => setPublicizedFilter('')}
                style={[
                  styles.sizeChip,
                  publicizedFilter === '' && styles.sizeChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.sizeChipText,
                    publicizedFilter === '' && styles.sizeChipTextActive,
                  ]}
                >
                  All Interests
                </Text>
              </Pressable>
              {interests.slice(0, 8).map((it) => {
                const active = publicizedFilter === it.slug;
                return (
                  <Pressable
                    key={it.slug}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => setPublicizedFilter(it.slug)}
                    style={[styles.sizeChip, active && styles.sizeChipActive]}
                  >
                    <Text
                      style={[
                        styles.sizeChipText,
                        active && styles.sizeChipTextActive,
                      ]}
                    >
                      {it.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {publicizedQuery.isLoading ? (
              <View style={styles.loadingCard}>
                <ActivityIndicator color={PALETTE.forest} />
                <Text style={styles.loadingText}>
                  Loading publicized groups...
                </Text>
              </View>
            ) : publicizedGroups.length === 0 ? (
              <View style={styles.emptyDirectoryBox}>
                <Ionicons
                  name="compass-outline"
                  size={26}
                  color={PALETTE.forest}
                />
                <Text style={styles.emptyTitle}>
                  No publicized groups listed yet
                </Text>
                <Text style={styles.emptySub}>
                  Switch to Create Own Group (Pro) to launch the first
                  publicized group in this interest!
                </Text>
              </View>
            ) : (
              publicizedGroups.map((grp) => {
                const isFull = grp.memberCount >= grp.maxMembers;
                return (
                  <View key={grp.podId} style={styles.directoryGroupCard}>
                    <View style={styles.podTopRow}>
                      <View style={styles.podCodeWrap}>
                        <Text style={styles.podCode}>
                          {grp.title?.trim() ? grp.title : `#${grp.code}`}
                        </Text>
                        <Text style={styles.podInterestLabel}>
                          #{grp.code} · {grp.interestLabel} · Founded by{' '}
                          {grp.founderAlias}
                        </Text>
                      </View>
                      <View style={styles.tierBadge}>
                        <Text style={styles.tierBadgeText}>
                          {capacityTierBadge(grp.memberCount, grp.maxMembers)}
                        </Text>
                      </View>
                    </View>

                    {grp.description?.trim() ? (
                      <Text style={styles.podDescSnippet}>
                        {grp.description}
                      </Text>
                    ) : null}

                    {grp.alreadyMember ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => {
                          setActivePodId(grp.podId);
                          setActiveTab('chat');
                        }}
                        style={styles.shareActionBtn}
                      >
                        <Text style={styles.shareActionText}>
                          Already Member · Open Chat
                        </Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Join group ${
                          grp.title || grp.code
                        }`}
                        disabled={isFull || joinPublicizedMutation.isPending}
                        onPress={() => joinPublicizedMutation.mutate(grp.podId)}
                        style={[
                          styles.openChatBtn,
                          (isFull || joinPublicizedMutation.isPending) &&
                            styles.disabledBtn,
                        ]}
                      >
                        <Text style={styles.openChatText}>
                          {isFull ? 'Group Full' : 'Join Group'}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                );
              })
            )}
          </View>
        ) : null}

        {/* SUB-VIEW 3: Create Own Custom Admin Group (Canopy Pro) */}
        {discoveryTab === 'create' ? (
          !isPro ? (
            <View style={styles.proUpgradeGate}>
              <View style={styles.proGateBadge}>
                <Text style={styles.proGateBadgeText}>👑 CANOPY PRO</Text>
              </View>
              <Text style={styles.matcherTitle}>
                Create & Moderate Your Own Blind Group
              </Text>
              <Text style={styles.matcherSub}>
                Upgrade to Canopy Pro to launch custom 10, 25, or 50-seat Admin
                groups — keep them Private (Invite Only) or list them in the
                Publicized Groups directory while preserving 100% peer-blind
                aliases.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Upgrade to Canopy Pro"
                disabled={upgradeProMutation.isPending}
                onPress={() => upgradeProMutation.mutate()}
                style={styles.openChatBtn}
              >
                {upgradeProMutation.isPending ? (
                  <ActivityIndicator size="small" color={PALETTE.charcoal} />
                ) : (
                  <Text style={styles.openChatText}>Upgrade to Canopy Pro</Text>
                )}
              </Pressable>
            </View>
          ) : (
            <View style={styles.subViewStack}>
              <View style={styles.matcherHeader}>
                <View style={styles.proActiveRow}>
                  <Text style={styles.matcherTitle}>
                    Create Custom Admin Group
                  </Text>
                  <View style={styles.proGateBadge}>
                    <Text style={styles.proGateBadgeText}>👑 PRO</Text>
                  </View>
                </View>
                <Text style={styles.matcherSub}>
                  You become Group Owner with instant Co-Admin, roster, and
                  visibility controls. Every peer stays anonymous.
                </Text>
              </View>

              <View style={styles.controlBlock}>
                <Text style={styles.controlLabel}>Group Title</Text>
                <TextInput
                  value={groupTitle}
                  onChangeText={setGroupTitle}
                  placeholder="e.g. Tactical Co-op Raiders"
                  placeholderTextColor={PALETTE.muted}
                  style={styles.customInput}
                />
              </View>

              <View style={styles.controlBlock}>
                <Text style={styles.controlLabel}>#handle</Text>
                <TextInput
                  value={groupHandle}
                  onChangeText={setGroupHandle}
                  placeholder={
                    sanitizePodHandle('', groupTitle) || 'tactical-raiders'
                  }
                  placeholderTextColor={PALETTE.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.inviteInput}
                />
              </View>

              <View style={styles.controlBlock}>
                <Text style={styles.controlLabel}>Interest</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.filterPillsRow}
                >
                  {interests.slice(0, 8).map((it) => {
                    const active = groupInterest === it.slug;
                    return (
                      <Pressable
                        key={it.slug}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        onPress={() => setGroupInterest(it.slug)}
                        style={[
                          styles.sizeChip,
                          active && styles.sizeChipActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.sizeChipText,
                            active && styles.sizeChipTextActive,
                          ]}
                        >
                          {it.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
                <TextInput
                  value={groupInterest}
                  onChangeText={setGroupInterest}
                  placeholder="Interest slug or name (e.g. gaming)"
                  placeholderTextColor={PALETTE.muted}
                  autoCapitalize="none"
                  style={styles.customInput}
                />
              </View>

              <View style={styles.controlBlock}>
                <Text style={styles.controlLabel}>Description</Text>
                <TextInput
                  value={groupDescription}
                  onChangeText={setGroupDescription}
                  placeholder="Nightly Helldivers runs, loadouts & voice..."
                  placeholderTextColor={PALETTE.muted}
                  multiline
                  style={styles.customInput}
                />
              </View>

              <View style={styles.controlBlock}>
                <Text style={styles.controlLabel}>Seats (10 / 25 / 50)</Text>
                <View style={styles.sizeGrid}>
                  {CUSTOM_GROUP_SIZES.map((opt) => {
                    const active = groupMaxMembers === opt.value;
                    return (
                      <Pressable
                        key={opt.value}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        onPress={() => setGroupMaxMembers(opt.value)}
                        style={[
                          styles.sizeChip,
                          active && styles.sizeChipActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.sizeChipText,
                            active && styles.sizeChipTextActive,
                          ]}
                        >
                          {opt.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={styles.controlBlock}>
                <Text style={styles.controlLabel}>Visibility</Text>
                <View style={styles.modeToggleRow}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: !groupPublicized }}
                    onPress={() => setGroupPublicized(false)}
                    style={[
                      styles.modeBtn,
                      !groupPublicized && styles.modeBtnActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.modeBtnText,
                        !groupPublicized && styles.modeBtnTextActive,
                      ]}
                    >
                      Private (Invite Only)
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: groupPublicized }}
                    onPress={() => setGroupPublicized(true)}
                    style={[
                      styles.modeBtn,
                      groupPublicized && styles.modeBtnActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.modeBtnText,
                        groupPublicized && styles.modeBtnTextActive,
                      ]}
                    >
                      Publicize Group
                    </Text>
                  </Pressable>
                </View>
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create custom admin group"
                disabled={
                  !groupTitle.trim() || createGroupMutation.isPending
                }
                onPress={() => createGroupMutation.mutate()}
                style={[
                  styles.openChatBtn,
                  (!groupTitle.trim() || createGroupMutation.isPending) &&
                    styles.disabledBtn,
                ]}
              >
                {createGroupMutation.isPending ? (
                  <ActivityIndicator size="small" color={PALETTE.charcoal} />
                ) : (
                  <Text style={styles.openChatText}>Create Own Group</Text>
                )}
              </Pressable>
            </View>
          )
        ) : null}
      </View>
      </ScrollView>

      <InviteShareModal
        visible={!!shareModalPod}
        pod={shareModalPod}
        onClose={() => setShareModalPod(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.surface,
  },
  flex: {
    flex: 1,
  },
  content: {
    padding: 14,
    gap: 12,
    paddingBottom: 30,
  },
  inviteJoinCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1.5,
    borderColor: PALETTE.mintBorder,
    gap: 10,
  },
  inviteJoinHeader: {
    gap: 3,
  },
  inviteTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  inviteJoinTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  inviteJoinSub: {
    fontSize: 12,
    lineHeight: 17,
    color: PALETTE.muted,
  },
  inviteInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  inviteInput: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    paddingHorizontal: 12,
    fontSize: 13,
    color: PALETTE.ink,
    fontFamily: MONO_FONT,
  },
  inviteJoinBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inviteJoinBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  inviteInlineError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: PALETTE.dangerSoft,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  inviteInlineErrorText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: PALETTE.danger,
  },
  mintBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  mintBannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.forest,
  },
  dismissHit: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: PALETTE.dangerSoft,
    borderRadius: 12,
    padding: 12,
  },
  errorBannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.danger,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  sectionMeta: {
    fontSize: 12,
    color: PALETTE.muted,
    fontFamily: MONO_FONT,
  },
  loadingCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  loadingText: {
    fontSize: 13,
    color: PALETTE.muted,
  },
  emptyCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  emptySub: {
    fontSize: 13,
    lineHeight: 19,
    color: PALETTE.muted,
    textAlign: 'center',
  },
  podsList: {
    gap: 12,
  },
  podCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: 10,
  },
  podCardActive: {
    borderColor: PALETTE.forest,
    borderWidth: 1.5,
  },
  podTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  podCodeWrap: {
    flex: 1,
    gap: 2,
  },
  podCode: {
    fontSize: 17,
    fontWeight: '700',
    color: PALETTE.charcoal,
    fontFamily: MONO_FONT,
  },
  podInterestLabel: {
    fontSize: 13,
    color: PALETTE.muted,
    fontWeight: '600',
  },
  podDescSnippet: {
    fontSize: 12,
    lineHeight: 17,
    color: PALETTE.ink,
    marginTop: 2,
  },
  badgesRight: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 6,
    maxWidth: '56%',
  },
  govBadge: {
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  govBadgeAdmin: {
    backgroundColor: PALETTE.surfaceMuted,
    borderColor: PALETTE.borderStrong,
  },
  govBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  govBadgeTextAdmin: {
    color: PALETTE.charcoal,
  },
  openVotesPill: {
    backgroundColor: PALETTE.mint,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  openVotesPillText: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.charcoal,
    fontFamily: MONO_FONT,
  },
  voiceLiveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: PALETTE.mint,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  voiceLiveText: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.charcoal,
    fontFamily: MONO_FONT,
  },
  tierBadge: {
    backgroundColor: PALETTE.charcoal,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  tierBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.mint,
    fontFamily: MONO_FONT,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  aliasPill: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  aliasDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  aliasPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  statusTriggerBtn: {
    minHeight: TOUCH_MIN,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  statusTriggerText: {
    fontSize: 12,
    color: PALETTE.muted,
    flex: 1,
  },
  statusEditorRow: {
    flexDirection: 'row',
    gap: 8,
  },
  statusInput: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    backgroundColor: PALETTE.surface,
    paddingHorizontal: 12,
    fontSize: 14,
    color: PALETTE.ink,
  },
  statusSaveBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: PALETTE.charcoal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusSaveText: {
    color: PALETTE.mint,
    fontWeight: '700',
    fontSize: 13,
  },
  podActionsGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  openChatBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  openChatText: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  shareActionBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  shareActionText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  podActionsSecondaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  secondaryActionBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 8,
  },
  secondaryActionText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  leaveActionBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: PALETTE.dangerSoft,
    borderWidth: 1,
    borderColor: '#f3c1bd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  leaveActionText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.danger,
  },
  matcherCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: 14,
    marginTop: 4,
  },
  discoverySegmented: {
    flexDirection: 'row',
    backgroundColor: PALETTE.surfaceMuted,
    borderRadius: 12,
    padding: 4,
    gap: 4,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  discoverySegBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 9,
    paddingHorizontal: 6,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discoverySegBtnActive: {
    backgroundColor: PALETTE.charcoal,
  },
  discoverySegText: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.ink,
    textAlign: 'center',
  },
  discoverySegTextActive: {
    color: PALETTE.mint,
  },
  subViewStack: {
    gap: 12,
  },
  filterPillsRow: {
    gap: 8,
    paddingVertical: 2,
  },
  emptyDirectoryBox: {
    backgroundColor: PALETTE.surface,
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    gap: 6,
  },
  directoryGroupCard: {
    backgroundColor: PALETTE.surface,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    gap: 10,
  },
  proUpgradeGate: {
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1.5,
    borderColor: PALETTE.mintBorder,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  proActiveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  proGateBadge: {
    alignSelf: 'flex-start',
    backgroundColor: PALETTE.charcoal,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  proGateBadgeText: {
    color: PALETTE.mint,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: MONO_FONT,
    letterSpacing: 0.5,
  },
  matcherHeader: {
    gap: 4,
  },
  matcherTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  matcherSub: {
    fontSize: 13,
    lineHeight: 18,
    color: PALETTE.muted,
  },
  controlBlock: {
    gap: 6,
  },
  controlLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontFamily: MONO_FONT,
  },
  sizeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  sizeChip: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 11,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sizeChipActive: {
    backgroundColor: PALETTE.mint,
    borderColor: PALETTE.forest,
  },
  sizeChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.ink,
  },
  sizeChipTextActive: {
    color: PALETTE.charcoal,
    fontWeight: '700',
  },
  modeToggleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  modeBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 11,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  modeBtnActive: {
    backgroundColor: PALETTE.mint,
    borderColor: PALETTE.forest,
  },
  modeBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.muted,
  },
  modeBtnTextActive: {
    color: PALETTE.charcoal,
    fontWeight: '700',
  },
  customRow: {
    flexDirection: 'row',
    gap: 8,
  },
  customInput: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    paddingHorizontal: 12,
    fontSize: 14,
    color: PALETTE.ink,
  },
  customAddBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: PALETTE.charcoal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  customAddText: {
    color: PALETTE.mint,
    fontWeight: '700',
    fontSize: 13,
  },
  disabledBtn: {
    opacity: 0.45,
  },
  batchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: PALETTE.surface,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  batchCountText: {
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.ink,
    fontFamily: MONO_FONT,
  },
  batchMatchBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: PALETTE.charcoal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  batchMatchText: {
    color: PALETTE.mint,
    fontWeight: '700',
    fontSize: 13,
  },
  interestGrid: {
    gap: 8,
  },
  interestCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: PALETTE.surface,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  interestCardChecked: {
    backgroundColor: PALETTE.mintSoft,
    borderColor: PALETTE.mintBorder,
  },
  interestSelectArea: {
    flex: 1,
    minHeight: TOUCH_MIN,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  interestTextCol: {
    flex: 1,
    gap: 2,
  },
  interestLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  interestStats: {
    fontSize: 11,
    color: PALETTE.muted,
    fontFamily: MONO_FONT,
  },
  quickJoinBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.mint,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickJoinText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
});
