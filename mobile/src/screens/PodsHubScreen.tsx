import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../theme/ui';
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
  PIECES,
  PIECE_HEX,
  PIECE_NAMES,
  TOUCH_MIN,
  capacityTierBadge,
  pieceColor,
  pieceRadii,
} from '../theme/palette';
import { InviteShareModal } from '../components/InviteShareModal';
import { Sheet } from '../components/Sheet';
import { Badge, Btn, Chip, Piece, fieldStyles } from '../components/Pieces';

const MONO_FONT = 'DMMono_500Medium';

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
        : 'That room is full. Ask for another invite or join a different room.';
    }
    if (err.status === 410) {
      return hasServerDetail
        ? err.message
        : 'That invite expired, ran out of uses, or was cancelled.';
    }
    if (err.status === 404) {
      return hasServerDetail
        ? err.message
        : 'We could not find that invite. Check the link or code.';
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Could not join with that invite.';
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
  const [joinOpen, setJoinOpen] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
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
          `Joined ${newest.title?.trim() || newest.interestLabel} as ${newest.myAlias}`
        );
      } else {
        setFeedbackBanner('Your rooms are up to date.');
      }
    },
    onError: (err) => {
      setErrorBanner(err instanceof Error ? err.message : 'Could not join a room.');
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
          `Joined ${res.matched.length} new ${
            res.matched.length === 1 ? 'room' : 'rooms'
          }.`
        );
      } else {
        setFeedbackBanner(
          'Hobbies saved. Press Join on any tile to open another room.'
        );
      }
    },
    onError: (err) => {
      setErrorBanner(
        err instanceof Error ? err.message : 'Could not join those rooms.'
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
          `Switched rooms. You are ${res.newPod.myAlias} here.`
        );
      } else {
        setFeedbackBanner('You left the room.');
      }
    },
    onError: (err) => {
      setErrorBanner(
        err instanceof Error ? err.message : 'Could not change your seat in the room.'
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
        'You are on Canopy Pro. You can now make your own groups.'
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
        err instanceof Error ? err.message : 'Could not join that group.'
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
        err instanceof Error ? err.message : 'Could not make the group.'
      );
    },
  });

  const handleJoinByInvite = () => {
    const code = extractInviteCode(inviteRawInput);
    if (!code) {
      setInviteError(
        'Paste an invite link or code, like k8m4p2x9q7w3.'
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

  const activePod = pods.find((p) => p.podId === activePodId) ?? pods[0] ?? null;
  const roomInitials = (pod: PodDetail) =>
    (pod.title?.trim() || pod.interestLabel || pod.code).slice(0, 2);
  const tileColor = (index: number) =>
    PIECE_HEX[PIECE_NAMES[(index * 5 + 1) % PIECE_NAMES.length]];

  const openPrivate = (pod: PodDetail, peerId: string) => {
    setActivePodId(pod.podId);
    setActiveDmPeerMap((prev) => ({ ...prev, [pod.podId]: peerId }));
    setActiveTab('chat');
  };

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
            tintColor={PIECES.ink}
          />
        }
      >
        {feedbackBanner ? (
          <View style={styles.doneBanner} accessibilityRole="alert">
            <Text style={styles.bannerText}>{feedbackBanner}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              onPress={() => setFeedbackBanner(null)}
              style={styles.dismissHit}
            >
              <Ionicons name="close" size={18} color={PIECES.ink} />
            </Pressable>
          </View>
        ) : null}

        {errorBanner ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.bannerText}>{errorBanner}</Text>
          </View>
        ) : null}

        {/* Your rooms: one sheet, one row per room */}
        <View style={styles.sheetCard}>
          <Text style={styles.h2}>Your rooms</Text>

          {podsQuery.isLoading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={PIECES.ink} />
              <Text style={styles.muted}>Finding your rooms...</Text>
            </View>
          ) : pods.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>No rooms yet</Text>
              <Text style={styles.muted}>
                Pick a hobby and you get a seat among people who picked the same
                one, under an alias you can't change.
              </Text>
            </View>
          ) : (
            pods.map((pod, index) => {
              const isSelected = pod.podId === activePod?.podId;
              const voiceCount = getPodVoiceCount(pod);
              const color = pieceColor(pod.myAlias);
              const open = manageId === pod.podId;
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
              const unread = groupUnread + dmUnread;
              return (
                <View key={pod.podId} style={styles.roomWrap}>
                  <View
                    style={[
                      styles.roomRow,
                      isSelected && { backgroundColor: color },
                    ]}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${
                        pod.title?.trim() || pod.interestLabel
                      }, you are ${pod.myAlias}${
                        unread > 0 ? `, ${unread} unread` : ''
                      }`}
                      onPress={() => openChatForPod(pod)}
                      style={styles.roomMain}
                    >
                      <View
                        style={[
                          styles.roomTile,
                          pieceRadii(pod.myAlias, 52),
                          {
                            backgroundColor: isSelected ? PIECES.sheet : color,
                          },
                        ]}
                      >
                        <Text style={styles.roomTileText}>
                          {roomInitials(pod)}
                        </Text>
                      </View>
                      <View style={styles.roomText}>
                        <Text style={styles.roomTitle} numberOfLines={1}>
                          {pod.title?.trim() || pod.interestLabel}
                        </Text>
                        <Text style={styles.roomAlias} numberOfLines={1}>
                          as {pod.myAlias}
                          {pod.myStatus ? ` · ${pod.myStatus}` : ''}
                        </Text>
                      </View>
                      {unread > 0 ? <Badge n={unread} /> : null}
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`More for ${
                        pod.title?.trim() || pod.interestLabel
                      }`}
                      accessibilityState={{ expanded: open }}
                      onPress={() => setManageId(open ? null : pod.podId)}
                      style={styles.moreBtn}
                    >
                      <Ionicons
                        name={open ? 'chevron-up' : 'ellipsis-horizontal'}
                        size={20}
                        color={PIECES.ink}
                      />
                    </Pressable>
                  </View>

                  {open ? (
                    <View style={styles.manage}>
                      <View style={styles.tagRow}>
                        <Text style={styles.tag}>
                          {pod.governanceMode === 'ADMIN'
                            ? `Admin run · ${
                                pod.isPublicized ? 'listed' : 'private'
                              }`
                            : 'Votes decide'}
                        </Text>
                        <Text style={styles.tag}>
                          {capacityTierBadge(pod.memberCount, pod.maxMembers)}
                        </Text>
                        {pod.openProposalsCount > 0 ? (
                          <Text style={styles.tag}>
                            {pod.openProposalsCount} open vote
                            {pod.openProposalsCount === 1 ? '' : 's'}
                          </Text>
                        ) : null}
                        {voiceCount > 0 ? (
                          <Text style={styles.tag}>{voiceCount} in the call</Text>
                        ) : null}
                      </View>
                      {pod.description?.trim() ? (
                        <Text style={styles.muted}>{pod.description}</Text>
                      ) : null}

                      {isEditingStatus ? (
                        <View style={styles.statusEditorRow}>
                          <TextInput
                            value={statusDraft}
                            onChangeText={setStatusDraft}
                            placeholder="What are you up to?"
                            placeholderTextColor={PIECES.muted}
                            maxLength={80}
                            accessibilityLabel="Your status in this room"
                            style={[fieldStyles.input, styles.flex]}
                          />
                          <Btn
                            label="Save"
                            kind="blue"
                            onPress={() =>
                              statusMutation.mutate({
                                podId: pod.podId,
                                status: statusDraft.trim(),
                              })
                            }
                          />
                        </View>
                      ) : null}

                      <View style={styles.actionRow}>
                        <Btn
                          label={pod.myStatus ? 'Change status' : 'Set status'}
                          kind="white"
                          icon="pricetag-outline"
                          onPress={() => {
                            if (isEditingStatus) {
                              setEditingStatusPodId(null);
                            } else {
                              setEditingStatusPodId(pod.podId);
                              setStatusDraft(pod.myStatus || '');
                            }
                          }}
                        />
                        <Btn
                          label="Invite"
                          kind="white"
                          icon="share-social-outline"
                          onPress={() => setShareModalPod(pod)}
                          a11yLabel={`Invite people to ${
                            pod.title?.trim() || pod.interestLabel
                          }`}
                        />
                      </View>
                      <View style={styles.actionRow}>
                        <Btn
                          label="Another one"
                          kind="white"
                          a11yLabel={`Join another ${pod.interestLabel} room`}
                          disabled={joinSingleInterestMutation.isPending}
                          onPress={() =>
                            joinSingleInterestMutation.mutate(pod.interestSlug)
                          }
                        />
                        <Btn
                          label="Switch"
                          kind="white"
                          icon="shuffle"
                          a11yLabel={`Switch ${
                            pod.title?.trim() || pod.interestLabel
                          } for a new room`}
                          disabled={leaveOrSwitchMutation.isPending}
                          onPress={() =>
                            leaveOrSwitchMutation.mutate({
                              podId: pod.podId,
                              rematch: true,
                            })
                          }
                        />
                        <Btn
                          label="Leave"
                          kind="off"
                          a11yLabel={`Leave ${
                            pod.title?.trim() || pod.interestLabel
                          }`}
                          disabled={leaveOrSwitchMutation.isPending}
                          onPress={() =>
                            leaveOrSwitchMutation.mutate({
                              podId: pod.podId,
                              rematch: false,
                            })
                          }
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </View>

        {/* Private chats in the room you are in */}
        {activePod && (activePod.dmConversations ?? []).length > 0 ? (
          <View style={styles.sheetCard}>
            <Text style={styles.h3}>Private chats</Text>
            {(activePod.dmConversations ?? []).map((dm) => {
              const unread =
                unreadDmMap[dmConvoKey(activePod.podId, dm.peerId)] ??
                dm.unreadCount ??
                0;
              return (
                <Pressable
                  key={dm.peerId}
                  accessibilityRole="button"
                  accessibilityLabel={`Private chat with ${dm.peerAlias}${
                    unread > 0 ? `, ${unread} unread` : ''
                  }`}
                  onPress={() => openPrivate(activePod, dm.peerId)}
                  style={styles.dmRow}
                >
                  <Piece alias={dm.peerAlias} size={44} />
                  <View style={styles.roomText}>
                    <Text style={styles.dmName} numberOfLines={1}>
                      {dm.peerAlias}
                    </Text>
                    <Text style={styles.muted} numberOfLines={1}>
                      {dm.lastSenderPeerId === activePod.myPeerId
                        ? 'You: '
                        : ''}
                      {dm.lastBody || 'Voice note'}
                    </Text>
                  </View>
                  {unread > 0 ? <Badge n={unread} /> : null}
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* Join with an invite */}
        <View style={styles.sheetCard}>
          <Text style={styles.h3}>Have an invite?</Text>
          <Text style={styles.muted}>
            Paste the link or code. You land in that room under a fresh alias.
          </Text>
          <View style={styles.inviteInputRow}>
            <TextInput
              value={inviteRawInput}
              onChangeText={(val) => {
                setInviteRawInput(val);
                if (inviteError) setInviteError(null);
              }}
              placeholder="Link or code"
              placeholderTextColor={PIECES.muted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={handleJoinByInvite}
              accessibilityLabel="Invite link or code"
              style={[fieldStyles.input, styles.flex]}
            />
            <Btn
              label="Join"
              kind="blue"
              loading={acceptInviteMutation.isPending}
              onPress={handleJoinByInvite}
              a11yLabel="Join with this invite"
              style={{ minHeight: 56, borderRadius: 28 }}
            />
          </View>
          {inviteError ? (
            <View style={styles.errorBanner} accessibilityRole="alert">
              <Text style={styles.bannerText}>{inviteError}</Text>
            </View>
          ) : null}
        </View>

        <Btn
          label="Join another room"
          kind="blue"
          big
          wide
          onPress={() => setJoinOpen(true)}
        />
      </ScrollView>

      {/* Pick up a hobby */}
      <Sheet
        visible={joinOpen}
        title="Pick up a hobby"
        lead="You get a seat in a room of people who picked the same one, and an alias to sit under."
        onClose={() => setJoinOpen(false)}
        footer={
          discoveryTab === 'match' ? (
            <Btn
              label={
                selectedSlugs.length > 0
                  ? `Join ${selectedSlugs.length} ${
                      selectedSlugs.length === 1 ? 'room' : 'rooms'
                    }`
                  : 'Pick a hobby first'
              }
              kind="blue"
              big
              wide
              disabled={selectedSlugs.length === 0}
              loading={matchSelectedMutation.isPending}
              onPress={() => matchSelectedMutation.mutate(selectedSlugs)}
            />
          ) : null
        }
      >
        <View style={styles.segRow}>
          {(
            [
              { key: 'match', label: 'Find a room' },
              { key: 'publicized', label: 'Listed groups' },
              { key: 'create', label: 'Make a group' },
            ] as const
          ).map((seg) => (
            <Chip
              key={seg.key}
              label={seg.label}
              active={discoveryTab === seg.key}
              onPress={() => {
                setDiscoveryTab(seg.key);
                setErrorBanner(null);
              }}
            />
          ))}
        </View>

        {discoveryTab === 'match' ? (
          <>
            <View style={styles.controlBlock}>
              <Text style={fieldStyles.label}>Room size</Text>
              <View style={styles.chipWrap}>
                {SIZE_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.label}
                    label={opt.label}
                    active={selectedSize === opt.value}
                    onPress={() => setSelectedSize(opt.value)}
                  />
                ))}
              </View>
            </View>

            <View style={styles.controlBlock}>
              <Text style={fieldStyles.label}>Which room</Text>
              <View style={styles.chipWrap}>
                <Chip
                  label="One with seats"
                  active={!forceNewPod}
                  onPress={() => setForceNewPod(false)}
                />
                <Chip
                  label="A fresh one"
                  active={forceNewPod}
                  onPress={() => setForceNewPod(true)}
                />
              </View>
            </View>

            <View style={styles.inviteInputRow}>
              <TextInput
                value={customInterest}
                onChangeText={setCustomInterest}
                placeholder="Your own hobby, like Bouldering"
                placeholderTextColor={PIECES.muted}
                onSubmitEditing={handleAddCustomInterest}
                accessibilityLabel="Your own hobby"
                style={[fieldStyles.input, styles.flex]}
              />
              <Btn
                label="Join"
                kind="ink"
                disabled={
                  !customInterest.trim() || joinSingleInterestMutation.isPending
                }
                onPress={handleAddCustomInterest}
                a11yLabel="Join a room for your own hobby"
                style={{ minHeight: 56, borderRadius: 28 }}
              />
            </View>

            <View style={styles.tileGrid}>
              {interests.map((item, index) => {
                const isChecked = selectedSlugs.includes(item.slug);
                return (
                  <View
                    key={item.slug}
                    style={[
                      styles.tile,
                      { backgroundColor: tileColor(index) },
                      isChecked && styles.tileOn,
                    ]}
                  >
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={item.label}
                      accessibilityState={{ checked: isChecked }}
                      onPress={() => toggleInterestSlug(item.slug)}
                      style={styles.tileSelect}
                    >
                      <Text style={styles.tileName}>{item.label}</Text>
                      <Text style={styles.tileStats}>
                        {item.activeMembers === 1
                          ? '1 person'
                          : `${item.activeMembers} people`}
                        {item.openPods > 0 ? `, ${item.openPods} open` : ''}
                      </Text>
                      {isChecked ? (
                        <View style={styles.tileCheck}>
                          <Ionicons name="checkmark" size={16} color={PIECES.sheet} />
                        </View>
                      ) : null}
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Join a ${item.label} room now`}
                      disabled={joinSingleInterestMutation.isPending}
                      onPress={() => joinSingleInterestMutation.mutate(item.slug)}
                      style={styles.tileJoin}
                    >
                      <Text style={styles.tileJoinText}>Join now</Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          </>
        ) : null}

        {discoveryTab === 'publicized' ? (
          <View style={styles.controlBlock}>
            <Text style={styles.muted}>
              Groups their founders listed for anyone to join. You still sit
              under a fresh alias.
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipWrapRow}
            >
              <Chip
                label="All hobbies"
                active={publicizedFilter === ''}
                onPress={() => setPublicizedFilter('')}
              />
              {interests.slice(0, 8).map((it) => (
                <Chip
                  key={it.slug}
                  label={it.label}
                  active={publicizedFilter === it.slug}
                  onPress={() => setPublicizedFilter(it.slug)}
                />
              ))}
            </ScrollView>

            {publicizedQuery.isLoading ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color={PIECES.ink} />
                <Text style={styles.muted}>Finding groups...</Text>
              </View>
            ) : publicizedGroups.length === 0 ? (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyTitle}>No listed groups yet</Text>
                <Text style={styles.muted}>
                  Be the first: make a group and list it.
                </Text>
              </View>
            ) : (
              publicizedGroups.map((grp, index) => {
                const isFull = grp.memberCount >= grp.maxMembers;
                return (
                  <View
                    key={grp.podId}
                    style={[styles.groupCard, { backgroundColor: tileColor(index + 3) }]}
                  >
                    <Text style={styles.tileName}>
                      {grp.title?.trim() ? grp.title : grp.interestLabel}
                    </Text>
                    <Text style={styles.tileStats}>
                      {grp.interestLabel} · {grp.memberCount} of {grp.maxMembers}{' '}
                      seats · founded by {grp.founderAlias}
                    </Text>
                    {grp.description?.trim() ? (
                      <Text style={styles.groupDesc}>{grp.description}</Text>
                    ) : null}
                    {grp.alreadyMember ? (
                      <Btn
                        label="You are in. Open chat"
                        kind="white"
                        onPress={() => {
                          setActivePodId(grp.podId);
                          setJoinOpen(false);
                          setActiveTab('chat');
                        }}
                      />
                    ) : (
                      <Btn
                        label={isFull ? 'No seats left' : 'Join this group'}
                        kind="ink"
                        disabled={isFull}
                        loading={joinPublicizedMutation.isPending}
                        onPress={() => {
                          joinPublicizedMutation.mutate(grp.podId);
                          setJoinOpen(false);
                        }}
                        a11yLabel={`Join ${grp.title || grp.interestLabel}`}
                      />
                    )}
                  </View>
                );
              })
            )}
          </View>
        ) : null}

        {discoveryTab === 'create' ? (
          !isPro ? (
            <View style={styles.controlBlock}>
              <Text style={styles.emptyTitle}>Make your own group</Text>
              <Text style={styles.muted}>
                Canopy Pro lets you open a 10, 25 or 50 seat group that you
                run. Keep it invite only, or list it for anyone to join. Every
                member still sits under an alias.
              </Text>
              <Btn
                label="Go Pro"
                kind="blue"
                big
                wide
                loading={upgradeProMutation.isPending}
                onPress={() => upgradeProMutation.mutate()}
                a11yLabel="Upgrade to Canopy Pro"
              />
            </View>
          ) : (
            <View style={styles.controlBlock}>
              <Text style={styles.muted}>
                You become the owner, with roster and visibility controls.
              </Text>

              <View style={styles.field}>
                <Text style={fieldStyles.label}>Name</Text>
                <TextInput
                  value={groupTitle}
                  onChangeText={setGroupTitle}
                  placeholder="Tactical Co-op Raiders"
                  placeholderTextColor={PIECES.muted}
                  accessibilityLabel="Group name"
                  style={fieldStyles.input}
                />
              </View>

              <View style={styles.field}>
                <Text style={fieldStyles.label}>Handle</Text>
                <TextInput
                  value={groupHandle}
                  onChangeText={setGroupHandle}
                  placeholder={
                    sanitizePodHandle('', groupTitle) || 'tactical-raiders'
                  }
                  placeholderTextColor={PIECES.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Group handle"
                  style={fieldStyles.input}
                />
              </View>

              <View style={styles.field}>
                <Text style={fieldStyles.label}>Hobby</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipWrapRow}
                >
                  {interests.slice(0, 8).map((it) => (
                    <Chip
                      key={it.slug}
                      label={it.label}
                      active={groupInterest === it.slug}
                      onPress={() => setGroupInterest(it.slug)}
                    />
                  ))}
                </ScrollView>
                <TextInput
                  value={groupInterest}
                  onChangeText={setGroupInterest}
                  placeholder="Or type one"
                  placeholderTextColor={PIECES.muted}
                  autoCapitalize="none"
                  accessibilityLabel="Hobby"
                  style={fieldStyles.input}
                />
              </View>

              <View style={styles.field}>
                <Text style={fieldStyles.label}>What it is about</Text>
                <TextInput
                  value={groupDescription}
                  onChangeText={setGroupDescription}
                  placeholder="Nightly runs, loadouts and voice."
                  placeholderTextColor={PIECES.muted}
                  multiline
                  accessibilityLabel="What the group is about"
                  style={fieldStyles.multi}
                />
              </View>

              <View style={styles.field}>
                <Text style={fieldStyles.label}>Seats</Text>
                <View style={styles.chipWrap}>
                  {CUSTOM_GROUP_SIZES.map((opt) => (
                    <Chip
                      key={opt.value}
                      label={opt.label}
                      active={groupMaxMembers === opt.value}
                      onPress={() => setGroupMaxMembers(opt.value)}
                    />
                  ))}
                </View>
              </View>

              <View style={styles.field}>
                <Text style={fieldStyles.label}>Who can find it</Text>
                <View style={styles.chipWrap}>
                  <Chip
                    label="Invite only"
                    active={!groupPublicized}
                    onPress={() => setGroupPublicized(false)}
                  />
                  <Chip
                    label="Listed"
                    active={groupPublicized}
                    onPress={() => setGroupPublicized(true)}
                  />
                </View>
              </View>

              <Btn
                label="Make the group"
                kind="blue"
                big
                wide
                disabled={!groupTitle.trim()}
                loading={createGroupMutation.isPending}
                onPress={() => {
                  createGroupMutation.mutate();
                  setJoinOpen(false);
                }}
                a11yLabel="Make the group"
              />
            </View>
          )
        ) : null}
      </Sheet>

      <InviteShareModal
        visible={!!shareModalPod}
        pod={shareModalPod}
        onClose={() => setShareModalPod(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PIECES.bg },
  flex: { flex: 1, minWidth: 0 },
  content: { padding: 12, gap: 12, paddingBottom: 24 },
  sheetCard: {
    backgroundColor: PIECES.sheet,
    borderRadius: 28,
    padding: 16,
    gap: 10,
  },
  h2: { fontSize: 24, lineHeight: 28, color: PIECES.ink, fontWeight: '600', paddingHorizontal: 4 },
  h3: { fontSize: 18, lineHeight: 22, color: PIECES.ink, fontWeight: '600', paddingHorizontal: 4 },
  muted: { fontSize: 14, lineHeight: 20, color: PIECES.muted },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8 },
  emptyBox: { gap: 6, padding: 6 },
  emptyTitle: { fontSize: 20, color: PIECES.ink, fontWeight: '600' },
  doneBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 18,
    backgroundColor: PIECE_HEX.mint,
    borderRadius: 22,
  },
  errorBanner: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    backgroundColor: PIECES.off,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 0,
  },
  bannerText: { flex: 1, fontSize: 15, fontWeight: '600', color: PIECES.ink, lineHeight: 21 },
  dismissHit: { width: TOUCH_MIN, height: TOUCH_MIN, alignItems: 'center', justifyContent: 'center' },
  roomWrap: { gap: 4 },
  roomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 26,
    paddingRight: 4,
  },
  roomMain: {
    flex: 1,
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingLeft: 8,
    paddingRight: 4,
  },
  roomTile: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  roomTileText: { fontSize: 19, color: PIECES.ink, fontFamily: 'Gabarito_500Medium' },
  roomText: { flex: 1, minWidth: 0 },
  roomTitle: { fontSize: 18, color: PIECES.ink, fontFamily: 'Gabarito_500Medium' },
  roomAlias: { fontSize: 14, color: PIECES.ink2, marginTop: 1 },
  moreBtn: { width: TOUCH_MIN, height: TOUCH_MIN, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  manage: {
    backgroundColor: PIECES.bg,
    borderRadius: 22,
    padding: 14,
    gap: 10,
    marginHorizontal: 4,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    fontSize: 12,
    color: PIECES.ink,
    fontFamily: MONO_FONT,
    backgroundColor: PIECES.sheet,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    overflow: 'hidden',
  },
  statusEditorRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dmRow: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, paddingHorizontal: 4 },
  dmName: { fontSize: 16, fontWeight: '600', color: PIECES.ink },
  inviteInputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  segRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  controlBlock: { gap: 10 },
  field: { gap: 8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipWrapRow: { flexDirection: 'row', gap: 8, paddingRight: 8 },
  tileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { width: '48%', flexGrow: 1, borderRadius: 24, overflow: 'hidden', minHeight: 132 },
  tileOn: { borderWidth: 3, borderColor: PIECES.ink },
  tileSelect: { flex: 1, minHeight: 84, padding: 14, gap: 4 },
  tileName: { fontSize: 18, lineHeight: 21, color: PIECES.ink, fontFamily: 'Gabarito_500Medium' },
  tileStats: { fontSize: 13, color: PIECES.ink, opacity: 0.8 },
  tileCheck: {
    position: 'absolute',
    right: 10,
    top: 10,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: PIECES.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileJoin: {
    minHeight: TOUCH_MIN,
    margin: 8,
    marginTop: 0,
    borderRadius: 22,
    backgroundColor: PIECES.glass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileJoinText: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  groupCard: { borderRadius: 24, padding: 16, gap: 8 },
  groupDesc: { fontSize: 15, lineHeight: 21, color: PIECES.ink },
});
