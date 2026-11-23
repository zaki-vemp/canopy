import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useAtomValue, useSetAtom } from 'jotai';
import { getWsBaseUrl } from './client';
import {
  activeChannelByPodAtom,
  activePodIdAtom,
  activeVoiceSessionAtom,
  apiBaseUrlAtom,
  authTokenAtom,
  lastWebRtcSignalAtom,
  podPresenceByPodAtom,
  typingByChannelAtom,
  voiceRosterByPodAtom,
  wsConnectedAtom,
} from '../state/atoms';
import type {
  MessagesPage,
  PodDetail,
  PodProposalDto,
  RichMessage,
  ThreadPayload,
  WsInboundFrame,
  WsOutboundFrame,
} from '../types/canopy';

type MessageInfiniteCache = InfiniteData<MessagesPage, number>;
type PodsListCache = { pods: PodDetail[] };
type PinsListCache = { messages: RichMessage[] };
type ProposalsListCache = { proposals: PodProposalDto[] };

function upsertMessageInPages(
  oldData: MessageInfiniteCache | undefined,
  incoming: RichMessage,
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

export interface PodSocketController {
  sendFrame: (frame: WsOutboundFrame) => boolean;
}

/**
 * Connects to ws://<host>/ws/pods/{podId}?token=<jwt> for the active pod,
 * patching TanStack Query caches and Jotai presence/typing/voice atoms in real time.
 * ponytail: reconnects with bounded exponential backoff (1s -> 8s) for the single active pod;
 * upgrade to multiplexed multi-pod socket if background pod push badges are needed.
 */
export function usePodSocket(podId: string | null): PodSocketController {
  const queryClient = useQueryClient();
  const token = useAtomValue(authTokenAtom);
  const apiBaseUrl = useAtomValue(apiBaseUrlAtom);

  const setConnected = useSetAtom(wsConnectedAtom);
  const setPresenceByPod = useSetAtom(podPresenceByPodAtom);
  const setTypingByChannel = useSetAtom(typingByChannelAtom);
  const setVoiceRosterByPod = useSetAtom(voiceRosterByPodAtom);
  const setLastSignal = useSetAtom(lastWebRtcSignalAtom);
  const setActiveChannelMap = useSetAtom(activeChannelByPodAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const setVoiceSession = useSetAtom(activeVoiceSessionAtom);

  const wsRef = useRef<WebSocket | null>(null);
  const signalListenersRef = useRef<Set<(frame: WsInboundFrame) => void>>(
    new Set()
  );

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
    if (!podId || !token) {
      setConnected(false);
      return;
    }

    let cancelled = false;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const handleInbound = (frame: WsInboundFrame) => {
      switch (frame.type) {
        case 'presence_snapshot': {
          setPresenceByPod((prev) => ({
            ...prev,
            [frame.podId]: {
              selfPeerId: frame.selfPeerId,
              onlinePeerIds: frame.onlinePeerIds,
              members: frame.members,
            },
          }));
          setVoiceRosterByPod((prev) => ({
            ...prev,
            [frame.podId]: frame.voiceRoster || {},
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
                      }
                    : p
                ),
              };
            }
          );
          break;
        }

        case 'typing_update': {
          setTypingByChannel((prev) => ({
            ...prev,
            [frame.channelId]: frame.typingAliases,
          }));
          break;
        }

        case 'message_created': {
          if (frame.message.parentMessageId === 0) {
            queryClient.setQueryData(
              ['messages', podId, frame.channelId],
              (old: MessageInfiniteCache | undefined) =>
                upsertMessageInPages(old, frame.message, true)
            );
          }
          break;
        }

        case 'thread_reply_created': {
          queryClient.setQueryData(
            ['thread', podId, frame.channelId, frame.parentMessageId],
            (old: ThreadPayload | undefined) => {
              if (!old) return old;
              const exists = old.replies.some((r) => r.id === frame.reply.id);
              return {
                parent: {
                  ...old.parent,
                  replyCount: frame.parentReplyCount,
                },
                replies: exists ? old.replies : [...old.replies, frame.reply],
              };
            }
          );
          queryClient.setQueryData(
            ['messages', podId, frame.channelId],
            (old: MessageInfiniteCache | undefined) => {
              if (!old) return old;
              return {
                ...old,
                pages: old.pages.map((page) => ({
                  ...page,
                  messages: page.messages.map((m) =>
                    m.id === frame.parentMessageId
                      ? { ...m, replyCount: frame.parentReplyCount }
                      : m
                  ),
                })),
              };
            }
          );
          break;
        }

        case 'message_updated':
        case 'reaction_updated':
        case 'pin_updated':
        case 'poll_updated': {
          const updated = frame.message;
          if (updated.parentMessageId === 0) {
            queryClient.setQueryData(
              ['messages', podId, frame.channelId],
              (old: MessageInfiniteCache | undefined) =>
                upsertMessageInPages(old, updated, false)
            );
          } else {
            queryClient.setQueryData(
              ['thread', podId, frame.channelId, updated.parentMessageId],
              (old: ThreadPayload | undefined) =>
                old
                  ? {
                      ...old,
                      replies: old.replies.map((r) =>
                        r.id === updated.id
                          ? { ...updated, isBookmarked: r.isBookmarked }
                          : r
                      ),
                    }
                  : old
            );
          }
          queryClient.setQueryData(
            ['thread', podId, frame.channelId, updated.id],
            (old: ThreadPayload | undefined) =>
              old
                ? {
                    ...old,
                    parent: {
                      ...updated,
                      isBookmarked: old.parent.isBookmarked,
                    },
                  }
                : old
          );
          if (frame.type === 'pin_updated') {
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
          if (frame.parentMessageId === 0) {
            queryClient.setQueryData(
              ['messages', podId, frame.channelId],
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
          } else {
            queryClient.setQueryData(
              ['thread', podId, frame.channelId, frame.parentMessageId],
              (old: ThreadPayload | undefined) =>
                old
                  ? {
                      ...old,
                      replies: old.replies.map((r) =>
                        r.id === frame.messageId
                          ? { ...r, isDeleted: true, body: '' }
                          : r
                      ),
                    }
                  : old
            );
          }
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

        case 'channel_created': {
          queryClient.setQueryData(
            ['pods'],
            (old: PodsListCache | undefined) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) => {
                  if (p.podId !== podId) return p;
                  const exists = p.channels.some(
                    (c) => c.channelId === frame.channel.channelId
                  );
                  return exists
                    ? p
                    : { ...p, channels: [...p.channels, frame.channel] };
                }),
              };
            }
          );
          break;
        }

        case 'channel_deleted': {
          queryClient.setQueryData(
            ['pods'],
            (old: PodsListCache | undefined) => {
              if (!old) return old;
              return {
                pods: old.pods.map((p) =>
                  p.podId === podId
                    ? {
                        ...p,
                        channels: p.channels.filter(
                          (c) => c.channelId !== frame.channelId
                        ),
                      }
                    : p
                ),
              };
            }
          );
          setActiveChannelMap((prev) => {
            if (prev[podId] !== frame.channelId) return prev;
            const next = { ...prev };
            delete next[podId];
            return next;
          });
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
            { queryKey: ['messages', targetPodId] },
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
          }
          break;
        }

        case 'voice_roster_updated': {
          setVoiceRosterByPod((prev) => ({
            ...prev,
            [podId]: frame.voiceRoster || {},
          }));
          break;
        }

        case 'webrtc_signal': {
          setLastSignal({
            voiceChannelId: frame.voiceChannelId,
            fromPeerId: frame.fromPeerId,
            fromAlias: frame.fromAlias,
            receivedAt: Date.now(),
          });
          signalListenersRef.current.forEach((fn) => fn(frame));
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
    setConnected,
    setPresenceByPod,
    setTypingByChannel,
    setVoiceRosterByPod,
    setLastSignal,
    setActiveChannelMap,
    setActivePodId,
    setVoiceSession,
  ]);

  return { sendFrame };
}
