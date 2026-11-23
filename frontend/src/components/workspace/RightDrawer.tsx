'use client';

import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  Gavel,
  MessageCircle,
  PhoneCall,
  Plus,
  Scale,
  Settings,
  Shield,
  UserMinus,
  Volume2,
  X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import {
  activeDmPeerByPodAtom,
  activePodIdAtom,
  adminSettingsPodIdAtom,
  highlightedMessageIdAtom,
  presenceByPodAtom,
  proposeSheetOpenAtom,
  rightPanelAtom,
  unreadByConvoAtom,
  voicePeersByPodAtom,
} from '@/state/workspaceAtoms';
import {
  markConversationReadInCaches,
  personalizeProposal,
  syncProposalIntoCaches,
} from '@/state/wsPodClient';
import { useVoiceActions } from '@/state/voiceEngine';
import {
  MessageCard,
  PodProposalVoteCard,
} from '@/components/workspace/MessageCard';
import { aliasInitials, safeAvatarColor } from '@/components/workspace/markdown';
import {
  conversationKey,
  resolveMessagePeerId,
  type CreateProposalRequest,
  type PodDetail,
  type PodMember,
  type PodProposalDto,
  type ProposalKind,
  type RichMessage,
  type RightPanelMode,
} from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

interface RightDrawerProps {
  pod: PodDetail | null;
  allPods: PodDetail[];
  members: PodMember[];
}

const PROPOSAL_KIND_OPTIONS: Array<{ value: ProposalKind; label: string }> = [
  { value: 'RENAME_POD', label: 'Rename Pod / Set Description' },
  { value: 'UPDATE_TOPIC', label: 'Update Pod Topic / Description' },
  { value: 'CHANGE_CAPACITY', label: 'Change Pod Capacity (10 / 25 / 50)' },
  { value: 'TOGGLE_LOCK', label: 'Lock / Unlock Random Matching' },
  { value: 'KICK_MEMBER', label: 'Vote to Kick Member' },
  { value: 'PIN_MESSAGE', label: 'Pin / Unpin Group Message (#id)' },
];

export function RightDrawer({ pod, allPods, members }: RightDrawerProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useAtom(rightPanelAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const [dmPeerMap, setDmPeerMap] = useAtom(activeDmPeerByPodAtom);
  const setUnreadMap = useSetAtom(unreadByConvoAtom);
  const setHighlightedId = useSetAtom(highlightedMessageIdAtom);
  const setAdminSettingsPodId = useSetAtom(adminSettingsPodIdAtom);
  const setPresenceByPod = useSetAtom(presenceByPodAtom);
  const [proposeOpen, setProposeOpen] = useAtom(proposeSheetOpenAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);
  const { dmSession, startDmCall } = useVoiceActions();

  // Roster vote-kick / admin action state
  const [kickPromptPeerId, setKickPromptPeerId] = useState<string | null>(null);
  const [kickReason, setKickReason] = useState('');
  const [rosterActionErr, setRosterActionErr] = useState<string | null>(null);

  // New proposal form state
  const [propKind, setPropKind] = useState<ProposalKind>('RENAME_POD');
  const [propLabel, setPropLabel] = useState('');
  const [propTopic, setPropTopic] = useState('');
  const [propTargetPeerId, setPropTargetPeerId] = useState('');
  const [propMessageId, setPropMessageId] = useState('');
  const [propCapacity, setPropCapacity] = useState<10 | 25 | 50>(25);
  const [propLocked, setPropLocked] = useState<boolean>(true);
  const [propReason, setPropReason] = useState('');
  const [propExpiresMins, setPropExpiresMins] = useState<number>(5);
  const [propError, setPropError] = useState<string | null>(null);

  useEffect(() => {
    setKickPromptPeerId(null);
    setKickReason('');
    setRosterActionErr(null);
    setPropError(null);
    if (pod) {
      setPropLocked(Boolean(pod.allowRandomMatch));
      setPropLabel(pod.title || '');
      setPropTopic(pod.description || '');
      const firstOther = members.find((m) => m.peerId !== pod.myPeerId);
      setPropTargetPeerId(firstOther?.peerId || '');
    }
  }, [pod?.podId]);

  useEffect(() => {
    if (!pod) return;
    if (propKind === 'RENAME_POD') {
      setPropLabel(pod.title || '');
      setPropTopic(pod.description || '');
    } else if (propKind === 'UPDATE_TOPIC') {
      setPropTopic(pod.description || '');
    } else if (propKind === 'TOGGLE_LOCK') {
      setPropLocked(Boolean(pod.allowRandomMatch));
    } else if (propKind === 'KICK_MEMBER') {
      const otherPeers = members.filter((m) => m.peerId !== pod.myPeerId);
      if (
        otherPeers.length > 0 &&
        !otherPeers.some((m) => m.peerId === propTargetPeerId)
      ) {
        setPropTargetPeerId(otherPeers[0].peerId);
      }
    }
  }, [members, pod, propKind, propTargetPeerId]);

  const proposalsQuery = useQuery<{ proposals: PodProposalDto[] }>({
    queryKey: ['proposals', pod?.podId || ''],
    queryFn: async () => {
      const res = await apiFetch<{ proposals: PodProposalDto[] }>(
        `/api/pods/${pod!.podId}/proposals`
      );
      return {
        proposals: (res.proposals || []).map((pr) =>
          personalizeProposal(pr, pod?.myAlias)
        ),
      };
    },
    enabled: Boolean(mode === 'votes' && pod),
  });

  const pinsQuery = useQuery<{ messages: RichMessage[] }>({
    queryKey: ['pins', pod?.podId || ''],
    queryFn: () =>
      apiFetch<{ messages: RichMessage[] }>(`/api/pods/${pod!.podId}/pins`),
    enabled: Boolean(mode === 'pins' && pod),
  });

  const bookmarksQuery = useQuery<{ messages: RichMessage[] }>({
    queryKey: ['bookmarks'],
    queryFn: () => apiFetch<{ messages: RichMessage[] }>('/api/bookmarks'),
    enabled: mode === 'bookmarks',
  });

  const submitProposalMutation = useMutation({
    mutationFn: async (payload: CreateProposalRequest) => {
      if (!pod) throw new Error('Select a pod first.');
      return apiFetch<{ proposal: PodProposalDto; pod?: PodDetail | null }>(
        `/api/pods/${pod.podId}/proposals`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      );
    },
    onSuccess: (res) => {
      if (!pod) return;
      setPropError(null);
      setRosterActionErr(null);
      setKickPromptPeerId(null);
      setKickReason('');
      setPropReason('');
      setPropMessageId('');
      setProposeOpen(false);
      syncProposalIntoCaches(queryClient, pod.podId, res.proposal, res.pod);
      queryClient.invalidateQueries({ queryKey: ['proposals', pod.podId] });
      queryClient.invalidateQueries({
        queryKey: ['messages', pod.podId, 'group'],
      });
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      setMode('votes');
    },
    onError: (err: Error) => {
      setPropError(err.message || 'Could not submit proposal');
      setRosterActionErr(err.message || 'Could not submit proposal');
    },
  });

  const adminKickMutation = useMutation({
    mutationFn: async (targetPeerId: string) => {
      if (!pod) throw new Error('No pod selected');
      return apiFetch<{ pod: PodDetail }>(
        `/api/pods/${pod.podId}/admin/kick`,
        {
          method: 'POST',
          body: JSON.stringify({ targetPeerId }),
        }
      );
    },
    onSuccess: (res) => {
      if (!pod) return;
      setRosterActionErr(null);
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) =>
        old
          ? {
              pods: old.pods.map((p) =>
                p.podId === res.pod.podId
                  ? {
                      ...p,
                      ...res.pod,
                      dmConversations:
                        res.pod.dmConversations &&
                        res.pod.dmConversations.length > 0
                          ? res.pod.dmConversations
                          : p.dmConversations,
                    }
                  : p
              ),
            }
          : { pods: [res.pod] }
      );
      setPresenceByPod((prev) => {
        const snap = prev[pod.podId];
        if (!snap) return prev;
        return {
          ...prev,
          [pod.podId]: {
            ...snap,
            members: res.pod.members,
            onlinePeerIds: res.pod.members
              .filter((m) => m.online)
              .map((m) => m.peerId),
          },
        };
      });
    },
    onError: (err: Error) => {
      setRosterActionErr(err.message || 'Could not kick member');
    },
  });

  const adminRoleMutation = useMutation({
    mutationFn: async ({
      targetPeerId,
      role,
    }: {
      targetPeerId: string;
      role: 'ADMIN' | 'MEMBER';
    }) => {
      if (!pod) throw new Error('No pod selected');
      return apiFetch<{ pod: PodDetail }>(
        `/api/pods/${pod.podId}/admin/role`,
        {
          method: 'POST',
          body: JSON.stringify({ targetPeerId, role }),
        }
      );
    },
    onSuccess: (res) => {
      if (!pod) return;
      setRosterActionErr(null);
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) =>
        old
          ? {
              pods: old.pods.map((p) =>
                p.podId === res.pod.podId
                  ? {
                      ...p,
                      ...res.pod,
                      dmConversations:
                        res.pod.dmConversations &&
                        res.pod.dmConversations.length > 0
                          ? res.pod.dmConversations
                          : p.dmConversations,
                    }
                  : p
              ),
            }
          : { pods: [res.pod] }
      );
      setPresenceByPod((prev) => {
        const snap = prev[pod.podId];
        if (!snap) return prev;
        return {
          ...prev,
          [pod.podId]: {
            ...snap,
            members: res.pod.members,
          },
        };
      });
    },
    onError: (err: Error) => {
      setRosterActionErr(err.message || 'Could not update member role');
    },
  });

  if (!mode) return null;

  const effectiveMode: Exclude<RightPanelMode, null | 'search'> =
    mode === 'search' ? 'members' : mode;

  const knownAliases = members.map((m) => m.alias);

  const voicePeerIds = new Set(
    (pod ? voicePeersByPod[pod.podId] || [] : []).map((p) => p.peerId)
  );

  const inVoiceMembers = members.filter(
    (m) => voicePeerIds.has(m.peerId) || Boolean(m.inVoice)
  );
  const onlineMembers = members.filter(
    (m) => m.online && !voicePeerIds.has(m.peerId) && !m.inVoice
  );
  const offlineMembers = members.filter(
    (m) => !m.online && !voicePeerIds.has(m.peerId) && !m.inVoice
  );

  const openMemberDm = (targetPodId: string, peerId: string | null) => {
    setActivePodId(targetPodId);
    setDmPeerMap({ ...dmPeerMap, [targetPodId]: peerId });
    const key = conversationKey(targetPodId, peerId);
    setUnreadMap((prev) => (prev[key] === 0 ? prev : { ...prev, [key]: 0 }));
    markConversationReadInCaches(queryClient, targetPodId, peerId);
    if (typeof window !== 'undefined' && window.innerWidth <= 900) {
      setMode(null);
    }
  };

  const jumpToMessage = (msg: RichMessage) => {
    const msgPod = allPods.find((p) => p.podId === msg.podId) || pod;
    const myPeerId = msgPod?.myPeerId || '';
    const otherPeerId = resolveMessagePeerId(
      msg.senderPeerId,
      msg.recipientPeerId,
      myPeerId
    );
    openMemberDm(msg.podId, otherPeerId);
    setHighlightedId(msg.id);
  };

  const allProposals = proposalsQuery.data?.proposals || [];
  const openProposals = allProposals.filter((p) => p.status === 'OPEN');
  const closedProposals = allProposals.filter((p) => p.status !== 'OPEN');
  const openBadgeCount =
    mode === 'votes' && proposalsQuery.data
      ? openProposals.length
      : pod?.openProposalsCount || 0;

  const isAdminPod = pod?.governanceMode === 'ADMIN';
  const canAdminManage =
    isAdminPod && (pod?.myRole === 'OWNER' || pod?.myRole === 'ADMIN');

  const otherPeers = pod
    ? members.filter((m) => m.peerId !== pod.myPeerId)
    : [];

  const handleProposeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pod) return;
    setPropError(null);

    const base: CreateProposalRequest = {
      kind: propKind,
      reason: propReason.trim() || undefined,
      expiresInMinutes: propExpiresMins,
    };

    if (propKind === 'RENAME_POD') {
      if (!propLabel.trim() && !propTopic.trim()) {
        setPropError('Enter a pod title or description.');
        return;
      }
      base.label = propLabel.trim();
      base.title = propLabel.trim();
      base.topic = propTopic.trim();
      base.description = propTopic.trim();
    } else if (propKind === 'UPDATE_TOPIC') {
      if (!propTopic.trim()) {
        setPropError('Enter a new pod topic or description.');
        return;
      }
      base.topic = propTopic.trim();
      base.description = propTopic.trim();
    } else if (propKind === 'CHANGE_CAPACITY') {
      base.maxMembers = propCapacity;
    } else if (propKind === 'TOGGLE_LOCK') {
      base.locked = propLocked;
    } else if (propKind === 'KICK_MEMBER') {
      if (!propTargetPeerId) {
        setPropError('Select a member to propose kicking.');
        return;
      }
      base.targetPeerId = propTargetPeerId;
    } else if (propKind === 'PIN_MESSAGE') {
      const parsedId = Number(propMessageId.trim());
      if (!Number.isInteger(parsedId) || parsedId <= 0) {
        setPropError(
          'Enter a valid Group Chat message ID (or click the Pin icon directly on any message).'
        );
        return;
      }
      base.messageId = parsedId;
    }

    submitProposalMutation.mutate(base);
  };

  const renderMemberRolePill = (m: PodMember) => {
    const role = m.role || 'MEMBER';
    if (role === 'OWNER') {
      return <span className={styles.rolePillOwner}>OWNER</span>;
    }
    if (role === 'ADMIN') {
      return <span className={styles.rolePillAdmin}>ADMIN</span>;
    }
    return null;
  };

  const renderMemberActions = (m: PodMember) => {
    if (!pod || m.peerId === pod.myPeerId) return null;
    const targetRole = m.role || 'MEMBER';
    const inPrivateCallWithMember =
      dmSession.status !== 'idle' &&
      dmSession.podId === pod.podId &&
      dmSession.peerId === m.peerId;

    return (
      <div className={styles.rosterMemberActions}>
        <button
          type="button"
          className={styles.rosterPrimaryDmBtn}
          onClick={() => openMemberDm(pod.podId, m.peerId)}
          title={`Open private 1:1 chat with ${m.alias}`}
          aria-label={`Message ${m.alias} privately`}
        >
          <MessageCircle size={12} />
          <span>Message</span>
        </button>

        <button
          type="button"
          className={styles.rosterSmallBtn}
          onClick={() => {
            openMemberDm(pod.podId, m.peerId);
            startDmCall(pod.podId, m.peerId, m.alias, m.color);
          }}
          title={`Start private 1:1 audio call with ${m.alias}`}
          aria-label={`Call ${m.alias} privately`}
        >
          <PhoneCall size={11} />
          <span>{inPrivateCallWithMember ? 'In 1:1 Call' : 'Call'}</span>
        </button>

        {isAdminPod ? (
          canAdminManage &&
          targetRole !== 'OWNER' && (
            <>
              {pod.myRole === 'OWNER' && (
                <button
                  type="button"
                  className={styles.rosterSmallBtn}
                  disabled={adminRoleMutation.isPending}
                  onClick={() =>
                    adminRoleMutation.mutate({
                      targetPeerId: m.peerId,
                      role: targetRole === 'ADMIN' ? 'MEMBER' : 'ADMIN',
                    })
                  }
                  title={
                    targetRole === 'ADMIN'
                      ? `Remove Admin from ${m.alias}`
                      : `Promote ${m.alias} to Admin`
                  }
                >
                  <Shield size={11} />
                  <span>
                    {targetRole === 'ADMIN' ? 'Remove Admin' : 'Make Admin'}
                  </span>
                </button>
              )}
              <button
                type="button"
                className={styles.rosterDangerBtn}
                disabled={adminKickMutation.isPending}
                onClick={() => adminKickMutation.mutate(m.peerId)}
                title={`Kick ${m.alias} from group`}
              >
                <UserMinus size={11} />
                <span>Kick</span>
              </button>
            </>
          )
        ) : (
          <button
            type="button"
            className={styles.rosterSmallBtn}
            onClick={() => {
              setKickPromptPeerId((cur) =>
                cur === m.peerId ? null : m.peerId
              );
              setKickReason('');
            }}
            title={`Start a YES/NO vote to kick ${m.alias}`}
          >
            <Gavel size={11} />
            <span>Vote Kick</span>
          </button>
        )}
      </div>
    );
  };

  const renderKickConfirmDrawer = (m: PodMember) => {
    if (!pod || isAdminPod || kickPromptPeerId !== m.peerId) return null;
    return (
      <form
        className={styles.kickConfirmBox}
        onSubmit={(e) => {
          e.preventDefault();
          submitProposalMutation.mutate({
            kind: 'KICK_MEMBER',
            targetPeerId: m.peerId,
            reason: kickReason.trim() || undefined,
          });
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: '#232323' }}>
          Propose vote to kick {m.alias}?
        </div>
        <input
          type="text"
          value={kickReason}
          onChange={(e) => setKickReason(e.target.value)}
          placeholder="Optional reason (shown on vote card)..."
          maxLength={140}
          className={styles.statusInput}
          aria-label={`Reason to vote kick ${m.alias}`}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="submit"
            disabled={submitProposalMutation.isPending}
            className={styles.statusSaveBtn}
            style={{
              flex: 1,
              background: '#191b19',
              color: '#a1ffcb',
              borderColor: '#191b19',
            }}
          >
            {submitProposalMutation.isPending
              ? 'Starting Vote...'
              : 'Start YES/NO Vote'}
          </button>
          <button
            type="button"
            className={styles.statusSaveBtn}
            onClick={() => setKickPromptPeerId(null)}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  };

  const renderRosterRow = (
    m: PodMember,
    opts: { inVoice?: boolean; offline?: boolean }
  ) => (
    <div key={m.peerId}>
      <div
        className={styles.rosterMember}
        style={opts.offline ? { opacity: 0.72 } : undefined}
      >
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <span
            className={`${styles.msgAvatar} ${
              opts.inVoice ? styles.voiceAvatarSpeaking : ''
            }`}
            style={{
              width: 36,
              height: 36,
              fontSize: 12,
              borderRadius: '50%',
              background: safeAvatarColor(m.color, m.alias),
            }}
          >
            {aliasInitials(m.alias)}
          </span>
          {!opts.inVoice && !opts.offline && (
            <span
              style={{
                position: 'absolute',
                right: -1,
                bottom: -1,
                width: 11,
                height: 11,
                borderRadius: 999,
                background: '#22c55e',
                border: '2px solid #f8f9f8',
              }}
            />
          )}
        </div>

        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 5,
              fontSize: 13.5,
              fontWeight: opts.inVoice ? 700 : 600,
            }}
          >
            <span>
              {m.alias}
              {pod && m.peerId === pod.myPeerId ? ' (you)' : ''}
            </span>
            {renderMemberRolePill(m)}
          </div>

          {opts.inVoice ? (
            <div
              style={{
                fontSize: 11.5,
                color: '#17522c',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Volume2 size={12} />
              <span>In Pod Audio Call</span>
            </div>
          ) : (
            m.customStatus && (
              <div
                style={{
                  fontSize: 12,
                  color: '#686868',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {m.customStatus}
              </div>
            )
          )}

          {renderMemberActions(m)}
        </div>
      </div>
      {renderKickConfirmDrawer(m)}
    </div>
  );

  return (
    <aside className={styles.rightDrawer} aria-label="Workspace right panel">
      <div className={styles.drawerHeader}>
        <strong style={{ fontSize: 14.5 }}>
          {effectiveMode === 'members' &&
            `Pod Members (${members.length}/${pod?.maxMembers || 25})`}
          {effectiveMode === 'votes' && `Pod Votes (${openBadgeCount} open)`}
          {effectiveMode === 'pins' && 'Pinned Messages'}
          {effectiveMode === 'bookmarks' && 'Saved Messages'}
        </strong>
        <button
          type="button"
          className={styles.iconSmallBtn}
          onClick={() => setMode(null)}
          aria-label="Close right panel"
        >
          <X size={16} />
        </button>
      </div>

      <div className={styles.drawerTabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMode === 'members'}
          className={`${styles.drawerTabBtn} ${
            effectiveMode === 'members' ? styles.drawerTabBtnActive : ''
          }`}
          onClick={() => setMode('members')}
        >
          Members
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMode === 'votes'}
          className={`${styles.drawerTabBtn} ${
            effectiveMode === 'votes' ? styles.drawerTabBtnActive : ''
          }`}
          onClick={() => setMode('votes')}
        >
          <span>Votes</span>
          {openBadgeCount > 0 && (
            <span className={styles.drawerTabCount}>{openBadgeCount}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMode === 'pins'}
          className={`${styles.drawerTabBtn} ${
            effectiveMode === 'pins' ? styles.drawerTabBtnActive : ''
          }`}
          onClick={() => setMode('pins')}
        >
          Pins
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMode === 'bookmarks'}
          className={`${styles.drawerTabBtn} ${
            effectiveMode === 'bookmarks' ? styles.drawerTabBtnActive : ''
          }`}
          onClick={() => setMode('bookmarks')}
        >
          Saved
        </button>
      </div>

      {/* BLIND MEMBER ROSTER */}
      {effectiveMode === 'members' && (
        <>
          <div className={styles.blindNotice}>
            Peer-blind pod: real names, genders &amp; nationalities hidden
          </div>
          <div className={styles.drawerBody}>
            {rosterActionErr && (
              <div
                style={{
                  marginBottom: 10,
                  padding: '7px 10px',
                  borderRadius: 8,
                  background: '#fef3f2',
                  color: '#b42318',
                  fontSize: 12,
                }}
                role="alert"
              >
                {rosterActionErr}
              </div>
            )}

            {!pod ? (
              <p style={{ fontSize: 13, color: '#686868' }}>
                Join a 25-member pod to view anonymous room aliases.
              </p>
            ) : (
              <>
                {inVoiceMembers.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div className={styles.sectionHeader}>
                      <span>In Call — {inVoiceMembers.length}</span>
                    </div>
                    {inVoiceMembers.map((m) =>
                      renderRosterRow(m, { inVoice: true })
                    )}
                  </div>
                )}

                <div style={{ marginBottom: 14 }}>
                  <div className={styles.sectionHeader}>
                    <span>Online — {onlineMembers.length}</span>
                  </div>
                  {onlineMembers.map((m) => renderRosterRow(m, {}))}
                </div>

                {offlineMembers.length > 0 && (
                  <div>
                    <div className={styles.sectionHeader}>
                      <span>Offline — {offlineMembers.length}</span>
                    </div>
                    {offlineMembers.map((m) =>
                      renderRosterRow(m, { offline: true })
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* POD GOVERNANCE VOTES TAB */}
      {effectiveMode === 'votes' && (
        <div className={styles.drawerBody}>
          {!pod ? (
            <p style={{ fontSize: 13, color: '#686868' }}>
              Select a pod to view or start governance votes.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className={styles.votesIntroBox}>
                {isAdminPod ? (
                  <>
                    <div className={styles.votesIntroTitle}>
                      Canopy Pro Group (
                      {pod.isPublicized ? 'Publicized' : 'Private'})
                    </div>
                    <p className={styles.votesIntroText}>
                      This group uses Canopy Pro Admin moderation. Owners and
                      Admins manage group settings, roles, and kicks directly.
                    </p>
                    {canAdminManage && (
                      <button
                        type="button"
                        className={styles.podCardPrimaryBtn}
                        style={{ minHeight: 44, width: '100%', marginTop: 6 }}
                        onClick={() => setAdminSettingsPodId(pod.podId)}
                      >
                        <Settings size={14} />
                        <span>Manage Group Settings</span>
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <div className={styles.votesIntroTitle}>
                      <Scale size={14} />
                      <span>100% Democratic Pod · YES &gt; NO Wins</span>
                    </div>
                    <p className={styles.votesIntroText}>
                      No single member has admin power. Any member can propose a
                      pod change — proposals pass as soon as YES beats remaining
                      possible NO votes (or YES &gt; NO at expiry).
                    </p>
                    <button
                      type="button"
                      className={styles.podCardPrimaryBtn}
                      style={{ minHeight: 44, width: '100%', marginTop: 6 }}
                      onClick={() => setProposeOpen((v) => !v)}
                    >
                      <Plus size={15} />
                      <span>
                        {proposeOpen
                          ? 'Close Proposal Sheet'
                          : '+ Propose Pod Change'}
                      </span>
                    </button>
                  </>
                )}
              </div>

              {!isAdminPod && proposeOpen && (
                <form
                  className={styles.proposeFormCard}
                  onSubmit={handleProposeSubmit}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <strong style={{ fontSize: 13.5 }}>
                      New Pod Proposal Vote
                    </strong>
                    <button
                      type="button"
                      className={styles.iconSmallBtn}
                      onClick={() => setProposeOpen(false)}
                      aria-label="Cancel proposal"
                    >
                      <X size={15} />
                    </button>
                  </div>

                  {propError && (
                    <div
                      style={{
                        padding: '7px 9px',
                        borderRadius: 7,
                        background: '#fef3f2',
                        color: '#b42318',
                        fontSize: 12,
                      }}
                      role="alert"
                    >
                      {propError}
                    </div>
                  )}

                  <label className={styles.inviteFieldGroup}>
                    <span className={styles.podOptionLabel}>Action Kind</span>
                    <select
                      className={styles.inviteSelect}
                      value={propKind}
                      onChange={(e) =>
                        setPropKind(e.target.value as ProposalKind)
                      }
                      aria-label="Proposal action kind"
                    >
                      {PROPOSAL_KIND_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {propKind === 'RENAME_POD' && (
                    <>
                      <input
                        type="text"
                        value={propLabel}
                        onChange={(e) => setPropLabel(e.target.value)}
                        placeholder={`Pod title (currently #${pod.code})`}
                        maxLength={80}
                        className={styles.statusInput}
                        style={{ height: 42 }}
                        aria-label="Proposed pod title"
                      />
                      <input
                        type="text"
                        value={propTopic}
                        onChange={(e) => setPropTopic(e.target.value)}
                        placeholder="Pod description (optional)"
                        maxLength={200}
                        className={styles.statusInput}
                        style={{ height: 42 }}
                        aria-label="Proposed pod description"
                      />
                    </>
                  )}

                  {propKind === 'UPDATE_TOPIC' && (
                    <input
                      type="text"
                      value={propTopic}
                      onChange={(e) => setPropTopic(e.target.value)}
                      placeholder="New pod topic / description..."
                      maxLength={200}
                      required
                      className={styles.statusInput}
                      style={{ height: 42 }}
                      aria-label="New pod topic"
                    />
                  )}

                  {propKind === 'CHANGE_CAPACITY' && (
                    <div className={styles.inviteFieldGroup}>
                      <span className={styles.podOptionLabel}>
                        New Pod Capacity (Current: {pod.maxMembers})
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {([10, 25, 50] as const).map((cap) => (
                          <button
                            key={cap}
                            type="button"
                            onClick={() => setPropCapacity(cap)}
                            className={`${styles.podOptionPill} ${
                              propCapacity === cap
                                ? styles.podOptionPillActive
                                : ''
                            }`}
                            style={{ flex: 1, minHeight: 40 }}
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
                  )}

                  {propKind === 'TOGGLE_LOCK' && (
                    <div className={styles.inviteFieldGroup}>
                      <span className={styles.podOptionLabel}>
                        Random Matching (
                        {pod.allowRandomMatch
                          ? 'Currently Unlocked'
                          : 'Currently Locked'}
                        )
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => setPropLocked(true)}
                          className={`${styles.podOptionPill} ${
                            propLocked ? styles.podOptionPillActive : ''
                          }`}
                          style={{ flex: 1, minHeight: 40 }}
                        >
                          Lock Random Match
                        </button>
                        <button
                          type="button"
                          onClick={() => setPropLocked(false)}
                          className={`${styles.podOptionPill} ${
                            !propLocked ? styles.podOptionPillActive : ''
                          }`}
                          style={{ flex: 1, minHeight: 40 }}
                        >
                          Unlock Random Match
                        </button>
                      </div>
                    </div>
                  )}

                  {propKind === 'KICK_MEMBER' && (
                    <label className={styles.inviteFieldGroup}>
                      <span className={styles.podOptionLabel}>
                        Member to Vote Kick
                      </span>
                      {otherPeers.length === 0 ? (
                        <p style={{ margin: 0, fontSize: 12, color: '#686868' }}>
                          No other members in this pod yet.
                        </p>
                      ) : (
                        <select
                          className={styles.inviteSelect}
                          value={propTargetPeerId}
                          onChange={(e) => setPropTargetPeerId(e.target.value)}
                          aria-label="Member to vote kick"
                        >
                          {otherPeers.map((m) => (
                            <option key={m.peerId} value={m.peerId}>
                              {m.alias}
                            </option>
                          ))}
                        </select>
                      )}
                    </label>
                  )}

                  {propKind === 'PIN_MESSAGE' && (
                    <input
                      type="number"
                      min={1}
                      value={propMessageId}
                      onChange={(e) => setPropMessageId(e.target.value)}
                      placeholder="Group message ID (or click Pin on any message)"
                      required
                      className={styles.statusInput}
                      style={{ height: 42 }}
                      aria-label="Group message ID to pin"
                    />
                  )}

                  <input
                    type="text"
                    value={propReason}
                    onChange={(e) => setPropReason(e.target.value)}
                    placeholder="Why propose this? (optional)"
                    maxLength={160}
                    className={styles.statusInput}
                    style={{ height: 40 }}
                    aria-label="Proposal reason"
                  />

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <select
                      className={styles.inviteSelect}
                      style={{ width: 128, minHeight: 44 }}
                      value={propExpiresMins}
                      onChange={(e) =>
                        setPropExpiresMins(Number(e.target.value))
                      }
                      aria-label="Vote duration"
                    >
                      <option value={5}>5 min vote</option>
                      <option value={15}>15 min vote</option>
                      <option value={60}>60 min vote</option>
                    </select>

                    <button
                      type="submit"
                      disabled={submitProposalMutation.isPending}
                      className={styles.primaryActionBtn}
                      style={{ flex: 1 }}
                    >
                      {submitProposalMutation.isPending
                        ? 'Posting Vote...'
                        : 'Submit Proposal Vote'}
                    </button>
                  </div>
                </form>
              )}

              {proposalsQuery.isLoading ? (
                <p style={{ fontSize: 13, color: '#686868' }}>
                  Loading pod proposals...
                </p>
              ) : (
                <>
                  <div>
                    <div className={styles.sectionHeader}>
                      <span>Open Votes — {openProposals.length}</span>
                    </div>
                    {openProposals.length === 0 ? (
                      <p
                        style={{
                          fontSize: 12.5,
                          color: '#686868',
                          margin: '4px 6px 8px',
                        }}
                      >
                        No open votes right now.
                      </p>
                    ) : (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 10,
                        }}
                      >
                        {openProposals.map((prop) => (
                          <PodProposalVoteCard
                            key={prop.id}
                            proposal={prop}
                            podId={pod.podId}
                            compact
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  {closedProposals.length > 0 && (
                    <div>
                      <div className={styles.sectionHeader}>
                        <span>History — {closedProposals.length}</span>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 10,
                        }}
                      >
                        {closedProposals.map((prop) => (
                          <PodProposalVoteCard
                            key={prop.id}
                            proposal={prop}
                            podId={pod.podId}
                            compact
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* PINNED MESSAGES */}
      {effectiveMode === 'pins' && (
        <div className={styles.drawerBody}>
          {!pod ? (
            <p style={{ fontSize: 13, color: '#686868' }}>Select a pod first.</p>
          ) : pinsQuery.isLoading ? (
            <p style={{ fontSize: 13, color: '#686868' }}>Loading pins...</p>
          ) : (pinsQuery.data?.messages.length || 0) === 0 ? (
            <p style={{ fontSize: 13, color: '#686868' }}>
              No pinned messages in #{pod.code} Group Chat yet. Hover any
              message and click the Pin icon.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {pinsQuery.data!.messages.map((msg) => (
                <div
                  key={msg.id}
                  style={{
                    background: '#ffffff',
                    borderRadius: 10,
                    border: '1px solid rgba(35,35,35,0.11)',
                  }}
                >
                  <MessageCard
                    message={msg}
                    myPeerId={pod.myPeerId}
                    knownAliases={knownAliases}
                    compact
                  />
                  <div style={{ padding: '0 10px 8px', textAlign: 'right' }}>
                    <button
                      type="button"
                      className={styles.statusSaveBtn}
                      onClick={() => jumpToMessage(msg)}
                    >
                      Jump to message →
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SAVED BOOKMARKS */}
      {effectiveMode === 'bookmarks' && (
        <div className={styles.drawerBody}>
          {bookmarksQuery.isLoading ? (
            <p style={{ fontSize: 13, color: '#686868' }}>
              Loading saved messages...
            </p>
          ) : (bookmarksQuery.data?.messages.length || 0) === 0 ? (
            <p style={{ fontSize: 13, color: '#686868' }}>
              No saved messages yet. Click the Bookmark icon on any Group or
              Private 1:1 message to save it privately.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {bookmarksQuery.data!.messages.map((msg) => {
                const msgPod = allPods.find((p) => p.podId === msg.podId);
                const myPeerId = msgPod?.myPeerId || pod?.myPeerId || '';
                const otherPeerId = resolveMessagePeerId(
                  msg.senderPeerId,
                  msg.recipientPeerId,
                  myPeerId
                );
                const otherAlias =
                  msg.senderPeerId === myPeerId
                    ? msg.recipientAlias || 'Member'
                    : msg.senderAlias;

                return (
                  <div
                    key={msg.id}
                    style={{
                      background: '#ffffff',
                      borderRadius: 10,
                      border: '1px solid rgba(35,35,35,0.11)',
                    }}
                  >
                    {msgPod && (
                      <div
                        style={{
                          padding: '6px 10px 0',
                          fontSize: 11,
                          fontFamily: 'var(--m-font-mono)',
                          color: '#686868',
                        }}
                      >
                        {msgPod.title
                          ? `${msgPod.title} (#${msgPod.code})`
                          : `#${msgPod.code}`}{' '}
                        ·{' '}
                        {otherPeerId
                          ? `Private 1:1 with ${otherAlias}`
                          : 'Group Chat'}
                      </div>
                    )}
                    <MessageCard
                      message={msg}
                      myPeerId={myPeerId}
                      knownAliases={knownAliases}
                      compact
                    />
                    <div style={{ padding: '0 10px 8px', textAlign: 'right' }}>
                      <button
                        type="button"
                        className={styles.statusSaveBtn}
                        onClick={() => jumpToMessage(msg)}
                      >
                        Jump →
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
