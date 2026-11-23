import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  adminKickMember,
  adminUpdateMemberRole,
  createChannel,
  createPodProposal,
  deletePodChannel,
  fetchPodProposals,
  resolveProposal,
  updatePodSettings,
  voteProposal,
} from '../api/client';
import type {
  ChannelKind,
  CreateProposalRequest,
  PodCapacityPreset,
  PodDetail,
  PodProposalDto,
} from '../types/canopy';
import {
  PALETTE,
  TOUCH_MIN,
  aliasInitials,
  capacityTierBadge,
  safePeerColor,
} from '../theme/palette';

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

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

function isProposalExpired(expiresAt: string): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  return !Number.isNaN(ts) && ts <= Date.now();
}

export interface PodGovernanceModalProps {
  visible: boolean;
  pod: PodDetail | null;
  onClose: () => void;
}

type DemocraticTab = 'votes' | 'propose' | 'roster';
type AdminTab = 'settings' | 'roster' | 'channels';

export function PodGovernanceModal({
  visible,
  pod,
  onClose,
}: PodGovernanceModalProps) {
  const queryClient = useQueryClient();
  const [demTab, setDemTab] = useState<DemocraticTab>('votes');
  const [adminTab, setAdminTab] = useState<AdminTab>('settings');

  const [bannerMsg, setBannerMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Shared / Democratic proposal inputs
  const [reasonDraft, setReasonDraft] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [propChannelLabel, setPropChannelLabel] = useState('');
  const [propChannelTopic, setPropChannelTopic] = useState('');
  const [propChannelKind, setPropChannelKind] = useState<ChannelKind>('TEXT');
  const [propCapacity, setPropCapacity] = useState<PodCapacityPreset>(25);

  // Admin group settings & channel creator inputs
  const [adminTitle, setAdminTitle] = useState('');
  const [adminDesc, setAdminDesc] = useState('');
  const [adminCapacity, setAdminCapacity] = useState<PodCapacityPreset>(25);
  const [adminPublicized, setAdminPublicized] = useState(false);
  const [adminChLabel, setAdminChLabel] = useState('');
  const [adminChTopic, setAdminChTopic] = useState('');
  const [adminChKind, setAdminChKind] = useState<ChannelKind>('TEXT');

  const podId = pod?.podId ?? '';
  const isAdminPod = pod?.governanceMode === 'ADMIN';
  const canAdminManage =
    isAdminPod && (pod?.myRole === 'OWNER' || pod?.myRole === 'ADMIN');

  useEffect(() => {
    if (!visible || !pod) return;
    setBannerMsg(null);
    setErrorMsg(null);
    setRenameDraft(pod.title || '');
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

  const patchPodInCache = (updatedPod: PodDetail | null | undefined) => {
    if (!updatedPod) return;
    queryClient.setQueryData(
      ['pods'],
      (old: { pods: PodDetail[] } | undefined) =>
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

  const createProposalMutation = useMutation({
    mutationFn: (payload: CreateProposalRequest) =>
      createPodProposal(podId, payload),
    onSuccess: (res) => {
      setErrorMsg(null);
      patchPodInCache(res.pod);
      upsertProposalInCache(res.proposal);
      queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
      queryClient.invalidateQueries({ queryKey: ['messages', podId] });
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      setReasonDraft('');
      setPropChannelLabel('');
      setPropChannelTopic('');
      setDemTab('votes');
      setBannerMsg(
        res.proposal.status === 'PASSED'
          ? `Vote passed & executed: ${res.proposal.title}`
          : `Opened pod vote: ${res.proposal.title}`
      );
    },
    onError: (err) => {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not create proposal.'
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
      queryClient.invalidateQueries({ queryKey: ['messages', podId] });
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
      setBannerMsg(`Finalized vote (${res.proposal.status}).`);
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
      setErrorMsg(err instanceof Error ? err.message : 'Kick failed.');
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

  const adminCreateChannelMutation = useMutation({
    mutationFn: () =>
      createChannel(podId, {
        label: adminChLabel.trim(),
        topic: adminChTopic.trim(),
        kind: adminChKind,
      }),
    onSuccess: () => {
      setErrorMsg(null);
      setAdminChLabel('');
      setAdminChTopic('');
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      setBannerMsg('Created channel.');
    },
    onError: (err) => {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not add channel.'
      );
    },
  });

  const adminDeleteChannelMutation = useMutation({
    mutationFn: (channelId: string) => deletePodChannel(podId, channelId),
    onSuccess: (res) => {
      setErrorMsg(null);
      patchPodInCache(res.pod);
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      setBannerMsg('Deleted channel.');
    },
    onError: (err) => {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not delete channel.'
      );
    },
  });

  if (!pod) return null;

  const proposals = proposalsQuery.data?.proposals ?? [];
  const openCount = proposals.filter((p) => p.status === 'OPEN').length;
  const displayPodTitle = pod.title?.trim() ? pod.title : `#${pod.code}`;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          {/* Charcoal Header */}
          <View style={styles.header}>
            <View style={styles.headerTextCol}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {isAdminPod
                  ? `👑 Manage · ${displayPodTitle}`
                  : `⚖️ Pod Votes · ${displayPodTitle}`}
              </Text>
              <Text style={styles.headerSub}>
                #{pod.code} · {pod.interestLabel} ·{' '}
                {capacityTierBadge(pod.memberCount, pod.maxMembers)}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close governance modal"
              onPress={onClose}
              style={styles.closeBtn}
            >
              <Ionicons name="close" size={22} color={PALETTE.card} />
            </Pressable>
          </View>

          {/* Segmented Sub-Tabs */}
          {isAdminPod ? (
            <View style={styles.tabsBar}>
              {(
                [
                  { key: 'settings', label: 'Settings' },
                  { key: 'roster', label: `Members (${pod.members.length})` },
                  { key: 'channels', label: `Channels (${pod.channels.length})` },
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
                  { key: 'propose', label: 'New Vote' },
                  { key: 'roster', label: `Kick / Roster (${pod.members.length})` },
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
                    ⚖️ 100% Democratic Peer-Blind Pod
                  </Text>
                  <Text style={styles.infoNoteBody}>
                    No single member has admin power. Every kick, channel edit,
                    rename, capacity change, or lock passes by YES vs NO vote.
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
                    color={PALETTE.charcoal}
                  />
                  <Text style={styles.mintCtaText}>+ Start a Pod Proposal</Text>
                </Pressable>

                {proposalsQuery.isLoading ? (
                  <View style={styles.centerPad}>
                    <ActivityIndicator color={PALETTE.forest} />
                  </View>
                ) : proposals.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <Text style={styles.emptyTitle}>No proposals yet</Text>
                    <Text style={styles.emptyBody}>
                      Tap New Vote above or Kick / Roster to open a YES vs NO
                      vote for this pod.
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
                          <Text style={styles.propKindTag}>{prop.kind}</Text>
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
                            Reason: {prop.reason}
                          </Text>
                        ) : null}

                        <View style={styles.tallyRow}>
                          <Text style={styles.yesCountText}>
                            YES: {prop.yesCount}
                          </Text>
                          <Text style={styles.eligibleText}>
                            {prop.eligibleCount} eligible · by{' '}
                            {prop.proposerAlias}
                          </Text>
                          <Text style={styles.noCountText}>
                            NO: {prop.noCount}
                          </Text>
                        </View>

                        {prop.yesAliases.length > 0 ? (
                          <Text style={styles.voterListText} numberOfLines={1}>
                            YES: {prop.yesAliases.join(', ')}
                          </Text>
                        ) : null}
                        {prop.noAliases.length > 0 ? (
                          <Text style={styles.voterListText} numberOfLines={1}>
                            NO: {prop.noAliases.join(', ')}
                          </Text>
                        ) : null}

                        {prop.status === 'OPEN' ? (
                          <View style={styles.voteActionRow}>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Vote YES on ${prop.title}`}
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
                                {prop.myVote === true ? '✓ Voted YES' : 'Vote YES'}{' '}
                                ({prop.yesCount})
                              </Text>
                            </Pressable>

                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Vote NO on ${prop.title}`}
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
                                {prop.myVote === false ? '✕ Voted NO' : 'Vote NO'}{' '}
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
                              Finalize Expired Vote
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
                  <Text style={styles.cardTitle}>Optional Vote Note</Text>
                  <TextInput
                    value={reasonDraft}
                    onChangeText={setReasonDraft}
                    placeholder="Reason shown on the YES/NO ballot..."
                    placeholderTextColor={PALETTE.muted}
                    style={styles.input}
                  />
                </View>

                {/* Vote to Add Channel */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Vote to Add Channel</Text>
                  <TextInput
                    value={propChannelLabel}
                    onChangeText={setPropChannelLabel}
                    placeholder="Channel name (e.g. clips-and-builds)"
                    placeholderTextColor={PALETTE.muted}
                    autoCapitalize="none"
                    style={styles.input}
                  />
                  <TextInput
                    value={propChannelTopic}
                    onChangeText={setPropChannelTopic}
                    placeholder="Optional topic..."
                    placeholderTextColor={PALETTE.muted}
                    style={styles.input}
                  />
                  <View style={styles.rowGap}>
                    {(['TEXT', 'VOICE'] as const).map((k) => {
                      const active = propChannelKind === k;
                      return (
                        <Pressable
                          key={k}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          onPress={() => setPropChannelKind(k)}
                          style={[styles.chipBtn, active && styles.chipActive]}
                        >
                          <Text
                            style={[
                              styles.chipText,
                              active && styles.chipTextActive,
                            ]}
                          >
                            {k === 'TEXT' ? '# Text Channel' : '🔊 Voice Lounge'}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    disabled={
                      !propChannelLabel.trim() ||
                      createProposalMutation.isPending
                    }
                    onPress={() =>
                      createProposalMutation.mutate({
                        kind: 'ADD_CHANNEL',
                        label: propChannelLabel.trim(),
                        topic: propChannelTopic.trim(),
                        channelKind: propChannelKind,
                        reason: reasonDraft.trim(),
                      })
                    }
                    style={[
                      styles.mintCtaBtn,
                      !propChannelLabel.trim() && styles.disabledBtn,
                    ]}
                  >
                    <Text style={styles.mintCtaText}>Vote to Add Channel</Text>
                  </Pressable>
                </View>

                {/* Vote to Remove Channel */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Vote to Remove Channel</Text>
                  {pod.channels.filter((c) => c.slug !== 'general').length ===
                  0 ? (
                    <Text style={styles.helperText}>
                      Only #general exists (protected).
                    </Text>
                  ) : (
                    pod.channels
                      .filter((c) => c.slug !== 'general')
                      .map((ch) => (
                        <View key={ch.channelId} style={styles.listItemRow}>
                          <Text style={styles.listItemLabel}>
                            {ch.kind === 'VOICE' ? `🔊 ${ch.label}` : `#${ch.slug}`}
                          </Text>
                          <Pressable
                            accessibilityRole="button"
                            disabled={createProposalMutation.isPending}
                            onPress={() =>
                              createProposalMutation.mutate({
                                kind: 'REMOVE_CHANNEL',
                                channelId: ch.channelId,
                                label: ch.label,
                                reason: reasonDraft.trim(),
                              })
                            }
                            style={styles.dangerSmBtn}
                          >
                            <Text style={styles.dangerSmText}>Vote Remove</Text>
                          </Pressable>
                        </View>
                      ))
                  )}
                </View>

                {/* Vote to Rename Pod */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Vote to Rename Pod</Text>
                  <TextInput
                    value={renameDraft}
                    onChangeText={setRenameDraft}
                    placeholder="New pod display title..."
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
                    <Text style={styles.mintCtaText}>Vote to Rename Pod</Text>
                  </Pressable>
                </View>

                {/* Vote to Change Capacity */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    Vote to Change Capacity (10 / 25 / 50)
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
                      Vote Capacity {'->'} {propCapacity} Seats
                    </Text>
                  </Pressable>
                </View>

                {/* Vote to Lock / Unlock Pod */}
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    Vote to Lock / Unlock Random Matching
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
                        🔒 Vote to Lock
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
                      <Text style={styles.mintCtaText}>🔓 Vote to Unlock</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            ) : null}

            {!isAdminPod && demTab === 'roster' ? (
              <View style={styles.sectionStack}>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    Blind Pod Roster · Vote to Kick
                  </Text>
                  <Text style={styles.helperText}>
                    Peers only appear by their room-scoped animal alias. Kicking
                    requires a democratic YES vs NO majority.
                  </Text>
                  <TextInput
                    value={reasonDraft}
                    onChangeText={setReasonDraft}
                    placeholder="Kick reason (e.g. audio spam)..."
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
                          {m.online ? '● Online' : '○ Offline'}
                          {m.customStatus ? ` · ${m.customStatus}` : ''}
                        </Text>
                      </View>
                      {!isSelf ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Vote to kick ${m.alias}`}
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
                          <Text style={styles.dangerSmText}>Vote to Kick</Text>
                        </Pressable>
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
                    👑 Admin Group · Your Role: {pod.myRole}
                  </Text>
                  <Text style={styles.infoNoteBody}>
                    Visibility:{' '}
                    {pod.isPublicized
                      ? 'Publicized in Directory'
                      : 'Private (Invite Only)'}{' '}
                    · Every member remains 100% peer-blind.
                  </Text>
                </View>

                {canAdminManage ? (
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>Edit Group Settings</Text>
                    <Text style={styles.fieldLabel}>Group Title</Text>
                    <TextInput
                      value={adminTitle}
                      onChangeText={setAdminTitle}
                      placeholder="e.g. Tactical Co-op Raiders"
                      placeholderTextColor={PALETTE.muted}
                      style={styles.input}
                    />

                    <Text style={styles.fieldLabel}>Description</Text>
                    <TextInput
                      value={adminDesc}
                      onChangeText={setAdminDesc}
                      placeholder="What happens in this group..."
                      placeholderTextColor={PALETTE.muted}
                      multiline
                      style={styles.input}
                    />

                    <Text style={styles.fieldLabel}>Capacity Preset</Text>
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

                    <Text style={styles.fieldLabel}>Group Visibility</Text>
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
                          🔒 Private
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
                          color={PALETTE.charcoal}
                        />
                      ) : (
                        <Text style={styles.mintCtaText}>
                          Save Group Settings
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
                      Only the Group Owner and Co-Admins can modify settings,
                      channels, or member roles.
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
                            {role} · {m.online ? '● Online' : '○ Offline'}
                          </Text>
                        </View>
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
                                ? 'Set Member'
                                : 'Make Co-Admin'}
                            </Text>
                          </Pressable>

                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Kick ${m.alias}`}
                            disabled={adminKickMutation.isPending}
                            onPress={() => adminKickMutation.mutate(m.peerId)}
                            style={styles.dangerSmBtn}
                          >
                            <Text style={styles.dangerSmText}>Kick</Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ) : null}

            {isAdminPod && adminTab === 'channels' ? (
              <View style={styles.sectionStack}>
                {canAdminManage ? (
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>Add Channel</Text>
                    <TextInput
                      value={adminChLabel}
                      onChangeText={setAdminChLabel}
                      placeholder="Channel label (e.g. raid-notes)"
                      placeholderTextColor={PALETTE.muted}
                      autoCapitalize="none"
                      style={styles.input}
                    />
                    <TextInput
                      value={adminChTopic}
                      onChangeText={setAdminChTopic}
                      placeholder="Optional topic..."
                      placeholderTextColor={PALETTE.muted}
                      style={styles.input}
                    />
                    <View style={styles.rowGap}>
                      {(['TEXT', 'VOICE'] as const).map((k) => {
                        const active = adminChKind === k;
                        return (
                          <Pressable
                            key={k}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            onPress={() => setAdminChKind(k)}
                            style={[
                              styles.chipFlexBtn,
                              active && styles.chipActive,
                            ]}
                          >
                            <Text
                              style={[
                                styles.chipText,
                                active && styles.chipTextActive,
                              ]}
                            >
                              {k === 'TEXT' ? '# Text' : '🔊 Voice'}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      disabled={
                        !adminChLabel.trim() ||
                        adminCreateChannelMutation.isPending
                      }
                      onPress={() => adminCreateChannelMutation.mutate()}
                      style={[
                        styles.mintCtaBtn,
                        !adminChLabel.trim() && styles.disabledBtn,
                      ]}
                    >
                      <Text style={styles.mintCtaText}>+ Create Channel</Text>
                    </Pressable>
                  </View>
                ) : null}

                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Group Channels</Text>
                  {pod.channels.map((ch) => (
                    <View key={ch.channelId} style={styles.listItemRow}>
                      <View style={styles.memberInfoCol}>
                        <Text style={styles.listItemLabel}>
                          {ch.kind === 'VOICE'
                            ? `🔊 ${ch.label}`
                            : `#${ch.slug}`}
                        </Text>
                        {ch.topic ? (
                          <Text style={styles.helperText}>{ch.topic}</Text>
                        ) : null}
                      </View>
                      {canAdminManage && ch.slug !== 'general' ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Delete channel ${ch.label}`}
                          disabled={adminDeleteChannelMutation.isPending}
                          onPress={() =>
                            adminDeleteChannelMutation.mutate(ch.channelId)
                          }
                          style={styles.dangerSmBtn}
                        >
                          <Text style={styles.dangerSmText}>Delete</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
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
    fontSize: 16,
    fontWeight: '700',
  },
  headerSub: {
    color: PALETTE.mint,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: MONO_FONT,
  },
  closeBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2a2d2a',
  },
  tabsBar: {
    flexDirection: 'row',
    backgroundColor: PALETTE.card,
    padding: 6,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: PALETTE.border,
  },
  tabBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  tabBtnActive: {
    backgroundColor: PALETTE.charcoal,
  },
  tabBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  tabBtnTextActive: {
    color: PALETTE.mint,
  },
  content: {
    padding: 14,
    gap: 12,
    paddingBottom: 32,
  },
  sectionStack: {
    gap: 12,
  },
  mintBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    borderRadius: 12,
    padding: 10,
  },
  mintBannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.forest,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: PALETTE.dangerSoft,
    borderRadius: 12,
    padding: 10,
  },
  errorBannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.danger,
  },
  infoNote: {
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    borderRadius: 14,
    padding: 12,
    gap: 4,
  },
  infoNoteTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  infoNoteBody: {
    fontSize: 12,
    lineHeight: 18,
    color: PALETTE.ink,
  },
  card: {
    backgroundColor: PALETTE.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: PALETTE.border,
    padding: 14,
    gap: 10,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  helperText: {
    fontSize: 12,
    lineHeight: 17,
    color: PALETTE.muted,
  },
  input: {
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: PALETTE.ink,
  },
  rowGap: {
    flexDirection: 'row',
    gap: 8,
  },
  rowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chipBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipFlexBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: PALETTE.mint,
    borderColor: PALETTE.forest,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.ink,
  },
  chipTextActive: {
    color: PALETTE.charcoal,
    fontWeight: '700',
  },
  mintCtaBtn: {
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
    borderColor: PALETTE.forest,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
  },
  mintFlexBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  mintCtaText: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  secondaryBtn: {
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  secondaryFlexBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  disabledBtn: {
    opacity: 0.45,
  },
  centerPad: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  emptyCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    gap: 4,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  emptyBody: {
    fontSize: 13,
    color: PALETTE.muted,
    textAlign: 'center',
    lineHeight: 18,
  },
  proposalCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    gap: 8,
  },
  propHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  propKindTag: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusOpen: {
    backgroundColor: PALETTE.mintSoft,
    borderColor: PALETTE.mintBorder,
  },
  statusPassed: {
    backgroundColor: PALETTE.mint,
    borderColor: PALETTE.forest,
  },
  statusRejected: {
    backgroundColor: PALETTE.dangerSoft,
    borderColor: '#f3c1bd',
  },
  statusPillText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: MONO_FONT,
  },
  statusTextOpen: {
    color: PALETTE.forest,
  },
  statusTextPassed: {
    color: PALETTE.charcoal,
  },
  statusTextRejected: {
    color: PALETTE.danger,
  },
  propTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  propReason: {
    fontSize: 13,
    color: PALETTE.muted,
  },
  tallyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  yesCountText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  eligibleText: {
    fontSize: 11,
    color: PALETTE.muted,
  },
  noCountText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.danger,
    fontFamily: MONO_FONT,
  },
  voterListText: {
    fontSize: 11,
    color: PALETTE.muted,
  },
  voteActionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  voteYesBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voteYesBtnActive: {
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
  },
  voteYesBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  voteNoBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voteNoBtnActive: {
    backgroundColor: PALETTE.dangerSoft,
    borderColor: PALETTE.danger,
    borderWidth: 1.5,
  },
  voteNoBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  voteNoBtnTextActive: {
    color: PALETTE.danger,
  },
  listItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: PALETTE.surfaceMuted,
  },
  listItemLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
    fontFamily: MONO_FONT,
  },
  dangerSmBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: PALETTE.dangerSoft,
    borderWidth: 1,
    borderColor: '#f3c1bd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerSmText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.danger,
  },
  memberCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: PALETTE.card,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  adminMemberCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: 10,
  },
  memberTopLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  memberAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberAvatarText: {
    color: PALETTE.card,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO_FONT,
  },
  memberInfoCol: {
    flex: 1,
    gap: 2,
  },
  memberAlias: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  memberMeta: {
    fontSize: 12,
    color: PALETTE.muted,
    fontFamily: MONO_FONT,
  },
});
