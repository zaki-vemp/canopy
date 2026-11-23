'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAtom } from 'jotai';
import { ArrowDown, Lock, Sparkles, Users } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { highlightedMessageIdAtom } from '@/state/workspaceAtoms';
import { MessageCard } from '@/components/workspace/MessageCard';
import { aliasInitials, safeAvatarColor } from '@/components/workspace/markdown';
import {
  conversationKey,
  messageQueryKey,
  type MessagesPage,
  type PodDetail,
  type PodMember,
  type RichMessage,
} from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

interface MessageStreamProps {
  pod: PodDetail;
  activePeer: PodMember | null;
  knownAliases: string[];
}

export function MessageStream({
  pod,
  activePeer,
  knownAliases,
}: MessageStreamProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [highlightedId, setHighlightedId] = useAtom(highlightedMessageIdAtom);
  const [nearBottom, setNearBottom] = useState(true);

  const activePeerId = activePeer?.peerId ?? null;
  const convoKey = conversationKey(pod.podId, activePeerId);

  const messagesQuery = useInfiniteQuery<MessagesPage, Error>({
    queryKey: messageQueryKey(pod.podId, activePeerId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiFetch<MessagesPage>(
        activePeerId
          ? `/api/pods/${pod.podId}/dms/${encodeURIComponent(
              activePeerId
            )}/messages?beforeId=${pageParam}&limit=40`
          : `/api/pods/${pod.podId}/messages?beforeId=${pageParam}&limit=40`
      ),
    getNextPageParam: (lastPage) =>
      lastPage.nextBeforeId && lastPage.nextBeforeId > 0
        ? lastPage.nextBeforeId
        : undefined,
  });

  const messages = useMemo<RichMessage[]>(() => {
    if (!messagesQuery.data) return [];
    const orderedPages = [...messagesQuery.data.pages].reverse();
    const seen = new Set<number>();
    const out: RichMessage[] = [];
    for (const page of orderedPages) {
      for (const m of page.messages) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          out.push(m);
        }
      }
    }
    return out;
  }, [messagesQuery.data]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 92,
    overscan: 8,
  });

  const initialScrolledConvoRef = useRef<string | null>(null);
  const prevLastMsgIdRef = useRef<number | null>(null);

  useEffect(() => {
    prevLastMsgIdRef.current = null;
    setNearBottom(true);
  }, [convoKey]);

  useEffect(() => {
    if (messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];

    if (initialScrolledConvoRef.current !== convoKey) {
      initialScrolledConvoRef.current = convoKey;
      prevLastMsgIdRef.current = lastMsg.id;
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
      });
      return;
    }

    if (prevLastMsgIdRef.current !== lastMsg.id) {
      prevLastMsgIdRef.current = lastMsg.id;
      if (nearBottom || lastMsg.senderPeerId === pod.myPeerId) {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
        });
      }
    }
  }, [convoKey, messages, nearBottom, pod.myPeerId, virtualizer]);

  useEffect(() => {
    if (!highlightedId || messages.length === 0) return;
    const idx = messages.findIndex((m) => m.id === highlightedId);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: 'center' });
    }
    const timer = setTimeout(() => setHighlightedId(null), 2800);
    return () => clearTimeout(timer);
  }, [highlightedId, messages, setHighlightedId, virtualizer]);

  const handleScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setNearBottom(distanceFromBottom < 220);
  };

  const virtualItems = virtualizer.getVirtualItems();
  const streamTitle = activePeer
    ? `Private 1:1 chat with ${activePeer.alias}`
    : `Pod Group Chat in ${pod.title || `#${pod.code}`}`;

  return (
    <div
      ref={viewportRef}
      onScroll={handleScroll}
      className={styles.streamViewport}
      role="log"
      aria-live="polite"
      aria-label={streamTitle}
    >
      {messagesQuery.hasNextPage && (
        <div className={styles.loadOlderWrap}>
          <button
            type="button"
            className={styles.loadOlderBtn}
            disabled={messagesQuery.isFetchingNextPage}
            onClick={() => messagesQuery.fetchNextPage()}
          >
            {messagesQuery.isFetchingNextPage
              ? 'Loading older messages...'
              : 'Load older messages'}
          </button>
        </div>
      )}

      {messagesQuery.isLoading ? (
        <div className={styles.emptyState}>
          <p style={{ color: '#686868', fontSize: 14 }}>
            {activePeer
              ? `Loading private chat with ${activePeer.alias}...`
              : `Loading Pod Group Chat...`}
          </p>
        </div>
      ) : messages.length === 0 ? (
        activePeer ? (
          <div className={styles.emptyState}>
            <div style={{ position: 'relative', display: 'inline-flex' }}>
              <span
                className={styles.convoAvatar}
                style={{
                  width: 56,
                  height: 56,
                  fontSize: 18,
                  background: safeAvatarColor(activePeer.color, activePeer.alias),
                }}
              >
                {aliasInitials(activePeer.alias)}
              </span>
              <span
                style={{
                  position: 'absolute',
                  right: -4,
                  bottom: -4,
                  width: 24,
                  height: 24,
                  borderRadius: 999,
                  background: '#a1ffcb',
                  color: '#144223',
                  border: '2px solid #ffffff',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Lock size={12} />
              </span>
            </div>
            <h3 style={{ margin: 0, fontSize: 18 }}>
              Private 1:1 Chat with {activePeer.alias}
            </h3>
            <p
              style={{
                margin: 0,
                maxWidth: 420,
                color: '#686868',
                fontSize: 14,
                lineHeight: 1.5,
              }}
            >
              Messages, voice notes, and files here are visible{' '}
              <strong>only</strong> to you ({pod.myAlias}) and{' '}
              <strong>{activePeer.alias}</strong>. Real names, emails, genders,
              and nationalities stay 100% hidden.
            </p>
          </div>
        ) : (
          <div className={styles.emptyState}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                background: '#eafbef',
                color: '#17522c',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(31,107,58,0.24)',
              }}
            >
              <Users size={24} />
            </div>
            <h3 style={{ margin: 0, fontSize: 18 }}>
              Pod Group Chat · {pod.title || `#${pod.code}`}
            </h3>
            <p
              style={{
                margin: 0,
                maxWidth: 440,
                color: '#686868',
                fontSize: 14,
                lineHeight: 1.5,
              }}
            >
              {pod.description ||
                `Everyone in #${pod.code} chats under a peer-blind room alias. Say hi, share a voice note, run a /poll, or tap any member to message privately!`}
            </p>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontFamily: 'var(--m-font-mono)',
                color: '#17522c',
                background: '#ffffff',
                padding: '6px 12px',
                borderRadius: 999,
                border: '1px solid rgba(31,107,58,0.22)',
              }}
            >
              <Sparkles size={13} />
              <span>Try /icebreaker, /poll, or /propose below</span>
            </div>
          </div>
        )
      ) : (
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((virtualRow) => {
            const msg = messages[virtualRow.index];
            if (!msg) return null;
            return (
              <div
                key={msg.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <MessageCard
                  message={msg}
                  myPeerId={pod.myPeerId}
                  knownAliases={knownAliases}
                  highlighted={highlightedId === msg.id}
                />
              </div>
            );
          })}
        </div>
      )}

      {!nearBottom && messages.length > 0 && (
        <button
          type="button"
          className={styles.jumpLatestBtn}
          onClick={() => {
            virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
            setNearBottom(true);
          }}
        >
          <ArrowDown size={14} />
          <span>Jump to latest</span>
        </button>
      )}
    </div>
  );
}
