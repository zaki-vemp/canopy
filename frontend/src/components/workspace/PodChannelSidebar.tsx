'use client';

import React, { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  AudioLines,
  Crown,
  Hash,
  HeadphoneOff,
  Headphones,
  LogOut,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  Radio,
  Scale,
  Settings,
  Shuffle,
  Sliders,
  UserPlus,
  Volume2,
} from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import {
  activeChannelIdMapAtom,
  activePodIdAtom,
  activeThreadMessageIdAtom,
  adminSettingsPodIdAtom,
  interestModalOpenAtom,
  interestModalTabAtom,
  inviteModalPodIdAtom,
  mobileNavOpenAtom,
  presenceByPodAtom,
  rightPanelAtom,
  unreadByChannelAtom,
  voiceRosterByPodAtom,
} from '@/state/workspaceAtoms';
import { syncProposalIntoCaches } from '@/state/wsPodClient';
import {
  remoteSpeakingMapAtom,
  useVoiceActions,
} from '@/state/voiceEngine';
import { aliasInitials, safeAvatarColor } from '@/components/workspace/markdown';
import {
  getPodTierLabel,
  type ChannelKind,
  type LeavePodRequest,
  type PodChannel,
  type PodDetail,
  type PodProposalDto,
  type VoicePeer,
} from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

interface PodChannelSidebarProps {
  pod: PodDetail | null;
  allPods: PodDetail[];
  activeChannelId: string | null;
}

export function PodChannelSidebar({
  pod,
  allPods,
  activeChannelId,
}: PodChannelSidebarProps) {
  const queryClient = useQueryClient();
  const setActivePodId = useSetAtom(activePodIdAtom);
  const [channelMap, setChannelMap] = useAtom(activeChannelIdMapAtom);
  const [unreadMap, setUnreadMap] = useAtom(unreadByChannelAtom);
  const setActiveThreadId = useSetAtom(activeThreadMessageIdAtom);
  const setInterestOpen = useSetAtom(interestModalOpenAtom);
  const setInterestTab = useSetAtom(interestModalTabAtom);
  const setInviteModalPodId = useSetAtom(inviteModalPodIdAtom);
  const setAdminSettingsPodId = useSetAtom(adminSettingsPodIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);
  const setMobileNavOpen = useSetAtom(mobileNavOpenAtom);
  const presenceByPod = useAtomValue(presenceByPodAtom);
  const voiceRosterByPod = useAtomValue(voiceRosterByPodAtom);
  const remoteSpeakingMap = useAtomValue(remoteSpeakingMapAtom);

  const {
    session: voiceSession,
    peerVolumes,
    joinVoice,
    leaveVoice,
    toggleMute,
    toggleDeafen,
    toggleTestTone,
    setPeerVolume,
  } = useVoiceActions();

  const [statusInput, setStatusInput] = useState('');
  const [statusSavedMsg, setStatusSavedMsg] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [newChannelLabel, setNewChannelLabel] = useState('');
  const [newChannelTopic, setNewChannelTopic] = useState('');
  const [newChannelKind, setNewChannelKind] = useState<ChannelKind>('TEXT');
  const [channelErr, setChannelErr] = useState<string | null>(null);
  const [openVolumePeerId, setOpenVolumePeerId] = useState<string | null>(null);
  const [leaveFeedback, setLeaveFeedback] = useState<string | null>(null);

  useEffect(() => {
    setStatusInput(pod?.myStatus || '');
    setShowCreateChannel(false);
    setChannelErr(null);
    setOpenVolumePeerId(null);
    setLeaveFeedback(null);
  }, [pod?.podId, pod?.myStatus]);

  const statusMutation = useMutation({
    mutationFn: async (customStatus: string) => {
      if (!pod) return;
      await apiFetch<{ ok: boolean }>(`/api/pods/${pod.podId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ customStatus }),
      });
      return customStatus;
    },
    onSuccess: (customStatus) => {
      if (!pod || customStatus === undefined) return;
      setStatusSavedMsg(true);
      setTimeout(() => setStatusSavedMsg(false), 1400);
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
        if (!old) return old;
        return {
          pods: old.pods.map((p) =>
            p.podId === pod.podId ? { ...p, myStatus: customStatus } : p
          ),
        };
      });
    },
  });

  const liveOccupancy = pod
    ? presenceByPod[pod.podId]?.members.length || pod.memberCount
    : 0;
  const isAdminPod = pod?.governanceMode === 'ADMIN';
  const canManageAdminPod =
    isAdminPod && (pod?.myRole === 'OWNER' || pod?.myRole === 'ADMIN');
  const requiresChannelVote = Boolean(
    pod && !isAdminPod && Math.max(liveOccupancy, pod.memberCount) > 1
  );
  const canShowAddChannelBtn = Boolean(
    pod && (!isAdminPod || canManageAdminPod)
  );

  const submitAddChannelProposal = async () => {
    if (!pod) return null;
    const res = await apiFetch<{
      proposal: PodProposalDto;
      pod?: PodDetail | null;
    }>(`/api/pods/${pod.podId}/proposals`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'ADD_CHANNEL',
        label: newChannelLabel.trim(),
        topic: newChannelTopic.trim(),
        channelKind: newChannelKind,
      }),
    });
    syncProposalIntoCaches(queryClient, pod.podId, res.proposal, res.pod);
    queryClient.invalidateQueries({ queryKey: ['messages', pod.podId] });
    queryClient.invalidateQueries({ queryKey: ['pods'] });
    setNewChannelLabel('');
    setNewChannelTopic('');
    setShowCreateChannel(false);
    setMobileNavOpen(false);
    setRightPanel('votes');
    return null;
  };

  const createChannelMutation = useMutation({
    mutationFn: async () => {
      if (!pod || !newChannelLabel.trim()) return null;
      if (requiresChannelVote) {
        return submitAddChannelProposal();
      }
      try {
        return await apiFetch<{ channel: PodChannel }>(
          `/api/pods/${pod.podId}/channels`,
          {
            method: 'POST',
            body: JSON.stringify({
              label: newChannelLabel.trim(),
              topic: newChannelTopic.trim(),
              kind: newChannelKind,
            }),
          }
        );
      } catch (err) {
        if (
          !isAdminPod &&
          err instanceof ApiError &&
          (err.status === 403 || err.status === 409)
        ) {
          return submitAddChannelProposal();
        }
        throw err;
      }
    },
    onSuccess: (res) => {
      setChannelErr(null);
      if (!pod || !res?.channel) return;
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
        if (!old) return old;
        return {
          pods: old.pods.map((p) => {
            if (p.podId !== pod.podId) return p;
            if (p.channels.some((c) => c.channelId === res.channel.channelId)) {
              return p;
            }
            return {
              ...p,
              channels: [...p.channels, res.channel],
            };
          }),
        };
      });
      if (res.channel.kind === 'TEXT') {
        setChannelMap({ ...channelMap, [pod.podId]: res.channel.channelId });
      }
      setNewChannelLabel('');
      setNewChannelTopic('');
      setShowCreateChannel(false);
    },
    onError: (err: Error) => {
      setChannelErr(err.message || 'Could not create channel');
    },
  });

  const leaveOrRematchMutation = useMutation({
    mutationFn: async (rematch: boolean) => {
      if (!pod) return null;
      if (voiceSession.podId === pod.podId) {
        leaveVoice();
      }
      const payload: LeavePodRequest = { rematch };
      return apiFetch<{ leftPodId: string; newPod: PodDetail | null }>(
        `/api/pods/${pod.podId}/leave`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      );
    },
    onSuccess: (res, rematch) => {
      if (!res) return;
      const remaining = allPods.filter((p) => p.podId !== res.leftPodId);
      const nextList = res.newPod ? [...remaining, res.newPod] : remaining;
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
        pods: nextList,
      });
      queryClient.invalidateQueries({ queryKey: ['interests'] });

      if (res.newPod) {
        setActivePodId(res.newPod.podId);
      } else if (nextList.length > 0) {
        setActivePodId(nextList[0].podId);
        if (rematch) {
          setLeaveFeedback('No other open pod found for that interest yet.');
        }
      } else {
        setActivePodId(null);
        setInterestTab('match');
        setInterestOpen(true);
      }
    },
  });

  if (!pod) {
    return (
      <aside className={styles.channelSidebar} aria-label="Pod channels">
        <div className={styles.podHeader}>
          <h2 className={styles.podCode}>No Pod Selected</h2>
          <p style={{ fontSize: 13, color: '#686868', margin: '8px 0 12px' }}>
            Match by shared interest to join 25-member democratic blind pods
            (Compact 10, Standard 25, or Club 50 seats) or publicized groups.
          </p>
          <button
            type="button"
            className={styles.primaryActionBtn}
            style={{ width: '100%' }}
            onClick={() => {
              setInterestTab('match');
              setInterestOpen(true);
              setMobileNavOpen(false);
            }}
          >
            + Match 25-Seat Pod
          </button>
        </div>
      </aside>
    );
  }

  const textChannels = pod.channels.filter((c) => c.kind === 'TEXT');
  const voiceChannels = pod.channels.filter((c) => c.kind === 'VOICE');
  const podVoiceRoster = voiceRosterByPod[pod.podId] || {};
  const tierLabel = getPodTierLabel(pod.maxMembers);
  const displayTitle = pod.title ? pod.title : `#${pod.code}`;

  const handleSelectTextChannel = (channelId: string) => {
    setChannelMap({ ...channelMap, [pod.podId]: channelId });
    setActiveThreadId(null);
    if (unreadMap[channelId]) {
      const copy = { ...unreadMap };
      delete copy[channelId];
      setUnreadMap(copy);
    }
    setMobileNavOpen(false);
  };

  const getChannelVoicePeers = (voiceChannelId: string): VoicePeer[] => {
    const list = podVoiceRoster[voiceChannelId]
      ? [...podVoiceRoster[voiceChannelId]]
      : [];
    if (
      voiceSession.status === 'connected' &&
      voiceSession.podId === pod.podId &&
      voiceSession.voiceChannelId === voiceChannelId &&
      !list.some((p) => p.peerId === pod.myPeerId)
    ) {
      list.unshift({
        peerId: pod.myPeerId,
        alias: pod.myAlias,
        color: pod.myColor,
        muted: voiceSession.muted,
        deafened: voiceSession.deafened,
        speaking: voiceSession.selfSpeaking,
      });
    }
    return list;
  };

  return (
    <aside
      className={styles.channelSidebar}
      aria-label={`Pod ${displayTitle} sidebar`}
    >
      <div className={styles.podHeader}>
        <div className={styles.podTitleRow}>
          <h2 className={styles.podCode} title={displayTitle}>
            {displayTitle}
          </h2>
          <span className={styles.interestBadge}>{pod.interestLabel}</span>
        </div>

        {pod.title && (
          <div className={styles.podHandleSubline}>#{pod.code}</div>
        )}

        {pod.description && (
          <div className={styles.podDescLine} title={pod.description}>
            {pod.description}
          </div>
        )}

        <div className={styles.podOccupancyRow}>
          <span className={styles.tierBadge}>
            {liveOccupancy}/{pod.maxMembers} · {tierLabel}
          </span>
          {allPods.length > 1 && (
            <button
              type="button"
              className={styles.podSwitchInlineBtn}
              onClick={() => {
                setInterestTab('pods');
                setInterestOpen(true);
                setMobileNavOpen(false);
              }}
            >
              {allPods.length} active pods →
            </button>
          )}
        </div>

        {/* Governance Pill + Votes / Manage Action */}
        <div className={styles.podGovBar}>
          {isAdminPod ? (
            <>
              <span className={styles.govModePillAdmin}>
                <Crown size={12} />
                <span>
                  👑 Custom Group ·{' '}
                  {pod.isPublicized ? 'Publicized' : 'Private'}
                </span>
              </span>
              {canManageAdminPod && (
                <button
                  type="button"
                  className={styles.govActionBtn}
                  onClick={() => {
                    setMobileNavOpen(false);
                    setAdminSettingsPodId(pod.podId);
                  }}
                >
                  <Settings size={12} />
                  <span>Manage Group</span>
                </button>
              )}
            </>
          ) : (
            <>
              <span className={styles.govModePillDemocratic}>
                <Scale size={12} />
                <span>⚖️ Democratic · Vote-Run</span>
              </span>
              <button
                type="button"
                className={styles.govActionBtn}
                onClick={() => {
                  setMobileNavOpen(false);
                  setRightPanel('votes');
                }}
              >
                <span>Votes ({pod.openProposalsCount || 0})</span>
              </button>
            </>
          )}
        </div>

        <div className={styles.aliasCard}>
          <div className={styles.aliasLine}>
            <span
              className={styles.aliasSwatch}
              style={{ background: safeAvatarColor(pod.myColor, pod.myAlias) }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              You are <strong>{pod.myAlias}</strong>
            </span>
            {pod.myRole === 'OWNER' && (
              <span className={styles.rolePillOwner}>OWNER</span>
            )}
            {pod.myRole === 'ADMIN' && (
              <span className={styles.rolePillAdmin}>ADMIN</span>
            )}
          </div>

          <form
            className={styles.statusForm}
            onSubmit={(e) => {
              e.preventDefault();
              statusMutation.mutate(statusInput.trim());
            }}
          >
            <input
              type="text"
              value={statusInput}
              onChange={(e) => setStatusInput(e.target.value)}
              placeholder="Set pod status..."
              maxLength={80}
              aria-label="Set pod status"
              className={styles.statusInput}
            />
            <button
              type="submit"
              className={styles.statusSaveBtn}
              disabled={statusMutation.isPending}
            >
              {statusSavedMsg ? 'Saved' : 'Set'}
            </button>
          </form>
        </div>

        <div className={styles.podActionsRow}>
          <button
            type="button"
            className={styles.inviteSidebarBtn}
            onClick={() => {
              setMobileNavOpen(false);
              setInviteModalPodId(pod.podId);
            }}
            aria-label={`Invite or share link to pod #${pod.code}`}
            title="Share invite link or code for this blind pod"
          >
            <UserPlus size={15} />
            <span>Invite / Share</span>
          </button>

          {!isAdminPod && (
            <button
              type="button"
              className={styles.rematchBtn}
              disabled={leaveOrRematchMutation.isPending}
              onClick={() => leaveOrRematchMutation.mutate(true)}
              title="Opt out of this pod and join another random 25-member pod for this interest"
            >
              <Shuffle size={14} />
              <span>Switch Random Pod</span>
            </button>
          )}

          <button
            type="button"
            className={styles.addPodBtn}
            onClick={() => {
              setInterestTab('match');
              setInterestOpen(true);
              setMobileNavOpen(false);
            }}
            aria-label="Join or create an additional pod"
            title="Join or create another 25-member pod (10 / 25 / 50 seats)"
          >
            <Plus size={14} />
            <span>+ Pod</span>
          </button>
          <button
            type="button"
            className={styles.leaveBtn}
            disabled={leaveOrRematchMutation.isPending}
            onClick={() => leaveOrRematchMutation.mutate(false)}
            aria-label="Leave Pod"
            title="Leave Pod"
          >
            <LogOut size={14} />
            <span>Leave</span>
          </button>
        </div>

        {leaveFeedback && (
          <div
            style={{
              marginTop: 6,
              fontSize: 11.5,
              color: '#686868',
            }}
          >
            {leaveFeedback}
          </div>
        )}
      </div>

      <div className={styles.sidebarScroll}>
        {/* TEXT CHANNELS */}
        <section aria-label="Text channels">
          <div className={styles.sectionHeader}>
            <span>Text Channels</span>
            {canShowAddChannelBtn && (
              <button
                type="button"
                className={styles.iconSmallBtn}
                onClick={() => {
                  setChannelErr(null);
                  setShowCreateChannel((v) => !v);
                }}
                aria-label={
                  requiresChannelVote
                    ? 'Propose new channel vote'
                    : 'Create sub-channel'
                }
                title={
                  requiresChannelVote
                    ? 'Propose Channel Vote (Democratic YES/NO)'
                    : 'Create channel in pod'
                }
              >
                <Plus size={15} />
              </button>
            )}
          </div>

          {showCreateChannel && canShowAddChannelBtn && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createChannelMutation.mutate();
              }}
              style={{
                padding: 10,
                marginBottom: 8,
                borderRadius: 9,
                background: '#ffffff',
                border: '1px solid rgba(35,35,35,0.13)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              {requiresChannelVote && (
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: 'var(--m-font-mono)',
                    color: '#154726',
                    fontWeight: 600,
                  }}
                >
                  ⚖️ Democratic pod: starts a YES/NO channel vote
                </div>
              )}
              {channelErr && (
                <div
                  style={{
                    padding: '5px 8px',
                    borderRadius: 6,
                    background: '#fef3f2',
                    color: '#b42318',
                    fontSize: 11.5,
                  }}
                  role="alert"
                >
                  {channelErr}
                </div>
              )}
              <input
                type="text"
                value={newChannelLabel}
                onChange={(e) => setNewChannelLabel(e.target.value)}
                placeholder="Channel name (e.g. strategy-notes)"
                maxLength={48}
                required
                className={styles.statusInput}
                aria-label="New channel name"
              />
              <input
                type="text"
                value={newChannelTopic}
                onChange={(e) => setNewChannelTopic(e.target.value)}
                placeholder="Topic (optional)"
                maxLength={140}
                className={styles.statusInput}
                aria-label="New channel topic"
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setNewChannelKind('TEXT')}
                  className={styles.statusSaveBtn}
                  style={{
                    flex: 1,
                    background: newChannelKind === 'TEXT' ? '#a1ffcb' : '#ffffff',
                  }}
                >
                  # Text
                </button>
                <button
                  type="button"
                  onClick={() => setNewChannelKind('VOICE')}
                  className={styles.statusSaveBtn}
                  style={{
                    flex: 1,
                    background:
                      newChannelKind === 'VOICE' ? '#a1ffcb' : '#ffffff',
                  }}
                >
                  Voice
                </button>
              </div>
              <button
                type="submit"
                className={styles.statusSaveBtn}
                style={{
                  minHeight: 40,
                  background: '#191b19',
                  color: '#a1ffcb',
                }}
                disabled={createChannelMutation.isPending}
              >
                {createChannelMutation.isPending
                  ? 'Submitting...'
                  : requiresChannelVote
                    ? 'Propose Channel Vote'
                    : 'Create Channel'}
              </button>
            </form>
          )}

          {textChannels.map((ch) => {
            const isActive = ch.channelId === activeChannelId;
            const unread = unreadMap[ch.channelId] || 0;
            return (
              <button
                key={ch.channelId}
                type="button"
                className={`${styles.channelItem} ${
                  isActive ? styles.channelItemActive : ''
                }`}
                onClick={() => handleSelectTextChannel(ch.channelId)}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className={styles.channelLabelGroup}>
                  <Hash size={16} aria-hidden="true" />
                  <span className={styles.channelName}>{ch.label}</span>
                </span>
                {unread > 0 && !isActive && (
                  <span className={styles.unreadBadge}>{unread}</span>
                )}
              </button>
            );
          })}
        </section>

        {/* VOICE CHANNELS */}
        <section aria-label="Voice channels">
          <div className={styles.sectionHeader}>
            <span>Voice Channels</span>
          </div>

          {voiceChannels.map((vch) => {
            const connectedHere =
              voiceSession.status !== 'idle' &&
              voiceSession.podId === pod.podId &&
              voiceSession.voiceChannelId === vch.channelId;
            const peers = getChannelVoicePeers(vch.channelId);

            return (
              <div key={vch.channelId}>
                <button
                  type="button"
                  className={`${styles.channelItem} ${
                    connectedHere ? styles.channelItemVoiceActive : ''
                  }`}
                  onClick={() => joinVoice(pod.podId, vch.channelId, vch.label)}
                  aria-label={`Join voice channel ${vch.label}`}
                >
                  <span className={styles.channelLabelGroup}>
                    <Volume2 size={16} aria-hidden="true" />
                    <span className={styles.channelName}>{vch.label}</span>
                  </span>
                  {peers.length > 0 && (
                    <span className={styles.unreadBadge}>{peers.length}</span>
                  )}
                </button>

                {peers.length > 0 && (
                  <div className={styles.voicePeersTree}>
                    {peers.map((peer) => {
                      const isSelf = peer.peerId === pod.myPeerId;
                      const speaking = isSelf
                        ? voiceSession.selfSpeaking || peer.speaking
                        : Boolean(
                            peer.speaking || remoteSpeakingMap[peer.peerId]
                          );
                      const peerVolPct = Math.round(
                        (peerVolumes[peer.peerId] ?? 1) * 100
                      );

                      return (
                        <div key={peer.peerId}>
                          <div className={styles.voicePeerRow}>
                            <div className={styles.voicePeerIdentity}>
                              <span
                                className={`${styles.voiceAvatar} ${
                                  speaking ? styles.voiceAvatarSpeaking : ''
                                }`}
                                style={{
                                  background: safeAvatarColor(
                                    peer.color,
                                    peer.alias
                                  ),
                                }}
                              >
                                {aliasInitials(peer.alias)}
                              </span>
                              <span
                                style={{
                                  fontWeight: isSelf ? 700 : 500,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {peer.alias}
                                {isSelf ? ' (you)' : ''}
                              </span>
                            </div>

                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                              }}
                            >
                              {peer.muted && (
                                <MicOff
                                  size={13}
                                  color="#b42318"
                                  aria-label="Muted"
                                />
                              )}
                              {peer.deafened && (
                                <HeadphoneOff
                                  size={13}
                                  color="#b42318"
                                  aria-label="Deafened"
                                />
                              )}
                              {!isSelf && (
                                <button
                                  type="button"
                                  className={styles.iconSmallBtn}
                                  style={{ width: 26, height: 26 }}
                                  onClick={() =>
                                    setOpenVolumePeerId((cur) =>
                                      cur === peer.peerId ? null : peer.peerId
                                    )
                                  }
                                  aria-label={`Adjust volume for ${peer.alias}`}
                                  title={`Peer volume (${peerVolPct}%)`}
                                >
                                  <Sliders size={13} />
                                </button>
                              )}
                            </div>
                          </div>

                          {!isSelf && openVolumePeerId === peer.peerId && (
                            <div className={styles.volumePopover}>
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  marginBottom: 4,
                                }}
                              >
                                <span>{peer.alias} Volume</span>
                                <strong>{peerVolPct}%</strong>
                              </div>
                              <input
                                type="range"
                                min={0}
                                max={150}
                                step={5}
                                value={peerVolPct}
                                onChange={(e) =>
                                  setPeerVolume(
                                    peer.peerId,
                                    Number(e.target.value) / 100
                                  )
                                }
                                className={styles.volumeSlider}
                                aria-label={`${peer.alias} volume percentage`}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>

      {/* DOCKED VOICE CONNECTION BAR */}
      {voiceSession.status !== 'idle' && (
        <div
          className={styles.voiceDock}
          role="region"
          aria-label="Voice connection controls"
        >
          <div className={styles.voiceDockTop}>
            <div>
              <div className={styles.voiceDockStatus}>
                <Radio size={14} />
                <span>
                  {voiceSession.status === 'connecting'
                    ? 'Connecting Voice...'
                    : `Voice Connected · ${voiceSession.voiceChannelLabel}`}
                </span>
              </div>
              <div className={styles.voiceDockSub}>
                WebRTC P2P Opus Mesh · #{pod.code}
              </div>
            </div>
          </div>

          {voiceSession.fallbackBanner && (
            <div className={styles.synthBanner} role="status">
              {voiceSession.fallbackBanner}
            </div>
          )}

          <div className={styles.voiceDockControls}>
            <button
              type="button"
              className={`${styles.voiceCtrlBtn} ${
                voiceSession.muted ? styles.voiceCtrlBtnActive : ''
              }`}
              onClick={toggleMute}
              aria-pressed={voiceSession.muted}
              aria-label={
                voiceSession.muted ? 'Unmute microphone' : 'Mute microphone'
              }
            >
              {voiceSession.muted ? <MicOff size={16} /> : <Mic size={16} />}
              <span>{voiceSession.muted ? 'Unmute' : 'Mute'}</span>
            </button>

            <button
              type="button"
              className={`${styles.voiceCtrlBtn} ${
                voiceSession.deafened ? styles.voiceCtrlBtnActive : ''
              }`}
              onClick={toggleDeafen}
              aria-pressed={voiceSession.deafened}
              aria-label={
                voiceSession.deafened ? 'Undeafen audio' : 'Deafen audio'
              }
            >
              {voiceSession.deafened ? (
                <HeadphoneOff size={16} />
              ) : (
                <Headphones size={16} />
              )}
              <span>{voiceSession.deafened ? 'Deaf' : 'Deafen'}</span>
            </button>

            <button
              type="button"
              className={`${styles.voiceCtrlBtn} ${
                voiceSession.testToneActive ? styles.voiceCtrlBtnActive : ''
              }`}
              onClick={toggleTestTone}
              aria-pressed={voiceSession.testToneActive}
              aria-label="Toggle 240Hz/360Hz synth voice test tone"
            >
              <AudioLines size={16} />
              <span>Test Tone</span>
            </button>

            <button
              type="button"
              className={`${styles.voiceCtrlBtn} ${styles.voiceCtrlBtnDanger}`}
              onClick={leaveVoice}
              aria-label="Disconnect from voice channel"
            >
              <PhoneOff size={16} />
              <span>Leave</span>
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
