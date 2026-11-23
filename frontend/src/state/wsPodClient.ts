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
  activeChannelIdMapAtom,
  activePodIdAtom,
  kickedNoticeAtom,
  presenceByPodAtom,
  typingByChannelAtom,
  unreadByChannelAtom,
  voiceRosterByPodAtom,
  wsConnectedAtom,
} from '@/state/workspaceAtoms';
import type {
  MessagesPage,
  PodDetail,
  PodProposalDto,
  RichMessage,
  ThreadPayload,
  WsInboundFrame,
  WsOutboundFrame,
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
    { queryKey: ['messages', podId] },
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

  queryClient.setQueriesData<ThreadPayload>(
    { queryKey: ['thread', podId] },
    (old) => {
      if (!old) return old;
      const nextParent =
        old.parent.proposal?.id === proposal.id
          ? { ...old.parent, proposal }
          : old.parent;
      const nextReplies = old.replies.map((r) =>
        r.proposal?.id === proposal.id ? { ...r, proposal } : r
      );
      return { parent: nextParent, replies: nextReplies };
    }
  );

  queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
    if (!old) return old;
    return {
      pods: old.pods.map((p) => {
        if (p.podId !== podId) return p;
        if (updatedPod && updatedPod.podId === podId) {
          return updatedPod;
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

export function upsertChannelMessageInCache(
  queryClient: QueryClient,
  podId: string,
  channelId: string,
  message: RichMessage
): void {
  if (message.parentMessageId > 0) return;
  const podsCache = queryClient.getQueryData<{ pods: PodDetail[] }>(['pods']);
  const myAlias = podsCache?.pods.find((p) => p.podId === podId)?.myAlias;
  const normalizedMsg: RichMessage = message.proposal
    ? { ...message, proposal: personalizeProposal(message.proposal, myAlias) }
    : message;

  queryClient.setQueryData<InfiniteData<MessagesPage, number>>(
    ['messages', podId, channelId],
    (old) => {
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
    }
  );
}

export function patchMessageAcrossCaches(
  queryClient: QueryClient,
  podId: string,
  incomingRaw: RichMessage,
  preserveBookmark = true
): void {
  const podsCache = queryClient.getQueryData<{ pods: PodDetail[] }>(['pods']);
  const myAlias = podsCache?.pods.find((p) => p.podId === podId)?.myAlias;
  const incoming: RichMessage = incomingRaw.proposal
    ? {
        ...incomingRaw,
        proposal: personalizeProposal(incomingRaw.proposal, myAlias),
      }
    : incomingRaw;
  const channelId = incoming.channelId;

  queryClient.setQueryData<InfiniteData<MessagesPage, number>>(
    ['messages', podId, channelId],
    (old) => {
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
    }
  );

  const threadParentId =
    incoming.parentMessageId > 0 ? incoming.parentMessageId : incoming.id;
  queryClient.setQueryData<ThreadPayload>(
    ['thread', podId, channelId, threadParentId],
    (old) => {
      if (!old) return old;
      return {
        parent:
          old.parent.id === incoming.id
            ? mergeMessage(old.parent, incoming, preserveBookmark)
            : old.parent,
        replies: old.replies.map((r) =>
          r.id === incoming.id ? mergeMessage(r, incoming, preserveBookmark) : r
        ),
      };
    }
  );

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

  if (!preserveBookmark) {
    queryClient.setQueryData<{ messages: RichMessage[] }>(
      ['bookmarks'],
      (old) => {
        if (!old) return old;
        const exists = old.messages.some((m) => m.id === incoming.id);
        if (incoming.isBookmarked && !incoming.isDeleted) {
          return {
            messages: exists
              ? old.messages.map((m) => (m.id === incoming.id ? incoming : m))
              : [incoming, ...old.messages],
          };
        }
        return { messages: old.messages.filter((m) => m.id !== incoming.id) };
      }
    );
  }
}

export function upsertThreadReplyInCache(
  queryClient: QueryClient,
  podId: string,
  channelId: string,
  parentMessageId: number,
  reply: RichMessage,
  parentReplyCount?: number
): void {
  queryClient.setQueryData<InfiniteData<MessagesPage, number>>(
    ['messages', podId, channelId],
    (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          messages: page.messages.map((m) =>
            m.id === parentMessageId
              ? {
                  ...m,
                  replyCount:
                    parentReplyCount !== undefined
                      ? parentReplyCount
                      : m.replyCount + 1,
                }
              : m
          ),
        })),
      };
    }
  );

  queryClient.setQueryData<ThreadPayload>(
    ['thread', podId, channelId, parentMessageId],
    (old) => {
      if (!old) return old;
      const exists = old.replies.some((r) => r.id === reply.id);
      const nextReplies = exists
        ? old.replies.map((r) =>
            r.id === reply.id ? mergeMessage(r, reply, true) : r
          )
        : [...old.replies, reply].sort((a, b) => a.id - b.id);
      return {
        parent: {
          ...old.parent,
          replyCount:
            parentReplyCount !== undefined
              ? parentReplyCount
              : nextReplies.length,
        },
        replies: nextReplies,
      };
    }
  );
}

export function markMessageDeletedInCaches(
  queryClient: QueryClient,
  podId: string,
  channelId: string,
  messageId: number,
  parentMessageId: number
): void {
  queryClient.setQueryData<InfiniteData<MessagesPage, number>>(
    ['messages', podId, channelId],
    (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          messages: page.messages.map((m) =>
            m.id === messageId
              ? { ...m, isDeleted: true, body: '', isPinned: false }
              : m
          ),
        })),
      };
    }
  );

  const threadKeyId = parentMessageId > 0 ? parentMessageId : messageId;
  queryClient.setQueryData<ThreadPayload>(
    ['thread', podId, channelId, threadKeyId],
    (old) => {
      if (!old) return old;
      return {
        parent:
          old.parent.id === messageId
            ? { ...old.parent, isDeleted: true, body: '' }
            : old.parent,
        replies: old.replies.map((r) =>
          r.id === messageId ? { ...r, isDeleted: true, body: '' } : r
        ),
      };
    }
  );

  queryClient.setQueryData<{ messages: RichMessage[] }>(
    ['pins', podId],
    (old) =>
      old
        ? { messages: old.messages.filter((m) => m.id !== messageId) }
        : old
  );
}

export function usePodWebSocket(): void {
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const [activeChannelMap, setActiveChannelMap] = useAtom(
    activeChannelIdMapAtom
  );
  const setPresenceByPod = useSetAtom(presenceByPodAtom);
  const setVoiceRosterByPod = useSetAtom(voiceRosterByPodAtom);
  const setTypingByChannel = useSetAtom(typingByChannelAtom);
  const setUnreadByChannel = useSetAtom(unreadByChannelAtom);
  const setWsConnected = useSetAtom(wsConnectedAtom);
  const setKickedNotice = useSetAtom(kickedNoticeAtom);
  const queryClient = useQueryClient();

  const activeChannelMapRef = useRef(activeChannelMap);
  activeChannelMapRef.current = activeChannelMap;
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
      };

      ws.onmessage = (event) => {
        if (disposed || typeof event.data !== 'string') return;
        let frame: WsInboundFrame;
        try {
          frame = JSON.parse(event.data) as WsInboundFrame;
        } catch {
          return;
        }

        switch (frame.type) {
          case 'presence_snapshot': {
            if (frame.selfPeerId) {
              selfPeerIdRef.current = frame.selfPeerId;
            }
            setPresenceByPod((prev) => ({
              ...prev,
              [activePodId]: {
                selfPeerId: frame.selfPeerId,
                onlinePeerIds: frame.onlinePeerIds,
                members: frame.members,
              },
            }));
            setVoiceRosterByPod((prev) => ({
              ...prev,
              [activePodId]: frame.voiceRoster || {},
            }));
            queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) =>
                  p.podId === activePodId
                    ? {
                        ...p,
                        myPeerId: frame.selfPeerId || p.myPeerId,
                        members: frame.members,
                        memberCount: frame.members.length,
                      }
                    : p
                ),
              };
            });
            break;
          }

          case 'typing_update': {
            setTypingByChannel((prev) => ({
              ...prev,
              [frame.channelId]: frame.typingAliases,
            }));
            break;
          }

          case 'voice_roster_updated': {
            setVoiceRosterByPod((prev) => ({
              ...prev,
              [activePodId]: frame.voiceRoster || {},
            }));
            break;
          }

          case 'webrtc_signal': {
            signalListeners.forEach((fn) => fn(frame));
            break;
          }

          case 'message_created': {
            upsertChannelMessageInCache(
              queryClient,
              activePodId,
              frame.channelId,
              frame.message
            );
            const currentChannel = activeChannelMapRef.current[activePodId];
            if (currentChannel && currentChannel !== frame.channelId) {
              setUnreadByChannel((prev) => ({
                ...prev,
                [frame.channelId]: (prev[frame.channelId] || 0) + 1,
              }));
            }
            break;
          }

          case 'thread_reply_created': {
            upsertThreadReplyInCache(
              queryClient,
              activePodId,
              frame.channelId,
              frame.parentMessageId,
              frame.reply,
              frame.parentReplyCount
            );
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
              true
            );
            break;
          }

          case 'message_deleted': {
            markMessageDeletedInCaches(
              queryClient,
              activePodId,
              frame.channelId,
              frame.messageId,
              frame.parentMessageId
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

          case 'channel_created': {
            queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) => {
                  if (p.podId !== activePodId) return p;
                  if (
                    p.channels.some(
                      (c) => c.channelId === frame.channel.channelId
                    )
                  ) {
                    return p;
                  }
                  return {
                    ...p,
                    channels: [...p.channels, frame.channel].sort((a, b) =>
                      a.kind === b.kind
                        ? a.position - b.position
                        : a.kind === 'TEXT'
                          ? -1
                          : 1
                    ),
                  };
                }),
              };
            });
            break;
          }

          case 'channel_deleted': {
            let fallbackChannelId: string | null = null;
            queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) => {
                  if (p.podId !== activePodId) return p;
                  const remainingChannels = p.channels.filter(
                    (c) => c.channelId !== frame.channelId
                  );
                  const general =
                    remainingChannels.find(
                      (c) => c.kind === 'TEXT' && c.slug === 'general'
                    ) || remainingChannels.find((c) => c.kind === 'TEXT');
                  fallbackChannelId = general?.channelId ?? null;
                  return {
                    ...p,
                    channels: remainingChannels,
                  };
                }),
              };
            });
            if (
              activeChannelMapRef.current[activePodId] === frame.channelId &&
              fallbackChannelId
            ) {
              const targetId = fallbackChannelId;
              setActiveChannelMap((prev) => ({
                ...prev,
                [activePodId]: targetId,
              }));
            }
            setUnreadByChannel((prev) => {
              if (!(frame.channelId in prev)) return prev;
              const copy = { ...prev };
              delete copy[frame.channelId];
              return copy;
            });
            setVoiceRosterByPod((prev) => {
              const podRoster = prev[activePodId];
              if (!podRoster || !(frame.channelId in podRoster)) return prev;
              const nextRoster = { ...podRoster };
              delete nextRoster[frame.channelId];
              return { ...prev, [activePodId]: nextRoster };
            });
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
              setVoiceRosterByPod((prev) => {
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
            setVoiceRosterByPod((prev) => {
              const podRoster = prev[activePodId];
              if (!podRoster) return prev;
              const nextRoster: typeof podRoster = {};
              for (const [chId, peers] of Object.entries(podRoster)) {
                nextRoster[chId] = peers.filter(
                  (p) => p.peerId !== frame.peerId
                );
              }
              return { ...prev, [activePodId]: nextRoster };
            });
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
        }
      };

      ws.onclose = () => {
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
    setActiveChannelMap,
    setActivePodId,
    setKickedNotice,
    setPresenceByPod,
    setTypingByChannel,
    setUnreadByChannel,
    setVoiceRosterByPod,
    setWsConnected,
  ]);
}
