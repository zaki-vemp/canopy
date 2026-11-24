import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../theme/ui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSetAtom } from 'jotai';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  adminKickMember,
  adminUpdateMemberRole,
  createPodProposal,
  fetchPodProposals,
  resolveProposal,
  updatePodSettings,
  voteProposal,
} from '../api/client';
import {
  activeDmPeerByPodAtom,
  activePodIdAtom,
  activeTabAtom,
} from '../state/atoms';
import type {
  CreateProposalRequest,
  PodCapacityPreset,
  PodDetailDto,
  PodProposalDto,
} from '../types/canopy';
import {
  PALETTE,
  PIECES,
  pieceRadii,
  TOUCH_MIN,
  aliasInitials,
  capacityTierBadge,
  safePeerColor,
} from '../theme/palette';

const MONO_FONT = 'DMMono_500Medium';

const CAPACITY_PRESETS: ReadonlyArray<{
  value: PodCapacityPreset;
  label: string;
}> = [
  { value: 10, label: 'Compact (10)' },
  { value: 25, label: 'Standard (25)' },
  { value: 50, label: 'Club (50)' },
];

function normalizePreset(val: number): PodCapacityPreset {
  if (val <= 10) return 10;
  if (val <= 25) return 25;
  return 50;
}

const KIND_LABEL: Record<string, string> = {
  KICK_MEMBER: 'Remove someone',
  RENAME_POD: 'Rename',
  UPDATE_TOPIC: 'Topic',
  CHANGE_CAPACITY: 'Size',
  TOGGLE_LOCK: 'Lock',
  PIN_MESSAGE: 'Pin',
};

function isProposalExpired(expiresAt: string): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  return !Number.isNaN(ts) && ts <= Date.now();
}

export interface PodGovernanceModalProps {
  visible: boolean;
  pod: PodDetailDto | null;
  onClose: () => void;
  onOpenMemberDm?: (peerId: string) => void;
}

type DemocraticTab = 'votes' | 'propose' | 'roster';
type AdminTab = 'settings' | 'roster';

export function PodGovernanceModal({
  visible,
  pod,
  onClose,
  onOpenMemberDm,
}: PodGovernanceModalProps) {
  const queryClient = useQueryClient();
  const setActivePodId = useSetAtom(activePodIdAtom);
  const setActiveDmPeerMap = useSetAtom(activeDmPeerByPodAtom);
  const setActiveTab = useSetAtom(activeTabAtom);

  const [demTab, setDemTab] = useState<DemocraticTab>('votes');
  const [adminTab, setAdminTab] = useState<AdminTab>('settings');

  const [bannerMsg, setBannerMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Democratic proposal inputs
  const [reasonDraft, setReasonDraft] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [topicDraft, setTopicDraft] = useState('');
  const [propCapacity, setPropCapacity] = useState<PodCapacityPreset>(25);

  // Admin group settings inputs
  const [adminTitle, setAdminTitle] = useState('');
  const [adminDesc, setAdminDesc] = useState('');
  const [adminCapacity, setAdminCapacity] = useState<PodCapacityPreset>(25);
  const [adminPublicized, setAdminPublicized] = useState(false);

  const podId = pod?.podId ?? '';
  const isAdminPod = pod?.governanceMode === 'ADMIN';
  const canAdminManage =
    isAdminPod && (pod?.myRole === 'OWNER' || pod?.myRole === 'ADMIN');

  useEffect(() => {
    if (!visible || !pod) return;
    setBannerMsg(null);
    setErrorMsg(null);
    setRenameDraft(pod.title || '');
    setTopicDraft(pod.description || '');
    setPropCapacity(normalizePreset(pod.maxMembers));
    setAdminTitle(pod.title || '');
    setAdminDesc(pod.description || '');
    setAdminCapacity(normalizePreset(pod.maxMembers));
    setAdminPublicized(!!pod.isPublicized);
  }, [visible, pod?.podId]);

  const proposalsQuery = useQuery({
    queryKey: ['proposals', podId],
    queryFn: () => fetchPodProposals(podId),
    enabled: visible && !!podId && !isAdminPod,
  });

  const patchPodInCache = (updatedPod: PodDetailDto | null | undefined) => {
    if (!updatedPod) return;
    queryClient.setQueryData(
      ['pods'],
      (old: { pods: PodDetailDto[] } | undefined) =>
        old
          ? {
              pods: old.pods.map((p) =>
                p.podId === updatedPod.podId ? updatedPod : p
              ),
            }
          : old
    );
  };

  const upsertProposalInCache = (proposal: PodProposalDto) => {
    queryClient.setQueryData(
      ['proposals', podId],
      (old: { proposals: PodProposalDto[] } | undefined) => {
        if (!old) return { proposals: [proposal] };
        const exists = old.proposals.some((pr) => pr.id === proposal.id);
        return {
          proposals: exists
            ? old.proposals.map((pr) =>
                pr.id === proposal.id ? proposal : pr
              )
            : [proposal, ...old.proposals],
        };
      }
    );
  };

  const handleOpenDm = (peerId: string) => {
    if (!pod || peerId === pod.myPeerId) return;
    if (onOpenMemberDm) {
      onOpenMemberDm(peerId);
      return;
    }
    setActivePodId(pod.podId);
    setActiveDmPeerMap((prev) => ({ ...prev, [pod.podId]: peerId }));
    setActiveTab('chat');
    onClose();
  };

  const createProposalMutation = useMutation({
    mutationFn: (payload: CreateProposalRequest) =>
      createPodProposal(podId, payload),
    onSuccess: (res) => {
      setErrorMsg(null);
      patchPodInCache(res.pod);
      upsertProposalInCache(res.proposal);
      queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
      queryClient.invalidateQueries({ queryKey: ['messages', podId, 'group'] });
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      setReasonDraft('');
      setDemTab('votes');
      setBannerMsg(
        res.proposal.status === 'PASSED'
          ? `It passed: ${res.proposal.title}`
          : `Vote opened: ${res.proposal.title}`
      );
    },
    onError: (err) => {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not open that vote.'
      );
    },
  });

  const voteProposalMutation = useMutation({
    mutationFn: ({
      proposalId,
      vote,
    }: {
      proposalId: number;
      vote: boolean;
    }) => voteProposal(proposalId, vote),
    onSuccess: (res) => {
      setErrorMsg(null);
      upsertProposalInCache(res.proposal);
      if (res.pod) patchPodInCache(res.pod);
      queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
      queryClient.invalidateQueries({ queryKey: ['messages', podId, 'group'] });
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : 'Vote failed.');
    },
  });

  const resolveProposalMutation = useMutation({
    mutationFn: (proposalId: number) => resolveProposal(proposalId),
    onSuccess: (res) => {
      setErrorMsg(null);
      upsertProposalInCache(res.proposal);
      if (res.pod) patchPodInCache(res.pod);
      queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      setBannerMsg(`Vote closed: ${res.proposal.status === 'PASSED' ? 'it passed' : 'it did not pass'}.`);
    },
    onError: (err) => {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not finalize vote.'
      );
    },
  });

  const saveAdminSettingsMutation = useMutation({
    mutationFn: () =>
      updatePodSettings(podId, {
        title: adminTitle.trim(),
        description: adminDesc.trim(),
        maxMembers: adminCapacity,
        isPublicized: adminPublicized,
        isOpen: true,
      }),
    onSuccess: (res) => {
      setErrorMsg(null);
      patchPodInCache(res.pod);
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      queryClient.invalidateQueries({ queryKey: ['publicized-pods'] });
      setBannerMsg('Saved group settings.');
    },
    onError: (err) => {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not save settings.'
      );
    },
  });

  const adminKickMutation = useMutation({
    mutationFn: (targetPeerId: string) => adminKickMember(podId, targetPeerId),
    onSuccess: (res) => {
      setErrorMsg(null);
      patchPodInCache(res.pod);
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      setBannerMsg('Removed member from group.');
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : 'Could not remove them.');
    },
  });

  const adminRoleMutation = useMutation({
    mutationFn: ({
      targetPeerId,
      role,
    }: {
      targetPeerId: string;
      role: 'ADMIN' | 'MEMBER';
    }) => adminUpdateMemberRole(podId, targetPeerId, role),
    onSuccess: (res) => {
      setErrorMsg(null);
      patchPodInCache(res.pod);
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      setBannerMsg('Updated member role.');
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : 'Role update failed.');
    },
  });

  if (!pod) return null;

  const proposals = proposalsQuery.data?.proposals ?? [];
  const openCount = proposals.filter((p) => p.status === 'OPEN').length;
  const displayPodTitle = pod.title?.trim() ? pod.title : `#${pod.code}`;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable
          accessibilityLabel="Close"
          style={styles.backdropHit}
          onPress={onClose}
        />
        <View style={styles.safeArea}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <View style={styles.headerTextCol}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {isAdminPod
                  ? `Manage ${displayPodTitle}`
                  : `Votes in ${displayPodTitle}`}
              </Text>
              <Text style={styles.headerSub}>
                {pod.interestLabel} · {capacityTierBadge(pod.memberCount, pod.maxMembers)}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={styles.closeBtn}
            >
              <Ionicons name="close" size={22} color={PIECES.ink} />
            </Pressable>
          </View>

          {/* Segmented Sub-Tabs */}
          {isAdminPod ? (
            <View style={styles.tabsBar}>
              {(
                [
                  { key: 'settings', label: 'Settings' },
                  { key: 'roster', label: `People (${pod.members.length})` },
                ] as const
              ).map((t) => {
                const active = adminTab === t.key;
                return (
                  <Pressable
                    key={t.key}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    onPress={() => setAdminTab(t.key)}
                    style={[styles.tabBtn, active && styles.tabBtnActive]}
                  >
                    <Text
                      style={[
                        styles.tabBtnText,
                        active && styles.tabBtnTextActive,
                      ]}
                    >
                      {t.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <View style={styles.tabsBar}>
              {(
                [
                  {
                    key: 'votes',
                    label: `Votes (${
                      proposalsQuery.data ? openCount : pod.openProposalsCount
                    })`,
                  },
                  { key: 'propose', label: 'New vote' },
                  {
                    key: 'roster',
                    label: `People (${pod.members.length})`,
                  },
                ] as const
              ).map((t) => {
                const active = demTab === t.key;
                return (
                  <Pressable
                    key={t.key}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    onPress={() => setDemTab(t.key)}
                    style={[styles.tabBtn, active && styles.tabBtnActive]}
                  >
                    <Text
                      style={[
                        styles.tabBtnText,
                        active && styles.tabBtnTextActive,
                      ]}
                    >
                      {t.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
          >
            {bannerMsg ? (
              <View style={styles.mintBanner}>
                <Ionicons
                  name="checkmark-circle"
                  size={16}
                  color={PALETTE.forest}
                />
                <Text style={styles.mintBannerText}>{bannerMsg}</Text>
              </View>
            ) : null}

            {errorMsg ? (
              <View style={styles.errorBanner}>
                <Ionicons
                  name="alert-circle"
                  size={16}
                  color={PALETTE.danger}
                />
                <Text style={styles.errorBannerText}>{errorMsg}</Text>
              </View>
            ) : null}

            {/* ================= DEMOCRATIC POD VIEWS ================= */}
            {!isAdminPod && demTab === 'votes' ? (
              <View style={styles.sectionStack}>
                <View style={styles.infoNote}>
                  <Text style={styles.infoNoteTitle}>
                    Votes decide here
                  </Text>
                  <Text style={styles.infoNoteBody}>
                    Nobody runs this room. Removing someone, renaming, changing the
                    topic or size, or locking it all pass when Yes beats No.
                  </Text>
                </View>

                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDemTab('propose')}
                  style={styles.mintCtaBtn}
                >
                  <Ionicons
                    name="add-circle-outline"
                    size={18}
                    color={PIECES.sheet}
                  />
                  <Text style={styles.mintCtaText}>Start a vote</Text>
                </Pressable>

                {proposalsQuery.isLoading ? (
                  <View style={styles.centerPad}>
                    <ActivityIndicator color={PALETTE.forest} />
                  </View>
                ) : proposals.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <Text style={styles.emptyTitle}>No votes yet</Text>
                    <Text style={styles.emptyBody}>
                      Start one above, or open People to vote on someone.
                    </Text>
                  </View>
                ) : (
                  proposals.map((prop) => {
                    const expired =
                      prop.status === 'OPEN' &&
                      isProposalExpired(prop.expiresAt);
                    return (
                      <View key={prop.id} style={styles.proposalCard}>
                        <View style={styles.propHeaderRow}>
                          <Text style={styles.propKindTag}>{KIND_LABEL[prop.kind] ?? prop.kind}</Text>
                          <View
                            style={[
                              styles.statusPill,
                              prop.status === 'PASSED'
                                ? styles.statusPassed
                                : prop.status === 'REJECTED'
                                ? styles.statusRejected
                                : styles.statusOpen,
                            ]}
                          >
                            <Text
                              style={[
                                styles.statusPillText,
                                prop.status === 'PASSED'
                                  ? styles.statusTextPassed
                                  : prop.status === 'REJECTED'
                                  ? styles.statusTextRejected
                                  : styles.statusTextOpen,
                              ]}
                            >
                              {prop.status}
                            </Text>
                          </View>
                        </View>

                        <Text style={styles.propTitle}>{prop.title}</Text>
                        {prop.reason ? (
                          <Text style={styles.propReason}>
                            Why: {prop.reason}
                          </Text>
                        ) : null}

                        <View style={styles.tallyRow}>
                          <Text style={styles.yesCountText}>
                            Yes: {prop.yesCount}
                          </Text>
                          <Text style={styles.eligibleText}>
                            {prop.eligibleCount} eligible · by{' '}
                            {prop.proposerAlias}
                          </Text>
                          <Text style={styles.noCountText}>
                            No: {prop.noCount}
                          </Text>
                        </View>

                        {prop.yesAliases.length > 0 ? (
                          <Text style={styles.voterListText} numberOfLines={1}>
                            Yes: {prop.yesAliases.join(', ')}
                          </Text>
                        ) : null}
                        {prop.noAliases.length > 0 ? (
                          <Text style={styles.voterListText} numberOfLines={1}>
                            No: {prop.noAliases.join(', ')}
                          </Text>
                        ) : null}

                        {prop.status === 'OPEN' ? (
                          <View style={styles.voteActionRow}>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Vote Yes on ${prop.title}`}
                              disabled={voteProposalMutation.isPending}
                              onPress={() =>
                                voteProposalMutation.mutate({
                                  proposalId: prop.id,
                                  vote: true,
                                })
                              }
                              style={[
                                styles.voteYesBtn,
                                prop.myVote === true && styles.voteYesBtnActive,
                              ]}
                            >
                              <Text style={styles.voteYesBtnText}>
                                {prop.myVote === true
                                  ? 'Voted Yes'
                                  : 'Vote Yes'}{' '}
                                ({prop.yesCount})
                              </Text>
                            </Pressable>

                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Vote No on ${prop.title}`}
                              disabled={voteProposalMutation.isPending}
                              onPress={() =>
                                voteProposalMutation.mutate({
                                  proposalId: prop.id,
                                  vote: false,
                                })
                              }
                              style={[
                                styles.voteNoBtn,
                                prop.myVote === false && styles.voteNoBtnActive,
                              ]}
                            >
                              <Text
                                style={[
                                  styles.voteNoBtnText,
                                  prop.myVote === false &&
                                    styles.voteNoBtnTextActive,
                                ]}
                              >
                                {prop.myVote === false
                                  ? 'Voted No'
                                  : 'Vote No'}{' '}
                                ({prop.noCount})
                              </Text>
                            </Pressable>
                          </View>
                        ) : null}

                        {expired ? (
                          <Pressable
                            accessibilityRole="button"
                            disabled={resolveProposalMutation.isPending}
                            onPress={() =>
                              resolveProposalMutation.mutate(prop.id)
                            }
                            style={styles.secondaryBtn}
                          >
                            <Text style={styles.secondaryBtnText}>
                              Close the expired vote
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>
                    );
                  })
                )}
              </View>
            ) : null}

            {!isAdminPod && demTab === 'propose' ? (
              <View style={styles.sectionStack}>
                {/* Optional Reason */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>A note for the vote</Text>
                  <TextInput
                    value={reasonDraft}
                    onChangeText={setReasonDraft}
                    placeholder="Why, shown on the vote"
                    placeholderTextColor={PALETTE.muted}
                    style={styles.input}
                  />
                </View>

                {/* Rename the room */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Rename the room</Text>
                  <TextInput
                    value={renameDraft}
                    onChangeText={setRenameDraft}
                    placeholder="New name"
                    placeholderTextColor={PALETTE.muted}
                    style={styles.input}
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={
                      !renameDraft.trim() || createProposalMutation.isPending
                    }
                    onPress={() =>
                      createProposalMutation.mutate({
                        kind: 'RENAME_POD',
                        label: renameDraft.trim(),
                        reason: reasonDraft.trim(),
                      })
                    }
                    style={[
                      styles.mintCtaBtn,
                      !renameDraft.trim() && styles.disabledBtn,
                    ]}
                  >
                    <Text style={styles.mintCtaText}>Rename the room</Text>
                  </Pressable>
                </View>

                {/* Change the topic */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    Change the topic
                  </Text>
                  <TextInput
                    value={topicDraft}
                    onChangeText={setTopicDraft}
                    placeholder="What the room is about"
                    placeholderTextColor={PALETTE.muted}
                    multiline
                    style={styles.input}
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={
                      !topicDraft.trim() || createProposalMutation.isPending
                    }
                    onPress={() =>
                      createProposalMutation.mutate({
                        kind: 'UPDATE_TOPIC',
                        topic: topicDraft.trim(),
                        reason: reasonDraft.trim(),
                      })
                    }
                    style={[
                      styles.mintCtaBtn,
                      !topicDraft.trim() && styles.disabledBtn,
                    ]}
                  >
                    <Text style={styles.mintCtaText}>Vote on the topic</Text>
                  </Pressable>
                </View>

                {/* Vote to Change Capacity */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    Change the size (10, 25 or 50)
                  </Text>
                  <View style={styles.rowWrap}>
                    {CAPACITY_PRESETS.map((preset) => {
                      const active = propCapacity === preset.value;
                      return (
                        <Pressable
                          key={preset.value}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          onPress={() => setPropCapacity(preset.value)}
                          style={[styles.chipBtn, active && styles.chipActive]}
                        >
                          <Text
                            style={[
                              styles.chipText,
                              active && styles.chipTextActive,
                            ]}
                          >
                            {preset.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    disabled={createProposalMutation.isPending}
                    onPress={() =>
                      createProposalMutation.mutate({
                        kind: 'CHANGE_CAPACITY',
                        maxMembers: propCapacity,
                        reason: reasonDraft.trim(),
                      })
                    }
                    style={styles.mintCtaBtn}
                  >
                    <Text style={styles.mintCtaText}>
                      Vote for {propCapacity} seats
                    </Text>
                  </Pressable>
                </View>

                {/* Vote to Lock / Unlock Pod */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    Lock or open the room to newcomers
                  </Text>
                  <View style={styles.rowGap}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={createProposalMutation.isPending}
                      onPress={() =>
                        createProposalMutation.mutate({
                          kind: 'TOGGLE_LOCK',
                          locked: true,
                          reason: reasonDraft.trim(),
                        })
                      }
                      style={styles.secondaryFlexBtn}
                    >
                      <Text style={styles.secondaryBtnText}>
                        Vote to lock
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      disabled={createProposalMutation.isPending}
                      onPress={() =>
                        createProposalMutation.mutate({
                          kind: 'TOGGLE_LOCK',
                          locked: false,
                          reason: reasonDraft.trim(),
                        })
                      }
                      style={styles.mintFlexBtn}
                    >
                      <Text style={styles.mintCtaText}>Vote to unlock</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            ) : null}

            {!isAdminPod && demTab === 'roster' ? (
              <View style={styles.sectionStack}>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    People
                  </Text>
                  <Text style={styles.helperText}>
                    Everyone appears only as their alias. Write privately, or open a vote to remove someone.
                  </Text>
                  <TextInput
                    value={reasonDraft}
                    onChangeText={setReasonDraft}
                    placeholder="Why, if you want to say"
                    placeholderTextColor={PALETTE.muted}
                    style={styles.input}
                  />
                </View>

                {pod.members.map((m) => {
                  const isSelf = m.peerId === pod.myPeerId;
                  const peerCol = safePeerColor(m.color, m.alias);
                  return (
                    <View key={m.peerId} style={styles.memberCard}>
                      <View
                        style={[
                          styles.memberAvatar,
                          { backgroundColor: peerCol },
                          pieceRadii(m.alias, 48),
                        ]}
                      >
                        <Text style={styles.memberAvatarText}>
                          {aliasInitials(m.alias)}
                        </Text>
                      </View>
                      <View style={styles.memberInfoCol}>
                        <Text style={styles.memberAlias}>
                          {m.alias}
                          {isSelf ? ' (You)' : ''}
                        </Text>
                        <Text style={styles.memberMeta}>
                          {m.online ? 'Online' : 'Away'}
                          {m.inVoice ? ' · in the call' : ''}
                          {m.customStatus ? ` · ${m.customStatus}` : ''}
                        </Text>
                      </View>
                      {!isSelf ? (
                        <View style={styles.memberActionRow}>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Write to ${m.alias} privately`}
                            onPress={() => handleOpenDm(m.peerId)}
                            style={styles.dmSmBtn}
                          >
                            <Ionicons
                              name="chatbubble-ellipses-outline"
                              size={15}
                              color={PIECES.sheet}
                            />
                            <Text style={styles.dmSmText}>Write</Text>
                          </Pressable>

                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Start a vote to remove ${m.alias}`}
                            disabled={createProposalMutation.isPending}
                            onPress={() =>
                              createProposalMutation.mutate({
                                kind: 'KICK_MEMBER',
                                targetPeerId: m.peerId,
                                reason: reasonDraft.trim(),
                              })
                            }
                            style={styles.dangerSmBtn}
                          >
                            <Text style={styles.dangerSmText}>Vote to remove</Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ) : null}

            {/* ================= ADMIN POD VIEWS ================= */}
            {isAdminPod && adminTab === 'settings' ? (
              <View style={styles.sectionStack}>
                <View style={styles.infoNote}>
                  <Text style={styles.infoNoteTitle}>
                    Run by an admin. Your role: {pod.myRole}
                  </Text>
                  <Text style={styles.infoNoteBody}>
                    Visibility:{' '}
                    {pod.isPublicized
                      ? 'Listed for anyone to join'
                      : 'Invite only'}{' '}
                    · Everyone stays an alias.
                  </Text>
                </View>

                {canAdminManage ? (
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>Group settings</Text>
                    <Text style={styles.fieldLabel}>Name</Text>
                    <TextInput
                      value={adminTitle}
                      onChangeText={setAdminTitle}
                      placeholder="e.g. Tactical Co-op Raiders"
                      placeholderTextColor={PALETTE.muted}
                      style={styles.input}
                    />

                    <Text style={styles.fieldLabel}>What it is about</Text>
                    <TextInput
                      value={adminDesc}
                      onChangeText={setAdminDesc}
                      placeholder="What happens in this group..."
                      placeholderTextColor={PALETTE.muted}
                      multiline
                      style={styles.input}
                    />

                    <Text style={styles.fieldLabel}>Seats</Text>
                    <View style={styles.rowWrap}>
                      {CAPACITY_PRESETS.map((preset) => {
                        const active = adminCapacity === preset.value;
                        return (
                          <Pressable
                            key={preset.value}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            onPress={() => setAdminCapacity(preset.value)}
                            style={[
                              styles.chipBtn,
                              active && styles.chipActive,
                            ]}
                          >
                            <Text
                              style={[
                                styles.chipText,
                                active && styles.chipTextActive,
                              ]}
                            >
                              {preset.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    <Text style={styles.fieldLabel}>Who can find it</Text>
                    <View style={styles.rowGap}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: !adminPublicized }}
                        onPress={() => setAdminPublicized(false)}
                        style={[
                          styles.chipFlexBtn,
                          !adminPublicized && styles.chipActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.chipText,
                            !adminPublicized && styles.chipTextActive,
                          ]}
                        >
                          Invite only
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: adminPublicized }}
                        onPress={() => setAdminPublicized(true)}
                        style={[
                          styles.chipFlexBtn,
                          adminPublicized && styles.chipActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.chipText,
                            adminPublicized && styles.chipTextActive,
                          ]}
                        >
                          🌐 Publicized
                        </Text>
                      </Pressable>
                    </View>

                    <Pressable
                      accessibilityRole="button"
                      disabled={saveAdminSettingsMutation.isPending}
                      onPress={() => saveAdminSettingsMutation.mutate()}
                      style={styles.mintCtaBtn}
                    >
                      {saveAdminSettingsMutation.isPending ? (
                        <ActivityIndicator
                          size="small"
                          color={PIECES.sheet}
                        />
                      ) : (
                        <Text style={styles.mintCtaText}>
                          Save
                        </Text>
                      )}
                    </Pressable>
                  </View>
                ) : (
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>{displayPodTitle}</Text>
                    {pod.description ? (
                      <Text style={styles.helperText}>{pod.description}</Text>
                    ) : null}
                    <Text style={styles.helperText}>
                      Only the owner and co-admins can change group
                      settings or member roles.
                    </Text>
                  </View>
                )}
              </View>
            ) : null}

            {isAdminPod && adminTab === 'roster' ? (
              <View style={styles.sectionStack}>
                {pod.members.map((m) => {
                  const isSelf = m.peerId === pod.myPeerId;
                  const role = m.role ?? 'MEMBER';
                  const peerCol = safePeerColor(m.color, m.alias);
                  return (
                    <View key={m.peerId} style={styles.adminMemberCard}>
                      <View style={styles.memberTopLine}>
                        <View
                          style={[
                            styles.memberAvatar,
                            { backgroundColor: peerCol },
                          pieceRadii(m.alias, 48),
                          ]}
                        >
                          <Text style={styles.memberAvatarText}>
                            {aliasInitials(m.alias)}
                          </Text>
                        </View>
                        <View style={styles.memberInfoCol}>
                          <Text style={styles.memberAlias}>
                            {m.alias}
                            {isSelf ? ' (You)' : ''}
                          </Text>
                          <Text style={styles.memberMeta}>
                            {role} · {m.online ? 'Online' : 'Away'}
                            {m.inVoice ? ' · in the call' : ''}
                          </Text>
                        </View>
                        {!isSelf ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Write to ${m.alias} privately`}
                            onPress={() => handleOpenDm(m.peerId)}
                            style={styles.dmSmBtn}
                          >
                            <Ionicons
                              name="chatbubble-ellipses-outline"
                              size={15}
                              color={PIECES.sheet}
                            />
                            <Text style={styles.dmSmText}>Write</Text>
                          </Pressable>
                        ) : null}
                      </View>

                      {canAdminManage && !isSelf && role !== 'OWNER' ? (
                        <View style={styles.rowGap}>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Toggle Co-Admin for ${m.alias}`}
                            disabled={adminRoleMutation.isPending}
                            onPress={() =>
                              adminRoleMutation.mutate({
                                targetPeerId: m.peerId,
                                role: role === 'ADMIN' ? 'MEMBER' : 'ADMIN',
                              })
                            }
                            style={styles.secondaryFlexBtn}
                          >
                            <Text style={styles.secondaryBtnText}>
                              {role === 'ADMIN'
                                ? 'Make member'
                                : 'Make co-admin'}
                            </Text>
                          </Pressable>

                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${m.alias}`}
                            disabled={adminKickMutation.isPending}
                            onPress={() => adminKickMutation.mutate(m.peerId)}
                            style={styles.dangerSmBtn}
                          >
                            <Text style={styles.dangerSmText}>Remove</Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17, 17, 17, 0.45)', justifyContent: 'flex-end', alignItems: 'center' },
  backdropHit: { ...StyleSheet.absoluteFillObject },
  safeArea: { width: '100%', maxWidth: 640, maxHeight: '92%', minHeight: '60%', backgroundColor: PIECES.sheet, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden' },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 },
  headerTextCol: { flex: 1, gap: 2 },
  headerTitle: { fontSize: 26, lineHeight: 30, color: PIECES.ink, fontWeight: '600' },
  headerSub: { fontSize: 14, color: PIECES.muted, fontFamily: 'DMMono_500Medium' },
  closeBtn: { width: TOUCH_MIN, height: TOUCH_MIN, borderRadius: TOUCH_MIN / 2, backgroundColor: PIECES.bg, alignItems: 'center', justifyContent: 'center' },
  tabsBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, paddingVertical: 8 },
  tabBtn: { minHeight: TOUCH_MIN, paddingHorizontal: 16, borderRadius: 22, backgroundColor: PIECES.bg, alignItems: 'center', justifyContent: 'center' },
  tabBtnActive: { backgroundColor: PIECES.ink },
  tabBtnText: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  tabBtnTextActive: { color: PIECES.sheet },
  content: { padding: 20, paddingTop: 8, gap: 14, paddingBottom: 28 },
  sectionStack: { gap: 14 },
  mintBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 22, backgroundColor: '#9bddbb' },
  mintBannerText: { flex: 1, fontSize: 15, fontWeight: '600', color: PIECES.ink },
  errorBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 14, backgroundColor: PIECES.off, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderBottomRightRadius: 20, borderBottomLeftRadius: 0 },
  errorBannerText: { flex: 1, fontSize: 15, fontWeight: '600', color: PIECES.ink },
  infoNote: { backgroundColor: '#e8c7c9', borderRadius: 24, padding: 16, gap: 4 },
  infoNoteTitle: { fontSize: 20, color: PIECES.ink, fontWeight: '600' },
  infoNoteBody: { fontSize: 15, lineHeight: 21, color: PIECES.ink },
  card: { backgroundColor: PIECES.bg, borderRadius: 24, padding: 16, gap: 12 },
  cardTitle: { fontSize: 18, color: PIECES.ink, fontWeight: '600' },
  fieldLabel: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  helperText: { fontSize: 14, lineHeight: 20, color: PIECES.muted },
  input: { minHeight: 56, borderRadius: 28, backgroundColor: PIECES.sheet, paddingHorizontal: 22, paddingVertical: 12, fontSize: 16, color: PIECES.ink },
  rowGap: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipBtn: { minHeight: TOUCH_MIN, paddingHorizontal: 16, borderRadius: 22, backgroundColor: PIECES.sheet, alignItems: 'center', justifyContent: 'center' },
  chipFlexBtn: { flex: 1, minHeight: TOUCH_MIN, paddingHorizontal: 12, borderRadius: 22, backgroundColor: PIECES.sheet, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: PIECES.ink },
  chipText: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  chipTextActive: { color: PIECES.sheet },
  mintCtaBtn: { minHeight: 52, paddingHorizontal: 22, borderRadius: 26, backgroundColor: PIECES.blue, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  mintFlexBtn: { flex: 1, minHeight: 52, paddingHorizontal: 14, borderRadius: 26, backgroundColor: PIECES.blue, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  mintCtaText: { fontSize: 16, fontWeight: '600', color: PIECES.sheet },
  secondaryBtn: { minHeight: 52, paddingHorizontal: 22, borderRadius: 26, backgroundColor: PIECES.sheet, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  secondaryFlexBtn: { flex: 1, minHeight: 52, paddingHorizontal: 14, borderRadius: 26, backgroundColor: PIECES.sheet, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  secondaryBtnText: { fontSize: 16, fontWeight: '600', color: PIECES.ink },
  disabledBtn: { opacity: 0.45 },
  centerPad: { padding: 24, alignItems: 'center' },
  emptyCard: { backgroundColor: PIECES.bg, borderRadius: 24, padding: 18, gap: 6 },
  emptyTitle: { fontSize: 20, color: PIECES.ink, fontWeight: '600' },
  emptyBody: { fontSize: 15, lineHeight: 21, color: PIECES.muted },
  proposalCard: { backgroundColor: '#7396f2', borderRadius: 24, padding: 16, gap: 10 },
  propHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  propKindTag: { fontSize: 12, color: PIECES.ink, fontFamily: 'DMMono_500Medium' },
  statusPill: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: PIECES.glass },
  statusOpen: { backgroundColor: PIECES.glass },
  statusPassed: { backgroundColor: '#9bddbb' },
  statusRejected: { backgroundColor: PIECES.off },
  statusPillText: { fontSize: 13, fontWeight: '700', color: PIECES.ink },
  statusTextOpen: { color: PIECES.ink },
  statusTextPassed: { color: PIECES.ink },
  statusTextRejected: { color: PIECES.ink },
  propTitle: { fontSize: 22, lineHeight: 26, color: PIECES.ink, fontWeight: '600' },
  propReason: { fontSize: 14, color: PIECES.ink2 },
  tallyRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  yesCountText: { fontSize: 15, fontWeight: '700', color: PIECES.ink },
  eligibleText: { fontSize: 13, color: PIECES.ink2 },
  noCountText: { fontSize: 15, fontWeight: '700', color: PIECES.ink },
  voterListText: { fontSize: 13, color: PIECES.ink2 },
  voteActionRow: { flexDirection: 'row', gap: 8 },
  voteYesBtn: { flex: 1, minHeight: 52, borderRadius: 26, backgroundColor: PIECES.glass, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  voteYesBtnActive: { backgroundColor: PIECES.ink },
  voteYesBtnText: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  voteNoBtn: { flex: 1, minHeight: 52, borderRadius: 26, backgroundColor: PIECES.glass, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  voteNoBtnActive: { backgroundColor: PIECES.ink },
  voteNoBtnText: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  voteNoBtnTextActive: { color: PIECES.sheet },
  memberActionRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  dmSmBtn: { minHeight: TOUCH_MIN, paddingHorizontal: 16, borderRadius: 22, backgroundColor: PIECES.ink, alignItems: 'center', justifyContent: 'center' },
  dmSmText: { fontSize: 14, fontWeight: '600', color: PIECES.sheet },
  dangerSmBtn: { minHeight: TOUCH_MIN, paddingHorizontal: 16, borderRadius: 22, backgroundColor: PIECES.off, alignItems: 'center', justifyContent: 'center' },
  dangerSmText: { fontSize: 14, fontWeight: '600', color: PIECES.ink },
  memberCard: { backgroundColor: PIECES.bg, borderRadius: 24, padding: 14, gap: 10 },
  adminMemberCard: { backgroundColor: PIECES.bg, borderRadius: 24, padding: 14, gap: 10 },
  memberTopLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  memberAvatar: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  memberAvatarText: { fontSize: 16, color: PIECES.ink, fontFamily: 'Gabarito_500Medium' },
  memberInfoCol: { flex: 1, minWidth: 0 },
  memberAlias: { fontSize: 17, fontWeight: '600', color: PIECES.ink },
  memberMeta: { fontSize: 14, color: PIECES.muted },
});
