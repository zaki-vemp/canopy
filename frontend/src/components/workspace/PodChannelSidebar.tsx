'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  Crown,
  LogOut,
  Mic,
  Plus,
  Radio,
  Scale,
  Search,
  Settings,
  Shuffle,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import {
  activeDmPeerByPodAtom,
  activePodIdAtom,
  adminSettingsPodIdAtom,
  interestModalOpenAtom,
  interestModalTabAtom,
  inviteModalPodIdAtom,
  mobileNavOpenAtom,
  presenceByPodAtom,
  rightPanelAtom,
  unreadByConvoAtom,
  voicePeersByPodAtom,
} from '@/state/workspaceAtoms';
import { useVoiceActions } from '@/state/voiceEngine';
import { aliasInitials, safeAvatarColor } from '@/components/workspace/markdown';
import {
  conversationKey,
  getPodTierLabel,
  sortMembersWithDmConversations,
  type DmConversationSummary,
  type LeavePodRequest,
  type PodDetail,
  type PodMember,
  type VoicePeer,
} from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

function formatShortTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface PodChannelSidebarProps {
  pod: PodDetail | null;
  allPods: PodDetail[];
  activePeerId: string | null;
  members: PodMember[];
}

export function PodChannelSidebar({
  pod,
  allPods,
  activePeerId,
  members,
}: PodChannelSidebarProps) {
  const queryClient = useQueryClient();
  const setActivePodId = useSetAtom(activePodIdAtom);
  const [dmPeerMap, setDmPeerMap] = useAtom(activeDmPeerByPodAtom);
  const [unreadMap, setUnreadMap] = useAtom(unreadByConvoAtom);
  const setInterestOpen = useSetAtom(interestModalOpenAtom);
  const setInterestTab = useSetAtom(interestModalTabAtom);
  const setInviteModalPodId = useSetAtom(inviteModalPodIdAtom);
  const setAdminSettingsPodId = useSetAtom(adminSettingsPodIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);
  const setMobileNavOpen = useSetAtom(mobileNavOpenAtom);
  const presenceByPod = useAtomValue(presenceByPodAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);

  const { session: voiceSession, leaveVoice } = useVoiceActions();

  const [statusInput, setStatusInput] = useState('');
  const [statusSavedMsg, setStatusSavedMsg] = useState(false);
  const [memberFilter, setMemberFilter] = useState('');
  const [leaveFeedback, setLeaveFeedback] = useState<string | null>(null);

  useEffect(() => {
    setStatusInput(pod?.myStatus || '');
    setMemberFilter('');
    setLeaveFeedback(null);
  }, [pod?.podId, pod?.myStatus]);

  const dmsQuery = useQuery<{ conversations: DmConversationSummary[] }>({
    queryKey: ['dms', pod?.podId || ''],
    queryFn: () =>
      apiFetch<{ conversations: DmConversationSummary[] }>(
        `/api/pods/${pod!.podId}/dms`
      ),
    enabled: Boolean(pod?.podId),
    staleTime: 10_000,
    initialData: pod?.dmConversations
      ? { conversations: pod.dmConversations }
      : undefined,
  });

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

  const dmConversations = useMemo<DmConversationSummary[]>(
    () => dmsQuery.data?.conversations ?? pod?.dmConversations ?? [],
    [dmsQuery.data?.conversations, pod?.dmConversations]
  );

  const dmMap = useMemo(() => {
    const map = new Map<string, DmConversationSummary>();
    for (const dm of dmConversations) {
      map.set(dm.peerId, dm);
    }
    return map;
  }, [dmConversations]);

  const orderedPeers = useMemo(() => {
    if (!pod) return [];
    return sortMembersWithDmConversations(members, pod.myPeerId, dmConversations);
  }, [dmConversations, members, pod]);

  const filteredPeers = useMemo(() => {
    const q = memberFilter.trim().toLowerCase();
    if (!q) return orderedPeers;
    return orderedPeers.filter((m) => {
      const dm = dmMap.get(m.peerId);
      return (
        m.alias.toLowerCase().includes(q) ||
        m.customStatus.toLowerCase().includes(q) ||
        (dm?.lastBody || '').toLowerCase().includes(q)
      );
    });
  }, [dmMap, memberFilter, orderedPeers]);

  if (!pod) {
    return (
      <aside className={styles.channelSidebar} aria-label="Pod conversations">
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

  const liveOccupancy =
    presenceByPod[pod.podId]?.members.length || members.length || pod.memberCount;
  const isAdminPod = pod.governanceMode === 'ADMIN';
  const canManageAdminPod =
    isAdminPod && (pod.myRole === 'OWNER' || pod.myRole === 'ADMIN');
  const tierLabel = getPodTierLabel(pod.maxMembers);
  const displayTitle = pod.title ? pod.title : `#${pod.code}`;

  const rawVoicePeers = voicePeersByPod[pod.podId] || [];
  const voicePeers: VoicePeer[] = [...rawVoicePeers];
  if (
    voiceSession.status === 'connected' &&
    voiceSession.podId === pod.podId &&
    !voicePeers.some((p) => p.peerId === pod.myPeerId)
  ) {
    voicePeers.unshift({
      peerId: pod.myPeerId,
      alias: pod.myAlias,
      color: pod.myColor,
      muted: voiceSession.muted,
      deafened: voiceSession.deafened,
      speaking: voiceSession.selfSpeaking,
    });
  }
  const voicePeerIdSet = new Set(voicePeers.map((p) => p.peerId));

  const groupConvoKey = conversationKey(pod.podId, null);
  const groupUnread = unreadMap[groupConvoKey] || 0;
  const isGroupSelected = activePeerId === null;

  const selectConversation = (peerId: string | null) => {
    setDmPeerMap({ ...dmPeerMap, [pod.podId]: peerId });
    const key = conversationKey(pod.podId, peerId);
    if (unreadMap[key]) {
      const copy = { ...unreadMap };
      delete copy[key];
      setUnreadMap(copy);
    }
    setMobileNavOpen(false);
  };

  return (
    <aside
      className={styles.channelSidebar}
      aria-label={`Pod ${displayTitle} conversations`}
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
                  Canopy Pro Group · {pod.isPublicized ? 'Publicized' : 'Private'}
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
                  <span>Manage</span>
                </button>
              )}
            </>
          ) : (
            <>
              <span className={styles.govModePillDemocratic}>
                <Scale size={12} />
                <span>Democratic · Vote-Run</span>
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
        {/* PINNED TOP CONVERSATION: POD GROUP CHAT */}
        <section aria-label="Pod Group Chat">
          <button
            type="button"
            className={`${styles.convoItem} ${styles.convoItemGroup} ${
              isGroupSelected ? styles.convoItemActive : ''
            }`}
            onClick={() => selectConversation(null)}
            aria-current={isGroupSelected ? 'page' : undefined}
          >
            <span className={styles.groupConvoAvatar} aria-hidden="true">
              <Users size={18} />
            </span>

            <span className={styles.convoBody}>
              <span className={styles.convoTopRow}>
                <span className={styles.convoTitle}>Pod Group Chat</span>
                {voicePeers.length > 0 && (
                  <span className={styles.convoCallPill}>
                    <Radio size={11} />
                    <span>In Call ({voicePeers.length})</span>
                  </span>
                )}
              </span>

              <span className={styles.convoBottomRow}>
                <span className={styles.convoSnippet}>
                  All {liveOccupancy}{' '}
                  {liveOccupancy === 1 ? 'member' : 'members'} · Polls &amp; Votes
                </span>
                {groupUnread > 0 && !isGroupSelected && (
                  <span
                    className={styles.unreadBadge}
                    aria-label={`${groupUnread} unread group messages`}
                  >
                    {groupUnread}
                  </span>
                )}
              </span>
            </span>
          </button>
        </section>

        {/* DIRECT MESSAGES / POD MEMBERS (PRIVATE 1:1 CHATS) */}
        <section aria-label="Direct messages with pod members">
          <div className={styles.sectionHeader}>
            <span>Private 1:1 Chats · {orderedPeers.length}</span>
          </div>

          {orderedPeers.length > 1 && (
            <div className={styles.memberSearchBox}>
              <Search size={14} color="#686868" aria-hidden="true" />
              <input
                type="text"
                value={memberFilter}
                onChange={(e) => setMemberFilter(e.target.value)}
                placeholder="Search members..."
                aria-label="Search pod members"
                className={styles.memberSearchInput}
              />
              {memberFilter && (
                <button
                  type="button"
                  className={styles.memberSearchClear}
                  onClick={() => setMemberFilter('')}
                  aria-label="Clear member search"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          )}

          {orderedPeers.length === 0 ? (
            <div className={styles.emptyDmHint}>
              No other members in #{pod.code} yet. Share an invite link or say
              hello in Pod Group Chat!
            </div>
          ) : filteredPeers.length === 0 ? (
            <div className={styles.emptyDmHint}>
              No members matching “{memberFilter}”.
            </div>
          ) : (
            <div className={styles.convoList}>
              {filteredPeers.map((member) => {
                const isSelected = activePeerId === member.peerId;
                const dm = dmMap.get(member.peerId);
                const dmKey = conversationKey(pod.podId, member.peerId);
                const unread = unreadMap[dmKey] || 0;
                const inCall =
                  Boolean(member.inVoice) || voicePeerIdSet.has(member.peerId);

                let snippet = 'Tap to chat privately';
                if (dm) {
                  const prefix =
                    dm.lastSenderPeerId === pod.myPeerId
                      ? 'You'
                      : dm.peerAlias || member.alias;
                  snippet = `${prefix}: ${dm.lastBody || 'Attachment'}`;
                } else if (member.customStatus) {
                  snippet = member.customStatus;
                }

                return (
                  <button
                    key={member.peerId}
                    type="button"
                    className={`${styles.convoItem} ${
                      isSelected ? styles.convoItemActive : ''
                    }`}
                    onClick={() => selectConversation(member.peerId)}
                    aria-current={isSelected ? 'page' : undefined}
                    aria-label={`Private 1:1 chat with ${member.alias}${
                      unread > 0 ? `, ${unread} unread` : ''
                    }`}
                  >
                    <span className={styles.convoAvatarWrap}>
                      <span
                        className={styles.convoAvatar}
                        style={{
                          background: safeAvatarColor(
                            member.color,
                            member.alias
                          ),
                        }}
                      >
                        {aliasInitials(member.alias)}
                      </span>
                      <span
                        className={`${styles.convoPresenceDot} ${
                          member.online
                            ? styles.convoPresenceOnline
                            : styles.convoPresenceOffline
                        }`}
                        aria-hidden="true"
                      />
                      {inCall && (
                        <span
                          className={styles.convoMicBadge}
                          title="In Pod Audio Call"
                          aria-label="In Pod Audio Call"
                        >
                          <Mic size={10} />
                        </span>
                      )}
                    </span>

                    <span className={styles.convoBody}>
                      <span className={styles.convoTopRow}>
                        <span className={styles.convoNameWrap}>
                          <span className={styles.convoTitle}>
                            {member.alias}
                          </span>
                          {member.role === 'OWNER' && (
                            <span className={styles.rolePillOwner}>OWNER</span>
                          )}
                          {member.role === 'ADMIN' && (
                            <span className={styles.rolePillAdmin}>ADMIN</span>
                          )}
                        </span>
                        {dm?.lastCreatedAt && (
                          <span className={styles.convoTime}>
                            {formatShortTime(dm.lastCreatedAt)}
                          </span>
                        )}
                      </span>

                      <span className={styles.convoBottomRow}>
                        <span
                          className={`${styles.convoSnippet} ${
                            unread > 0 && !isSelected
                              ? styles.convoSnippetUnread
                              : !dm && !member.customStatus
                                ? styles.convoSnippetMuted
                                : ''
                          }`}
                        >
                          {snippet}
                        </span>
                        {unread > 0 && !isSelected && (
                          <span className={styles.unreadBadge}>{unread}</span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
