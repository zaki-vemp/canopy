'use client';

import { useEffect, useRef } from 'react';
import {
  InfiniteData,
  QueryClient,
  useQueryClient,
} from '@tanstack/react-query';
import { useAtom, useSetAtom } from 'jotai';
import { WS_BASE, getAuthToken } from '@/lib/api';
import {
  activeDmPeerByPodAtom,
  activePodIdAtom,
  kickedNoticeAtom,
  presenceByPodAtom,
  typingByConvoAtom,
  unreadByConvoAtom,
  voicePeersByPodAtom,
  wsConnectedAtom,
} from '@/state/workspaceAtoms';
import {
  conversationKey,
  deriveDmPreviewBody,
  messageQueryKey,
  resolveMessagePeerId,
  type DmConversationSummary,
  type MessagesPage,
  type PodDetail,
  type PodProposalDto,
  type RichMessage,
  type WsInboundFrame,
  type WsOutboundFrame,
} from '@/types/canopy';

type SignalFrame = Extract<WsInboundFrame, { type: 'webrtc_signal' }>;
type SignalListener = (frame: SignalFrame) => void;
type ReconnectListener = (podId: string) => void;

let activeSocket: WebSocket | null = null;
let activeSocketPodId: string | null = null;
const signalListeners = new Set<SignalListener>();
const reconnectListeners = new Set<ReconnectListener>();

export function sendPodWsFrame(frame: WsOutboundFrame): boolean {
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
    return false;
  }
  activeSocket.send(JSON.stringify(frame));
  return true;
}

export function getConnectedWsPodId(): string | null {
  return activeSocket && activeSocket.readyState === WebSocket.OPEN
    ? activeSocketPodId
    : null;
}

export function subscribeWebRtcSignals(fn: SignalListener): () => void {
  signalListeners.add(fn);
  return () => {
    signalListeners.delete(fn);
  };
}

export function subscribeWsOpen(fn: ReconnectListener): () => void {
  reconnectListeners.add(fn);
  return () => {
    reconnectListeners.delete(fn);
  };
}

function mergeMessage(
  existing: RichMessage,
  incoming: RichMessage,
  preserveBookmark: boolean
): RichMessage {
  return {
    ...incoming,
    proposal:
      incoming.proposal !== undefined ? incoming.proposal : existing.proposal,
    isBookmarked: preserveBookmark
      ? existing.isBookmarked
      : incoming.isBookmarked,
  };
}

export function personalizeProposal(
  proposal: PodProposalDto,
  myAlias?: string
): PodProposalDto {
  if (!myAlias) return proposal;
  const yesList = proposal.yesAliases || [];
  const noList = proposal.noAliases || [];
  const derivedVote = yesList.includes(myAlias)
    ? true
    : noList.includes(myAlias)
      ? false
      : proposal.myVote ?? null;
  return {
    ...proposal,
    myVote: derivedVote,
  };
}

export function upsertDmSummaryInCaches(
  queryClient: QueryClient,
  podId: string,
  message: RichMessage,
  fallbackMyPeerId?: string | null
): void {
  if (!message.recipientPeerId) return;
  const podsCache = queryClient.getQueryData<{ pods: PodDetail[] }>(['pods']);
  const currentPod = podsCache?.pods.find((p) => p.podId === podId);
  const myPeerId = fallbackMyPeerId || currentPod?.myPeerId || '';
  if (!myPeerId) return;

  const otherPeerId = resolveMessagePeerId(
    message.senderPeerId,
    message.recipientPeerId,
    myPeerId
  );
  if (!otherPeerId) return;

  const member = currentPod?.members.find((m) => m.peerId === otherPeerId);
  const peerAlias =
    message.senderPeerId === myPeerId
      ? message.recipientAlias || member?.alias || 'Pod Member'
      : message.senderAlias;
  const peerColor =
    message.senderPeerId === myPeerId
      ? member?.color || '#1f6b3a'
      : message.senderColor;
  const online = member?.online ?? true;
  const previewBody = deriveDmPreviewBody(message);

  const applyListUpdate = (
    list: DmConversationSummary[] = []
  ): DmConversationSummary[] => {
    const existing = list.find((d) => d.peerId === otherPeerId);
    let nextItem: DmConversationSummary;
    if (existing && existing.lastMessageId > message.id) {
      nextItem = {
        ...existing,
        peerAlias: peerAlias || existing.peerAlias,
        peerColor: peerColor || existing.peerColor,
        online,
      };
    } else {
      nextItem = {
        peerId: otherPeerId,
        peerAlias,
        peerColor,
        online,
        lastMessageId: message.id,
        lastBody: previewBody,
        lastSenderPeerId: message.senderPeerId,
        lastSenderAlias: message.senderAlias,
        lastCreatedAt: message.createdAt,
      };
    }
    const filtered = list.filter((d) => d.peerId !== otherPeerId);
    return [nextItem, ...filtered].sort(
      (a, b) => b.lastMessageId - a.lastMessageId
    );
  };

  queryClient.setQueryData<{ conversations: DmConversationSummary[] }>(
    ['dms', podId],
    (old) => ({
      conversations: applyListUpdate(
        old?.conversations ?? currentPod?.dmConversations ?? []
      ),
    })
  );

  queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
    if (!old) return old;
    return {
      pods: old.pods.map((p) =>
        p.podId === podId
          ? {
              ...p,
              dmConversations: applyListUpdate(p.dmConversations ?? []),
            }
          : p
      ),
    };
  });
}

export function syncProposalIntoCaches(
  queryClient: QueryClient,
  podId: string,
  incomingProposal: PodProposalDto,
  updatedPod?: PodDetail | null
): void {
  const podsCache = queryClient.getQueryData<{ pods: PodDetail[] }>(['pods']);
  const currentPod =
    updatedPod || podsCache?.pods.find((p) => p.podId === podId);
  const proposal = personalizeProposal(incomingProposal, currentPod?.myAlias);

  let computedOpenCount: number | null = null;
  let wasPreviouslyOpen: boolean | null = null;
  let existedInProposalsCache = false;

  queryClient.setQueryData<{ proposals: PodProposalDto[] }>(
    ['proposals', podId],
    (old) => {
      if (!old) return old;
      existedInProposalsCache = true;
      const prev = old.proposals.find((p) => p.id === proposal.id);
      if (prev) {
        wasPreviouslyOpen = prev.status === 'OPEN';
      }
      const nextList = prev
        ? old.proposals.map((p) => (p.id === proposal.id ? proposal : p))
        : [proposal, ...old.proposals];
      const sorted = [...nextList].sort((a, b) => b.id - a.id);
      computedOpenCount = sorted.filter((p) => p.status === 'OPEN').length;
      return { proposals: sorted };
    }
  );

  queryClient.setQueriesData<InfiniteData<MessagesPage, number>>(
    { queryKey: ['messages', podId, 'group'] },
    (old) => {
      if (!old) return old;
      let touched = false;
      const nextPages = old.pages.map((page) => {
        let pageTouched = false;
        const nextMessages = page.messages.map((m) => {
          if (m.proposal?.id === proposal.id) {
            pageTouched = true;
            touched = true;
            return { ...m, proposal };
          }
          return m;
        });
        return pageTouched ? { ...page, messages: nextMessages } : page;
      });
      return touched ? { ...old, pages: nextPages } : old;
    }
  );

  queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
    if (!old) return old;
    return {
      pods: old.pods.map((p) => {
        if (p.podId !== podId) return p;
        if (updatedPod && updatedPod.podId === podId) {
          return {
            ...p,
            ...updatedPod,
            myPeerId: updatedPod.myPeerId || p.myPeerId,
            myAlias: updatedPod.myAlias || p.myAlias,
            myColor: updatedPod.myColor || p.myColor,
            myRole: updatedPod.myRole || p.myRole,
            dmConversations:
              updatedPod.dmConversations && updatedPod.dmConversations.length > 0
                ? updatedPod.dmConversations
                : p.dmConversations,
          };
        }
        let nextOpen = p.openProposalsCount ?? 0;
        if (computedOpenCount !== null) {
          nextOpen = computedOpenCount;
        } else if (wasPreviouslyOpen === true && proposal.status !== 'OPEN') {
          nextOpen = Math.max(0, nextOpen - 1);
        }
        return {
          ...p,
          openProposalsCount: nextOpen,
        };
      }),
    };
  });

  if (!existedInProposalsCache) {
    queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
  }
}

export function upsertConversationMessageInCache(
  queryClient: QueryClient,
  podId: string,
  message: RichMessage,
  fallbackMyPeerId?: string | null
): void {
  const podsCache = queryClient.getQueryData<{ pods: PodDetail[] }>(['pods']);
  const currentPod = podsCache?.pods.find((p) => p.podId === podId);
  const myPeerId = fallbackMyPeerId || currentPod?.myPeerId || '';
  const myAlias = currentPod?.myAlias;

  const normalizedMsg: RichMessage = message.proposal
    ? { ...message, proposal: personalizeProposal(message.proposal, myAlias) }
    : message;

  const otherPeerId = resolveMessagePeerId(
    normalizedMsg.senderPeerId,
    normalizedMsg.recipientPeerId,
    myPeerId
  );
  const qKey = messageQueryKey(podId, otherPeerId);

  queryClient.setQueryData<InfiniteData<MessagesPage, number>>(qKey, (old) => {
    if (!old || old.pages.length === 0) {
      return {
        pages: [{ messages: [normalizedMsg], nextBeforeId: 0 }],
        pageParams: [0],
      };
    }
    const alreadyExists = old.pages.some((p) =>
      p.messages.some((m) => m.id === normalizedMsg.id)
    );
    if (alreadyExists) {
      return {
        ...old,
        pages: old.pages.map((p) => ({
          ...p,
          messages: p.messages.map((m) =>
            m.id === normalizedMsg.id
              ? mergeMessage(m, normalizedMsg, true)
              : m
          ),
        })),
      };
    }
    const newestPage = old.pages[0];
    const nextPages = [...old.pages];
    nextPages[0] = {
      ...newestPage,
      messages: [...newestPage.messages, normalizedMsg].sort(
        (a, b) => a.id - b.id
      ),
    };
    return {
      ...old,
      pages: nextPages,
    };
  });

  if (otherPeerId) {
    upsertDmSummaryInCaches(queryClient, podId, normalizedMsg, myPeerId);
  }
}

export function patchMessageAcrossCaches(
  queryClient: QueryClient,
  podId: string,
  incomingRaw: RichMessage,
  preserveBookmark = true,
  fallbackMyPeerId?: string | null
): void {
  const podsCache = queryClient.getQueryData<{ pods: PodDetail[] }>(['pods']);
  const currentPod = podsCache?.pods.find((p) => p.podId === podId);
  const myPeerId = fallbackMyPeerId || currentPod?.myPeerId || '';
  const myAlias = currentPod?.myAlias;

  const incoming: RichMessage = incomingRaw.proposal
    ? {
        ...incomingRaw,
        proposal: personalizeProposal(incomingRaw.proposal, myAlias),
      }
    : incomingRaw;

  const otherPeerId = resolveMessagePeerId(
    incoming.senderPeerId,
    incoming.recipientPeerId,
    myPeerId
  );
  const qKey = messageQueryKey(podId, otherPeerId);

  queryClient.setQueryData<InfiniteData<MessagesPage, number>>(qKey, (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => ({
        ...page,
        messages: page.messages.map((m) =>
          m.id === incoming.id
            ? mergeMessage(m, incoming, preserveBookmark)
            : m.quoteMessage?.id === incoming.id
              ? {
                  ...m,
                  quoteMessage: {
                    ...m.quoteMessage,
                    body: incoming.body,
                    isDeleted: incoming.isDeleted,
                  },
                }
              : m
        ),
      })),
    };
  });

  if (otherPeerId) {
    upsertDmSummaryInCaches(queryClient, podId, incoming, myPeerId);
  } else {
    queryClient.setQueryData<{ messages: RichMessage[] }>(
      ['pins', podId],
      (old) => {
        if (!old) return old;
        const exists = old.messages.some((m) => m.id === incoming.id);
        if (incoming.isPinned && !incoming.isDeleted) {
          return {
            messages: exists
              ? old.messages.map((m) =>
                  m.id === incoming.id
                    ? mergeMessage(m, incoming, preserveBookmark)
                    : m
                )
              : [incoming, ...old.messages],
          };
        }
        return exists
          ? { messages: old.messages.filter((m) => m.id !== incoming.id) }
          : old;
      }
    );
  }

  queryClient.setQueryData<{ messages: RichMessage[] }>(
    ['bookmarks'],
    (old) => {
      if (!old) return old;
      const exists = old.messages.some((m) => m.id === incoming.id);
      if (!preserveBookmark) {
        if (incoming.isBookmarked && !incoming.isDeleted) {
          return {
            messages: exists
              ? old.messages.map((m) => (m.id === incoming.id ? incoming : m))
              : [incoming, ...old.messages],
          };
        }
        return { messages: old.messages.filter((m) => m.id !== incoming.id) };
      }
      if (!exists) return old;
      return {
        messages: incoming.isDeleted
          ? old.messages.filter((m) => m.id !== incoming.id)
          : old.messages.map((m) =>
              m.id === incoming.id ? mergeMessage(m, incoming, true) : m
            ),
      };
    }
  );
}

export function markMessageDeletedInCaches(
  queryClient: QueryClient,
  podId: string,
  messageId: number,
  senderPeerId: string,
  recipientPeerId: string | null,
  fallbackMyPeerId?: string | null
): void {
  const podsCache = queryClient.getQueryData<{ pods: PodDetail[] }>(['pods']);
  const currentPod = podsCache?.pods.find((p) => p.podId === podId);
  const myPeerId = fallbackMyPeerId || currentPod?.myPeerId || '';
  const otherPeerId = resolveMessagePeerId(
    senderPeerId,
    recipientPeerId,
    myPeerId
  );
  const qKey = messageQueryKey(podId, otherPeerId);

  queryClient.setQueryData<InfiniteData<MessagesPage, number>>(qKey, (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => ({
        ...page,
        messages: page.messages.map((m) =>
          m.id === messageId
            ? { ...m, isDeleted: true, body: '', isPinned: false }
            : m.quoteMessage?.id === messageId
              ? {
                  ...m,
                  quoteMessage: {
                    ...m.quoteMessage,
                    body: '',
                    isDeleted: true,
                  },
                }
              : m
        ),
      })),
    };
  });

  if (otherPeerId) {
    const patchDeletedSummary = (
      list: DmConversationSummary[] = []
    ): DmConversationSummary[] =>
      list.map((d) =>
        d.peerId === otherPeerId && d.lastMessageId === messageId
          ? { ...d, lastBody: 'Message deleted' }
          : d
      );

    queryClient.setQueryData<{ conversations: DmConversationSummary[] }>(
      ['dms', podId],
      (old) =>
        old ? { conversations: patchDeletedSummary(old.conversations) } : old
    );

    queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
      if (!old) return old;
      return {
        pods: old.pods.map((p) =>
          p.podId === podId
            ? {
                ...p,
                dmConversations: patchDeletedSummary(p.dmConversations ?? []),
              }
            : p
        ),
      };
    });
  } else {
    queryClient.setQueryData<{ messages: RichMessage[] }>(
      ['pins', podId],
      (old) =>
        old
          ? { messages: old.messages.filter((m) => m.id !== messageId) }
          : old
    );
  }

  queryClient.setQueryData<{ messages: RichMessage[] }>(
    ['bookmarks'],
    (old) =>
      old
        ? { messages: old.messages.filter((m) => m.id !== messageId) }
        : old
  );
}

export function usePodWebSocket(): void {
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const [activeDmPeerMap, setActiveDmPeerMap] = useAtom(activeDmPeerByPodAtom);
  const setPresenceByPod = useSetAtom(presenceByPodAtom);
  const setVoicePeersByPod = useSetAtom(voicePeersByPodAtom);
  const setTypingByConvo = useSetAtom(typingByConvoAtom);
  const setUnreadByConvo = useSetAtom(unreadByConvoAtom);
  const setWsConnected = useSetAtom(wsConnectedAtom);
  const setKickedNotice = useSetAtom(kickedNoticeAtom);
  const queryClient = useQueryClient();

  const activeDmPeerMapRef = useRef(activeDmPeerMap);
  activeDmPeerMapRef.current = activeDmPeerMap;
  const selfPeerIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activePodId) {
      selfPeerIdRef.current = null;
      setWsConnected(false);
      return;
    }

    const initialPod = queryClient
      .getQueryData<{ pods: PodDetail[] }>(['pods'])
      ?.pods.find((p) => p.podId === activePodId);
    if (initialPod?.myPeerId) {
      selfPeerIdRef.current = initialPod.myPeerId;
    }

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let attempt = 0;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (disposed) return;
      const token = getAuthToken();
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      const url = `${WS_BASE}/ws/pods/${activePodId}${qs}`;
      ws = new WebSocket(url);
      activeSocket = ws;
      activeSocketPodId = activePodId;

      ws.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setWsConnected(true);
        reconnectListeners.forEach((fn) => fn(activePodId));
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          sendPodWsFrame({ type: 'ping' });
        }, 25_000);
      };

      ws.onmessage = (event) => {
        if (disposed || typeof event.data !== 'string') return;
        let frame: WsInboundFrame;
        try {
          frame = JSON.parse(event.data) as WsInboundFrame;
        } catch {
          return;
        }

        const getMyPeerId = (): string => {
          if (selfPeerIdRef.current) return selfPeerIdRef.current;
          const pod = queryClient
            .getQueryData<{ pods: PodDetail[] }>(['pods'])
            ?.pods.find((p) => p.podId === activePodId);
          return pod?.myPeerId || '';
        };

        switch (frame.type) {
          case 'presence_snapshot': {
            if (frame.selfPeerId) {
              selfPeerIdRef.current = frame.selfPeerId;
            }
            const voicePeers = frame.voicePeers || [];
            const voicePeerSet = new Set(voicePeers.map((v) => v.peerId));
            const onlineSet = new Set(frame.onlinePeerIds || []);
            const enrichedMembers = (frame.members || []).map((m) => ({
              ...m,
              online: onlineSet.size > 0 ? onlineSet.has(m.peerId) || m.online : m.online,
              inVoice: voicePeerSet.has(m.peerId) || Boolean(m.inVoice),
            }));

            setPresenceByPod((prev) => ({
              ...prev,
              [activePodId]: {
                selfPeerId: frame.selfPeerId,
                onlinePeerIds: frame.onlinePeerIds,
                members: enrichedMembers,
              },
            }));
            setVoicePeersByPod((prev) => ({
              ...prev,
              [activePodId]: voicePeers,
            }));
            queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) =>
                  p.podId === activePodId
                    ? {
                        ...p,
                        myPeerId: frame.selfPeerId || p.myPeerId,
                        members: enrichedMembers,
                        memberCount: enrichedMembers.length,
                      }
                    : p
                ),
              };
            });
            queryClient.setQueryData<{ conversations: DmConversationSummary[] }>(
              ['dms', activePodId],
              (old) =>
                old
                  ? {
                      conversations: old.conversations.map((d) => ({
                        ...d,
                        online: onlineSet.has(d.peerId),
                      })),
                    }
                  : old
            );
            break;
          }

          case 'typing_update': {
            const myPeerId = getMyPeerId();
            if (!frame.targetPeerId) {
              const groupKey = conversationKey(activePodId, null);
              setTypingByConvo((prev) => ({
                ...prev,
                [groupKey]: frame.typingAliases || [],
              }));
            } else {
              const dmPeerId =
                frame.fromPeerId && frame.fromPeerId !== myPeerId
                  ? frame.fromPeerId
                  : frame.targetPeerId;
              const dmKey = conversationKey(activePodId, dmPeerId);
              setTypingByConvo((prev) => ({
                ...prev,
                [dmKey]: frame.typingAliases || [],
              }));
            }
            break;
          }

          case 'voice_roster_updated': {
            const voicePeers = frame.voicePeers || [];
            const voiceSet = new Set(voicePeers.map((v) => v.peerId));
            setVoicePeersByPod((prev) => ({
              ...prev,
              [activePodId]: voicePeers,
            }));
            setPresenceByPod((prev) => {
              const snap = prev[activePodId];
              if (!snap) return prev;
              return {
                ...prev,
                [activePodId]: {
                  ...snap,
                  members: snap.members.map((m) => ({
                    ...m,
                    inVoice: voiceSet.has(m.peerId),
                  })),
                },
              };
            });
            queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) =>
                  p.podId === activePodId
                    ? {
                        ...p,
                        members: p.members.map((m) => ({
                          ...m,
                          inVoice: voiceSet.has(m.peerId),
                        })),
                      }
                    : p
                ),
              };
            });
            break;
          }

          case 'webrtc_signal': {
            signalListeners.forEach((fn) => fn(frame));
            break;
          }

          case 'message_created': {
            const myPeerId = getMyPeerId();
            upsertConversationMessageInCache(
              queryClient,
              activePodId,
              frame.message,
              myPeerId
            );
            const msgPeerId = resolveMessagePeerId(
              frame.message.senderPeerId,
              frame.message.recipientPeerId,
              myPeerId
            );
            const activePeerInPod = activeDmPeerMapRef.current[activePodId] ?? null;
            if (
              frame.message.senderPeerId !== myPeerId &&
              activePeerInPod !== msgPeerId
            ) {
              const key = conversationKey(activePodId, msgPeerId);
              setUnreadByConvo((prev) => ({
                ...prev,
                [key]: (prev[key] || 0) + 1,
              }));
            }
            break;
          }

          case 'message_updated':
          case 'reaction_updated':
          case 'pin_updated':
          case 'poll_updated': {
            patchMessageAcrossCaches(
              queryClient,
              activePodId,
              frame.message,
              true,
              getMyPeerId()
            );
            break;
          }

          case 'message_deleted': {
            markMessageDeletedInCaches(
              queryClient,
              activePodId,
              frame.messageId,
              frame.senderPeerId,
              frame.recipientPeerId,
              getMyPeerId()
            );
            break;
          }

          case 'proposal_updated': {
            syncProposalIntoCaches(queryClient, activePodId, frame.proposal);
            queryClient.invalidateQueries({
              queryKey: ['proposals', activePodId],
            });
            queryClient.invalidateQueries({ queryKey: ['pods'] });
            break;
          }

          case 'pod_updated': {
            if (frame.pod.myPeerId) {
              selfPeerIdRef.current = frame.pod.myPeerId;
            }
            queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
              if (!old) return { pods: [frame.pod] };
              return {
                pods: old.pods.map((p) =>
                  p.podId === frame.pod.podId
                    ? {
                        ...p,
                        ...frame.pod,
                        myPeerId: frame.pod.myPeerId || p.myPeerId,
                        myAlias: frame.pod.myAlias || p.myAlias,
                        myColor: frame.pod.myColor || p.myColor,
                        myRole: frame.pod.myRole || p.myRole,
                        dmConversations:
                          frame.pod.dmConversations &&
                          frame.pod.dmConversations.length > 0
                            ? frame.pod.dmConversations
                            : p.dmConversations,
                      }
                    : p
                ),
              };
            });
            if (frame.pod.members && frame.pod.podId === activePodId) {
              setPresenceByPod((prev) => {
                const snap = prev[activePodId];
                if (!snap) return prev;
                return {
                  ...prev,
                  [activePodId]: {
                    ...snap,
                    members: frame.pod.members,
                    onlinePeerIds: frame.pod.members
                      .filter((m) => m.online)
                      .map((m) => m.peerId),
                  },
                };
              });
            }
            break;
          }

          case 'member_joined': {
            setPresenceByPod((prev) => {
              const snap = prev[activePodId];
              if (!snap) return prev;
              const exists = snap.members.some(
                (m) => m.peerId === frame.member.peerId
              );
              const nextMembers = exists
                ? snap.members.map((m) =>
                    m.peerId === frame.member.peerId ? frame.member : m
                  )
                : [...snap.members, frame.member];
              return {
                ...prev,
                [activePodId]: {
                  ...snap,
                  onlinePeerIds: Array.from(
                    new Set([...snap.onlinePeerIds, frame.member.peerId])
                  ),
                  members: nextMembers,
                },
              };
            });
            queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) => {
                  if (p.podId !== activePodId) return p;
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
            });
            break;
          }

          case 'member_left': {
            if (activeDmPeerMapRef.current[activePodId] === frame.peerId) {
              setActiveDmPeerMap((prev) => ({
                ...prev,
                [activePodId]: null,
              }));
            }
            setPresenceByPod((prev) => {
              const snap = prev[activePodId];
              if (!snap) return prev;
              return {
                ...prev,
                [activePodId]: {
                  ...snap,
                  onlinePeerIds: snap.onlinePeerIds.filter(
                    (id) => id !== frame.peerId
                  ),
                  members: snap.members.filter(
                    (m) => m.peerId !== frame.peerId
                  ),
                },
              };
            });
            setVoicePeersByPod((prev) => ({
              ...prev,
              [activePodId]: (prev[activePodId] || []).filter(
                (p) => p.peerId !== frame.peerId
              ),
            }));
            queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) => {
                  if (p.podId !== activePodId) return p;
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
            });
            break;
          }

          case 'member_kicked': {
            const podsData = queryClient.getQueryData<{ pods: PodDetail[] }>([
              'pods',
            ]);
            const currentPod = podsData?.pods.find(
              (p) => p.podId === activePodId
            );
            const myPeerId = currentPod?.myPeerId || selfPeerIdRef.current;

            if (myPeerId && frame.peerId === myPeerId) {
              disposed = true;
              if (reconnectTimer) clearTimeout(reconnectTimer);
              if (pingTimer) clearInterval(pingTimer);
              const podLabel = currentPod?.title
                ? `${currentPod.title} (#${currentPod.code})`
                : `#${currentPod?.code || 'pod'}`;
              const remainingPods = (podsData?.pods || []).filter(
                (p) => p.podId !== activePodId
              );
              queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
                pods: remainingPods,
              });
              queryClient.invalidateQueries({ queryKey: ['interests'] });
              setPresenceByPod((prev) => {
                const copy = { ...prev };
                delete copy[activePodId];
                return copy;
              });
              setVoicePeersByPod((prev) => {
                const copy = { ...prev };
                delete copy[activePodId];
                return copy;
              });
              setActivePodId(remainingPods[0]?.podId ?? null);
              setKickedNotice(
                `You were removed from ${podLabel}. You can match into another 25-member pod anytime.`
              );
              ws?.close();
              break;
            }

            if (activeDmPeerMapRef.current[activePodId] === frame.peerId) {
              setActiveDmPeerMap((prev) => ({
                ...prev,
                [activePodId]: null,
              }));
            }
            setPresenceByPod((prev) => {
              const snap = prev[activePodId];
              if (!snap) return prev;
              return {
                ...prev,
                [activePodId]: {
                  ...snap,
                  onlinePeerIds: snap.onlinePeerIds.filter(
                    (id) => id !== frame.peerId
                  ),
                  members: snap.members.filter(
                    (m) => m.peerId !== frame.peerId
                  ),
                },
              };
            });
            setVoicePeersByPod((prev) => ({
              ...prev,
              [activePodId]: (prev[activePodId] || []).filter(
                (p) => p.peerId !== frame.peerId
              ),
            }));
            queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) => {
                  if (p.podId !== activePodId) return p;
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
            });
            break;
          }

          case 'pong':
            break;
        }
      };

      ws.onclose = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (activeSocket === ws) {
          activeSocket = null;
          activeSocketPodId = null;
        }
        if (disposed) return;
        setWsConnected(false);
        const delay = Math.min(5000, 400 * Math.pow(2, attempt));
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (ws) {
        if (activeSocket === ws) {
          activeSocket = null;
          activeSocketPodId = null;
        }
        ws.close();
      }
      setWsConnected(false);
    };
  }, [
    activePodId,
    queryClient,
    setActiveDmPeerMap,
    setActivePodId,
    setKickedNotice,
    setPresenceByPod,
    setTypingByConvo,
    setUnreadByConvo,
    setVoicePeersByPod,
    setWsConnected,
  ]);
}
