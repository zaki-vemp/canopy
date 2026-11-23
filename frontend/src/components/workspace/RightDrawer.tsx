'use client';

import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  Gavel,
  Plus,
  Scale,
  Send,
  Settings,
  Shield,
  UserMinus,
  Volume2,
  X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import {
  activeChannelIdMapAtom,
  activePodIdAtom,
  activeThreadMessageIdAtom,
  adminSettingsPodIdAtom,
  highlightedMessageIdAtom,
  presenceByPodAtom,
  proposeSheetOpenAtom,
  rightPanelAtom,
  voiceRosterByPodAtom,
} from '@/state/workspaceAtoms';
import {
  personalizeProposal,
  syncProposalIntoCaches,
  upsertThreadReplyInCache,
} from '@/state/wsPodClient';
import {
  MessageCard,
  PodProposalVoteCard,
} from '@/components/workspace/MessageCard';
import { aliasInitials, safeAvatarColor } from '@/components/workspace/markdown';
import type {
  ChannelKind,
  CreateProposalRequest,
  PodChannel,
  PodDetail,
  PodMember,
  PodProposalDto,
  PostMessageResponse,
  ProposalKind,
  RichMessage,
  RightPanelMode,
  ThreadPayload,
} from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

interface RightDrawerProps {
  pod: PodDetail | null;
  allPods: PodDetail[];
  channel: PodChannel | null;
  members: PodMember[];
}

const PROPOSAL_KIND_OPTIONS: Array<{ value: ProposalKind; label: string }> = [
  { value: 'ADD_CHANNEL', label: 'Add Channel (Text or Voice)' },
  { value: 'REMOVE_CHANNEL', label: 'Remove Channel' },
  { value: 'RENAME_POD', label: 'Rename Pod / Set Description' },
  { value: 'UPDATE_TOPIC', label: 'Update Channel Topic' },
  { value: 'CHANGE_CAPACITY', label: 'Change Pod Capacity (10 / 25 / 50)' },
  { value: 'TOGGLE_LOCK', label: 'Lock / Unlock Random Matching' },
];

export function RightDrawer({
  pod,
  allPods,
  channel,
  members,
}: RightDrawerProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useAtom(rightPanelAtom);
  const [threadParentId, setThreadParentId] = useAtom(activeThreadMessageIdAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const [channelMap, setChannelMap] = useAtom(activeChannelIdMapAtom);
  const setHighlightedId = useSetAtom(highlightedMessageIdAtom);
  const setAdminSettingsPodId = useSetAtom(adminSettingsPodIdAtom);
  const setPresenceByPod = useSetAtom(presenceByPodAtom);
  const [proposeOpen, setProposeOpen] = useAtom(proposeSheetOpenAtom);
  const voiceRosterByPod = useAtomValue(voiceRosterByPodAtom);

  const [threadDraft, setThreadDraft] = useState('');

  // Roster vote-kick / admin action state
  const [kickPromptPeerId, setKickPromptPeerId] = useState<string | null>(null);
  const [kickReason, setKickReason] = useState('');
  const [rosterActionErr, setRosterActionErr] = useState<string | null>(null);

  // New proposal form state
  const [propKind, setPropKind] = useState<ProposalKind>('ADD_CHANNEL');
  const [propLabel, setPropLabel] = useState('');
  const [propTopic, setPropTopic] = useState('');
  const [propChannelKind, setPropChannelKind] = useState<ChannelKind>('TEXT');
  const [propTargetChannelId, setPropTargetChannelId] = useState('');
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
      const removable = pod.channels.find((c) => c.slug !== 'general');
      setPropTargetChannelId(
        removable?.channelId || pod.channels[0]?.channelId || ''
      );
      if (pod.title) setPropLabel(pod.title);
      else setPropLabel('');
      setPropTopic(pod.description || '');
    }
  }, [pod?.podId]);

  useEffect(() => {
    if (!pod) return;
    if (propKind === 'REMOVE_CHANNEL') {
      const removable = pod.channels.filter((c) => c.slug !== 'general');
      if (
        removable.length > 0 &&
        !removable.some((c) => c.channelId === propTargetChannelId)
      ) {
        setPropTargetChannelId(removable[0].channelId);
      }
    } else if (propKind === 'UPDATE_TOPIC') {
      if (!pod.channels.some((c) => c.channelId === propTargetChannelId)) {
        setPropTargetChannelId(pod.channels[0]?.channelId || '');
      }
    } else if (propKind === 'RENAME_POD') {
      setPropLabel(pod.title || '');
      setPropTopic(pod.description || '');
    } else if (propKind === 'ADD_CHANNEL') {
      setPropLabel('');
      setPropTopic('');
    } else if (propKind === 'TOGGLE_LOCK') {
      setPropLocked(Boolean(pod.allowRandomMatch));
    }
  }, [pod, propKind]);

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

  const threadQuery = useQuery<ThreadPayload>({
    queryKey: [
      'thread',
      pod?.podId || '',
      channel?.channelId || '',
      threadParentId || 0,
    ],
    queryFn: () =>
      apiFetch<ThreadPayload>(
        `/api/pods/${pod!.podId}/channels/${channel!.channelId}/threads/${threadParentId}`
      ),
    enabled: Boolean(
      mode === 'thread' && pod && channel && threadParentId && threadParentId > 0
    ),
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

  const threadReplyMutation = useMutation({
    mutationFn: async (body: string) => {
      if (!pod || !channel || !threadParentId) return null;
      return apiFetch<PostMessageResponse>(
        `/api/pods/${pod.podId}/channels/${channel.channelId}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            body,
            parentMessageId: threadParentId,
            quoteMessageId: 0,
            attachmentIds: [],
          }),
        }
      );
    },
    onSuccess: (res) => {
      setThreadDraft('');
      if (res?.message && pod && channel && threadParentId) {
        upsertThreadReplyInCache(
          queryClient,
          pod.podId,
          channel.channelId,
          threadParentId,
          res.message
        );
      }
    },
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
      setProposeOpen(false);
      syncProposalIntoCaches(queryClient, pod.podId, res.proposal, res.pod);
      queryClient.invalidateQueries({ queryKey: ['proposals', pod.podId] });
      queryClient.invalidateQueries({ queryKey: ['messages', pod.podId] });
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
                p.podId === res.pod.podId ? res.pod : p
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
                p.podId === res.pod.podId ? res.pod : p
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

  const podRoster = pod ? voiceRosterByPod[pod.podId] || {} : {};
  const peerVoiceChannelLabel = new Map<string, string>();
  if (pod) {
    for (const [vchId, peers] of Object.entries(podRoster)) {
      const chObj = pod.channels.find((c) => c.channelId === vchId);
      const label = chObj?.label || 'Voice';
      for (const p of peers) {
        peerVoiceChannelLabel.set(p.peerId, label);
      }
    }
  }

  const inVoiceMembers = members.filter(
    (m) => peerVoiceChannelLabel.has(m.peerId) || Boolean(m.voiceChannelId)
  );
  const onlineMembers = members.filter(
    (m) =>
      m.online &&
      !peerVoiceChannelLabel.has(m.peerId) &&
      !m.voiceChannelId
  );
  const offlineMembers = members.filter(
    (m) =>
      !m.online &&
      !peerVoiceChannelLabel.has(m.peerId) &&
      !m.voiceChannelId
  );

  const jumpToMessage = (msg: RichMessage) => {
    setActivePodId(msg.podId);
    setChannelMap({ ...channelMap, [msg.podId]: msg.channelId });
    if (msg.parentMessageId > 0) {
      setThreadParentId(msg.parentMessageId);
    } else {
      setHighlightedId(msg.id);
    }
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

  const handleProposeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pod) return;
    setPropError(null);

    const base: CreateProposalRequest = {
      kind: propKind,
      reason: propReason.trim() || undefined,
      expiresInMinutes: propExpiresMins,
    };

    if (propKind === 'ADD_CHANNEL') {
      if (!propLabel.trim()) {
        setPropError('Enter a name for the proposed channel.');
        return;
      }
      base.label = propLabel.trim();
      base.topic = propTopic.trim();
      base.channelKind = propChannelKind;
    } else if (propKind === 'REMOVE_CHANNEL') {
      if (!propTargetChannelId) {
        setPropError('Pick a non-#general channel to remove.');
        return;
      }
      base.channelId = propTargetChannelId;
    } else if (propKind === 'RENAME_POD') {
      if (!propLabel.trim() && !propTopic.trim()) {
        setPropError('Enter a pod title or description.');
        return;
      }
      base.label = propLabel.trim();
      base.title = propLabel.trim();
      base.topic = propTopic.trim();
      base.description = propTopic.trim();
    } else if (propKind === 'UPDATE_TOPIC') {
      if (!propTargetChannelId) {
        setPropError('Pick a channel to update.');
        return;
      }
      base.channelId = propTargetChannelId;
      base.topic = propTopic.trim();
    } else if (propKind === 'CHANGE_CAPACITY') {
      base.maxMembers = propCapacity;
    } else if (propKind === 'TOGGLE_LOCK') {
      base.locked = propLocked;
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

    if (isAdminPod) {
      if (!canAdminManage || targetRole === 'OWNER') return null;
      return (
        <div className={styles.rosterMemberActions}>
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
        </div>
      );
    }

    // Democratic Pod: Vote Kick button
    return (
      <div className={styles.rosterMemberActions}>
        <button
          type="button"
          className={styles.rosterSmallBtn}
          onClick={() => {
            setKickPromptPeerId((cur) => (cur === m.peerId ? null : m.peerId));
            setKickReason('');
          }}
          title={`Start a YES/NO vote to kick ${m.alias}`}
        >
          <Gavel size={11} />
          <span>Vote Kick</span>
        </button>
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
        style={opts.offline ? { opacity: 0.68 } : undefined}
      >
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <span
            className={`${styles.msgAvatar} ${
              opts.inVoice ? styles.voiceAvatarSpeaking : ''
            }`}
            style={{
              width: 34,
              height: 34,
              fontSize: 12,
              background: safeAvatarColor(m.color, m.alias),
            }}
          >
            {aliasInitials(m.alias)}
          </span>
          {!opts.inVoice && !opts.offline && (
            <span
              style={{
                position: 'absolute',
                right: -2,
                bottom: -2,
                width: 11,
                height: 11,
                borderRadius: 999,
                background: '#a1ffcb',
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
              <span>{peerVoiceChannelLabel.get(m.peerId) || 'In Voice'}</span>
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

  const removableChannels = pod
    ? pod.channels.filter((c) => c.slug !== 'general')
    : [];

  return (
    <aside className={styles.rightDrawer} aria-label="Workspace right panel">
      <div className={styles.drawerHeader}>
        <strong style={{ fontSize: 14.5 }}>
          {effectiveMode === 'members' &&
            `Pod Roster (${members.length}/${pod?.maxMembers || 25})`}
          {effectiveMode === 'votes' && `Pod Votes (${openBadgeCount} open)`}
          {effectiveMode === 'thread' && 'Thread'}
          {effectiveMode === 'pins' && 'Pinned Messages'}
          {effectiveMode === 'bookmarks' && 'Saved Bookmarks'}
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
          Roster
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
          aria-selected={effectiveMode === 'thread'}
          className={`${styles.drawerTabBtn} ${
            effectiveMode === 'thread' ? styles.drawerTabBtnActive : ''
          }`}
          onClick={() => setMode('thread')}
        >
          Thread
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
            Blind room: names, genders &amp; nationalities hidden
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
                      <span>In Voice — {inVoiceMembers.length}</span>
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
                      👑 Custom Group ({pod.isPublicized ? 'Publicized' : 'Private'})
                    </div>
                    <p className={styles.votesIntroText}>
                      This group uses Canopy Pro Admin moderation. Owners and
                      Admins manage channels, settings, and kicks directly.
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
                        {proposeOpen ? 'Close Proposal Sheet' : '+ Propose Pod Change'}
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

                  {propKind === 'ADD_CHANNEL' && (
                    <>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => setPropChannelKind('TEXT')}
                          className={`${styles.podOptionPill} ${
                            propChannelKind === 'TEXT'
                              ? styles.podOptionPillActive
                              : ''
                          }`}
                          style={{ flex: 1, minHeight: 40 }}
                        >
                          # Text Channel
                        </button>
                        <button
                          type="button"
                          onClick={() => setPropChannelKind('VOICE')}
                          className={`${styles.podOptionPill} ${
                            propChannelKind === 'VOICE'
                              ? styles.podOptionPillActive
                              : ''
                          }`}
                          style={{ flex: 1, minHeight: 40 }}
                        >
                          🔊 Voice Channel
                        </button>
                      </div>
                      <input
                        type="text"
                        value={propLabel}
                        onChange={(e) => setPropLabel(e.target.value)}
                        placeholder="Channel name (e.g. strategy-notes)"
                        maxLength={48}
                        required
                        className={styles.statusInput}
                        style={{ height: 42 }}
                        aria-label="Proposed channel name"
                      />
                      <input
                        type="text"
                        value={propTopic}
                        onChange={(e) => setPropTopic(e.target.value)}
                        placeholder="Channel topic (optional)"
                        maxLength={140}
                        className={styles.statusInput}
                        style={{ height: 42 }}
                        aria-label="Proposed channel topic"
                      />
                    </>
                  )}

                  {propKind === 'REMOVE_CHANNEL' && (
                    <label className={styles.inviteFieldGroup}>
                      <span className={styles.podOptionLabel}>
                        Channel to Remove (#general protected)
                      </span>
                      {removableChannels.length === 0 ? (
                        <p style={{ margin: 0, fontSize: 12, color: '#686868' }}>
                          Only #general exists right now.
                        </p>
                      ) : (
                        <select
                          className={styles.inviteSelect}
                          value={propTargetChannelId}
                          onChange={(e) =>
                            setPropTargetChannelId(e.target.value)
                          }
                          aria-label="Channel to remove"
                        >
                          {removableChannels.map((ch) => (
                            <option key={ch.channelId} value={ch.channelId}>
                              {ch.kind === 'VOICE' ? '🔊 ' : '#'}
                              {ch.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </label>
                  )}

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
                    <>
                      <label className={styles.inviteFieldGroup}>
                        <span className={styles.podOptionLabel}>Channel</span>
                        <select
                          className={styles.inviteSelect}
                          value={propTargetChannelId}
                          onChange={(e) =>
                            setPropTargetChannelId(e.target.value)
                          }
                          aria-label="Channel for topic update"
                        >
                          {pod.channels.map((ch) => (
                            <option key={ch.channelId} value={ch.channelId}>
                              {ch.kind === 'VOICE' ? '🔊 ' : '#'}
                              {ch.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <input
                        type="text"
                        value={propTopic}
                        onChange={(e) => setPropTopic(e.target.value)}
                        placeholder="New channel topic..."
                        maxLength={140}
                        required
                        className={styles.statusInput}
                        style={{ height: 42 }}
                        aria-label="New channel topic"
                      />
                    </>
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
                        Random Matching ({pod.allowRandomMatch ? 'Currently Unlocked' : 'Currently Locked'})
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

      {/* SLACK THREAD DRAWER */}
      {effectiveMode === 'thread' && (
        <>
          <div className={styles.drawerBody}>
            {!threadParentId || !pod || !channel ? (
              <p style={{ fontSize: 13, color: '#686868' }}>
                Click “Reply in Thread” on any channel message to open a focused
                Slack thread.
              </p>
            ) : threadQuery.isLoading ? (
              <p style={{ fontSize: 13, color: '#686868' }}>Loading thread...</p>
            ) : !threadQuery.data ? (
              <p style={{ fontSize: 13, color: '#686868' }}>
                Thread could not be loaded.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div
                  style={{
                    paddingBottom: 8,
                    borderBottom: '1px solid rgba(35,35,35,0.1)',
                  }}
                >
                  <MessageCard
                    message={threadQuery.data.parent}
                    myPeerId={pod.myPeerId}
                    knownAliases={knownAliases}
                    compact
                    allowThreadOpen={false}
                  />
                </div>

                <div className={styles.sectionHeader}>
                  <span>
                    {threadQuery.data.replies.length}{' '}
                    {threadQuery.data.replies.length === 1 ? 'Reply' : 'Replies'}
                  </span>
                </div>

                {threadQuery.data.replies.map((reply) => (
                  <MessageCard
                    key={reply.id}
                    message={reply}
                    myPeerId={pod.myPeerId}
                    knownAliases={knownAliases}
                    compact
                    allowThreadOpen={false}
                  />
                ))}
              </div>
            )}
          </div>

          {threadParentId && pod && channel && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (threadDraft.trim() && !threadReplyMutation.isPending) {
                  threadReplyMutation.mutate(threadDraft.trim());
                }
              }}
              style={{
                padding: 10,
                borderTop: '1px solid rgba(35,35,35,0.1)',
                background: '#ffffff',
                display: 'flex',
                gap: 6,
              }}
            >
              <input
                type="text"
                value={threadDraft}
                onChange={(e) => setThreadDraft(e.target.value)}
                placeholder="Reply in thread..."
                className={styles.statusInput}
                style={{ height: 44 }}
                aria-label="Reply in thread"
              />
              <button
                type="submit"
                className={styles.sendBtn}
                disabled={!threadDraft.trim() || threadReplyMutation.isPending}
                aria-label="Send thread reply"
              >
                <Send size={15} />
              </button>
            </form>
          )}
        </>
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
              No pinned messages in #{pod.code} yet. Hover any message and click
              the Pin icon.
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
                    allowThreadOpen={false}
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
              Loading saved bookmarks...
            </p>
          ) : (bookmarksQuery.data?.messages.length || 0) === 0 ? (
            <p style={{ fontSize: 13, color: '#686868' }}>
              No saved bookmarks yet. Click the Bookmark icon on any message to
              save it privately.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {bookmarksQuery.data!.messages.map((msg) => {
                const msgPod = allPods.find((p) => p.podId === msg.podId);
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
                          : `#${msgPod.code}`}
                      </div>
                    )}
                    <MessageCard
                      message={msg}
                      myPeerId={msgPod?.myPeerId || pod?.myPeerId || ''}
                      knownAliases={knownAliases}
                      compact
                      allowThreadOpen={false}
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
