'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  Check,
  Crown,
  ExternalLink,
  Globe,
  Link2,
  Lock,
  LogOut,
  Plus,
  Radio,
  Scale,
  Settings,
  Share2,
  Shuffle,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { authRevisionAtom, selfUserAtom } from '@/state/authAtoms';
import {
  activePodIdAtom,
  adminSettingsPodIdAtom,
  interestModalOpenAtom,
  interestModalTabAtom,
  inviteModalPodIdAtom,
  presenceByPodAtom,
  voicePeersByPodAtom,
} from '@/state/workspaceAtoms';
import { useVoiceActions } from '@/state/voiceEngine';
import { safeAvatarColor } from '@/components/workspace/markdown';
import {
  extractInviteCode,
  getPodTierLabel,
  sanitizeCustomPodCode,
  type AcceptInviteResponse,
  type CreateCustomPodRequest,
  type InterestItem,
  type LeavePodRequest,
  type MatchRequest,
  type PodCapacityPreset,
  type PodDetail,
  type PublicizedPodDto,
  type SelfUser,
} from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

interface MatchResponse {
  matched: PodDetail[];
  pods: PodDetail[];
}

const CAPACITY_OPTIONS: Array<{
  value: PodCapacityPreset;
  label: string;
}> = [
  { value: null, label: 'Any Size' },
  { value: 10, label: 'Compact (10)' },
  { value: 25, label: 'Standard (25)' },
  { value: 50, label: 'Club (50)' },
];

export function InterestMatchModal({
  currentPods,
}: {
  currentPods: PodDetail[];
}) {
  const [open, setOpen] = useAtom(interestModalOpenAtom);
  const [tab, setTab] = useAtom(interestModalTabAtom);
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const setInviteModalPodId = useSetAtom(inviteModalPodIdAtom);
  const setAdminSettingsPodId = useSetAtom(adminSettingsPodIdAtom);
  const selfUser = useAtomValue(selfUserAtom);
  const authRevision = useAtomValue(authRevisionAtom);
  const bumpAuthRevision = useSetAtom(authRevisionAtom);
  const presenceByPod = useAtomValue(presenceByPodAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);
  const { session: voiceSession, leaveVoice } = useVoiceActions();
  const queryClient = useQueryClient();

  const [selectedSlugs, setSelectedSlugs] = useState<string[]>([]);
  const [customInput, setCustomInput] = useState('');
  const [customExtras, setCustomExtras] = useState<string[]>([]);
  const [selectedCapacity, setSelectedCapacity] =
    useState<PodCapacityPreset>(null);
  const [forceNewMode, setForceNewMode] = useState<boolean>(false);
  const [inviteInput, setInviteInput] = useState<string>('');
  const [initialized, setInitialized] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Publicized directory filter
  const [publicizedInterestFilter, setPublicizedInterestFilter] =
    useState<string>('');

  // Create Own Pod (Pro) form state
  const [customTitle, setCustomTitle] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [customCodeTouched, setCustomCodeTouched] = useState(false);
  const [customInterest, setCustomInterest] = useState('gaming');
  const [customDescription, setCustomDescription] = useState('');
  const [customSeats, setCustomSeats] = useState<10 | 25 | 50>(25);
  const [customIsPublicized, setCustomIsPublicized] = useState<boolean>(false);

  const interestsQuery = useQuery<{ interests: InterestItem[] }>({
    queryKey: ['interests'],
    queryFn: () => apiFetch<{ interests: InterestItem[] }>('/api/interests'),
    enabled: open,
  });

  const publicizedQuery = useQuery<{ groups: PublicizedPodDto[] }>({
    queryKey: ['publicized-pods', publicizedInterestFilter],
    queryFn: () =>
      apiFetch<{ groups: PublicizedPodDto[] }>(
        publicizedInterestFilter
          ? `/api/pods/publicized?interest=${encodeURIComponent(
              publicizedInterestFilter
            )}`
          : '/api/pods/publicized'
      ),
    enabled: open && tab === 'publicized',
  });

  useEffect(() => {
    if (!open) {
      setInitialized(false);
      setErrorMsg(null);
      return;
    }
    if (currentPods.length === 0 && tab === 'pods') {
      setTab('match');
    }
    if (interestsQuery.data && !initialized) {
      const list = interestsQuery.data.interests;
      const preselected = list.filter((i) => i.selected).map((i) => i.slug);
      setSelectedSlugs(preselected);
      if (list.length > 0) {
        setCustomInterest(preselected[0] || list[0].slug);
      }
      setInitialized(true);
    }
  }, [
    currentPods.length,
    initialized,
    interestsQuery.data,
    open,
    setTab,
    tab,
  ]);

  const activeCountBySlug = useMemo(() => {
    const map = new Map<string, number>();
    for (const pod of currentPods) {
      map.set(pod.interestSlug, (map.get(pod.interestSlug) || 0) + 1);
    }
    return map;
  }, [currentPods]);

  const groupedPods = useMemo(() => {
    const groups = new Map<
      string,
      { slug: string; label: string; pods: PodDetail[] }
    >();
    for (const pod of currentPods) {
      const existing = groups.get(pod.interestSlug);
      if (existing) {
        existing.pods.push(pod);
      } else {
        groups.set(pod.interestSlug, {
          slug: pod.interestSlug,
          label: pod.interestLabel,
          pods: [pod],
        });
      }
    }
    return Array.from(groups.values());
  }, [currentPods]);

  const upgradeProMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ user: SelfUser }>('/api/auth/plan', {
        method: 'POST',
        body: JSON.stringify({ planTier: 'PREMIUM' }),
      }),
    onSuccess: (res) => {
      setErrorMsg(null);
      queryClient.setQueryData(['auth', 'me', authRevision], res);
      bumpAuthRevision((r) => r + 1);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || 'Could not activate Canopy Pro');
    },
  });

  const matchAllMutation = useMutation({
    mutationFn: async () => {
      const combined = Array.from(
        new Set([...selectedSlugs, ...customExtras])
      ).filter(Boolean);
      if (combined.length === 0) {
        throw new Error(
          'Pick at least one interest to match into a 25-member blind pod.'
        );
      }
      await apiFetch<{ interests: InterestItem[] }>('/api/me/interests', {
        method: 'PUT',
        body: JSON.stringify({ interests: combined }),
      });
      const payload: MatchRequest = {
        interest: combined[0],
        matchAll: true,
        maxMembers: selectedCapacity,
        forceNewPod: forceNewMode,
        allowAdditional: forceNewMode,
      };
      return apiFetch<MatchResponse>('/api/pods/match', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (res) => {
      setErrorMsg(null);
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
        pods: res.pods,
      });
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      const targetPod = res.matched[0] || res.pods[res.pods.length - 1];
      if (targetPod) {
        setActivePodId(targetPod.podId);
      }
      setCustomExtras([]);
      setOpen(false);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || 'Could not match into pods');
    },
  });

  const singleJoinMutation = useMutation({
    mutationFn: async ({
      interest,
      allowAdditional,
    }: {
      interest: string;
      allowAdditional: boolean;
    }) => {
      const payload: MatchRequest = {
        interest,
        matchAll: false,
        maxMembers: selectedCapacity,
        forceNewPod: forceNewMode,
        allowAdditional: allowAdditional || forceNewMode,
      };
      return apiFetch<MatchResponse>('/api/pods/match', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (res) => {
      setErrorMsg(null);
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
        pods: res.pods,
      });
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      const targetPod = res.matched[0] || res.pods[res.pods.length - 1];
      if (targetPod) {
        setActivePodId(targetPod.podId);
      }
      setOpen(false);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || 'Could not join or create pod');
    },
  });

  const joinPublicizedMutation = useMutation({
    mutationFn: (podId: string) =>
      apiFetch<{ pod: PodDetail; pods: PodDetail[] }>(
        `/api/pods/${podId}/join`,
        { method: 'POST' }
      ),
    onSuccess: (res) => {
      setErrorMsg(null);
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
        pods: res.pods,
      });
      queryClient.invalidateQueries({ queryKey: ['publicized-pods'] });
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      setActivePodId(res.pod.podId);
      setOpen(false);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || 'Could not join publicized group');
    },
  });

  const createCustomPodMutation = useMutation({
    mutationFn: async () => {
      const cleanTitle = customTitle.trim();
      const cleanCode = sanitizeCustomPodCode(customCode || cleanTitle);
      if (!cleanTitle) {
        throw new Error('Enter a title for your custom group.');
      }
      if (cleanCode.length < 3) {
        throw new Error(
          'Enter a custom #handle of at least 3 letters/numbers (e.g. tactical-raiders).'
        );
      }
      const payload: CreateCustomPodRequest = {
        title: cleanTitle,
        code: cleanCode,
        interest: customInterest || 'gaming',
        description: customDescription.trim(),
        maxMembers: customSeats,
        isPublicized: customIsPublicized,
      };
      return apiFetch<{ pod: PodDetail; pods: PodDetail[] }>(
        '/api/pods/custom',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      );
    },
    onSuccess: (res) => {
      setErrorMsg(null);
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
        pods: res.pods,
      });
      queryClient.invalidateQueries({ queryKey: ['publicized-pods'] });
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      setCustomTitle('');
      setCustomCode('');
      setCustomCodeTouched(false);
      setCustomDescription('');
      setActivePodId(res.pod.podId);
      setOpen(false);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || 'Could not create custom admin group');
    },
  });

  const leaveOrRematchPodMutation = useMutation({
    mutationFn: async ({
      podId,
      rematch,
    }: {
      podId: string;
      rematch: boolean;
    }) => {
      if (voiceSession.podId === podId) {
        leaveVoice();
      }
      const payload: LeavePodRequest = rematch
        ? {
            rematch: true,
            maxMembers: selectedCapacity,
            forceNewPod: forceNewMode,
          }
        : { rematch: false };
      return apiFetch<{ leftPodId: string; newPod: PodDetail | null }>(
        `/api/pods/${podId}/leave`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      );
    },
    onSuccess: (res, vars) => {
      setErrorMsg(null);
      const remaining = currentPods.filter((p) => p.podId !== res.leftPodId);
      const nextList = res.newPod ? [...remaining, res.newPod] : remaining;
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
        pods: nextList,
      });
      queryClient.invalidateQueries({ queryKey: ['interests'] });

      if (res.newPod) {
        setActivePodId(res.newPod.podId);
        setOpen(false);
      } else if (nextList.length > 0) {
        if (activePodId === res.leftPodId) {
          setActivePodId(nextList[0].podId);
        }
        if (vars.rematch) {
          setErrorMsg(
            'Left pod — no other open 25-member pod matched those filters yet.'
          );
        }
      } else {
        setActivePodId(null);
        setTab('match');
      }
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || 'Could not update pod membership');
    },
  });

  const acceptInviteMutation = useMutation({
    mutationFn: async (rawInput: string) => {
      const code = extractInviteCode(rawInput);
      if (!code) {
        throw new Error('Paste a valid /invite/... link or bare invite code.');
      }
      return apiFetch<AcceptInviteResponse>(
        `/api/invites/${encodeURIComponent(code)}/accept`,
        { method: 'POST' }
      );
    },
    onSuccess: (res) => {
      setErrorMsg(null);
      setInviteInput('');
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
        pods: res.pods,
      });
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      setActivePodId(res.pod.podId);
      setOpen(false);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || 'Could not join pod with that invite code.');
    },
  });

  if (!open) return null;

  const isPro = selfUser?.planTier === 'PREMIUM';

  const toggleInterest = (slug: string) => {
    setSelectedSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]
    );
  };

  const addCustomInterest = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = customInput.trim();
    if (!clean) return;
    if (!customExtras.includes(clean)) {
      setCustomExtras((prev) => [...prev, clean]);
    }
    setCustomInput('');
  };

  const getPodVoiceCount = (pod: PodDetail): number => {
    const peers = voicePeersByPod[pod.podId];
    if (peers) {
      let total = peers.length;
      if (
        voiceSession.status === 'connected' &&
        voiceSession.podId === pod.podId &&
        !peers.some((p) => p.peerId === pod.myPeerId)
      ) {
        total += 1;
      }
      return total;
    }
    return pod.members.filter((m) => Boolean(m.inVoice)).length;
  };

  const getPodLiveMemberCount = (pod: PodDetail): number => {
    const live = presenceByPod[pod.podId]?.members.length;
    return live && live > 0 ? live : pod.memberCount;
  };

  const isBusy =
    matchAllMutation.isPending ||
    singleJoinMutation.isPending ||
    leaveOrRematchPodMutation.isPending ||
    acceptInviteMutation.isPending ||
    joinPublicizedMutation.isPending ||
    createCustomPodMutation.isPending ||
    upgradeProMutation.isPending;

  const allInterests = interestsQuery.data?.interests || [];
  const publicizedGroups = publicizedQuery.data?.groups || [];

  return (
    <div
      className={styles.modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="interest-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && currentPods.length > 0) {
          setOpen(false);
        }
      }}
    >
      <div className={styles.modalCard} style={{ maxWidth: 740 }}>
        <div className={styles.modalHeader}>
          <div style={{ minWidth: 0 }}>
            <h2 id="interest-modal-title" style={{ margin: 0, fontSize: 18 }}>
              25-Member Democratic Pods &amp; Custom Groups
            </h2>
            <p style={{ margin: '3px 0 0', fontSize: 12.5, color: '#686868' }}>
              Join Compact (10), Standard (25), or Club (50) rooms — names,
              genders &amp; nationalities stay hidden.
            </p>
          </div>
          {currentPods.length > 0 && (
            <button
              type="button"
              className={styles.composerIconBtn}
              onClick={() => setOpen(false)}
              aria-label="Close pods modal"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {/* 4-Tab Segmented Bar */}
        <div
          className={styles.modalSegmentedBar}
          role="tablist"
          aria-label="Pod directory and creation views"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pods'}
            className={`${styles.modalSegmentBtn} ${
              tab === 'pods' ? styles.modalSegmentBtnActive : ''
            }`}
            onClick={() => {
              setErrorMsg(null);
              setTab('pods');
            }}
          >
            <span>My Pods</span>
            <span className={styles.segmentCountBadge}>
              {currentPods.length}
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'match'}
            className={`${styles.modalSegmentBtn} ${
              tab === 'match' ? styles.modalSegmentBtnActive : ''
            }`}
            onClick={() => {
              setErrorMsg(null);
              setTab('match');
            }}
          >
            <Sparkles size={14} />
            <span>Match 25-Seat Pod</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'publicized'}
            className={`${styles.modalSegmentBtn} ${
              tab === 'publicized' ? styles.modalSegmentBtnActive : ''
            }`}
            onClick={() => {
              setErrorMsg(null);
              setTab('publicized');
            }}
          >
            <Globe size={14} />
            <span>Publicized Groups</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'custom'}
            className={`${styles.modalSegmentBtn} ${
              tab === 'custom' ? styles.modalSegmentBtnActive : ''
            }`}
            onClick={() => {
              setErrorMsg(null);
              setTab('custom');
            }}
          >
            <Crown size={14} />
            <span>Create Own Pod (Pro)</span>
          </button>
        </div>

        <div className={styles.modalBody}>
          {errorMsg && (
            <div
              style={{
                marginBottom: 12,
                padding: '8px 12px',
                borderRadius: 8,
                background: '#fef3f2',
                color: '#b42318',
                fontSize: 13,
              }}
              role="alert"
            >
              {errorMsg}
            </div>
          )}

          {/* Join with Invite Link or Code Bar (on My Pods & Match tabs) */}
          {(tab === 'pods' || tab === 'match') && (
            <form
              className={styles.inviteJoinBar}
              onSubmit={(e) => {
                e.preventDefault();
                if (!inviteInput.trim() || isBusy) return;
                acceptInviteMutation.mutate(inviteInput);
              }}
            >
              <label
                htmlFor="interest-modal-invite-input"
                className={styles.inviteJoinLabel}
              >
                <Link2 size={14} />
                <span>Have a private or democratic invite link/code?</span>
              </label>
              <div className={styles.inviteJoinRow}>
                <input
                  id="interest-modal-invite-input"
                  type="text"
                  value={inviteInput}
                  onChange={(e) => setInviteInput(e.target.value)}
                  placeholder="Paste /invite/... link or code (e.g. k8m4p2x9q7w3)"
                  className={styles.inviteJoinInput}
                  aria-label="Have an invite link or code"
                />
                <button
                  type="submit"
                  className={styles.primaryActionBtn}
                  disabled={isBusy || !inviteInput.trim()}
                >
                  {acceptInviteMutation.isPending ? 'Joining...' : 'Join Pod'}
                </button>
              </div>
            </form>
          )}

          {/* TAB 1: MY PODS */}
          {tab === 'pods' &&
            (currentPods.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '28px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <p style={{ margin: 0, color: '#686868', fontSize: 14 }}>
                  You aren&apos;t in any active pods yet. Match into a
                  25-member democratic pod or join a publicized community group.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={styles.primaryActionBtn}
                    onClick={() => setTab('match')}
                  >
                    <Sparkles size={15} />
                    <span>Match 25-Seat Pod</span>
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryActionBtn}
                    onClick={() => setTab('publicized')}
                  >
                    <Globe size={15} />
                    <span>Browse Publicized Groups</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.activePodsGroups}>
                {groupedPods.map((group) => (
                  <section
                    key={group.slug}
                    className={styles.activePodGroup}
                    aria-label={`${group.label} pods`}
                  >
                    <div className={styles.activePodGroupHeader}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <strong>{group.label}</strong>
                        <span className={styles.interestActiveBadge}>
                          {group.pods.length} active
                        </span>
                      </div>
                      <button
                        type="button"
                        className={styles.statusSaveBtn}
                        disabled={isBusy}
                        onClick={() =>
                          singleJoinMutation.mutate({
                            interest: group.slug,
                            allowAdditional: true,
                          })
                        }
                      >
                        + Another {group.label} Pod
                      </button>
                    </div>

                    <div className={styles.activePodCardsList}>
                      {group.pods.map((pod) => {
                        const isCurrent = pod.podId === activePodId;
                        const tier = getPodTierLabel(pod.maxMembers);
                        const memberCount = getPodLiveMemberCount(pod);
                        const voiceCount = getPodVoiceCount(pod);
                        const isAdminPod = pod.governanceMode === 'ADMIN';
                        const canManage =
                          isAdminPod &&
                          (pod.myRole === 'OWNER' || pod.myRole === 'ADMIN');

                        return (
                          <div
                            key={pod.podId}
                            className={`${styles.activePodCard} ${
                              isCurrent ? styles.activePodCardCurrent : ''
                            }`}
                          >
                            <div className={styles.activePodCardTop}>
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  flexWrap: 'wrap',
                                  gap: 6,
                                }}
                              >
                                <strong style={{ fontSize: 15 }}>
                                  {pod.title
                                    ? `${pod.title} (#${pod.code})`
                                    : `#${pod.code}`}
                                </strong>
                                <span className={styles.tierBadge}>
                                  {tier} {memberCount}/{pod.maxMembers}
                                </span>
                                {isAdminPod ? (
                                  <span className={styles.govModePillAdmin}>
                                    <Crown size={11} />
                                    <span>
                                      Admin ·{' '}
                                      {pod.isPublicized
                                        ? 'Publicized'
                                        : 'Private'}
                                    </span>
                                  </span>
                                ) : (
                                  <span className={styles.govModePillDemocratic}>
                                    <Scale size={11} />
                                    <span>Democratic</span>
                                  </span>
                                )}
                                {isCurrent && (
                                  <span className={styles.interestActiveBadge}>
                                    Viewing
                                  </span>
                                )}
                              </div>

                              {voiceCount > 0 && (
                                <span className={styles.liveVoicePill}>
                                  <Radio size={12} />
                                  <span>{voiceCount} in voice</span>
                                </span>
                              )}
                            </div>

                            {pod.description && (
                              <div
                                style={{
                                  fontSize: 12.5,
                                  color: '#555555',
                                }}
                              >
                                {pod.description}
                              </div>
                            )}

                            <div className={styles.activePodMetaRow}>
                              <span
                                className={styles.aliasSwatch}
                                style={{
                                  background: safeAvatarColor(
                                    pod.myColor,
                                    pod.myAlias
                                  ),
                                }}
                              />
                              <span>
                                You: <strong>{pod.myAlias}</strong>
                              </span>
                              {pod.myRole === 'OWNER' && (
                                <span className={styles.rolePillOwner}>
                                  OWNER
                                </span>
                              )}
                              {pod.myRole === 'ADMIN' && (
                                <span className={styles.rolePillAdmin}>
                                  ADMIN
                                </span>
                              )}
                            </div>

                            <div className={styles.activePodActions}>
                              <button
                                type="button"
                                className={styles.podCardPrimaryBtn}
                                onClick={() => {
                                  setActivePodId(pod.podId);
                                  setOpen(false);
                                }}
                              >
                                <ExternalLink size={13} />
                                <span>
                                  {isCurrent ? 'Open' : 'Switch Here'}
                                </span>
                              </button>

                              <button
                                type="button"
                                className={styles.podCardSecondaryBtn}
                                onClick={() => setInviteModalPodId(pod.podId)}
                                aria-label={`Share invite link for pod #${pod.code}`}
                              >
                                <Share2 size={13} />
                                <span>Share</span>
                              </button>

                              {canManage && (
                                <button
                                  type="button"
                                  className={styles.podCardSecondaryBtn}
                                  onClick={() => {
                                    setOpen(false);
                                    setAdminSettingsPodId(pod.podId);
                                  }}
                                >
                                  <Settings size={13} />
                                  <span>Manage Group</span>
                                </button>
                              )}

                              {!isAdminPod && (
                                <button
                                  type="button"
                                  className={styles.podCardSecondaryBtn}
                                  disabled={isBusy}
                                  onClick={() =>
                                    leaveOrRematchPodMutation.mutate({
                                      podId: pod.podId,
                                      rematch: true,
                                    })
                                  }
                                >
                                  <Shuffle size={13} />
                                  <span>Rematch</span>
                                </button>
                              )}

                              <button
                                type="button"
                                className={styles.podCardDangerBtn}
                                disabled={isBusy}
                                onClick={() =>
                                  leaveOrRematchPodMutation.mutate({
                                    podId: pod.podId,
                                    rematch: false,
                                  })
                                }
                                aria-label={`Leave pod #${pod.code}`}
                              >
                                <LogOut size={13} />
                                <span>Leave</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            ))}

          {/* TAB 2: MATCH 25-SEAT POD */}
          {tab === 'match' && (
            <>
              <div
                className={styles.podOptionsBar}
                aria-label="Pod size and creation mode"
              >
                <div className={styles.podOptionGroup}>
                  <span className={styles.podOptionLabel}>
                    Pod Capacity (Default 25)
                  </span>
                  <div
                    className={styles.podPillsRow}
                    role="group"
                    aria-label="Pod capacity"
                  >
                    {CAPACITY_OPTIONS.map((opt) => {
                      const active = selectedCapacity === opt.value;
                      return (
                        <button
                          key={String(opt.value)}
                          type="button"
                          onClick={() => setSelectedCapacity(opt.value)}
                          className={`${styles.podOptionPill} ${
                            active ? styles.podOptionPillActive : ''
                          }`}
                          aria-pressed={active}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className={styles.podOptionGroup}>
                  <span className={styles.podOptionLabel}>Pod Mode</span>
                  <div
                    className={styles.podPillsRow}
                    role="group"
                    aria-label="Pod matching mode"
                  >
                    <button
                      type="button"
                      onClick={() => setForceNewMode(false)}
                      className={`${styles.podOptionPill} ${
                        !forceNewMode ? styles.podOptionPillActive : ''
                      }`}
                      aria-pressed={!forceNewMode}
                    >
                      Join Open Pod
                    </button>
                    <button
                      type="button"
                      onClick={() => setForceNewMode(true)}
                      className={`${styles.podOptionPill} ${
                        forceNewMode ? styles.podOptionPillActive : ''
                      }`}
                      aria-pressed={forceNewMode}
                    >
                      Create Fresh Pod
                    </button>
                  </div>
                </div>
              </div>

              <form
                onSubmit={addCustomInterest}
                style={{ display: 'flex', gap: 8, marginBottom: 14 }}
              >
                <input
                  type="text"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  placeholder="Add custom interest (e.g. Mechanical Keyboards)..."
                  maxLength={48}
                  className={styles.statusInput}
                  style={{ height: 44, fontSize: 16 }}
                  aria-label="Custom interest"
                />
                <button type="submit" className={styles.secondaryActionBtn}>
                  <Plus size={16} />
                  <span>Add</span>
                </button>
              </form>

              {customExtras.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    marginBottom: 14,
                  }}
                >
                  {customExtras.map((item) => (
                    <span
                      key={item}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '5px 10px',
                        borderRadius: 999,
                        background: '#a1ffcb',
                        color: '#154726',
                        fontSize: 12.5,
                        fontWeight: 700,
                      }}
                    >
                      <span>+{item}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setCustomExtras((prev) =>
                            prev.filter((x) => x !== item)
                          )
                        }
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          padding: 2,
                          display: 'inline-flex',
                        }}
                        aria-label={`Remove ${item}`}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {interestsQuery.isLoading ? (
                <p style={{ color: '#686868', fontSize: 14 }}>
                  Loading live 25-member interest pods...
                </p>
              ) : (
                <div className={styles.interestGrid}>
                  {allInterests.map((item) => {
                    const isSelected = selectedSlugs.includes(item.slug);
                    const activeCount = activeCountBySlug.get(item.slug) || 0;
                    const alreadyInPod = activeCount > 0;

                    return (
                      <div
                        key={item.slug}
                        className={`${styles.interestTile} ${
                          isSelected ? styles.interestTileSelected : ''
                        }`}
                      >
                        <div>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 6,
                              flexWrap: 'wrap',
                            }}
                          >
                            <strong style={{ fontSize: 15 }}>
                              {item.label}
                            </strong>
                            <div
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 5,
                              }}
                            >
                              {activeCount > 0 && (
                                <span className={styles.interestActiveBadge}>
                                  {activeCount} active
                                </span>
                              )}
                              <span
                                style={{
                                  fontFamily: 'var(--m-font-mono)',
                                  fontSize: 10.5,
                                  textTransform: 'uppercase',
                                  color: '#686868',
                                }}
                              >
                                {item.category}
                              </span>
                            </div>
                          </div>

                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 12,
                              color: '#575757',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              fontFamily: 'var(--m-font-mono)',
                            }}
                          >
                            <Users size={13} />
                            <span>
                              {item.openPods} open · {item.activeMembers} members
                            </span>
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            onClick={() => toggleInterest(item.slug)}
                            className={styles.statusSaveBtn}
                            style={{
                              minHeight: 40,
                              flex: 1,
                              background: isSelected ? '#a1ffcb' : '#ffffff',
                              borderColor: isSelected
                                ? '#1f6b3a'
                                : 'rgba(35,35,35,0.16)',
                            }}
                            aria-pressed={isSelected}
                          >
                            {isSelected ? (
                              <>
                                <Check
                                  size={13}
                                  style={{
                                    verticalAlign: 'middle',
                                    marginRight: 3,
                                  }}
                                />
                                Selected
                              </>
                            ) : (
                              'Select'
                            )}
                          </button>

                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              singleJoinMutation.mutate({
                                interest: item.slug,
                                allowAdditional: alreadyInPod,
                              })
                            }
                            className={styles.statusSaveBtn}
                            style={{
                              minHeight: 40,
                              background: alreadyInPod ? '#e8faef' : '#191b19',
                              color: alreadyInPod ? '#164e2a' : '#a1ffcb',
                              borderColor: alreadyInPod
                                ? 'rgba(31,107,58,0.35)'
                                : '#191b19',
                            }}
                          >
                            {alreadyInPod
                              ? '+ New Pod'
                              : forceNewMode
                                ? 'Create Pod'
                                : 'Join Pod'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* TAB 3: PUBLICIZED GROUPS DIRECTORY */}
          {tab === 'publicized' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div
                className={styles.podOptionsBar}
                style={{ marginBottom: 0 }}
              >
                <div>
                  <strong style={{ fontSize: 14 }}>
                    Featured Publicized Community Groups
                  </strong>
                  <p
                    style={{
                      margin: '2px 0 0',
                      fontSize: 12.5,
                      color: '#5a5a5a',
                    }}
                  >
                    Custom groups publicized by Canopy Pro founders. Join in one
                    click with a peer-blind animal alias.
                  </p>
                </div>

                <select
                  className={styles.inviteSelect}
                  style={{ width: 190, minHeight: 42 }}
                  value={publicizedInterestFilter}
                  onChange={(e) => setPublicizedInterestFilter(e.target.value)}
                  aria-label="Filter publicized groups by interest"
                >
                  <option value="">All Interests</option>
                  {allInterests.map((it) => (
                    <option key={it.slug} value={it.slug}>
                      {it.label}
                    </option>
                  ))}
                </select>
              </div>

              {publicizedQuery.isLoading ? (
                <p style={{ color: '#686868', fontSize: 14 }}>
                  Loading publicized community groups...
                </p>
              ) : publicizedGroups.length === 0 ? (
                <div className={styles.proUnlockCard}>
                  <strong style={{ fontSize: 15 }}>
                    No publicized groups listed yet
                  </strong>
                  <p style={{ margin: '4px 0 12px', fontSize: 13, color: '#555' }}>
                    Launch the first featured community group in the directory
                    with Canopy Pro!
                  </p>
                  <button
                    type="button"
                    className={styles.primaryActionBtn}
                    onClick={() => setTab('custom')}
                  >
                    <Crown size={15} />
                    <span>Create &amp; Publicize Your Group</span>
                  </button>
                </div>
              ) : (
                <div className={styles.activePodCardsList}>
                  {publicizedGroups.map((grp) => {
                    const inGroup =
                      grp.alreadyMember ||
                      currentPods.some((p) => p.podId === grp.podId);
                    const isFull = grp.memberCount >= grp.maxMembers;
                    const tier = getPodTierLabel(grp.maxMembers);

                    return (
                      <div key={grp.podId} className={styles.activePodCard}>
                        <div className={styles.activePodCardTop}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              flexWrap: 'wrap',
                              gap: 6,
                            }}
                          >
                            <strong style={{ fontSize: 15.5 }}>
                              {grp.title || `#${grp.code}`}
                            </strong>
                            <span
                              style={{
                                fontFamily: 'var(--m-font-mono)',
                                fontSize: 12,
                                color: '#555555',
                              }}
                            >
                              #{grp.code}
                            </span>
                            <span className={styles.interestBadge}>
                              {grp.interestLabel}
                            </span>
                            <span className={styles.tierBadge}>
                              {tier} · {grp.memberCount}/{grp.maxMembers}
                            </span>
                          </div>

                          {inGroup ? (
                            <button
                              type="button"
                              className={styles.podCardPrimaryBtn}
                              style={{ minHeight: 44 }}
                              onClick={() => {
                                setActivePodId(grp.podId);
                                setOpen(false);
                              }}
                            >
                              <ExternalLink size={14} />
                              <span>Open Group</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={isBusy || isFull}
                              className={styles.podCardPrimaryBtn}
                              style={{ minHeight: 44 }}
                              onClick={() =>
                                joinPublicizedMutation.mutate(grp.podId)
                              }
                            >
                              <span>{isFull ? 'Group Full' : 'Join Group'}</span>
                            </button>
                          )}
                        </div>

                        {grp.description && (
                          <p
                            style={{
                              margin: 0,
                              fontSize: 13,
                              color: '#363636',
                              lineHeight: 1.45,
                            }}
                          >
                            {grp.description}
                          </p>
                        )}

                        <div
                          style={{
                            fontSize: 12,
                            color: '#686868',
                            fontFamily: 'var(--m-font-mono)',
                          }}
                        >
                          Founded by <strong>{grp.founderAlias}</strong> · Zero
                          PII peer-blind room
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: CREATE OWN POD (PRO) */}
          {tab === 'custom' &&
            (!isPro ? (
              <div className={styles.proUnlockCard}>
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span className={styles.proBadge}>CANOPY PRO</span>
                  <span className={styles.tierBadge}>
                    Custom Admin &amp; Publicized Groups
                  </span>
                </div>

                <h3 style={{ margin: '10px 0 6px', fontSize: 19 }}>
                  Launch your own Private or Publicized Blind Group
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13.5,
                    color: '#454545',
                    lineHeight: 1.5,
                  }}
                >
                  Free accounts match into 100% democratic 25-member pods run by
                  YES/NO member votes. Upgrade to <strong>Canopy Pro</strong> to
                  found custom groups with your own title, <code>#handle</code>,
                  Owner/Admin moderation, and directory publicity controls —
                  while keeping every peer 100% anonymous.
                </p>

                <ul className={styles.proFeatureList}>
                  <li>
                    Preselect custom Group Title, <code>#handle</code>, and 10 /
                    25 / 50 seat caps
                  </li>
                  <li>
                    Choose <strong>Private (Invite Link Only)</strong> or{' '}
                    <strong>Publicize in Featured Directory</strong> anytime
                  </li>
                  <li>
                    Instant Owner &amp; Admin tools (Kick, Promote Admins, and
                    edit group settings without waiting on votes)
                  </li>
                </ul>

                <button
                  type="button"
                  disabled={upgradeProMutation.isPending}
                  onClick={() => upgradeProMutation.mutate()}
                  className={styles.primaryActionBtn}
                  style={{ marginTop: 6 }}
                >
                  <Crown size={16} />
                  <span>
                    {upgradeProMutation.isPending
                      ? 'Activating Canopy Pro...'
                      : 'Activate Canopy Pro (Instant Demo Upgrade)'}
                  </span>
                </button>
              </div>
            ) : (
              <form
                id="create-custom-pod-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  createCustomPodMutation.mutate();
                }}
                style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                    gap: 12,
                  }}
                >
                  <div className={styles.inviteFieldGroup}>
                    <label
                      htmlFor="custom-pod-title"
                      className={styles.podOptionLabel}
                    >
                      Group Title
                    </label>
                    <input
                      id="custom-pod-title"
                      type="text"
                      required
                      maxLength={80}
                      value={customTitle}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCustomTitle(val);
                        if (!customCodeTouched) {
                          setCustomCode(sanitizeCustomPodCode(val));
                        }
                      }}
                      placeholder="e.g. Tactical Co-op Raiders"
                      className={styles.statusInput}
                      style={{ height: 44, fontSize: 15 }}
                    />
                  </div>

                  <div className={styles.inviteFieldGroup}>
                    <label
                      htmlFor="custom-pod-handle"
                      className={styles.podOptionLabel}
                    >
                      Custom Handle (#slug)
                    </label>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        border: '1px solid rgba(35,35,35,0.18)',
                        borderRadius: 8,
                        background: '#f8f9f8',
                        paddingLeft: 10,
                        height: 44,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--m-font-mono)',
                          fontWeight: 700,
                          color: '#164e2a',
                        }}
                      >
                        #
                      </span>
                      <input
                        id="custom-pod-handle"
                        type="text"
                        required
                        maxLength={32}
                        value={customCode}
                        onChange={(e) => {
                          setCustomCodeTouched(true);
                          setCustomCode(sanitizeCustomPodCode(e.target.value));
                        }}
                        placeholder="tactical-raiders"
                        style={{
                          flex: 1,
                          border: 'none',
                          background: 'transparent',
                          height: '100%',
                          padding: '0 10px 0 4px',
                          fontFamily: 'var(--m-font-mono)',
                          fontSize: 14,
                          color: '#232323',
                          outline: 'none',
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: 12,
                  }}
                >
                  <div className={styles.inviteFieldGroup}>
                    <label
                      htmlFor="custom-pod-interest"
                      className={styles.podOptionLabel}
                    >
                      Interest Category
                    </label>
                    <select
                      id="custom-pod-interest"
                      className={styles.inviteSelect}
                      value={customInterest}
                      onChange={(e) => setCustomInterest(e.target.value)}
                    >
                      {allInterests.length === 0 ? (
                        <option value="gaming">Gaming</option>
                      ) : (
                        allInterests.map((it) => (
                          <option key={it.slug} value={it.slug}>
                            {it.label} ({it.category})
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  <div className={styles.inviteFieldGroup}>
                    <span className={styles.podOptionLabel}>Max Seats</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {([10, 25, 50] as const).map((cap) => (
                        <button
                          key={cap}
                          type="button"
                          onClick={() => setCustomSeats(cap)}
                          aria-pressed={customSeats === cap}
                          className={`${styles.podOptionPill} ${
                            customSeats === cap
                              ? styles.podOptionPillActive
                              : ''
                          }`}
                          style={{ flex: 1, minHeight: 44 }}
                        >
                          {cap === 10
                            ? 'Compact (10)'
                            : cap === 25
                              ? 'Standard (25)'
                              : 'Club (50)'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={styles.inviteFieldGroup}>
                  <label
                    htmlFor="custom-pod-desc"
                    className={styles.podOptionLabel}
                  >
                    Description
                  </label>
                  <input
                    id="custom-pod-desc"
                    type="text"
                    maxLength={240}
                    value={customDescription}
                    onChange={(e) => setCustomDescription(e.target.value)}
                    placeholder="e.g. Nightly co-op runs, loadouts & strategy voice comms"
                    className={styles.statusInput}
                    style={{ height: 44, fontSize: 14.5 }}
                  />
                </div>

                <div className={styles.inviteFieldGroup}>
                  <span className={styles.podOptionLabel}>Visibility</span>
                  <div className={styles.visibilityGrid}>
                    <button
                      type="button"
                      onClick={() => setCustomIsPublicized(false)}
                      aria-pressed={!customIsPublicized}
                      className={`${styles.visibilityChoiceCard} ${
                        !customIsPublicized
                          ? styles.visibilityChoiceCardActive
                          : ''
                      }`}
                    >
                      <div className={styles.visibilityChoiceHead}>
                        <Lock size={15} />
                        <strong>Private Group (Invite Link Only)</strong>
                      </div>
                      <span>
                        Unlisted — only peers you share your /invite link with
                        can join.
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setCustomIsPublicized(true)}
                      aria-pressed={customIsPublicized}
                      className={`${styles.visibilityChoiceCard} ${
                        customIsPublicized
                          ? styles.visibilityChoiceCardActive
                          : ''
                      }`}
                    >
                      <div className={styles.visibilityChoiceHead}>
                        <Globe size={15} />
                        <strong>Publicize in Featured Directory</strong>
                      </div>
                      <span>
                        Listed in Publicized Groups so anyone on Canopy can
                        discover &amp; join.
                      </span>
                    </button>
                  </div>
                </div>
              </form>
            ))}
        </div>

        <div className={styles.modalFooter}>
          {tab === 'pods' && (
            <>
              <span style={{ fontSize: 13, color: '#686868' }}>
                {currentPods.length} active{' '}
                {currentPods.length === 1 ? 'pod' : 'pods'}
              </span>
              <button
                type="button"
                className={styles.primaryActionBtn}
                onClick={() => setTab('match')}
              >
                <Plus size={16} />
                <span>Match or Create Another Pod</span>
              </button>
            </>
          )}

          {tab === 'match' && (
            <>
              <span style={{ fontSize: 13, color: '#686868' }}>
                {selectedSlugs.length + customExtras.length} selected
                {selectedCapacity
                  ? ` · ${selectedCapacity} seats`
                  : ' · 25 default seats'}
                {forceNewMode ? ' · Fresh' : ''}
              </span>
              <button
                type="button"
                className={styles.primaryActionBtn}
                disabled={isBusy}
                onClick={() => matchAllMutation.mutate()}
              >
                <Sparkles size={16} />
                <span>
                  {matchAllMutation.isPending
                    ? 'Matching Pods...'
                    : forceNewMode
                      ? 'Create Fresh 25-Seat Pods'
                      : 'Match into 25-Seat Pods'}
                </span>
              </button>
            </>
          )}

          {tab === 'publicized' && (
            <>
              <span style={{ fontSize: 13, color: '#686868' }}>
                {publicizedGroups.length} publicized{' '}
                {publicizedGroups.length === 1 ? 'group' : 'groups'}
              </span>
              <button
                type="button"
                className={styles.primaryActionBtn}
                onClick={() => setTab('custom')}
              >
                <Crown size={16} />
                <span>Create &amp; Publicize Own Pod</span>
              </button>
            </>
          )}

          {tab === 'custom' && (
            <>
              <span style={{ fontSize: 13, color: '#686868' }}>
                {isPro
                  ? `${customSeats} seats · ${
                      customIsPublicized
                        ? 'Featured Directory'
                        : 'Private Invite-Only'
                    }`
                  : 'Canopy Pro unlocks custom admin & publicized groups'}
              </span>
              {isPro ? (
                <button
                  type="submit"
                  form="create-custom-pod-form"
                  disabled={isBusy}
                  className={styles.primaryActionBtn}
                >
                  <Crown size={16} />
                  <span>
                    {createCustomPodMutation.isPending
                      ? 'Creating Group...'
                      : 'Create Custom Group'}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={upgradeProMutation.isPending}
                  onClick={() => upgradeProMutation.mutate()}
                  className={styles.primaryActionBtn}
                >
                  <Crown size={16} />
                  <span>Activate Canopy Pro</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
