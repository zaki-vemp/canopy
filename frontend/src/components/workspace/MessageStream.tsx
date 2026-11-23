'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAtom } from 'jotai';
import { ArrowDown, Hash, Sparkles } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { highlightedMessageIdAtom } from '@/state/workspaceAtoms';
import { MessageCard } from '@/components/workspace/MessageCard';
import type {
  MessagesPage,
  PodChannel,
  PodDetail,
  RichMessage,
} from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

interface MessageStreamProps {
  pod: PodDetail;
  channel: PodChannel;
  knownAliases: string[];
}

export function MessageStream({
  pod,
  channel,
  knownAliases,
}: MessageStreamProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [highlightedId, setHighlightedId] = useAtom(highlightedMessageIdAtom);
  const [nearBottom, setNearBottom] = useState(true);

  const messagesQuery = useInfiniteQuery<MessagesPage, Error>({
    queryKey: ['messages', pod.podId, channel.channelId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiFetch<MessagesPage>(
        `/api/pods/${pod.podId}/channels/${channel.channelId}/messages?beforeId=${pageParam}&limit=40`
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

  const initialScrolledChannelRef = useRef<string | null>(null);
  const prevLastMsgIdRef = useRef<number | null>(null);

  useEffect(() => {
    prevLastMsgIdRef.current = null;
    setNearBottom(true);
  }, [channel.channelId]);

  useEffect(() => {
    if (messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];

    if (initialScrolledChannelRef.current !== channel.channelId) {
      initialScrolledChannelRef.current = channel.channelId;
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
  }, [channel.channelId, messages, nearBottom, pod.myPeerId, virtualizer]);

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

  return (
    <div
      ref={viewportRef}
      onScroll={handleScroll}
      className={styles.streamViewport}
      role="log"
      aria-live="polite"
      aria-label={`Messages in #${channel.label}`}
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
            Loading #{channel.label}...
          </p>
        </div>
      ) : messages.length === 0 ? (
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
            }}
          >
            <Hash size={24} />
          </div>
          <h3 style={{ margin: 0, fontSize: 18 }}>
            Welcome to #{channel.label}
          </h3>
          <p style={{ margin: 0, maxWidth: 420, color: '#686868', fontSize: 14 }}>
            {channel.topic ||
              `Everyone in #${pod.code} appears under a room-scoped blind alias. Say hi, run /icebreaker, or start a /poll!`}
          </p>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              fontFamily: 'var(--m-font-mono)',
              color: '#17522c',
              background: '#f2fbf6',
              padding: '6px 12px',
              borderRadius: 999,
              border: '1px solid rgba(31,107,58,0.2)',
            }}
          >
            <Sparkles size={13} />
            <span>Try typing /icebreaker or /poll below</span>
          </div>
        </div>
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
