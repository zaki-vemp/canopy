import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { getWsBaseUrl } from './client';
import { emitSocketOpen, emitWebRtcSignal } from '../voice/signals';
import {
  activeDmCallAtom,
  activeDmPeerByPodAtom,
  activePodIdAtom,
  activeTabAtom,
  activeVoiceSessionAtom,
  apiBaseUrlAtom,
  authTokenAtom,
  callNoticeAtom,
  dmConvoKey,
  peerLastReadByPodPeerAtom,
  podPresenceByPodAtom,
  typingByConvoAtom,
  unreadDmByPodPeerAtom,
  unreadGroupByPodAtom,
  voicePeersByPodAtom,
  wsConnectedAtom,
} from '../state/atoms';
import {
  resolveDmPartnerPeerId,
  type DmSummaryDto,
  type MessagesPage,
  type PodDetailDto,
  type PodProposalDto,
  type RichMessageDto,
  type WsInboundFrame,
  type WsOutboundFrame,
} from '../types/canopy';

type MessageInfiniteCache = InfiniteData<MessagesPage, number>;
type PodsListCache = { pods: PodDetailDto[] };
type DmsListCache = { conversations: DmSummaryDto[] };
type PinsListCache = { messages: RichMessageDto[] };
type ProposalsListCache = { proposals: PodProposalDto[] };

function upsertMessageInPages(
  oldData: MessageInfiniteCache | undefined,
  incoming: RichMessageDto,
  appendIfMissing: boolean
): MessageInfiniteCache | undefined {
  if (!oldData) return oldData;
  let found = false;
  const pages = oldData.pages.map((page) => ({
    ...page,
    messages: page.messages.map((m) => {
      if (m.id === incoming.id) {
        found = true;
        return { ...incoming, isBookmarked: m.isBookmarked };
      }
      return m;
    }),
  }));

  if (!found && appendIfMissing && pages.length > 0) {
    const first = pages[0];
    pages[0] = {
      ...first,
      messages: [...first.messages, incoming],
    };
  }
  return { ...oldData, pages };
}

function upsertDmSummaryList(
  existingList: DmSummaryDto[],
  partnerPeerId: string,
  msg: RichMessageDto,
  pod: PodDetailDto | undefined,
  unreadDelta: number
): DmSummaryDto[] {
  const prev = existingList.find((c) => c.peerId === partnerPeerId);
  const member = pod?.members.find((m) => m.peerId === partnerPeerId);
  const isFromPartner = msg.senderPeerId === partnerPeerId;

  const summary: DmSummaryDto = {
    peerId: partnerPeerId,
    peerAlias: isFromPartner
      ? msg.senderAlias
      : msg.recipientAlias || prev?.peerAlias || member?.alias || 'Peer',
    peerColor: isFromPartner
      ? msg.senderColor
      : prev?.peerColor || member?.color || '#1f6b3a',
    online: member?.online ?? prev?.online ?? true,
    lastMessageId: msg.id,
    lastBody:
      msg.body ||
      (msg.attachments && msg.attachments.length > 0 ? 'Voice note' : ''),
    lastSenderPeerId: msg.senderPeerId,
    lastSenderAlias: msg.senderAlias,
    lastCreatedAt: msg.createdAt,
    unreadCount:
      unreadDelta > 0
        ? (prev?.unreadCount ?? 0) + unreadDelta
        : isFromPartner
        ? prev?.unreadCount ?? 0
        : 0,
    peerLastReadMessageId: prev?.peerLastReadMessageId ?? 0,
  };

  return [
    summary,
    ...existingList.filter((c) => c.peerId !== partnerPeerId),
  ];
}

export interface PodSocketController {
  sendFrame: (frame: WsOutboundFrame) => boolean;
}

/**
 * Connects to ws://<host>/ws/pods/{podId}?token=<jwt> for the active pod,
 * patching Group Chat, 1:1 DM, read cursors, and private 1:1 audio call atoms in real time.
 * ponytail: reconnects with bounded exponential backoff (1s -> 8s) for the single active pod;
 * upgrade to multiplexed multi-pod socket if background pod push badges are needed.
 */
export function usePodSocket(podId: string | null): PodSocketController {
  const queryClient = useQueryClient();
  const store = useStore();
  const token = useAtomValue(authTokenAtom);
  const apiBaseUrl = useAtomValue(apiBaseUrlAtom);
  const activeTab = useAtomValue(activeTabAtom);
  const activeDmPeerByPod = useAtomValue(activeDmPeerByPodAtom);

  const setConnected = useSetAtom(wsConnectedAtom);
  const setPresenceByPod = useSetAtom(podPresenceByPodAtom);
  const setTypingByConvo = useSetAtom(typingByConvoAtom);
  const setVoicePeersByPod = useSetAtom(voicePeersByPodAtom);
  const setActiveDmPeerMap = useSetAtom(activeDmPeerByPodAtom);
  const setUnreadGroupMap = useSetAtom(unreadGroupByPodAtom);
  const setUnreadDmMap = useSetAtom(unreadDmByPodPeerAtom);
  const setPeerLastReadMap = useSetAtom(peerLastReadByPodPeerAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const setVoiceSession = useSetAtom(activeVoiceSessionAtom);
  const setActiveDmCall = useSetAtom(activeDmCallAtom);
  const setCallNotice = useSetAtom(callNoticeAtom);

  const wsRef = useRef<WebSocket | null>(null);
  const selfPeerIdRef = useRef<string | null>(null);
  const activeTabRef = useRef(activeTab);
  const activeDmPeerMapRef = useRef(activeDmPeerByPod);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    activeDmPeerMapRef.current = activeDmPeerByPod;
  }, [activeDmPeerByPod]);

  const sendFrame = useCallback((frame: WsOutboundFrame): boolean => {
    const sock = wsRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      sock.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    selfPeerIdRef.current = null;
    if (!podId || !token) {
      setConnected(false);
      return;
    }

    let cancelled = false;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const getSelfPeerId = (): string | null => {
      if (selfPeerIdRef.current) return selfPeerIdRef.current;
      const cachedPods = queryClient.getQueryData<PodsListCache>(['pods']);
      const found = cachedPods?.pods.find((p) => p.podId === podId);
      if (found?.myPeerId) {
        selfPeerIdRef.current = found.myPeerId;
        return found.myPeerId;
      }
      return null;
    };

    const getConvoQueryKey = (partnerPeerId: string | null) =>
      partnerPeerId
        ? (['messages', podId, 'dm', partnerPeerId] as const)
        : (['messages', podId, 'group'] as const);

    const handleInbound = (frame: WsInboundFrame) => {
      switch (frame.type) {
        case 'presence_snapshot': {
          selfPeerIdRef.current = frame.selfPeerId;
          const onlineSet = new Set(frame.onlinePeerIds ?? []);
          const voicePeers = frame.voicePeers ?? [];
          setPresenceByPod((prev) => ({
            ...prev,
            [frame.podId]: {
              selfPeerId: frame.selfPeerId,
              onlinePeerIds: frame.onlinePeerIds,
              members: frame.members,
            },
          }));
          setVoicePeersByPod((prev) => ({
            ...prev,
            [frame.podId]: voicePeers,
          }));
          queryClient.setQueryData(
            ['pods'],
            (oldPods: PodsListCache | undefined) => {
              if (!oldPods) return oldPods;
              return {
                pods: oldPods.pods.map((p) =>
                  p.podId === frame.podId
                    ? {
                        ...p,
                        members: frame.members,
                        memberCount: frame.members.length,
                        dmConversations: (p.dmConversations ?? []).map((dm) => ({
                          ...dm,
                          online: onlineSet.has(dm.peerId),
                        })),
                      }
                    : p
                ),
              };
            }
          );
          queryClient.setQueryData(
            ['dms', frame.podId],
            (oldDms: DmsListCache | undefined) =>
              oldDms
                ? {
                    conversations: oldDms.conversations.map((dm) => ({
                      ...dm,
                      online: onlineSet.has(dm.peerId),
                    })),
                  }
                : oldDms
          );
          break;
        }

        case 'typing_update': {
          const selfId = getSelfPeerId();
          if (!frame.targetPeerId) {
            setTypingByConvo((prev) => ({
              ...prev,
              [dmConvoKey(podId, null)]: frame.typingAliases,
            }));
          } else {
            const partner = frame.fromPeerId
              ? resolveDmPartnerPeerId(
                  selfId,
                  frame.fromPeerId,
                  frame.targetPeerId
                )
              : frame.targetPeerId !== selfId
              ? frame.targetPeerId
              : null;

            if (partner) {
              setTypingByConvo((prev) => ({
                ...prev,
                [dmConvoKey(podId, partner)]: frame.typingAliases,
              }));
            } else if (frame.typingAliases.length === 0) {
              setTypingByConvo((prev) => {
                const next = { ...prev };
                const prefix = `${podId}:dm:`;
                for (const key of Object.keys(next)) {
                  if (key.startsWith(prefix)) {
                    next[key] = [];
                  }
                }
                return next;
              });
            }
          }
          break;
        }

        case 'message_created': {
          const msg = frame.message;
          const selfId = getSelfPeerId();
          const partnerPeerId = resolveDmPartnerPeerId(
            selfId,
            msg.senderPeerId,
            msg.recipientPeerId
          );

          queryClient.setQueryData(
            getConvoQueryKey(partnerPeerId),
            (old: MessageInfiniteCache | undefined) =>
              upsertMessageInPages(old, msg, true)
          );

          if (partnerPeerId === null) {
            const viewingGroup =
              activeTabRef.current === 'chat' &&
              (activeDmPeerMapRef.current[podId] ?? null) === null;
            if (selfId && msg.senderPeerId !== selfId && !viewingGroup) {
              setUnreadGroupMap((prev) => ({
                ...prev,
                [podId]: (prev[podId] ?? 0) + 1,
              }));
              queryClient.setQueryData(
                ['pods'],
                (oldPods: PodsListCache | undefined) =>
                  oldPods
                    ? {
                        pods: oldPods.pods.map((p) =>
                          p.podId === podId
                            ? {
                                ...p,
                                unreadGroupCount: (p.unreadGroupCount ?? 0) + 1,
                              }
                            : p
                        ),
                      }
                    : oldPods
              );
            }
          } else {
            const viewingThisDm =
              activeTabRef.current === 'chat' &&
              (activeDmPeerMapRef.current[podId] ?? null) === partnerPeerId;
            const unreadDelta =
              selfId && msg.senderPeerId !== selfId && !viewingThisDm ? 1 : 0;

            const cachedPods = queryClient.getQueryData<PodsListCache>(['pods']);
            const currentPod = cachedPods?.pods.find((p) => p.podId === podId);

            queryClient.setQueryData(
              ['dms', podId],
              (oldDms: DmsListCache | undefined) => ({
                conversations: upsertDmSummaryList(
                  oldDms?.conversations ?? currentPod?.dmConversations ?? [],
                  partnerPeerId,
                  msg,
                  currentPod,
                  unreadDelta
                ),
              })
            );

            queryClient.setQueryData(
              ['pods'],
              (oldPods: PodsListCache | undefined) => {
                if (!oldPods) return oldPods;
                return {
                  pods: oldPods.pods.map((p) =>
                    p.podId === podId
                      ? {
                          ...p,
                          dmConversations: upsertDmSummaryList(
                            p.dmConversations ?? [],
                            partnerPeerId,
                            msg,
                            p,
                            unreadDelta
                          ),
                        }
                      : p
                  ),
                };
              }
            );

            if (unreadDelta > 0) {
              const unreadKey = dmConvoKey(podId, partnerPeerId);
              setUnreadDmMap((prev) => ({
                ...prev,
                [unreadKey]: (prev[unreadKey] ?? 0) + 1,
              }));
            }
          }
          break;
        }

        case 'dm_read': {
          const selfId = getSelfPeerId();
          if (selfId && frame.peerId !== selfId) {
            const partnerPeerId = frame.peerId;
            const key = dmConvoKey(podId, partnerPeerId);
            setPeerLastReadMap((prev) => ({
              ...prev,
              [key]: Math.max(prev[key] ?? 0, frame.lastReadMessageId),
            }));

            queryClient.setQueryData(
              ['dms', podId],
              (oldDms: DmsListCache | undefined) =>
                oldDms
                  ? {
                      conversations: oldDms.conversations.map((dm) =>
                        dm.peerId === partnerPeerId
                          ? {
                              ...dm,
                              peerLastReadMessageId: Math.max(
                                dm.peerLastReadMessageId ?? 0,
                                frame.lastReadMessageId
                              ),
                            }
                          : dm
                      ),
                    }
                  : oldDms
            );

            queryClient.setQueryData(
              ['pods'],
              (oldPods: PodsListCache | undefined) =>
                oldPods
                  ? {
                      pods: oldPods.pods.map((p) =>
                        p.podId === podId
                          ? {
                              ...p,
                              dmConversations: (p.dmConversations ?? []).map(
                                (dm) =>
                                  dm.peerId === partnerPeerId
                                    ? {
                                        ...dm,
                                        peerLastReadMessageId: Math.max(
                                          dm.peerLastReadMessageId ?? 0,
                                          frame.lastReadMessageId
                                        ),
                                      }
                                    : dm
                              ),
                            }
                          : p
                      ),
                    }
                  : oldPods
            );
          } else if (selfId && frame.peerId === selfId && frame.targetPeerId) {
            const key = dmConvoKey(podId, frame.targetPeerId);
            setUnreadDmMap((prev) => ({ ...prev, [key]: 0 }));
            queryClient.setQueryData(
              ['dms', podId],
              (oldDms: DmsListCache | undefined) =>
                oldDms
                  ? {
                      conversations: oldDms.conversations.map((dm) =>
                        dm.peerId === frame.targetPeerId
                          ? { ...dm, unreadCount: 0 }
                          : dm
                      ),
                    }
                  : oldDms
            );
            queryClient.setQueryData(
              ['pods'],
              (oldPods: PodsListCache | undefined) =>
                oldPods
                  ? {
                      pods: oldPods.pods.map((p) =>
                        p.podId === podId
                          ? {
                              ...p,
                              dmConversations: (p.dmConversations ?? []).map(
                                (dm) =>
                                  dm.peerId === frame.targetPeerId
                                    ? { ...dm, unreadCount: 0 }
                                    : dm
                              ),
                            }
                          : p
                      ),
                    }
                  : oldPods
            );
          }
          break;
        }

        case 'dm_call_ringing': {
          // Every device of the caller hears this; only the one that dialled shows it.
          setActiveDmCall((prev) =>
            prev?.phase === 'ringing' && prev.peerId === frame.targetPeerId
              ? { ...prev, peerOnline: frame.targetOnline }
              : prev
          );
          break;
        }

        case 'dm_call_incoming': {
          setCallNotice(null);
          setActiveDmCall((prev) =>
            // Busy on another private call: let this one ring out.
            prev && prev.phase !== 'incoming' && prev.peerId !== frame.fromPeerId
              ? prev
              : {
                  podId,
                  peerId: frame.fromPeerId,
                  peerAlias: frame.fromAlias,
                  peerColor: frame.fromColor,
                  peerOnline: true,
                  phase: 'incoming',
                  muted: false,
                  speaking: false,
                  peerMuted: false,
                  peerSpeaking: false,
                }
          );
          break;
        }

        case 'dm_call_connected': {
          const selfId = getSelfPeerId();
          const partnerId = selfId === frame.peerAId ? frame.peerBId : frame.peerAId;
          setActiveDmCall((prev) => {
            if (!prev || prev.peerId !== partnerId) return prev;
            // Still ringing here means another of our devices picked it up.
            if (prev.phase === 'incoming') return null;
            return { ...prev, peerOnline: true, phase: 'connected' };
          });
          break;
        }

        case 'dm_call_state': {
          const selfId = getSelfPeerId();
          setActiveDmCall((prev) => {
            if (!prev || prev.podId !== podId) return prev;
            if (selfId && frame.fromPeerId === selfId) {
              return {
                ...prev,
                muted: frame.muted,
                speaking: frame.speaking,
              };
            }
            if (frame.fromPeerId === prev.peerId) {
              return {
                ...prev,
                peerMuted: frame.muted,
                peerSpeaking: frame.speaking,
              };
            }
            return prev;
          });
          break;
        }

        case 'dm_call_ended': {
          const call = store.get(activeDmCallAtom);
          if (!call) break;
          // Our own hang-up comes back too, maybe after we dialled someone else. It
          // only matters when another of our devices turned away a call ringing here.
          const bySelf = frame.byPeerId === getSelfPeerId();
          if (bySelf ? call.phase !== 'incoming' : frame.byPeerId !== call.peerId) break;
          setActiveDmCall(null);
          if (!bySelf) {
            setCallNotice(
              frame.reason === 'declined'
                ? 'Call declined.'
                : frame.reason === 'disconnected'
                ? 'The private call dropped.'
                : 'The private call ended.'
            );
          }
          break;
        }

        case 'message_updated':
        case 'reaction_updated':
        case 'pin_updated':
        case 'poll_updated': {
          const updated = frame.message;
          const selfId = getSelfPeerId();
          const partnerPeerId = resolveDmPartnerPeerId(
            selfId,
            updated.senderPeerId,
            updated.recipientPeerId
          );

          queryClient.setQueryData(
            getConvoQueryKey(partnerPeerId),
            (old: MessageInfiniteCache | undefined) =>
              upsertMessageInPages(old, updated, false)
          );

          if (frame.type === 'pin_updated' && partnerPeerId === null) {
            queryClient.setQueryData(
              ['pins', podId],
              (oldPins: PinsListCache | undefined) => {
                if (!oldPins) return oldPins;
                const filtered = oldPins.messages.filter(
                  (m) => m.id !== updated.id
                );
                return {
                  messages: updated.isPinned
                    ? [updated, ...filtered]
                    : filtered,
                };
              }
            );
          }
          break;
        }

        case 'message_deleted': {
          const selfId = getSelfPeerId();
          const partnerPeerId = resolveDmPartnerPeerId(
            selfId,
            frame.senderPeerId,
            frame.recipientPeerId
          );

          queryClient.setQueryData(
            getConvoQueryKey(partnerPeerId),
            (old: MessageInfiniteCache | undefined) => {
              if (!old) return old;
              return {
                ...old,
                pages: old.pages.map((page) => ({
                  ...page,
                  messages: page.messages.map((m) =>
                    m.id === frame.messageId
                      ? { ...m, isDeleted: true, body: '' }
                      : m
                  ),
                })),
              };
            }
          );

          queryClient.setQueryData(
            ['pins', podId],
            (oldPins: PinsListCache | undefined) =>
              oldPins
                ? {
                    messages: oldPins.messages.filter(
                      (m) => m.id !== frame.messageId
                    ),
                  }
                : oldPins
          );
          break;
        }

        case 'proposal_updated': {
          const targetPodId = frame.proposal.podId || podId;
          let computedOpenCount: number | null = null;
          queryClient.setQueryData(
            ['proposals', targetPodId],
            (old: ProposalsListCache | undefined) => {
              if (!old) return old;
              const exists = old.proposals.some(
                (pr) => pr.id === frame.proposal.id
              );
              const nextProposals = exists
                ? old.proposals.map((pr) =>
                    pr.id === frame.proposal.id ? frame.proposal : pr
                  )
                : [frame.proposal, ...old.proposals];
              computedOpenCount = nextProposals.filter(
                (pr) => pr.status === 'OPEN'
              ).length;
              return { proposals: nextProposals };
            }
          );

          queryClient.setQueriesData<MessageInfiniteCache>(
            { queryKey: ['messages', targetPodId, 'group'] },
            (old: MessageInfiniteCache | undefined) => {
              if (!old) return old;
              return {
                ...old,
                pages: old.pages.map((page) => ({
                  ...page,
                  messages: page.messages.map((m) =>
                    m.proposal?.id === frame.proposal.id
                      ? { ...m, proposal: frame.proposal }
                      : m
                  ),
                })),
              };
            }
          );

          if (computedOpenCount !== null) {
            const nextCount = computedOpenCount;
            queryClient.setQueryData(
              ['pods'],
              (old: PodsListCache | undefined) =>
                old
                  ? {
                      pods: old.pods.map((p) =>
                        p.podId === targetPodId
                          ? { ...p, openProposalsCount: nextCount }
                          : p
                      ),
                    }
                  : old
            );
          } else {
            queryClient.invalidateQueries({ queryKey: ['pods'] });
          }
          break;
        }

        case 'pod_updated': {
          const updatedPod = frame.pod;
          queryClient.setQueryData(
            ['pods'],
            (old: PodsListCache | undefined) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) =>
                  p.podId === updatedPod.podId ? updatedPod : p
                ),
              };
            }
          );
          setPresenceByPod((prev) => {
            const existing = prev[updatedPod.podId];
            if (!existing) return prev;
            return {
              ...prev,
              [updatedPod.podId]: {
                ...existing,
                members: updatedPod.members,
              },
            };
          });
          queryClient.invalidateQueries({ queryKey: ['publicized-pods'] });
          break;
        }

        case 'member_joined': {
          queryClient.setQueryData(
            ['pods'],
            (old: PodsListCache | undefined) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) => {
                  if (p.podId !== podId) return p;
                  const exists = p.members.some(
                    (m) => m.peerId === frame.member.peerId
                  );
                  const nextMembers = exists
                    ? p.members.map((m) =>
                        m.peerId === frame.member.peerId ? frame.member : m
                      )
                    : [...p.members, frame.member];
                  return {
                    ...p,
                    members: nextMembers,
                    memberCount: nextMembers.length,
                  };
                }),
              };
            }
          );
          break;
        }

        case 'member_left': {
          queryClient.setQueryData(
            ['pods'],
            (old: PodsListCache | undefined) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) => {
                  if (p.podId !== podId) return p;
                  const nextMembers = p.members.filter(
                    (m) => m.peerId !== frame.peerId
                  );
                  return {
                    ...p,
                    members: nextMembers,
                    memberCount: nextMembers.length,
                  };
                }),
              };
            }
          );
          if (activeDmPeerMapRef.current[podId] === frame.peerId) {
            setActiveDmPeerMap((prev) => ({ ...prev, [podId]: null }));
          }
          setActiveDmCall((prev) =>
            prev?.podId === podId && prev.peerId === frame.peerId ? null : prev
          );
          break;
        }

        case 'member_kicked': {
          const cachedPods = queryClient.getQueryData<PodsListCache>(['pods']);
          const currentPod = cachedPods?.pods.find((p) => p.podId === podId);
          const kickedSelf = currentPod?.myPeerId === frame.peerId;

          if (kickedSelf) {
            const remaining = (cachedPods?.pods ?? []).filter(
              (p) => p.podId !== podId
            );
            queryClient.setQueryData(['pods'], { pods: remaining });
            setVoiceSession((prev) => (prev?.podId === podId ? null : prev));
            setActiveDmCall((prev) => (prev?.podId === podId ? null : prev));
            setActivePodId(remaining[0]?.podId ?? null);
            queryClient.invalidateQueries({ queryKey: ['pods'] });
            queryClient.invalidateQueries({ queryKey: ['publicized-pods'] });
          } else {
            queryClient.setQueryData(
              ['pods'],
              (old: PodsListCache | undefined) => {
                if (!old) return old;
                return {
                  pods: old.pods.map((p) => {
                    if (p.podId !== podId) return p;
                    const nextMembers = p.members.filter(
                      (m) => m.peerId !== frame.peerId
                    );
                    return {
                      ...p,
                      members: nextMembers,
                      memberCount: nextMembers.length,
                    };
                  }),
                };
              }
            );
            setPresenceByPod((prev) => {
              const existing = prev[podId];
              if (!existing) return prev;
              return {
                ...prev,
                [podId]: {
                  ...existing,
                  onlinePeerIds: existing.onlinePeerIds.filter(
                    (id) => id !== frame.peerId
                  ),
                  members: existing.members.filter(
                    (m) => m.peerId !== frame.peerId
                  ),
                },
              };
            });
            if (activeDmPeerMapRef.current[podId] === frame.peerId) {
              setActiveDmPeerMap((prev) => ({ ...prev, [podId]: null }));
            }
            setActiveDmCall((prev) =>
              prev?.podId === podId && prev.peerId === frame.peerId
                ? null
                : prev
            );
          }
          break;
        }

        case 'voice_roster_updated': {
          const voicePeers = frame.voicePeers ?? [];
          const inVoiceSet = new Set(voicePeers.map((vp) => vp.peerId));
          setVoicePeersByPod((prev) => ({
            ...prev,
            [podId]: voicePeers,
          }));
          queryClient.setQueryData(
            ['pods'],
            (old: PodsListCache | undefined) =>
              old
                ? {
                    pods: old.pods.map((p) =>
                      p.podId === podId
                        ? {
                            ...p,
                            members: p.members.map((m) => ({
                              ...m,
                              inVoice: inVoiceSet.has(m.peerId),
                            })),
                          }
                        : p
                    ),
                  }
                : old
          );
          break;
        }

        case 'webrtc_signal': {
          emitWebRtcSignal(frame);
          break;
        }

        case 'pong': {
          break;
        }
      }
    };

    const connect = () => {
      if (cancelled) return;
      const wsBase = getWsBaseUrl();
      const wsUrl = `${wsBase}/ws/pods/${podId}?token=${encodeURIComponent(
        token
      )}`;
      const sock = new WebSocket(wsUrl);
      wsRef.current = sock;

      sock.onopen = () => {
        if (cancelled) {
          sock.close();
          return;
        }
        retryAttempt = 0;
        setConnected(true);
        emitSocketOpen(podId);
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (sock.readyState === WebSocket.OPEN) {
            try {
              sock.send(JSON.stringify({ type: 'ping' }));
            } catch {
              // ignore ping failure
            }
          }
        }, 25_000);
      };

      sock.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const parsed = JSON.parse(event.data) as WsInboundFrame;
          handleInbound(parsed);
        } catch {
          // ignore malformed frame
        }
      };

      sock.onerror = () => {
        // handled by onclose reconnect loop
      };

      sock.onclose = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (wsRef.current === sock) {
          wsRef.current = null;
        }
        setConnected(false);
        if (!cancelled) {
          const delayMs = Math.min(8000, 1000 * Math.pow(2, retryAttempt));
          retryAttempt += 1;
          retryTimer = setTimeout(connect, delayMs);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore close errors
        }
        wsRef.current = null;
      }
      setConnected(false);
    };
  }, [
    podId,
    token,
    apiBaseUrl,
    queryClient,
    store,
    setConnected,
    setPresenceByPod,
    setTypingByConvo,
    setVoicePeersByPod,
    setActiveDmPeerMap,
    setUnreadGroupMap,
    setUnreadDmMap,
    setPeerLastReadMap,
    setActivePodId,
    setVoiceSession,
    setActiveDmCall,
    setCallNotice,
  ]);

  return { sendFrame };
}
